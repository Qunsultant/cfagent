/**
 * #3015 — signed-out deep links must return to the bookmarked page
 * after sign-in.
 *
 * A signed-out visit to a bookmarked in-app URL (path + query, e.g.
 * ?tab=products) preserves that URL as the return target through the
 * sign-in flow, and after a successful sign-in through any provider
 * (GitHub, Google, Apple) the user lands on exactly that URL — not
 * the default page. The target travels in the SIGNED OAuth state
 * (never a raw query parameter trusted at callback), survives a
 * provider switch mid-flow (the /login page carries it into every
 * provider button), and is validated at every use: same-origin +
 * in-app route only, auth routes never valid targets, external or
 * tampered targets refused to the default landing — never an open
 * redirect. A direct /login visit with no target keeps today's
 * default landing, unchanged.
 *
 * TDD Red: this file is written before the implementation. The
 * modules it imports (src/security/returnTarget.ts, the state
 * helpers in src/security/session.ts, the isDefaultLandingUrl
 * helper in src/client/authOutcome.ts) do not exist yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  createState,
  verifyState,
  createStateWithReturnTarget,
  extractStateReturnTarget,
} from "../src/security/session";
import {
  validateReturnTarget,
  buildPostLoginRedirect,
} from "../src/security/returnTarget";
import { isDefaultLandingUrl, bootReturnTarget } from "../src/client/authOutcome";
import { renderLoginPage } from "../src/oauth";
import { renderLandingPage } from "../src/client/landing";
import {
  createOidcProvider,
  type OidcProviderOptions,
} from "../src/security/oidcProvider";
import type { Env } from "../src/types";

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  const { namespace } = makeFakeSessionStore();
  const env: Record<string, unknown> = {
    SESSION_STORE: namespace,
    SESSION_SECRET: "fake-test-secret-for-3015",
    APP_BASE_URL: "https://agent.test",
    IAAA_WIRING_ENABLED: "1",
    ACME_CLIENT_ID: "fake-acme-client-id",
    ACME_CLIENT_SECRET: "fake-acme-client-secret",
    ...overrides,
  };
  return env as unknown as Env;
}

const ACME_OPTIONS: OidcProviderOptions = {
  providerId: "acme",
  issuer: "https://acme.example",
  displayName: "Acme",
  authorizationEndpoint: "https://acme.example/oauth/authorize",
  tokenEndpoint: "https://acme.example/oauth/token",
  userinfoEndpoint: "https://acme.example/oauth/userinfo",
  clientIdEnv: "ACME_CLIENT_ID",
  clientSecretEnv: "ACME_CLIENT_SECRET",
  scope: "openid email profile",
  subjectField: "sub",
  loginKeyField: "email",
  requireEmailVerified: true,
};

const APPLE_LIKE_OPTIONS: OidcProviderOptions = {
  providerId: "applelike",
  issuer: "https://apple.example",
  displayName: "AppleLike",
  authorizationEndpoint: "https://apple.example/auth/authorize",
  tokenEndpoint: "https://apple.example/auth/token",
  clientIdEnv: "APPLELIKE_CLIENT_ID",
  clientSecretEnv: "APPLELIKE_CLIENT_SECRET",
  scope: "name email",
  subjectField: "sub",
  loginKeyField: "email",
  requireEmailVerified: true,
  profileFromIdToken: true,
  useStateAsNonce: true,
  extraAuthorizeParams: { response_mode: "query" },
};

describe("validateReturnTarget", () => {
  it.each([
    ["/?tab=products", "/?tab=products"],
    ["/?tab=chat", "/?tab=chat"],
    ["/", "/"],
    ["/some/path?x=1&y=2#frag", "/some/path?x=1&y=2#frag"],
    ["?tab=chat", "/?tab=chat"],
    ["/path#section", "/path#section"],
    ["/?tab=products&auth_outcome=signed_in", "/?tab=products"],
  ])("accepts and normalizes %p to %p", (raw, expected) => {
    expect(validateReturnTarget(raw)).toBe(expected);
  });

  it.each([
    "https://evil.com/x",
    "http://agent.openaimp.com/x",
    "//evil.com/x",
    "/login",
    "/login/",
    "/login?auth_outcome=signed_in",
    "/auth/login/github",
    "/auth/callback/github",
    "/auth/logout",
    "/auth/etrade/start",
    "javascript:alert(1)",
    "data:text/html,hi",
    "/\\evil.com",
    "/foo\r\n/bar",
    "",
    "   ",
    "x".repeat(2049),
    null,
    undefined,
    42,
  ])("refuses %p to null", (raw) => {
    expect(validateReturnTarget(raw)).toBeNull();
  });
});

describe("buildPostLoginRedirect", () => {
  it("appends the signed_in outcome to the validated target", () => {
    expect(buildPostLoginRedirect("/?tab=products")).toBe(
      "/?tab=products&auth_outcome=signed_in"
    );
  });

  it("keeps the hash after the query on a target with a fragment", () => {
    expect(buildPostLoginRedirect("/?tab=chat#msg-1")).toBe(
      "/?tab=chat&auth_outcome=signed_in#msg-1"
    );
  });

  it("falls back to the default landing for a missing or invalid target", () => {
    expect(buildPostLoginRedirect(null)).toBe("/?auth_outcome=signed_in");
    expect(buildPostLoginRedirect(undefined)).toBe("/?auth_outcome=signed_in");
    expect(buildPostLoginRedirect("https://evil.com/x")).toBe(
      "/?auth_outcome=signed_in"
    );
    expect(buildPostLoginRedirect("/login")).toBe("/?auth_outcome=signed_in");
  });

  it("replaces a stale outcome parameter instead of duplicating it", () => {
    expect(buildPostLoginRedirect("/?tab=x&auth_outcome=signin_failed")).toBe(
      "/?tab=x&auth_outcome=signed_in"
    );
  });
});

describe("signed state carrying a return target", () => {
  it("seals a valid target into a 4-part state that verifies and extracts", async () => {
    const env = makeEnv();
    const state = await createStateWithReturnTarget(env, "/?tab=products");
    expect(state).not.toBeNull();
    expect(state!.split(".")).toHaveLength(4);
    expect(await verifyState(env, state!)).toBe(true);
    expect(await extractStateReturnTarget(env, state!)).toBe("/?tab=products");
  });

  it("returns null for an invalid target so the caller falls back to a plain state", async () => {
    const env = makeEnv();
    expect(await createStateWithReturnTarget(env, "https://evil.com/x")).toBeNull();
    expect(await createStateWithReturnTarget(env, "/login")).toBeNull();
  });

  it("keeps plain 3-part states verifying with no extracted target (backward compat)", async () => {
    const env = makeEnv();
    const state = await createState(env);
    expect(state.split(".")).toHaveLength(3);
    expect(await verifyState(env, state)).toBe(true);
    expect(await extractStateReturnTarget(env, state)).toBeNull();
  });

  it("rejects a state whose target segment was tampered with", async () => {
    const env = makeEnv();
    const state = (await createStateWithReturnTarget(env, "/?tab=products"))!;
    const parts = state.split(".");
    parts[2] = b64url("/?tab=other");
    const tampered = parts.join(".");
    expect(await verifyState(env, tampered)).toBe(false);
    expect(await extractStateReturnTarget(env, tampered)).toBeNull();
  });

  it("rejects a state whose signature was tampered with", async () => {
    const env = makeEnv();
    const state = (await createStateWithReturnTarget(env, "/?tab=products"))!;
    const tampered = `${state.slice(0, -2)}xx`;
    expect(await verifyState(env, tampered)).toBe(false);
    expect(await extractStateReturnTarget(env, tampered)).toBeNull();
  });

  it("rejects an expired target-carrying state", async () => {
    const env = makeEnv();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 700000);
    const state = (await createStateWithReturnTarget(env, "/?tab=products"))!;
    nowSpy.mockRestore();
    expect(await verifyState(env, state)).toBe(false);
    expect(await extractStateReturnTarget(env, state)).toBeNull();
  });
});

describe("factory startLogin with a return target", () => {
  it("seals the target into the authorize URL state, and drops an invalid target", async () => {
    const provider = createOidcProvider(ACME_OPTIONS);
    const env = makeEnv();
    const res = await provider.startLogin(env, "/?tab=products");
    expect(res.status).toBe(302);
    const params = new URL(res.headers.get("Location") ?? "").searchParams;
    const state = params.get("state") ?? "";
    expect(state.split(".")).toHaveLength(4);
    expect(await extractStateReturnTarget(env, state)).toBe("/?tab=products");

    const dropped = await provider.startLogin(env, "https://evil.com/x");
    const droppedState =
      new URL(dropped.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    expect(droppedState.split(".")).toHaveLength(3);
  });

  it("keeps the no-target startLogin shape exactly (3-part state)", async () => {
    const provider = createOidcProvider(ACME_OPTIONS);
    const res = await provider.startLogin(makeEnv());
    const state =
      new URL(res.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    expect(state.split(".")).toHaveLength(3);
  });

  it("Apple-like provider: nonce is the full target-carrying state, query mode preserved", async () => {
    const provider = createOidcProvider(APPLE_LIKE_OPTIONS);
    const env = makeEnv({
      APPLELIKE_CLIENT_ID: "fake-applelike-id",
      APPLELIKE_CLIENT_SECRET: "fake-applelike-secret",
    });
    const res = await provider.startLogin(env, "/?tab=chat");
    const params = new URL(res.headers.get("Location") ?? "").searchParams;
    expect(params.get("response_mode")).toBe("query");
    const state = params.get("state") ?? "";
    expect(params.get("nonce")).toBe(state);
    expect(state.split(".")).toHaveLength(4);
    expect(await extractStateReturnTarget(env, state)).toBe("/?tab=chat");
  });
});

describe("factory handleCallback with a target-carrying state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects to the bookmarked URL with the outcome, not the default landing", async () => {
    const env = makeEnv();
    const stub = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "fake-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sub: "acme-sub-1",
          email: "user@acme.example",
          email_verified: true,
          name: "Acme User",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    vi.stubGlobal("fetch", stub);
    const auditStore = createMemoryAuditStore();
    const provider = createOidcProvider(ACME_OPTIONS);
    const state = (await createStateWithReturnTarget(env, "/?tab=products"))!;
    const req = new Request(
      `https://agent.test/auth/callback/acme?code=fake-code&state=${encodeURIComponent(state)}`
    );
    const res = await provider.handleCallback(env, req, {
      auditStore,
      auditTenantId: "primary",
      postLoginEnabled: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/?tab=products&auth_outcome=signed_in"
    );
    expect(res.headers.get("Set-Cookie")).toContain("session_id=");
  });
});

describe("renderLoginPage with a return target", () => {
  const providers = [
    { id: "github", displayName: "GitHub" },
    { id: "google", displayName: "Google" },
  ];

  it("embeds the validated target in every provider button (provider switch survives)", () => {
    const html = renderLoginPage(
      { APP_NAME: "Test App" } as never,
      providers,
      null,
      "/?tab=products"
    );
    expect(html).toContain("/auth/login/github?target=%2F%3Ftab%3Dproducts");
    expect(html).toContain("/auth/login/google?target=%2F%3Ftab%3Dproducts");
  });

  it("renders plain buttons without a target (unchanged)", () => {
    const html = renderLoginPage(
      { APP_NAME: "Test App" } as never,
      providers,
      null
    );
    expect(html).toContain('href="/auth/login/github"');
    expect(html).toContain('href="/auth/login/google"');
    expect(html).not.toContain("target=");
  });

  it("drops an invalid target instead of embedding it", () => {
    const html = renderLoginPage(
      { APP_NAME: "Test App" } as never,
      providers,
      null,
      "https://evil.com/x"
    );
    expect(html).toContain('href="/auth/login/github"');
    expect(html).not.toContain("evil.com");
  });
});

describe("renderLandingPage with a return target", () => {
  it("carries the target on every sign-in link", () => {
    const html = renderLandingPage("Test App", undefined, "/?tab=products");
    expect(html).toContain('/login?target=%2F%3Ftab%3Dproducts');
    expect(html).not.toContain('href="/login"');
  });

  it("leaves the page byte-identical without a target", () => {
    const plain = renderLandingPage("Test App");
    const noTarget = renderLandingPage("Test App", undefined, undefined);
    expect(noTarget).toBe(plain);
    expect(plain).toContain('href="/login"');
  });

  it("drops an invalid target instead of embedding it", () => {
    const html = renderLandingPage("Test App", undefined, "https://evil.com/x");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("evil.com");
  });
});

describe("bootReturnTarget", () => {
  it("carries path + query + hash, strips the outcome, refuses protocol-relative paths", () => {
    expect(bootReturnTarget("/", "?tab=products", "")).toBe("/?tab=products");
    expect(bootReturnTarget("/", "?tab=chat", "#msg-1")).toBe("/?tab=chat#msg-1");
    expect(bootReturnTarget("/", "", "")).toBe("/");
    expect(bootReturnTarget("/", "?auth_outcome=signed_in", "")).toBe("/");
    expect(bootReturnTarget("//evil.com", "", "")).toBe("");
    expect(bootReturnTarget("", "", "")).toBe("");
  });
});

describe("isDefaultLandingUrl", () => {
  it("is true only for the bare default landing", () => {
    expect(isDefaultLandingUrl("/")).toBe(true);
    expect(isDefaultLandingUrl("https://agent.test/")).toBe(true);
    expect(isDefaultLandingUrl("/?tab=products")).toBe(false);
    expect(isDefaultLandingUrl("https://agent.test/?tab=chat")).toBe(false);
    expect(isDefaultLandingUrl("/#frag")).toBe(false);
    expect(isDefaultLandingUrl("")).toBe(false);
  });
});

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

// eslint-disable-next-line import/first
import worker from "../src/server";

describe("return-target routes end to end", () => {
  function routeEnv(overrides: Record<string, unknown> = {}) {
    const { namespace } = makeFakeSessionStore();
    const env: Record<string, unknown> = {
      SESSION_STORE: namespace,
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      },
      APP_NAME: "Test Agent",
      APP_BASE_URL: "https://agent.test",
      SESSION_SECRET: "fake-test-secret-for-3015",
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      ...overrides,
    };
    return env as unknown as Env;
  }

  const req = (path: string) => new Request(`https://agent.test${path}`);

  it("GET /login?target= carries the target into every provider button", async () => {
    const res = await worker.fetch(
      req("/login?target=%2F%3Ftab%3Dproducts"),
      routeEnv()
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/auth/login/github?target=%2F%3Ftab%3Dproducts");
    expect(html).toContain("/auth/login/google?target=%2F%3Ftab%3Dproducts");
  });

  it("GET /login with a refused target renders plain buttons", async () => {
    const res = await worker.fetch(
      req("/login?target=https%3A%2F%2Fevil.com%2Fx"),
      routeEnv()
    );
    const html = await res.text();
    expect(html).toContain('href="/auth/login/github"');
    expect(html).not.toContain("evil.com");
  });

  it("GET /auth/login/github?target= seals the target into signed state", async () => {
    const env = routeEnv();
    const res = await worker.fetch(
      req("/auth/login/github?target=%2F%3Ftab%3Dproducts"),
      env
    );
    expect(res.status).toBe(302);
    const state =
      new URL(res.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    expect(state.split(".")).toHaveLength(4);
    expect(await extractStateReturnTarget(env, state)).toBe("/?tab=products");
  });

  it("signed-out GET /?tab=products serves landing links carrying the target", async () => {
    const res = await worker.fetch(req("/?tab=products"), routeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/login?target=%2F%3Ftab%3Dproducts');
  });

  it("session-unreadable redirect preserves a deep link, plain visits stay identical", async () => {
    const deep = await worker.fetch(
      req("/?tab=products&auth_outcome=signed_in"),
      routeEnv()
    );
    expect(deep.status).toBe(302);
    expect(deep.headers.get("Location")).toBe(
      "/login?auth_outcome=session_unreadable&target=%2F%3Ftab%3Dproducts"
    );
    const plain = await worker.fetch(req("/?auth_outcome=signed_in"), routeEnv());
    expect(plain.status).toBe(302);
    expect(plain.headers.get("Location")).toBe(
      "/login?auth_outcome=session_unreadable"
    );
  });
});
