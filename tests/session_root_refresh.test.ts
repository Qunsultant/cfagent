/**
 * Root refresh with duplicate `session_id` cookies.
 *
 * Symptom this pins: a browser can send an older `session_id` (different
 * Domain/Path) before the current one. The server must not bind auth to the
 * first value; it tries every UUID-shaped candidate and re-issues the cookie
 * that actually authenticated. A plain refresh with the same cookie must keep
 * the app shell (window.__USER__ injected), never the landing/login path.
 *
 * Auth HTML is also pinned `no-store`: a cached signed-out document replayed on
 * refresh looks like a sign-out even while the session cookie is still valid.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { MAX_SESSION_COOKIE_CANDIDATES } from "../src/security/session";

vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class MockAIChatAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("agents", () => ({ routeAgentRequest: async () => null, Agent: class MockAgent {} }));
vi.mock("agents/mcp", () => ({ McpAgent: class MockMcpAgent {} }));
vi.mock("agents/x402", () => ({ withX402: (cls: any) => cls }));

import worker from "../src/server";
import type { Env } from "../src/types";

const INDEX_HTML = "<!DOCTYPE html><html><head><title>App</title></head><body><div id=\"root\"></div></body></html>";

function makeEnv() {
  const { namespace, seed, store } = makeFakeSessionStore();
  const env = {
    SESSION_STORE: namespace,
    APP_NAME: "Test Agent",
    APP_BASE_URL: "https://agent.test",
    ASSETS: { fetch: async () => new Response(INDEX_HTML, { headers: { "Content-Type": "text/html" } }) },
    ORCHESTRATOR_AGENT: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({}) }) },
  } as unknown as Env;
  return { env, seed, store };
}

const liveSession = () => ({
  githubLogin: "owner",
  githubName: "Owner",
  githubAvatar: "",
  createdAt: Date.now(),
});

const req = (path: string, cookie: string) =>
  new Request(`https://agent.test${path}`, { headers: { Cookie: cookie } });

const seedLive = (seed: (ns: string, key: string, value: unknown) => void) => {
  const liveId = crypto.randomUUID();
  seed("sessions", liveId, liveSession());
  return liveId;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("root refresh session resolution", () => {
  it("ignores a stale duplicate and authenticates with the live cookie", async () => {
    const { env, seed } = makeEnv();
    const liveId = seedLive(seed);
    const staleId = crypto.randomUUID();

    const res = await worker.fetch(
      req("/", `session_id=${staleId}; session_id=${liveId}`),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__USER__");
    expect(body).toContain('"login":"owner"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // The response re-issues the live id, not the stale first value.
    expect(res.headers.get("Set-Cookie")).toContain(`session_id=${liveId}`);
  });

  it("keeps the app shell on a normal refresh with the same cookie", async () => {
    const { env, seed } = makeEnv();
    const id = seedLive(seed);

    for (let i = 0; i < 2; i += 1) {
      const res = await worker.fetch(req("/", `session_id=${id}`), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("window.__USER__");
    }
  });

  it("serves the landing page when no cookie matches a session", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/", `session_id=${crypto.randomUUID()}`), env);
    const body = await res.text();
    expect(body).not.toContain("window.__USER__");
    // A cached landing page must never be replayed on refresh.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the login page no-store", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/login", ""), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("tries candidates in order and stops at the first live session", async () => {
    const { env, seed } = makeEnv();
    const liveId = seedLive(seed);
    const stale = Array.from({ length: 3 }, () => crypto.randomUUID());
    const res = await worker.fetch(req("/", `session_id=${stale.join("; session_id=")}; session_id=${liveId}`), env);
    expect(await res.text()).toContain("window.__USER__");
    expect(res.headers.get("Set-Cookie")).toContain(`session_id=${liveId}`);
  });

  it("caps how many cookie candidates can reach the session store", async () => {
    const { env, seed } = makeEnv();
    const liveId = seedLive(seed);
    const stale = Array.from({ length: MAX_SESSION_COOKIE_CANDIDATES }, () => crypto.randomUUID());
    // The live id sits one past the cap: it must not be resolved.
    const res = await worker.fetch(
      req("/", `session_id=${[...stale, liveId].join("; session_id=")}`),
      env,
    );
    expect(await res.text()).not.toContain("window.__USER__");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("logout with duplicate session cookies", () => {
  it("deletes every UUID-shaped session_id candidate, not just the first", async () => {
    const { env, seed, store } = makeEnv();
    const liveId = seedLive(seed);
    const staleId = crypto.randomUUID();

    const res = await worker.fetch(
      req("/auth/logout", `session_id=${staleId}; session_id=${liveId}`),
      env,
    );
    expect(res.status).toBe(302);
    expect(store.has(`sessions:${liveId}`)).toBe(false);
    expect(store.has(`sessions:${staleId}`)).toBe(false);
  });
});
