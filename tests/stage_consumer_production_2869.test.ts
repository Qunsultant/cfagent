/**
 * Issue #2869 (G8) — the stage consumer is the production
 * PDF path, not just a tested module.
 *
 * The audit's F2 complaint was that consumeAnalysisDone
 * had no production caller and production was still
 * in-process runReportPipeline. This slice wires it:
 * generateRunPdf persists the run's analysis to a per-run
 * key, builds a real analysis-done message, and consumes
 * it — the PDF leg runs through the consumer, with
 * durable stage claims (mas_stage_claims in src/data/,
 * census-safe) and release-on-generation-failure so a
 * failed attempt never blocks #1278 regeneration.
 *
 * Pins:
 *  - generateRunPdf delegates PDF generation to the
 *    production helper (no direct formats:["pdf"] call
 *    left in screener-agent.ts);
 *  - a suppressed redelivery never clobbers the persisted
 *    analysis that carries the previous generation's pdf
 *    fields — the helper copy-backs those fields onto the
 *    fresh result instead;
 *  - the capability inventory names the consumer as the
 *    production PDF leg (tabular legs stay in the one
 *    generation module; queue transport stays open —
 *    filed on #2869, not claimed here).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  consumeAnalysisDone,
  type StageClaimStore,
} from "../src/workflows/stageReportConsumer";
import {
  generateRunPdfViaStageConsumer,
  stageAnalysisKey,
} from "../src/workflows/stageReportProduction";
import { createSqlStageClaimStore } from "../src/data/stageClaimsStore";
import { MockSqlStorage } from "./mock-sql";
import type { SqlStorage } from "../src/data/repositoryPorts";

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const RUN = {
  timestamp: "2026-11-03T12:00:00.000Z",
  trigger: "manual" as const,
  provider: "etrade" as const,
  universe: "TECH" as const,
  sector: "ALL",
  success: true,
  totalScanned: 2,
  matchedCount: 1,
  opportunities: [],
  allStocks: [
    { symbol: "AAA", price: 10 },
    { symbol: "BBB", price: 20 },
  ],
  discoveryMessage: "",
};

function countingGenerate(calls: Array<Record<string, unknown>>) {
  return async (input: { result: Record<string, unknown> }) => {
    calls.push(input as unknown as Record<string, unknown>);
    input.result["pdfKey"] = "screener:pdf:abcdef12";
    input.result["pdfStatus"] = "generated";
    delete input.result["pdfError"];
    return { format: "pdf", status: "generated", key: "screener:pdf:abcdef12" };
  };
}

describe("production PDF leg through the stage consumer (#2869)", () => {
  it("persists the analysis, consumes it, and copy-backs the pdf fields onto the run", async () => {
    const storage = new FakeStorage();
    const sql = new MockSqlStorage() as unknown as SqlStorage;
    const calls: Array<Record<string, unknown>> = [];
    const result = { ...RUN } as Record<string, unknown>;
    const out = await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      sql,
      result: result as never,
      userLogin: "alice",
      generatePdf: countingGenerate(calls) as never,
    });
    expect(out.status).toBe("generated");
    expect(calls).toHaveLength(1);
    expect(result["pdfKey"]).toBe("screener:pdf:abcdef12");
    expect(result["pdfStatus"]).toBe("generated");
    const analysis = await storage.get<Record<string, unknown>>(stageAnalysisKey(RUN.timestamp));
    expect(analysis).toBeTruthy();
    expect(analysis!["pdfKey"]).toBe("screener:pdf:abcdef12");
    const claims = createSqlStageClaimStore(() => sql);
    expect(claims.has(`screener:${RUN.timestamp}::analysis-done`)).toBe(true);
  });

  it("a suppressed redelivery copy-backs the previous generation's fields without regenerating or clobbering", async () => {
    const storage = new FakeStorage();
    const sql = new MockSqlStorage() as unknown as SqlStorage;
    const calls: Array<Record<string, unknown>> = [];
    const generate = countingGenerate(calls);
    const first = { ...RUN } as Record<string, unknown>;
    await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      sql,
      result: first as never,
      userLogin: "alice",
      generatePdf: generate as never,
    });
    expect(calls).toHaveLength(1);
    // A fresh result object for the same run (retry / re-read):
    // no pdf fields yet, same timestamp.
    const second = { ...RUN } as Record<string, unknown>;
    const out = await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      sql,
      result: second as never,
      userLogin: "alice",
      generatePdf: generate as never,
    });
    expect(out.status).toBe("duplicate-suppressed");
    expect(calls).toHaveLength(1);
    expect(second["pdfKey"]).toBe("screener:pdf:abcdef12");
    expect(second["pdfStatus"]).toBe("generated");
    const analysis = await storage.get<Record<string, unknown>>(stageAnalysisKey(RUN.timestamp));
    expect(analysis!["pdfKey"]).toBe("screener:pdf:abcdef12");
  });

  it("a failed generation releases the claim, records failure without throwing, and a retry generates", async () => {
    const storage = new FakeStorage();
    const sql = new MockSqlStorage() as unknown as SqlStorage;
    let attempts = 0;
    const flaky = async (input: { result: Record<string, unknown> }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("pdf renderer down");
      input.result["pdfKey"] = "screener:pdf:abcdef12";
      input.result["pdfStatus"] = "generated";
      return { format: "pdf", status: "generated" };
    };
    const first = { ...RUN } as Record<string, unknown>;
    const failed = await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      sql,
      result: first as never,
      userLogin: "alice",
      generatePdf: flaky as never,
    });
    expect(failed.status).toBe("failed");
    expect(first["pdfStatus"]).toBe("failed");
    expect(first["pdfError"]).toContain("pdf renderer down");
    const claims = createSqlStageClaimStore(() => sql);
    expect(claims.has(`screener:${RUN.timestamp}::analysis-done`)).toBe(false);
    const second = { ...RUN } as Record<string, unknown>;
    const retried = await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      sql,
      result: second as never,
      userLogin: "alice",
      generatePdf: flaky as never,
    });
    expect(retried.status).toBe("generated");
    expect(second["pdfStatus"]).toBe("generated");
  });

  it("a missing timestamp records failure instead of throwing", async () => {
    const storage = new FakeStorage();
    const result = { ...RUN, timestamp: "" } as Record<string, unknown>;
    const out = await generateRunPdfViaStageConsumer({
      env: {},
      storage: storage as never,
      result: result as never,
      userLogin: "alice",
      generatePdf: countingGenerate([]) as never,
    });
    expect(out.status).toBe("failed");
    expect(result["pdfStatus"]).toBe("failed");
  });
});

describe("consumer release-on-failure contract (#2869)", () => {
  it("a throwing generate releases the claim so a retry regenerates", async () => {
    const claims: StageClaimStore = (() => {
      const seen = new Set<string>();
      return {
        has: (k) => seen.has(k),
        add: (k) => {
          seen.add(k);
        },
        delete: (k) => {
          seen.delete(k);
        },
      };
    })();
    const message = {
      runId: "screener:2026-11-03T12:00:00.000Z",
      stageId: "analysis-done" as const,
      artifactKeys: ["k1"],
      userLogin: "alice",
      producedBy: "persistCanonicalResults" as const,
      idempotencyKey: "screener:2026-11-03T12:00:00.000Z::analysis-done",
      provenance: { parentRunId: "screener:2026-11-03T12:00:00.000Z" },
    };
    let attempts = 0;
    const generate = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { ok: true };
    };
    await expect(
      consumeAnalysisDone({
        message,
        claims,
        readPersisted: async () => ({ allStocks: [] }),
        generate: generate as never,
      }),
    ).rejects.toThrow("boom");
    expect(claims.has(message.idempotencyKey)).toBe(false);
    const retried = await consumeAnalysisDone({
      message,
      claims,
      readPersisted: async () => ({ allStocks: [] }),
      generate: generate as never,
    });
    expect(retried.status).toBe("generated");
    expect(attempts).toBe(2);
  });
});

describe("production wiring pins (#2869)", () => {
  it("generateRunPdf delegates PDF generation to the stage-consumer helper", () => {
    const text = readFileSync("src/agents/screener-agent.ts", "utf8");
    const start = text.indexOf("private async generateRunPdf");
    const end = text.indexOf("/**", start + 1);
    const body = text.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("generateRunPdfViaStageConsumer");
    expect(body).not.toContain('formats: ["pdf"]');
  });

  it("the capability inventory names the consumer as the production PDF leg", () => {
    const inv = readFileSync("src/workflows/stockScreenCapability.ts", "utf8");
    expect(inv).toContain("consumeAnalysisDone (production PDF leg)");
  });
});
