/**
 * Issue #3113 (#945 Q5) — CSRF gate enforced at the worker boundary.
 * TDD Red-first: the gate is not wired into handleFetch yet.
 *
 * A cookie-authenticated mutation without a valid CSRF token must be
 * rejected with 403 + csrf_invalid before any route work happens.
 * The positive control proves a matching token passes the gate (the
 * request then fails the PDP deny, a different message — the gate is
 * not what stopped it). Each case uses a distinct session id: the
 * worker caches sessions in-isolate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

const NOW = () => Date.now();
const HOUR = 60 * 60 * 1000;

function makeEnv() {
  const { namespace, seed } = makeFakeSessionStore();
  const env: any = {
    SESSION_STORE: namespace,
    IAAA_WIRING_ENABLED: "1",
  };
  return { env: env as Env, seed };
}

function seedWired(
  seed: ReturnType<typeof makeFakeSessionStore>["seed"],
  id: string,
  login: string,
  internalUserId: string,
) {
  const now = NOW();
  seed("sessions", id, {
    githubLogin: login,
    githubAvatar: "",
    githubName: login,
    createdAt: now - HOUR,
    firstCreatedAt: now - HOUR,
    internalUserId,
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: now - 60_000,
    lastActivityMs: now - 60_000,
    sessionVersion: 1,
  });
}

const req = (
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    csrf?: string;
    csrfHeader?: string;
    bearer?: string;
    body?: unknown;
  } = {},
) => {
  const cookies: string[] = [];
  if (opts.cookie) cookies.push(`session_id=${opts.cookie}`);
  if (opts.csrf) cookies.push(`csrf_token=${opts.csrf}`);
  return new Request(`https://agent.test${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
      ...(opts.csrfHeader ? { "X-CSRF-Token": opts.csrfHeader } : {}),
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
};

const CSRF = /csrf_invalid/;

describe("csrf gate at routes (#3113, #945 Q5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST role-grants/grant with session cookie and no token → 403 csrf_invalid", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3113-1c2b-4e3f-8a5b-311300000001", "octocat-csrf", "user-csrf");
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        cookie: "0d9a3113-1c2b-4e3f-8a5b-311300000001",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(CSRF);
  });

  it("POST role-grants/grant with mismatched token → 403 csrf_invalid", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3113-1c2b-4e3f-8a5b-311300000002", "octocat-csrf2", "user-csrf2");
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        cookie: "0d9a3113-1c2b-4e3f-8a5b-311300000002",
        csrf: "token-a",
        csrfHeader: "token-b",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(CSRF);
  });

  it("positive control: matching token passes the gate (then fails the PDP deny, a different message)", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3113-1c2b-4e3f-8a5b-311300000003", "octocat-fresh", "user-fresh");
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        cookie: "0d9a3113-1c2b-4e3f-8a5b-311300000003",
        csrf: "token-a",
        csrfHeader: "token-a",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).toMatch(/grant denied/);
    expect(text).not.toMatch(CSRF);
  });

  it("GET with session cookie and no token is not csrf-rejected", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3113-1c2b-4e3f-8a5b-311300000004", "octocat-get", "user-get");
    const res = await worker.fetch(
      req("/api/iaaa/logged-in-users", {
        cookie: "0d9a3113-1c2b-4e3f-8a5b-311300000004",
      }),
      env,
    );
    expect(await res.text()).not.toMatch(CSRF);
  });

  it("POST with Bearer token and no session cookie is not csrf-rejected", async () => {
    const { env, seed } = makeEnv();
    const res = await worker.fetch(
      req("/api/iaaa/role-grants/grant", {
        method: "POST",
        bearer: "some-api-key",
        body: { internalUserId: "target-1", role: "platform-admin" },
      }),
      env,
    );
    expect(await res.text()).not.toMatch(CSRF);
  });

  it("POST /auth/login with session cookie and no token passes the gate (exempt path)", async () => {
    const { env, seed } = makeEnv();
    seedWired(seed, "0d9a3113-1c2b-4e3f-8a5b-311300000005", "octocat-login", "user-login");
    const res = await worker.fetch(
      req("/auth/login", {
        method: "POST",
        cookie: "0d9a3113-1c2b-4e3f-8a5b-311300000005",
        body: {},
      }),
      env,
    );
    // The gate passes this request (no 403 csrf_invalid); routing then
    // falls through to static-asset serving, which 500s in this harness
    // because the fake env carries no ASSETS binding. The 500 is the
    // harness artifact — the gate-pass, not the 500, is the assertion.
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toMatch(CSRF);
  });
});
