/**
 * Issue #154 (found during the #147 survey; #149 fixed the same pattern
 * at /trade/approve): several routes in src/server.ts called
 * requireAuth, tolerated a null session, and proceeded under a
 * hard-coded FALLBACK IDENTITY:
 *
 * - POST /api/trading/email/inbound  → "omnichannel_email_trader",
 *   forwarding into the caller's agent, whose /trading/email/inbound
 *   handler processes inbound-email trade commands (incl. APPROVE).
 * - POST /api/trading/slack/test     → "omnichannel_slack_trader",
 *   forwarding to /trading/slack/event (Slack trading event handling).
 * - POST /api/trading/voice/turn|test → "omnichannel_voice_trader",
 *   forwarding to /trading/voice/turn (voice trading turns can act).
 * - GET  /api/trading/voice/greeting → "omnichannel_voice_trader".
 * - WS   /voice/trade, /api/trading/voice/ws → "voice_trader" — an
 *   unauthenticated caller could open a live voice trading session.
 * - /api/trading/options/* and /api/schedules* forwarders → fell back
 *   to the CALLER-SUPPLIED x-user-login header or a shared
 *   "default_trader", letting an unauthenticated caller select ANY
 *   user's agent instance (schedules are per-user create/cancel state;
 *   the options API acts on the caller's identity).
 *
 * Fix (the #149 pattern): a session is REQUIRED — unauthenticated →
 * 401 with NO forwarding/processing — and the identity is the session
 * login only. Authenticated behaviour is unchanged: the same forward,
 * under the caller's own login. The in-app callers (ETradeTradingHub,
 * ResearchReportActions, options/schedules panels) are signed in and
 * send their session cookie.
 *
 * Surveyed and deliberately NOT changed here (recorded in the #154
 * report): /mcp (header-identified external MCP transport) and the
 * /api/premium/* + /api/payments/agentic/* block (x402 — payment is
 * the designed access control) keep their designed identity models;
 * /api/browser/snapshot and /api/browser/transaction-snap never call
 * requireAuth at all (missing-auth, a different defect class);
 * /api/payments/webhook is unauthenticated BY DESIGN (the signature
 * is the auth, #148); /slack/* and /nlq/webhook are signature-gated
 * (#147/#140). These tests therefore pin the FIXED routes only.
 *
 * Harness: same pattern as tests/trade_approve_session_gate.test.ts —
 * the REAL worker fetch dispatch with a recording ORCHESTRATOR_AGENT stub
 * and a Map-backed SESSIONS KV. The voice-WS unauthenticated test also
 * proves the session check runs BEFORE WebSocketPair construction
 * (which does not exist in Node: reaching it would throw).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/trade_approve_session_gate.test.ts);
// routeAgentRequest returns null so the worker's own route dispatch runs.
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
  // Issue #199: src/server.ts re-exports PaymentsAgent/ScheduledAgent,
  // which `extend Agent` when the module loads — the stub must be an
  // extendable class, otherwise `extends undefined` throws at import time.
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

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const LOGIN = "octocat-154";
const SESSION_ID = "0d9a1540-1c2b-4e3f-8a5b-154000000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  body: any;
  userLogin: string | null;
}

function makeEnv() {
  const forwarded: ForwardedCall[] = [];
  // #604: sessions live in the SessionStore DO. Fake speaks the store
  // protocol (POST {op,ns,key,value} → {value|ok}).
  const kv = new Map<string, string>();
  kv.set(`sessions:${SESSION_ID}`, JSON.stringify({ githubLogin: LOGIN, userId: "154", login: LOGIN }));
  const env: any = {
    SESSION_STORE: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = (await req.json()) as {
            op: string;
            ns: string;
            key: string;
            value?: string;
          };
          const k = `${body.ns}:${body.key}`;
          if (body.op === "get") {
            return Response.json({ value: kv.get(k) ?? null });
          }
          if (body.op === "put") {
            kv.set(k, body.value ?? "");
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            kv.delete(k);
            return Response.json({ ok: true });
          }
          return Response.json({ error: "unknown op" }, { status: 400 });
        },
      }),
    },
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          forwarded.push({
            id,
            pathname: new URL(req.url).pathname,
            body: await req.json().catch(() => null),
            userLogin: req.headers.get("x-user-login"),
          });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

const req = (
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

// ---------------------------------------------------------------------------
// Omnichannel test/simulator routes
// ---------------------------------------------------------------------------

describe("worker omnichannel test routes — session required (#154)", () => {
  it("POST /api/trading/email/inbound unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/email/inbound", { method: "POST", body: { subject: "APPROVE ord_1" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/email/inbound with a valid session → forwarded to the SESSION user's agent", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/email/inbound", { method: "POST", cookie: SESSION_ID, body: { subject: "quote AAPL" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/trading/email/inbound");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });

  it("POST /api/trading/slack/test unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/slack/test", { method: "POST", body: { type: "event_callback" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/slack/test with an unknown session id → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/slack/test", { method: "POST", cookie: "no-such-session", body: {} }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/slack/test with a valid session → forwarded as the session user", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/slack/test", { method: "POST", cookie: SESSION_ID, body: { type: "event_callback" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/trading/slack/event");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });

  it("POST /api/trading/voice/turn unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/voice/turn", { method: "POST", body: { transcript: "buy 1 AAPL" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/voice/test (alias) unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/voice/test", { method: "POST", body: { transcript: "hello" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/voice/turn with a valid session → forwarded as the session user", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/voice/turn", { method: "POST", cookie: SESSION_ID, body: { transcript: "quote AAPL" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/trading/voice/turn");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });

  it("GET /api/trading/voice/greeting unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/trading/voice/greeting"), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("GET /api/trading/voice/greeting with a valid session → forwarded as the session user", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/trading/voice/greeting", { cookie: SESSION_ID }), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].pathname).toBe("/trading/voice/greeting");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });
});

// ---------------------------------------------------------------------------
// Options + schedules forwarders (header-identity impersonation removed)
// ---------------------------------------------------------------------------

describe("worker options/schedules forwarders — session identity only (#154)", () => {
  it("POST /api/trading/options/unified unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/options/unified", { method: "POST", body: { symbol: "AAPL" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/options/unified with only an x-user-login header → 401 (header no longer asserts identity)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/options/unified", {
        method: "POST",
        headers: { "x-user-login": "victim-user" },
        body: { symbol: "AAPL" },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/trading/options/unified with a session → forwarded under the SESSION login, not a spoofed header", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/options/unified", {
        method: "POST",
        cookie: SESSION_ID,
        headers: { "x-user-login": "someone-else" },
        body: { symbol: "AAPL" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/trading/options/unified");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });

  it("GET /api/schedules unauthenticated → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/schedules"), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("POST /api/schedules/create with only an x-user-login header → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/schedules/create", {
        method: "POST",
        headers: { "x-user-login": "victim-user" },
        body: { callback: "autonomousOptionsAnalysis" },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("GET /api/schedules with a valid session → forwarded under the session login", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(req("/api/schedules", { cookie: SESSION_ID }), env);
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/schedules");
    expect(forwarded[0].userLogin).toBe(LOGIN);
  });
});

// ---------------------------------------------------------------------------
// Voice WebSocket session
// ---------------------------------------------------------------------------

describe("worker voice-trading WebSocket — session required before accept (#154)", () => {
  it("WS /api/trading/voice/ws unauthenticated → 401 (rejected before WebSocketPair is constructed)", async () => {
    const { env, forwarded } = makeEnv();
    const res = await worker.fetch(
      req("/api/trading/voice/ws", { headers: { Upgrade: "websocket" } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("WS /voice/trade with an unknown session id → 401", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      req("/voice/trade", { cookie: "no-such-session", headers: { Upgrade: "websocket" } }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Source pins — the fallback identities must not return
// ---------------------------------------------------------------------------

describe("source pins (#154)", () => {
  // Slice 5 of Qunsultant/cfagent#2902 (2026-11-05): the omnichannel
  // trading blocks moved verbatim from src/server.ts to
  // src/server/routes/trading.ts; the entry surface is server.ts +
  // routes/*.ts, so the pins read both files.
  const entry = src("server.ts") + src("server/routes/trading.ts");

  it("server entry: the fixed fallback identities are gone", () => {
    const server = entry;
    expect(server).not.toContain("omnichannel_email_trader");
    expect(server).not.toContain("omnichannel_slack_trader");
    expect(server).not.toContain("omnichannel_voice_trader");
    expect(server).not.toContain('|| "voice_trader"');
  });

  it("server entry: no route derives identity from the caller-supplied x-user-login header", () => {
    const server = entry;
    expect(server).not.toContain('session?.githubLogin || request.headers.get("x-user-login")');
  });

  it("server entry: the omnichannel test routes reject a null session (401) before forwarding", () => {
    const server = entry;
    // The 401 guard appears once per fixed route block: email/inbound,
    // slack/test, voice turn/test, voice greeting, options forwarder,
    // schedules forwarder, voice WS — plus the E*TRADE diagnostics
    // route's JSON 401 and the pre-existing guards elsewhere.
    const guards = server.match(/if \(!session\) return new Response\("Unauthorized", \{ status: 401 \}\);/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(7);
  });
});
