/**
 * Issue #2787: bare /payments/agentic/commercial/* paths 404 in
 * production while the /api-prefixed twins work. The server.ts
 * dispatcher gated the agentic family on
 * path.startsWith("/api/payments/agentic/") while the handlers match
 * endsWith("/payments/agentic/commercial/..."), so a bare spelling
 * never reached a handler — including the live GoalScreenPanel
 * pricing fetch (rendered in ScreenersHub) and the
 * PaymentWorkflowAssurance prices/pricing fetches.
 *
 * Same harness as tests/browser_snapshot_auth_aliases.test.ts (real
 * worker fetch dispatch, recording ORCHESTRATOR_AGENT stub, Map-backed
 * SESSIONS KV). These tests pin every spelling:
 * - unauthenticated → 401, nothing forwarded (the handler is
 *   reached; a 404 would mean the dispatcher missed it);
 * - valid session → forwarded exactly like the canonical /api
 *   spelling (same stripped pathname, same x-user-login).
 * The canonical /api spelling is the control in every case.
 */
import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

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

const LOGIN = "octocat-2787";
const SESSION_ID = "0d9a2787-1c2b-4e3f-8a5b-278700000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  search: string;
  userLogin: string | null;
}

function makeEnv() {
  const forwarded: ForwardedCall[] = [];
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: LOGIN, userLogin: LOGIN });
  const env: any = {
    SESSION_STORE: sessionStoreNs,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (req: Request) => {
          const u = new URL(req.url);
          forwarded.push({
            id,
            pathname: u.pathname,
            search: u.search,
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
  opts: { method?: string; cookie?: string; headers?: Record<string, string> } = {},
) =>
  new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.cookie ? { Cookie: `session_id=${opts.cookie}` } : {}),
      ...(opts.headers || {}),
    },
  });

// The four user-reported paths, plus pricing/prices (the in-app bare
// call sites: GoalScreenPanel pricing, PaymentWorkflowAssurance
// prices/pricing). Each entry is [bare, api] — the forwarded pathname
// must be identical for both spellings.
const COMMERCIAL_PATHS: Array<[string, string]> = [
  ["/payments/agentic/commercial/account?userId=octocat-2787", "/api/payments/agentic/commercial/account?userId=octocat-2787"],
  ["/payments/agentic/commercial/identity", "/api/payments/agentic/commercial/identity"],
  ["/payments/agentic/commercial/plans", "/api/payments/agentic/commercial/plans"],
  ["/payments/agentic/commercial/operators", "/api/payments/agentic/commercial/operators"],
  ["/payments/agentic/commercial/pricing", "/api/payments/agentic/commercial/pricing"],
  ["/payments/agentic/commercial/prices", "/api/payments/agentic/commercial/prices"],
];

describe("commercial route spellings reach the same handler (#2787)", () => {
  for (const [bare, api] of COMMERCIAL_PATHS) {
    const stripped = bare.split("?")[0];
    it(`GET ${bare} unauthenticated → 401, not 404, nothing forwarded`, async () => {
      const { env, forwarded } = makeEnv();
      const res = await worker.fetch(req(bare), env);
      expect(res.status).toBe(401);
      expect(forwarded).toHaveLength(0);
    });

    it(`GET ${bare} with a valid session → forwarded exactly like ${api}`, async () => {
      const { env, forwarded } = makeEnv();
      const res = await worker.fetch(req(bare, { cookie: SESSION_ID }), env);
      expect(res.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].pathname).toBe(stripped);
      expect(forwarded[0].userLogin).toBe(LOGIN);

      const { env: apiEnv, forwarded: apiForwarded } = makeEnv();
      const apiRes = await worker.fetch(req(api, { cookie: SESSION_ID }), apiEnv);
      expect(apiRes.status).toBe(200);
      expect(apiForwarded).toHaveLength(1);
      expect(apiForwarded[0].pathname).toBe(forwarded[0].pathname);
      expect(apiForwarded[0].userLogin).toBe(forwarded[0].userLogin);
      expect(apiForwarded[0].search).toBe(forwarded[0].search);
    });
  }

  it("OPTIONS bare commercial preflight answers like the /api preflight", async () => {
    const { env } = makeEnv();
    const bare = await worker.fetch(
      req("/payments/agentic/commercial/plans", { method: "OPTIONS" }),
      env,
    );
    expect(bare.status).toBe(200);
    expect(bare.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const { env: apiEnv } = makeEnv();
    const api = await worker.fetch(
      req("/api/payments/agentic/commercial/plans", { method: "OPTIONS" }),
      apiEnv,
    );
    expect(api.status).toBe(200);
    expect(api.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
