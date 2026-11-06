/**
 * Issue #149 (found during #140): WorkflowsHub + platformKnowledge copy
 * claimed trade approvals use "HMAC-SHA256 signed one-click approval
 * links" that "strictly expire after 300 seconds". The end-to-end trace
 * showed that claim was fiction:
 *
 * - NOTHING in the codebase mints a /trade/approve link. The only
 *   approval links that exist are the email agent's "Review & Approve on
 *   Trading Hub" button (→ the signed-in app) and reply-by-email
 *   APPROVE <orderId>; Slack approvals are Block Kit interactions gated
 *   by Slack's own signing secret (#147).
 * - The /trade/approve route read only `orderId`, never a `sig` or any
 *   expiry — and it didn't even require a session: it proceeded under a
 *   hard-coded fallback identity when requireAuth returned null.
 * - The downstream /etrade/order/execute handler DOES re-check the real
 *   controls: HITL gate (agent DIDs blocked), draft exists, status is
 *   exactly "previewed" (drafts expire unexecuted at +900s via
 *   expireStaleOrderDraft), and parameter immutability vs the preview.
 *
 * Outcome (per the issue's rule that claim and behaviour must match
 * exactly): no signing scheme was built for links nobody generates.
 * The copy now describes the real control — session-authenticated
 * approval — and the route was hardened to match it: a session is
 * REQUIRED (401 otherwise, the /clear pattern) and the fallback
 * identity is deleted. These tests drive the REAL worker fetch
 * dispatch (harness pattern from tests/slack_signature_gate.test.ts)
 * with a recording ORCHESTRATOR_AGENT stub and a Map-backed SESSIONS KV.
 *
 * Note on Response.redirect: the route redirects to a relative URL,
 * which workerd resolves against the request; Node's undici requires
 * an absolute URL and throws. The spy below emulates the workerd
 * behaviour so the tests assert the route's own logic (status +
 * Location target), not the runtime's URL parser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { readFileSync } from "node:fs";

// src/server.ts re-exports the agent classes, whose real module graph
// pulls in `cloudflare:` protocol imports the node test loader cannot
// resolve. Mock the agent SDK entry points with plain stand-ins (same
// pattern as tests/slack_signature_gate.test.ts); routeAgentRequest
// returns null so the worker's own route dispatch runs.
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

const LOGIN = "octocat-149";
const SESSION_ID = "0d9a1490-1c2b-4e3f-8a5b-149000000001";
const ORDER_ID = "ord_149_test";

interface ForwardedCall {
  id: string;
  pathname: string;
  body: any;
  userLogin: string | null;
}

function makeEnv(agentResponse: any) {
  const forwarded: ForwardedCall[] = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userId: "149", login: LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
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
          return Response.json(agentResponse);
        },
      }),
    },
  };
  return { env: env as Env, forwarded };
}

const get = (path: string, cookie?: string) =>
  new Request(`https://agent.test${path}`, {
    method: "GET",
    headers: cookie ? { Cookie: `session_id=${cookie}` } : {},
  });

describe("worker /trade/approve — session-authenticated approval (#149)", () => {
  let redirectSpy: any;

  beforeEach(() => {
    redirectSpy = vi
      .spyOn(Response, "redirect")
      .mockImplementation((url: any, status?: any) => {
        const s = typeof status === "number" ? status : 302;
        return new Response(null, { status: s, headers: { Location: String(url) } });
      });
  });

  afterEach(() => {
    redirectSpy.mockRestore();
  });

  it("unauthenticated (no session cookie) → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv({ success: true, brokerOrderRef: "BRK-1" });
    const res = await worker.fetch(get(`/trade/approve?orderId=${ORDER_ID}`), env);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("sign in to approve a trade");
    expect(forwarded).toHaveLength(0);
  });

  it("a forged sig/exp in the URL gains nothing: still 401 without a session", async () => {
    const { env, forwarded } = makeEnv({ success: true, brokerOrderRef: "BRK-1" });
    const res = await worker.fetch(
      get(`/trade/approve?orderId=${ORDER_ID}&sig=deadbeef&exp=9999999999`),
      env
    );
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("unknown session id → 401, agent never invoked", async () => {
    const { env, forwarded } = makeEnv({ success: true, brokerOrderRef: "BRK-1" });
    const res = await worker.fetch(get(`/trade/approve?orderId=${ORDER_ID}`, "no-such-session"), env);
    expect(res.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("valid session → forwards the approval to the SESSION user's agent and redirects with the result", async () => {
    const { env, forwarded } = makeEnv({ success: true, brokerOrderRef: "BRK-149" });
    const res = await worker.fetch(get(`/trade/approve?orderId=${ORDER_ID}`, SESSION_ID), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") || "";
    expect(location).toContain(`executedOrder=${ORDER_ID}`);
    expect(location).toContain("brokerRef=BRK-149");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].id).toBe(LOGIN);
    expect(forwarded[0].pathname).toBe("/etrade/order/execute");
    expect(forwarded[0].userLogin).toBe(LOGIN);
    expect(forwarded[0].body).toEqual({ orderId: ORDER_ID, decision: "approved" });
  });

  it("valid session + downstream refusal → honest error redirect (the execute handler's checks still govern)", async () => {
    const { env, forwarded } = makeEnv({ success: false, error: "Order draft 'ord_149_test' cannot be executed. Current status is 'executed'." });
    const res = await worker.fetch(get(`/trade/approve?orderId=${ORDER_ID}`, SESSION_ID), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") || "";
    expect(location).toContain("error=");
    expect(decodeURIComponent(location)).toContain("cannot be executed");
    expect(forwarded).toHaveLength(1);
  });

  it("missing orderId → 400 before any forwarding", async () => {
    const { env, forwarded } = makeEnv({ success: true });
    const res = await worker.fetch(get(`/trade/approve`, SESSION_ID), env);
    expect(res.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});

// ===========================================================================
// Source pins — the signed-link claim must not return, in any copy surface
// ===========================================================================

describe("source pins (#149)", () => {
  const CLAIM_STRINGS = [
    "HMAC-SHA256 one-click",
    "HMAC-signed 1-click",
    "sig=...",
    "strictly expires after 300 seconds",
    "approvalTtl: 300s",
    "signed inbound email trading",
    "one-click mobile approval links",
    "Cryptographic Approval Link",
    "tamper-proof HMAC",
  ];

  it("WorkflowsHub carries none of the signed-link claims", () => {
    const hub = src("client/WorkflowsHub.tsx");
    for (const claim of CLAIM_STRINGS) expect(hub).not.toContain(claim);
  });

  it("platformKnowledge carries none of the signed-link claims", () => {
    const kb = src("services/platformKnowledge.ts");
    for (const claim of CLAIM_STRINGS) expect(kb).not.toContain(claim);
  });

  it("the corrected copy states the real control (no bearer links; session-authenticated approval)", () => {
    expect(src("client/WorkflowsHub.tsx")).toContain("no bearer approval links");
    expect(src("services/platformKnowledge.ts")).toContain("No bearer/signed approval links exist");
  });

  it("server entry: the fallback identity is gone and the route requires a session", () => {
    // Slice 5 of Qunsultant/cfagent#2902 (2026-11-05): the /trade/approve
    // block moved verbatim from src/server.ts to
    // src/server/routes/trading.ts; the entry surface is server.ts +
    // routes/*.ts, so the pin reads both files.
    const server = src("server.ts") + src("server/routes/trading.ts");
    expect(server).not.toContain("email_authorized_user");
    expect(server).toContain("Unauthorized: sign in to approve a trade.");
  });
});
