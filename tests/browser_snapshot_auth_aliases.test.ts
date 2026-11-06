/**
 * Issue #181 (alias coverage): the session gate added for
 * POST /api/browser/snapshot and POST /api/browser/transaction-snap lives in
 * the same route blocks as their aliases —
 *   POST /browser/snapshot
 *   POST /browser/transaction-snap
 *   POST /api/browser/snap/transaction
 * — but tests/browser_snapshot_auth.test.ts pins only the canonical /api
 * spellings. A future refactor that splits an alias into its own block could
 * silently ungate it; these tests pin every spelling:
 * - unauthenticated → 401, no capture attempted, nothing forwarded;
 * - valid session → behaves exactly like the canonical route.
 *
 * Same harness as tests/browser_snapshot_auth.test.ts (real worker fetch
 * dispatch, recording ORCHESTRATOR_AGENT stub, Map-backed SESSIONS KV, mocked
 * ETradeBrowserService so captures and their Slack dispatch are counted,
 * never performed).
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

// Record browser captures without touching a real browser or Slack.
const browserCalls = vi.hoisted(() => [] as Array<{ url: string; opts: any }>);
vi.mock("../src/services/browserAgent", () => {
  return {
    ETradeBrowserService: class {
      env: any;
      constructor(env: any) {
        this.env = env;
      }
      async captureAndSendToSlack(url: string, opts: any) {
        browserCalls.push({ url, opts });
        return { success: true, mocked: true };
      }
    },
  };
});

import worker from "../src/server";
import type { Env } from "../src/types";

const LOGIN = "octocat-181";
const SESSION_ID = "0d9a1810-1c2b-4e3f-8a5b-181000000001";

interface ForwardedCall {
  id: string;
  pathname: string;
  body: any;
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

const SNAPSHOT_ALIASES = ["/browser/snapshot"];
const TX_SNAP_ALIASES = ["/browser/transaction-snap", "/api/browser/snap/transaction"];

describe("browser snapshot route aliases require a session (#181)", () => {
  for (const path of SNAPSHOT_ALIASES) {
    it(`POST ${path} unauthenticated → 401, no capture attempted`, async () => {
      browserCalls.length = 0;
      const { env } = makeEnv();
      const res = await worker.fetch(
        req(path, { method: "POST", body: { url: "https://etrade.com" } }),
        env,
      );
      expect(res.status).toBe(401);
      expect(browserCalls).toHaveLength(0);
    });

    it(`POST ${path} with a valid session → capture runs as before`, async () => {
      browserCalls.length = 0;
      const { env } = makeEnv();
      const res = await worker.fetch(
        req(path, {
          method: "POST",
          cookie: SESSION_ID,
          body: { url: "https://etrade.com", caption: "daily" },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, mocked: true });
      expect(browserCalls).toHaveLength(1);
      expect(browserCalls[0].url).toBe("https://etrade.com");
    });
  }

  for (const path of TX_SNAP_ALIASES) {
    it(`POST ${path} unauthenticated → 401, not forwarded`, async () => {
      const { env, forwarded } = makeEnv();
      const res = await worker.fetch(
        req(path, {
          method: "POST",
          body: { transaction: { symbol: "AAPL" } },
        }),
        env,
      );
      expect(res.status).toBe(401);
      expect(forwarded).toHaveLength(0);
    });

    it(`POST ${path} with a valid session → forwarded as before`, async () => {
      const { env, forwarded } = makeEnv();
      const res = await worker.fetch(
        req(path, {
          method: "POST",
          cookie: SESSION_ID,
          body: { transaction: { symbol: "AAPL" } },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].pathname).toBe("/trading/browser/transaction-snap");
    });
  }
});
