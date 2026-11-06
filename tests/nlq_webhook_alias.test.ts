import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// Same harness pattern as tests/api_chat_auth.test.ts: src/server.ts's
// module graph pulls the agents SDK; mock the entry points so the worker's
// own route dispatch runs and routeAgentRequest returns null.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";

/**
 * Issue #313 — the advertised POST /api/nlq/webhook spelling 404'd while
 * /nlq/webhook and /api/trading/nlq/webhook worked. All three spellings now
 * delegate to one single-owner handler and must behave identically:
 * same throttle, same signature gate, same replay protection, same
 * forwarding, same response shapes for the same payload.
 */

const SECRET = "unit-test-nlq-webhook-secret";

const AGENT_RESULT = {
  summary: "NLQ request processed.",
  rows: [{ ticker: "NVDA" }],
  plan: { domain: "general", tradingData: { action: "none" } },
};

function makeEnv(secret: string | undefined) {
  const forwarded: { id: string; pathname: string; body: any }[] = [];
  const env: any = {
    INBOUND_NLQ_WEBHOOK_SECRET: secret,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            body: await req.json().catch(() => null),
          });
          return Response.json(AGENT_RESULT);
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

async function signedRequest(
  path: string,
  body: Record<string, unknown>,
  opts: { secret?: string; signingSecret?: string; login?: string } = {},
) {
  const rawBody = JSON.stringify(body);
  const signingSecret = opts.signingSecret !== undefined ? opts.signingSecret : opts.secret;
  const sig = signingSecret ? await computeHmacSha256Hex(signingSecret, rawBody) : null;
  return new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-login": opts.login ?? "nlq-alias-test-user",
      ...(sig ? { "X-Signature-256": sig } : {}),
    },
    body: rawBody,
  });
}

const SPELLINGS = ["/nlq/webhook", "/api/trading/nlq/webhook", "/api/nlq/webhook"];

const freshBody = (tag: string) => ({
  query: `what is the price of NVDA [alias-${tag}]`,
  timestamp: new Date().toISOString(),
});

describe("POST /api/nlq/webhook alias equivalence (#313)", () => {
  it("all three spellings accept a valid payload and return byte-identical responses", async () => {
    const { env, forwarded } = makeEnv(SECRET);
    const results: { status: number; json: unknown }[] = [];
    for (let i = 0; i < SPELLINGS.length; i++) {
      const body = freshBody(`valid-${i}`);
      const res = await worker.fetch(await signedRequest(SPELLINGS[i], body, { secret: SECRET, login: `nlq-valid-${i}` }), env);
      results.push({ status: res.status, json: await res.json() });
    }
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.json).toEqual(AGENT_RESULT);
    }
    // Identical bodies across spellings.
    expect(results[1].json).toEqual(results[0].json);
    expect(results[2].json).toEqual(results[0].json);
    // All three forwarded to the ORCHESTRATOR_AGENT instance.
    expect(forwarded).toHaveLength(3);
    for (const f of forwarded) {
      expect(f.pathname).toBe("/nlq");
      expect(f.id).toBe("nlq_webhook");
    }
  });

  it("invalid signature → identical 401 on all spellings", async () => {
    const { env } = makeEnv(SECRET);
    for (let i = 0; i < SPELLINGS.length; i++) {
      const body = freshBody(`badsig-${i}`);
      const res = await worker.fetch(
        await signedRequest(SPELLINGS[i], body, { secret: SECRET, signingSecret: "wrong-secret", login: `nlq-badsig-${i}` }),
        env,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid NLQ webhook signature." });
    }
  });

  it("missing query → identical 400 on all spellings", async () => {
    const { env } = makeEnv(SECRET);
    for (let i = 0; i < SPELLINGS.length; i++) {
      const res = await worker.fetch(
        await signedRequest(SPELLINGS[i], { timestamp: new Date().toISOString() }, { secret: SECRET, login: `nlq-noquery-${i}` }),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "A non-empty query string is required." });
    }
  });

  it("unconfigured secret → 503 on the /api spelling (fail-closed)", async () => {
    const { env } = makeEnv(undefined);
    const body = freshBody("nosecret");
    const res = await worker.fetch(await signedRequest("/api/nlq/webhook", body, { login: "nlq-nosecret" }), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "INBOUND_NLQ_WEBHOOK_SECRET is not configured." });
  });

  it("the advertised /api spelling is pinned in the route condition", () => {
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the NLQ webhook
    // branches moved from src/server.ts to src/server/routes/messaging.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files.
    const src = readFileSync("src/server.ts", "utf8") + readFileSync("src/server/routes/messaging.ts", "utf8");
    expect(src).toContain('path === "/api/nlq/webhook"');
  });
});
