/**
 * #945 Google-as-plugin — generic provider routes in server.ts.
 *
 * Routes /auth/login/<providerId> and /auth/callback/<providerId>
 * dispatch through the provider registry. Since #1254 PR-B they
 * are the ONLY login routes: the exact /auth/login + /auth/callback
 * GitHub branches are deleted (pinned below as static-assets
 * fall-through), and the /login page behaviour is asserted
 * unchanged. Uses the worker-fetch harness pattern from
 * tests/api_chat_auth.test.ts (mocked agent SDK entry points,
 * fake session namespace, mocked fetch for provider HTTP calls —
 * never a live provider).
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
import { createState } from "../src/security/session";
import type { Env } from "../src/types";

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
    ...overrides,
  };
  return { env: env as unknown as Env, store };
}

const req = (path: string) => new Request(`https://agent.test${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generic provider login routes", () => {
  it("wiring off → /auth/login/google redirects to the login page with wiring_disabled, never a fallback to github", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/login/google"), env);
    // #2402: the bare 403 text becomes the login-page outcome.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=wiring_disabled");
    const page = await worker.fetch(req("/login?auth_outcome=wiring_disabled"), env);
    expect(await page.text()).toContain("Sign-in is currently disabled");
  });

  it("wiring on but google not listed → login redirect with provider_unavailable", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/login?auth_outcome=provider_unavailable"
    );
    const page = await worker.fetch(
      req("/login?auth_outcome=provider_unavailable"),
      env
    );
    expect(await page.text()).toContain("not available");
  });

  it("an unknown provider id → login redirect, never a fallback", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,unknown-provider",
    });
    const res = await worker.fetch(req("/auth/login/unknown-provider"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/login?auth_outcome=provider_unavailable"
    );
  });

  it("google listed but no client id → login redirect, never a provider redirect", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("google listed with a client id → 302 to Google with the provider callback uri", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("client_id")).toBe("fake-google-client-id");
    expect(params.get("redirect_uri")).toBe("https://agent.test/auth/callback/google");
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("state")).toBeTruthy();
  });

  it("the deleted exact /auth/login and /auth/callback paths fall through to static assets (#1254 PR-B)", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GITHUB_CLIENT_ID: "fake-github-client-id",
      ASSETS: {
        fetch: async (r: Request) =>
          new Response(`ASSET:${new URL(r.url).pathname}`, { status: 200 }),
      },
    });
    const login = await worker.fetch(req("/auth/login"), env);
    expect(login.status).toBe(200);
    expect(await login.text()).toBe("ASSET:/auth/login");
    const callback = await worker.fetch(req("/auth/callback"), env);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toBe("ASSET:/auth/callback");
  });

  it("/auth/callback/google rejects a bad state with a login redirect before any upstream call", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    const res = await worker.fetch(req("/auth/callback/google?code=x&state=bogus"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("/auth/callback/google completes the full flow with a valid state + mocked provider", async () => {
    const { env, store } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    vi.stubGlobal(
      "fetch",
      async (input: unknown) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-google-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            sub: "google-sub-42",
            email: "owner@example.com",
            email_verified: true,
            name: "Owner",
            picture: "https://example.com/pic",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    const state = await createState(env);
    const res = await worker.fetch(
      req(`/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`),
      env
    );
    expect(res.status).toBe(302);
    // #2402: the success outcome travels on the redirect for the
    // one-time boot confirmation.
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    const sessionKey = [...store.keys()].find((k) => /^sessions:[0-9a-f-]{36}$/.test(k));
    expect(sessionKey).toBeDefined();
    const session = JSON.parse(store.get(sessionKey!)!);
    expect(session.githubLogin).toBe("owner@example.com");
    expect(session.providerIssuer).toBe("https://accounts.google.com");
    expect(session.providerSubject).toBe("google-sub-42");
    expect(session.internalUserId).toBeTruthy();
  });
});

describe("composable /login page", () => {
  it("wiring off → exactly the current GitHub-only page (no google button)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("/auth/login/google");
  });

  it("wiring off → no-arg page renders the focused GitHub login button and subtitle", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/login"), env);
    const html = await res.text();
    expect(html).toContain(
      '<p class="subtitle">Sign in with your GitHub account to access your trading workspace.</p>'
    );
    // The GitHub provider is an icon-only link (#3363)
    expect(html).toContain(
      '<a href="/auth/login" class="btn btn-github provider-icon" aria-label="Sign in with GitHub"'
    );
    expect(html).not.toContain("<span>Sign in with GitHub</span>");
    expect(html).not.toContain("btn-arrow");
  });

  it("wiring on with google enabled → one button per enabled provider", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
    });
    const res = await worker.fetch(req("/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/auth/login/github");
    expect(html).toContain("/auth/login/google");
    expect(html).toContain("Sign in with Google");
  });

  it("wiring on with github only → no google button", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github",
    });
    const res = await worker.fetch(req("/login"), env);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("/auth/login/google");
  });
});

describe("sign-in outcome channel (#2402)", () => {
  const INDEX_HTML =
    '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div></body></html>';

  function makeOutcomeEnv() {
    const { env, store } = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response(INDEX_HTML, { headers: { "Content-Type": "text/html" } }),
      },
    });
    return { env, store };
  }

  it("a just-created but unreadable session redirects to the session_unreadable notice, never the silent loop", async () => {
    // The callback sets the signed_in outcome on its redirect; when /
    // cannot read the session back (the #2280 loop, including quota
    // exhaustion, where reads collapse to null), the user gets the
    // message on the login page instead of another silent redirect.
    // This decision is pure URL logic — no SessionStore read — so it
    // renders even when the store is unavailable.
    const { env } = makeOutcomeEnv();
    const res = await worker.fetch(req("/?auth_outcome=signed_in"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/login?auth_outcome=session_unreadable"
    );
    const page = await worker.fetch(
      req("/login?auth_outcome=session_unreadable"),
      env
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("could not be verified");
  });

  it("a live session with the success outcome boots with the outcome marker", async () => {
    const { env, store } = makeOutcomeEnv();
    const id = crypto.randomUUID();
    store.set(
      `sessions:${id}`,
      JSON.stringify({
        githubLogin: "owner",
        githubName: "Owner",
        githubAvatar: "",
        createdAt: Date.now(),
      })
    );
    const authed = new Request("https://agent.test/?auth_outcome=signed_in", {
      headers: { Cookie: `session_id=${id}` },
    });
    const res = await worker.fetch(authed, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__USER__");
    expect(body).toContain('window.__AUTH_OUTCOME__="signed_in"');
  });

  it("a plain boot with a live session carries no outcome marker", async () => {
    const { env, store } = makeOutcomeEnv();
    const id = crypto.randomUUID();
    store.set(
      `sessions:${id}`,
      JSON.stringify({
        githubLogin: "owner",
        githubName: "Owner",
        githubAvatar: "",
        createdAt: Date.now(),
      })
    );
    const authed = new Request("https://agent.test/", {
      headers: { Cookie: `session_id=${id}` },
    });
    const res = await worker.fetch(authed, env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("__AUTH_OUTCOME__");
  });

  it("an unknown outcome code on /login renders no notice and never invents one", async () => {
    const { env } = makeOutcomeEnv();
    const res = await worker.fetch(req("/login?auth_outcome=bogus"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('class="notice"');
  });
});
