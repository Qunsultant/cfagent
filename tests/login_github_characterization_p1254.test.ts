/**
 * #1254 — CHARACTERIZATION pins for the GitHub login flow.
 *
 * Written for PR-A against the pre-refactor behaviour, at the
 * route level (src/server.ts dispatch) and the registry level
 * (providers.ts); PR-A kept every pin green while GitHub moved
 * onto the factory. PR-B (this re-pin, disclosed on the PR)
 * deletes the exact /auth/login + /auth/callback branches and
 * the wiring-off legacy flow, so the pins now capture the
 * post-deletion reality:
 *
 * - the authorize redirect lives only on the generic
 *   /auth/login/github route and carries
 *   redirect_uri=/auth/callback/github (PR-A's legacy override
 *   is gone with the app registration repointed);
 * - the exact legacy paths fall through the whole auth dispatch
 *   to the static-assets handler (env.ASSETS.fetch) — they are
 *   ordinary asset paths now, in both wiring modes, and a stray
 *   callback hit creates no session and makes no upstream call;
 * - wiring OFF refuses the generic routes with the login-page
 *   outcome redirect every plugin provider gets (#2402 supersedes
 *   the bare 403 text) — no legacy fallback anywhere;
 * - the wired callback runs on /auth/callback/github: session
 *   record fields, the binding write, the login success/failure
 *   audit events, and the failure outcomes as login-page redirects
 *   (#2402 supersedes the minimal error pages byte for byte);
 * - logout is unchanged (it was never part of the deleted flow).
 *
 * Pins that still describe true behaviour are byte-identical to
 * PR-A's file. The deleted legacy-callback pins (legacy session
 * shape, JSON token exchange, styled error pages) described a
 * flow that no longer exists; the profile-header contract they
 * carried for the legacy fetch is pinned for the factory fetch
 * by tests/login_profile_headers_hotfix_p1265.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createSession, createState, verifyState } from "../src/security/session";
import { getProvider } from "../src/security/providers";
import type { Env } from "../src/types";

const GH_ID = "fake-github-client-id";
const GH_SECRET = "fake-github-client-secret";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const PROFILE_URL = "https://api.github.com/user";
const PROFILE = {
  id: 4242,
  login: "octocat",
  avatar_url: "https://avatars.example/4242",
  name: "Octo Cat",
};

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { namespace, store } = makeFakeSessionStore();
  const env: Record<string, unknown> = {
    SESSION_STORE: namespace,
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    APP_NAME: "Test Agent",
    APP_BASE_URL: "https://agent.test",
    SESSION_SECRET: "test-session-secret",
    GITHUB_CLIENT_ID: GH_ID,
    GITHUB_CLIENT_SECRET: GH_SECRET,
    // The terminal dispatch is the static-assets handler; the
    // stub makes fall-through observable (asset body per path).
    ASSETS: {
      fetch: async (r: Request) =>
        new Response(`ASSET:${new URL(r.url).pathname}`, { status: 200 }),
    },
    ...overrides,
  };
  return { env: env as unknown as Env, store };
}

const req = (path: string, headers?: Record<string, string>) =>
  new Request(`https://agent.test${path}`, headers ? { headers } : undefined);

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Stub global fetch for the two GitHub upstream calls; capture everything. */
function stubGithub(impl: {
  tokenStatus?: number;
  tokenBody?: unknown;
  tokenRawBody?: string;
  tokenContentType?: string;
  profileStatus?: number;
  profileBody?: unknown;
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: (init?.method as string) ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url === TOKEN_URL) {
      const raw =
        impl.tokenRawBody ??
        JSON.stringify(impl.tokenBody ?? { access_token: "fake-access-token" });
      return new Response(raw, {
        status: impl.tokenStatus ?? 200,
        headers: { "Content-Type": impl.tokenContentType ?? "application/json" },
      });
    }
    if (url === PROFILE_URL) {
      return new Response(JSON.stringify(impl.profileBody ?? PROFILE), {
        status: impl.profileStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected url", { status: 404 });
  });
  return calls;
}

function sessionEntries(store: Map<string, string>): [string, any][] {
  return [...store.entries()]
    .filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k))
    .map(([k, v]) => [k, JSON.parse(v)]);
}

function auditEvents(store: Map<string, string>): any[] {
  const raw = store.get("sessions:iaaa-audit:events");
  return raw ? JSON.parse(raw) : [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("github authorize redirect (characterization)", () => {
  const EXPECTED_PREFIX =
    "https://github.com/login/oauth/authorize?" +
    `client_id=${GH_ID}` +
    "&redirect_uri=https%3A%2F%2Fagent.test%2Fauth%2Fcallback%2Fgithub" +
    "&scope=read%3Auser&state=";

  it("wiring ON: /auth/login/github redirects to GitHub with the generic callback and no response_type", async () => {
    const { env } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const res = await worker.fetch(req("/auth/login/github"), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith(EXPECTED_PREFIX)).toBe(true);
    const params = new URL(location).searchParams;
    // Exactly these parameters, in this order — no response_type.
    expect([...params.keys()]).toEqual(["client_id", "redirect_uri", "scope", "state"]);
    const state = params.get("state")!;
    expect(state.split(".")).toHaveLength(3);
    expect(await verifyState(env, state)).toBe(true);
  });

  it("wiring OFF: /auth/login/github is the login-page outcome redirect, never a legacy fallback", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/login/github"), env);
    // #2402: the bare 403 text becomes the login-page outcome.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=wiring_disabled");
    const page = await worker.fetch(req("/login?auth_outcome=wiring_disabled"), env);
    expect(await page.text()).toContain("Sign-in is currently disabled");
  });

  it("registry: github is an oauth2 provider with the GitHub issuer and display name", () => {
    const github = getProvider("github");
    expect(github).not.toBeNull();
    expect(github!.providerId).toBe("github");
    expect(github!.protocol).toBe("oauth2");
    expect(github!.issuer).toBe("https://github.com");
    expect(github!.displayName).toBe("GitHub");
  });
});

describe("deleted exact legacy paths (PR-B fall-through)", () => {
  it("exact /auth/login falls through to the static-assets handler in both wiring modes", async () => {
    for (const overrides of [{}, { IAAA_WIRING_ENABLED: "1" }]) {
      const { env } = makeEnv(overrides);
      const res = await worker.fetch(req("/auth/login"), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ASSET:/auth/login");
    }
  });

  it("exact /auth/callback falls through in both wiring modes: no session, no upstream call", async () => {
    for (const overrides of [{}, { IAAA_WIRING_ENABLED: "1" }]) {
      const { env, store } = makeEnv(overrides);
      const calls = stubGithub({});
      const state = await createState(env);
      const res = await worker.fetch(
        req(`/auth/callback?code=stray-code&state=${encodeURIComponent(state)}`),
        env
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ASSET:/auth/callback");
      expect(calls).toHaveLength(0);
      expect(sessionEntries(store)).toHaveLength(0);
    }
  });
});

describe("wired callback on /auth/callback/github (characterization)", () => {
  const WIRED = { IAAA_WIRING_ENABLED: "1" };

  async function wiredCallback(env: Env, path = "/auth/callback/github", code = "wired-code") {
    const state = await createState(env);
    return worker.fetch(
      req(`${path}?code=${code}&state=${encodeURIComponent(state)}`),
      env
    );
  }

  it("success: wired session fields, binding, and a login success audit event", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({});
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    // #2402: the success outcome travels on the redirect for the
    // one-time boot confirmation.
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    expect(res.headers.get("Set-Cookie")).toContain("session_id=");

    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    const [sessionKey, session] = sessions[0];
    expect(Object.keys(session).sort()).toEqual([
      "authTimeMs",
      "createdAt",
      "firstCreatedAt",
      "githubAvatar",
      "githubLogin",
      "githubName",
      "internalUserId",
      "lastActivityMs",
      "providerIssuer",
      "providerSubject",
      "sessionVersion",
    ]);
    expect(session.githubLogin).toBe("octocat");
    expect(session.githubAvatar).toBe("https://avatars.example/4242");
    expect(session.githubName).toBe("Octo Cat");
    expect(session.providerIssuer).toBe("https://github.com");
    expect(session.providerSubject).toBe("4242");
    expect(session.sessionVersion).toBe(1);
    expect(session.authTimeMs).toBe(session.createdAt);
    expect(session.lastActivityMs).toBe(session.createdAt);
    expect(session.firstCreatedAt).toBe(session.createdAt);
    expect(typeof session.internalUserId).toBe("string");
    expect(session.internalUserId.length).toBeGreaterThan(0);

    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(true);

    // #1760: post-login work runs before the login-success audit,
    // so a fresh login now records TWO events in order: the alias
    // recording, then the login success. The pin is the pair, not
    // the login event alone — the alias event is new evidence, not
    // a duplicate login event.
    const events = auditEvents(store);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("iaaa.alias.record");
    expect(events[0].actorPrincipalId).toBe(session.internalUserId);
    expect(events[1].type).toBe("auth.login");
    expect(events[1].outcome).toBe("succeeded");
    expect(events[1].decision).toBe("allow");
    expect(events[1].tenantId).toBe("primary");
    expect(events[1].actorPrincipalId).toBe(session.internalUserId);
    expect(events[1].correlationId).toBe(sessionKey.replace("sessions:", ""));
  });

  it("wiring OFF: the generic callback route is the login-page outcome redirect with zero upstream calls", async () => {
    const { env } = makeEnv();
    const calls = stubGithub({});
    const res = await worker.fetch(req("/auth/callback/github?code=x&state=bogus"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=wiring_disabled");
    expect(calls).toHaveLength(0);
  });

  it("null profile name falls back to the login in the session", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({ profileBody: { ...PROFILE, name: null } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(sessionEntries(store)[0][1].githubName).toBe("octocat");
  });

  it("provider error parameter → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    const res = await worker.fetch(req("/auth/callback/github?error=access_denied"), env);
    // #2402: the minimal error page becomes the login-page outcome.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    const page = await worker.fetch(req("/login?auth_outcome=signin_failed"), env);
    expect(await page.text()).toContain("Sign-in failed");
  });

  it("missing code/state → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    const res = await worker.fetch(req("/auth/callback/github"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("bad state → login redirect with signin_failed, zero upstream calls", async () => {
    const { env } = makeEnv(WIRED);
    const calls = stubGithub({});
    const res = await worker.fetch(req("/auth/callback/github?code=x&state=bogus"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(calls).toHaveLength(0);
  });

  it("token endpoint HTTP failure → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ tokenStatus: 502, tokenBody: { error: "bad" } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("token 200 with an error payload → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({
      tokenBody: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      },
    });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("token 200 with no access token and no error → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ tokenBody: {} });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("profile fetch failure → login redirect with signin_failed", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ profileStatus: 500, profileBody: {} });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("profile without a stable id → login redirect, no session/binding, MISSING_SUBJECT_ID failure audit", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({
      profileBody: { login: "octocat", avatar_url: "https://avatars.example/x" },
    });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionEntries(store)).toHaveLength(0);
    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(false);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.login");
    expect(events[0].outcome).toBe("failed");
    expect(events[0].decision).toBe("deny");
    expect(events[0].errorCode).toBe("MISSING_SUBJECT_ID");
    expect(events[0].tenantId).toBe("primary");
  });

  it("profile without a login → login redirect, no session, and no audit event", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({ profileBody: { id: 99, avatar_url: "https://avatars.example/x" } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionEntries(store)).toHaveLength(0);
    expect(auditEvents(store)).toHaveLength(0);
  });
});

describe("logout (characterization)", () => {
  it("wiring OFF: clears the cookie, deletes the session, redirects home", async () => {
    const { env, store } = makeEnv();
    const sessionId = await createSession(env, {
      githubLogin: "octocat",
      githubAvatar: "https://avatars.example/4242",
      githubName: "Octo Cat",
      createdAt: Date.now(),
    });
    const res = await worker.fetch(
      req("/auth/logout", { Cookie: `session_id=${sessionId}` }),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("session_id=;");
    expect(cookie).toContain("Max-Age=0");
    expect(store.has(`sessions:${sessionId}`)).toBe(false);
  });

  it("wiring ON: a wired session's logout records an auth.logout audit event", async () => {
    const { env, store } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const sessionId = await createSession(env, {
      githubLogin: "octocat",
      githubAvatar: "https://avatars.example/4242",
      githubName: "Octo Cat",
      createdAt: Date.now(),
      internalUserId: "user-42",
      providerIssuer: "https://github.com",
      providerSubject: "4242",
    } as never);
    const res = await worker.fetch(
      req("/auth/logout", { Cookie: `session_id=${sessionId}` }),
      env
    );
    expect(res.status).toBe(302);
    expect(store.has(`sessions:${sessionId}`)).toBe(false);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.logout");
    expect(events[0].action).toBe("auth.logout");
    expect(events[0].decision).toBe("allow");
    expect(events[0].actorPrincipalId).toBe("user-42");
    expect(events[0].tenantId).toBe("primary");
  });
});
