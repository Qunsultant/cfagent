import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Qunsultant/cfagent#1775 (parent #1717, Adapter S1): the four S1
 * modules route through their existing adapters — no direct
 * provider-binding calls remain in them. These pins capture the
 * fail-soft vs fail-loud contract of each path as it stands today:
 *
 * - verifier: LLM failure is fail-LOUD (throws past the router,
 *   after cheap -> primary -> fallback on retryable errors);
 *   an unparseable model reply is fail-SOFT (pass:false, 0.3).
 * - reportSemanticIndex: embedding/Vectorize failure is fail-SOFT
 *   (index false, search []); long texts embed truncated to 8000
 *   chars, exactly as the deleted local embed() did.
 * - staticAssets: the new unconditional fetch port answers any
 *   request from ASSETS verbatim (the landing-page + fallthrough
 *   contract), while serveStaticAsset keeps its session-free gate.
 */

// The verifier routes through the gateway port's shared call, so
// the seam under test is executeModelCall — NOT the "ai" module
// (the verifier itself must not import generateText: the #1741
// coverage pin that S1 resolves allows that call only inside
// the gateway module; see verifier.ts).
vi.mock("../src/gateway/gatewayModelCall", () => ({
  executeModelCall: vi.fn(),
}));

import { executeModelCall } from "../src/gateway/gatewayModelCall";
import { verifyWithLLM } from "../src/models/verifier";
import {
  indexReport,
  semanticSearchReports,
} from "../src/services/reportSemanticIndex";
import {
  fetchStaticAsset,
  serveStaticAsset,
} from "../src/security/staticAssets";
import type { Env } from "../src/types";

const mockedExecuteModelCall = vi.mocked(executeModelCall);

describe("#1775 verifier routes through the Workers AI adapter", () => {
  beforeEach(() => {
    mockedExecuteModelCall.mockReset();
  });

  it("parses a JSON verifier reply from the adapter model", async () => {
    mockedExecuteModelCall.mockResolvedValue({
      text: '{"pass": true, "confidence": 0.92, "issues": []}',
    });
    const result = await verifyWithLLM(
      { AI: {} } as never,
      "some output",
      "grounded in evidence"
    );
    expect(result).toEqual({ pass: true, confidence: 0.92, issues: [] });
    // The router's cheap tier runs first; the adapter model is built
    // for that tier's model id (no direct env.AI.run call exists).
    expect(mockedExecuteModelCall).toHaveBeenCalledTimes(1);
    const input = mockedExecuteModelCall.mock.calls[0][1] as any;
    expect(input.messages[1].content).toContain("some output");
    expect(input.messages[1].content).toContain("grounded in evidence");
  });

  it("fails soft on a reply with no JSON object at all", async () => {
    mockedExecuteModelCall.mockResolvedValue({ text: "not json at all" });
    const result = await verifyWithLLM({ AI: {} } as never, "out", "crit");
    // True pre-#1775 contract: no braces -> parse "{}" -> pass:false,
    // default confidence 0.5, no issues (the catch branch below is
    // only for braces that fail to parse).
    expect(result).toEqual({ pass: false, confidence: 0.5, issues: [] });
  });

  it("fails soft on malformed JSON braces (catch branch)", async () => {
    mockedExecuteModelCall.mockResolvedValue({ text: "{not json}" });
    const result = await verifyWithLLM({ AI: {} } as never, "out", "crit");
    expect(result).toEqual({
      pass: false,
      confidence: 0.3,
      issues: ["unparseable verifier response"],
    });
  });

  it("fails loud after the router exhausts retryable failover", async () => {
    const retryable = Object.assign(new Error("quota exceeded"), {
      code: 429,
    });
    mockedExecuteModelCall.mockRejectedValue(retryable);
    await expect(
      verifyWithLLM({ AI: {} } as never, "out", "crit")
    ).rejects.toThrow("quota exceeded");
    // cheap -> primary -> fallback: three adapter attempts.
    expect(mockedExecuteModelCall).toHaveBeenCalledTimes(3);
  });

  it("advances the router chain on a retryable error, then succeeds", async () => {
    const retryable = Object.assign(new Error("rate limit"), { code: 429 });
    mockedExecuteModelCall
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({
        text: '{"pass": false, "confidence": 0.4, "issues": ["unsupported"]}',
      });
    const result = await verifyWithLLM({ AI: {} } as never, "out", "crit");
    expect(result).toEqual({
      pass: false,
      confidence: 0.4,
      issues: ["unsupported"],
    });
    expect(mockedExecuteModelCall).toHaveBeenCalledTimes(2);
  });
});

describe("#1775 report index routes through VectorMemory", () => {
  it("truncates long text to 8000 chars before embedding (old embed parity)", async () => {
    const run = vi.fn(async () => ({ data: [[0.1]] }));
    const upsert = vi.fn(async () => undefined);
    const env = { AI: { run }, VECTOR_MEMORY: { upsert } };
    const ok = await indexReport(env as never, {
      reportId: "r1",
      title: "t",
      source: "s",
      text: "x".repeat(9000),
    });
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][1] as any).text).toHaveLength(8000);
    expect((run.mock.calls[0][0] as string)).toBe("@cf/baai/bge-base-en-v1.5");
  });

  it("fails soft when the adapter embedding returns no vector", async () => {
    const env = {
      AI: { run: async () => ({ data: [] }) },
      VECTOR_MEMORY: { upsert: vi.fn() },
    };
    expect(
      await indexReport(env as never, {
        reportId: "r1",
        title: "t",
        source: "s",
        text: "x",
      })
    ).toBe(false);
    expect(
      await semanticSearchReports(env as never, "query")
    ).toEqual([]);
  });

  it("queries through the adapter with the report filter + metadata", async () => {
    const query = vi.fn(async () => ({
      matches: [{ id: "report:r9", score: 0.8, metadata: {} }],
    }));
    const env = {
      AI: { run: async () => ({ data: [[0.1]] }) },
      VECTOR_MEMORY: { query },
    };
    const hits = await semanticSearchReports(env as never, "q", 8);
    expect(hits).toEqual([{ reportId: "r9", score: 0.8 }]);
    expect(query).toHaveBeenCalledWith(
      [0.1],
      expect.objectContaining({
        topK: 8,
        filter: { kind: "report" },
        returnMetadata: true,
      })
    );
  });
});

describe("#1775 static asset port", () => {
  function makeEnv() {
    const assetFetch = vi.fn(
      async (request: Request) =>
        new Response(`asset:${new URL(request.url).pathname}`, { status: 200 })
    );
    const env = { ASSETS: { fetch: assetFetch } } as unknown as Env;
    return { env, assetFetch };
  }

  it("fetchStaticAsset answers any path from ASSETS (landing + fallthrough)", async () => {
    const { env, assetFetch } = makeEnv();
    const res = await fetchStaticAsset(
      new Request("https://agent.openaimp.com/"),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/");
    expect(assetFetch).toHaveBeenCalledTimes(1);
  });

  it("serveStaticAsset still gates non-asset paths to null", async () => {
    const { env, assetFetch } = makeEnv();
    const res = await serveStaticAsset(
      new Request("https://agent.openaimp.com/"),
      "/",
      env
    );
    expect(res).toBeNull();
    expect(assetFetch).not.toHaveBeenCalled();
  });
});
