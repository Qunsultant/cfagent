/**
 * #1265 HOTFIX pins — factory userinfo (profile) request headers.
 *
 * Root cause of the production break: #1254 PR-A rationalized the
 * wired GitHub login onto the generic factory, whose userinfo fetch
 * sent only `Authorization: Bearer …`. The deleted hand-rolled
 * profile fetch had also sent `Accept: application/vnd.github+json`
 * and `User-Agent: ai-search-agent` — and GitHub's API rejects any
 * request without a User-Agent (403), so every wired GitHub login
 * failed at the profile step ("Failed to fetch user profile from
 * GitHub") while the token exchange succeeded. The characterization
 * stubs accepted any profile headers, so the gap was invisible.
 *
 * These pins assert the exact headers on the wire for both factory
 * providers, and that a 403 from the profile endpoint still fails
 * closed with the login-page outcome redirect (#2402 supersedes
 * the old error page/status). The legacy
 * (wiring-off) GitHub flow also sent these headers; #1254 PR-B
 * deleted that flow, and the factory is now their only sender —
 * the GitHub pins below run on the generic /auth/callback/github
 * route, with assertions identical to the combined PR's first cut.
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

const GH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GH_PROFILE_URL = "https://api.github.com/user";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const GH_PROFILE = {
  id: 4242,
  login: "octocat",
  avatar_url: "https://avatars.example/4242",
  name: "Octo Cat",
};
const GOOGLE_PROFILE = {
  sub: "google-sub-42",
  email: "owner@example.com",
  email_verified: true,
  name: "Owner",
  picture: "https://example.com/pic",
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
    GITHUB_CLIENT_ID: "fake-github-client-id",
    GITHUB_CLIENT_SECRET: "fake-github-client-secret",
    GOOGLE_CLIENT_ID: "fake-google-client-id",
    GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    ...overrides,
  };
  return { env: env as unknown as Env, store };
}

const req = (path: string) => new Request(`https://agent.test${path}`);

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Stub global fetch for the GitHub + Google upstream calls; capture everything. */
function stubUpstreams(impl: { ghProfileStatus?: number } = {}): CapturedCall[] {
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
    if (url === GH_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "fake-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === GH_PROFILE_URL) {
      return new Response(JSON.stringify(GH_PROFILE), {
        status: impl.ghProfileStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "fake-google-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === GOOGLE_USERINFO_URL) {
      return new Response(JSON.stringify(GOOGLE_PROFILE), {
        status: 200,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("factory userinfo request headers (#1265)", () => {
  it("wired GitHub callback: profile request carries exactly Authorization + GitHub Accept + the legacy User-Agent, and login completes", async () => {
    const { env, store } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const calls = stubUpstreams();
    const state = await createState(env);
    const res = await worker.fetch(
      req(`/auth/callback/github?code=wired-code&state=${encodeURIComponent(state)}`),
      env
    );
    // Login completes as the characterization expects.
    expect(res.status).toBe(302);
    // #2402: the success outcome travels on the redirect for the
    // one-time boot confirmation.
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0][1].githubLogin).toBe("octocat");
    expect(sessions[0][1].providerSubject).toBe("4242");

    const profileCall = calls.find((c) => c.url === GH_PROFILE_URL)!;
    expect(profileCall).toBeDefined();
    // Exactly these three headers — the set GitHub's API requires
    // (a missing User-Agent is a 403 there) and the set the legacy
    // flow sent before #1254.
    expect(Object.keys(profileCall.headers).sort()).toEqual([
      "Accept",
      "Authorization",
      "User-Agent",
    ]);
    expect(profileCall.headers["Authorization"]).toBe("Bearer fake-access-token");
    expect(profileCall.headers["Accept"]).toBe("application/vnd.github+json");
    expect(profileCall.headers["User-Agent"]).toBe("ai-search-agent");
  });

  it("wired Google callback: userinfo request carries the User-Agent and the default Accept, and login completes", async () => {
    const { env, store } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
    });
    const calls = stubUpstreams();
    const state = await createState(env);
    const res = await worker.fetch(
      req(`/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`),
      env
    );
    expect(res.status).toBe(302);
    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0][1].providerIssuer).toBe("https://accounts.google.com");
    expect(sessions[0][1].providerSubject).toBe("google-sub-42");

    const userinfoCall = calls.find((c) => c.url === GOOGLE_USERINFO_URL)!;
    expect(userinfoCall).toBeDefined();
    expect(userinfoCall.headers["Authorization"]).toBe("Bearer fake-google-token");
    expect(userinfoCall.headers["User-Agent"]).toBe("ai-search-agent");
    expect(userinfoCall.headers["Accept"]).toBe("application/json");
  });

  it("wired GitHub callback: a 403 from the profile endpoint yields the login redirect with signin_failed", async () => {
    const { env } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    stubUpstreams({ ghProfileStatus: 403 });
    const state = await createState(env);
    const res = await worker.fetch(
      req(`/auth/callback/github?code=wired-code&state=${encodeURIComponent(state)}`),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });
});
