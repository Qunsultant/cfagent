/**
 * #2686 — Sign in with Apple as a login provider, like Google/GitHub.
 *
 * Covers, with mocked fetch (never a live Apple call) and runtime-generated
 * test key material only (no committed key, not even a fake one):
 * - registration: the "apple" adapter in the default registry, its issuer,
 *   endpoints, and config gating (wiring flag + enabled list);
 * - the Apple client-secret JWT (ES256, minted on demand from the .p8 key)
 *   and its expiry detector;
 * - the generic factory's ID-token profile path (Apple has no userinfo
 *   endpoint): profile from the token response's id_token, nonce bound
 *   to the login attempt's state, identity keyed on subject (never
 *   email — a private-relay address and a real address for the same
 *   subject resolve to the same internal user).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { createState } from "../src/security/session";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  getAppleClientSecretExpiry,
  mintAppleClientSecret,
} from "../src/security/appleClientSecret";
import {
  createOidcProvider,
  type OidcProviderOptions,
} from "../src/security/oidcProvider";
import {
  enabledProviders,
  getProvider,
  getProviderByIssuer,
  isProviderEnabled,
  listProviders,
  resolveLoginProvider,
} from "../src/security/providers";
import type { Env } from "../src/types";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Craft an (unsigned) ID token payload for factory tests — the factory decodes, never verifies. */
function makeIdToken(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "ES256", kid: "KEY1234567", typ: "JWT" })}.${base64UrlJson(payload)}.`;
}

function decodeJwtPart(token: string, index: number): Record<string, unknown> {
  const part = token.split(".")[index] ?? "";
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

let applePrivateKeyPem = "";
let applePublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  applePublicKey = pair.publicKey;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = base64Url(new Uint8Array(pkcs8)).replace(/-/g, "+").replace(/_/g, "/");
  const lines = b64.match(/.{1,64}/g) ?? [];
  applePrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
});

function makeEnv(): { env: Env; store: Map<string, string> } {
  const { namespace, store } = makeFakeSessionStore();
  const env: Record<string, unknown> = {
    SESSION_STORE: namespace,
    SESSION_SECRET: "test-session-secret",
    APP_BASE_URL: "https://agent.test",
    IAAA_WIRING_ENABLED: "1",
    APPLE_CLIENT_ID: "com.example.service",
    APPLE_TEAM_ID: "TEAM1234567",
    APPLE_KEY_ID: "KEY1234567",
    APPLE_PRIVATE_KEY: applePrivateKeyPem,
  };
  return { env: env as unknown as Env, store };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

function installAppleFetch(idToken: string | null, tokenStatus = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const stub = async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    captured.push({
      url,
      method: (init?.method as string) ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url === "https://appleid.apple.com/auth/token") {
      const body: Record<string, unknown> = { access_token: "fake-apple-access-token" };
      if (idToken !== null) body.id_token = idToken;
      return new Response(JSON.stringify(body), {
        status: tokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected fetch in Apple test", { status: 500 });
  };
  vi.stubGlobal("fetch", stub);
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function sessionKeys(store: Map<string, string>): string[] {
  return [...store.keys()].filter((k) => /^sessions:[0-9a-f-]{36}$/.test(k));
}

async function callbackRequest(env: Env, state: string): Promise<Request> {
  return new Request(
    `https://agent.test/auth/callback/apple?code=fake-code&state=${encodeURIComponent(state)}`
  );
}

const APPLE_SUB = "001234.abcdef1234567890abcdef1234567890.1234";

describe("apple provider registration", () => {
  it("ships registered with the Apple issuer, OIDC protocol, and display name", () => {
    expect(listProviders()).toContain("apple");
    const apple = getProvider("apple");
    expect(apple).not.toBeNull();
    expect(apple!.providerId).toBe("apple");
    expect(apple!.protocol).toBe("oidc");
    expect(apple!.issuer).toBe("https://appleid.apple.com");
    expect(apple!.displayName).toBe("Apple");
  });

  it("resolves by issuer, so /api/me and session display never guess the provider", () => {
    const found = getProviderByIssuer("https://appleid.apple.com");
    expect(found).not.toBeNull();
    expect(found!.providerId).toBe("apple");
  });

  it("is disabled when wiring is off, even if listed", () => {
    expect(
      isProviderEnabled({ IAAA_ENABLED_PROVIDERS: "github,apple" } as never, "apple")
    ).toBe(false);
    expect(
      resolveLoginProvider({ IAAA_ENABLED_PROVIDERS: "github,apple" } as never, "apple")
        .disabledReason
    ).toBe("wiring-disabled");
  });

  it("is not enabled when wiring is on but apple is not in the enabled list", () => {
    expect(
      isProviderEnabled(
        { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github" } as never,
        "apple"
      )
    ).toBe(false);
  });

  it("resolves when wiring is on and apple is listed — never falling back to another provider", () => {
    const resolved = resolveLoginProvider(
      { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github,apple" } as never,
      "apple"
    );
    expect(resolved.disabledReason).toBeNull();
    expect(resolved.provider).not.toBeNull();
    expect(resolved.provider!.providerId).toBe("apple");
  });

  it("appears in the login-page button list exactly when enabled and registered", () => {
    const env = { IAAA_WIRING_ENABLED: "1", IAAA_ENABLED_PROVIDERS: "github,apple" } as never;
    const buttons = enabledProviders(env)
      .map((id) => getProvider(id))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({ id: p.providerId, displayName: p.displayName ?? p.providerId }));
    expect(buttons).toContainEqual({ id: "apple", displayName: "Apple" });
    const dark = enabledProviders({ IAAA_ENABLED_PROVIDERS: "github,apple" } as never);
    expect(dark).toEqual([]);
  });
});

describe("apple client secret (ES256 JWT, minted on demand)", () => {
  it("mints a JWT with the Apple header and claims, verifiable with the public key", async () => {
    const nowMs = Date.UTC(2026, 10, 3, 12, 0, 0);
    const jwt = await mintAppleClientSecret({
      teamId: "TEAM1234567",
      keyId: "KEY1234567",
      privateKeyPem: applePrivateKeyPem,
      clientId: "com.example.service",
      nowMs,
      ttlSeconds: 3600,
    });
    expect(jwt.split(".")).toHaveLength(3);
    expect(decodeJwtPart(jwt, 0)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeJwtPart(jwt, 1)).toMatchObject({
      iss: "TEAM1234567",
      aud: "https://appleid.apple.com",
      sub: "com.example.service",
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600,
    });
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      applePublicKey,
      sig,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    expect(ok).toBe(true);
  });

  it("defaults to a 1-day lifetime, far below Apple's 6-month maximum", async () => {
    const nowMs = Date.UTC(2026, 10, 3, 12, 0, 0);
    const jwt = await mintAppleClientSecret({
      teamId: "TEAM1234567",
      keyId: "KEY1234567",
      privateKeyPem: applePrivateKeyPem,
      clientId: "com.example.service",
      nowMs,
    });
    const payload = decodeJwtPart(jwt, 1);
    expect((payload["exp"] as number) - (payload["iat"] as number)).toBe(86400);
  });

  it("throws on a malformed key, so the caller fails closed instead of minting garbage", async () => {
    await expect(
      mintAppleClientSecret({
        teamId: "TEAM1234567",
        keyId: "KEY1234567",
        privateKeyPem: "not a pem key",
        clientId: "com.example.service",
        nowMs: Date.now(),
      })
    ).rejects.toThrow();
  });

  it("detects ok, expiring-soon, expired, and invalid secrets", () => {
    const nowMs = Date.UTC(2026, 10, 3, 12, 0, 0);
    const at = (expSeconds: number) =>
      `${base64UrlJson({ alg: "ES256" })}.${base64UrlJson({ exp: expSeconds })}.`;
    const day = 86400;
    const nowS = Math.floor(nowMs / 1000);
    expect(getAppleClientSecretExpiry(at(nowS + 60 * day), nowMs).status).toBe("ok");
    expect(getAppleClientSecretExpiry(at(nowS + 10 * day), nowMs).status).toBe("expiring-soon");
    expect(getAppleClientSecretExpiry(at(nowS - 60), nowMs).status).toBe("expired");
    expect(getAppleClientSecretExpiry("not-a-jwt", nowMs).status).toBe("invalid");
    expect(
      getAppleClientSecretExpiry(`${base64UrlJson({ alg: "ES256" })}.${base64UrlJson({})}.`, nowMs)
        .status
    ).toBe("invalid");
  });
});

describe("apple factory ID-token flow (registered adapter)", () => {
  it("startLogin redirects to Apple with code, scope, response_mode=query, and nonce=state", async () => {
    const { env } = makeEnv();
    const apple = getProvider("apple");
    expect(apple).not.toBeNull();
    const res = await apple!.startLogin(env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("https://appleid.apple.com/auth/authorize?")).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("client_id")).toBe("com.example.service");
    expect(params.get("redirect_uri")).toBe("https://agent.test/auth/callback/apple");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("name email");
    expect(params.get("response_mode")).toBe("query");
    const state = params.get("state") ?? "";
    expect(state.split(".")).toHaveLength(3);
    expect(params.get("nonce")).toBe(state);
  });

  it("startLogin fails closed when Apple credentials are missing — never a redirect to Apple", async () => {
    const { env } = makeEnv();
    const envNoKey = { ...env, APPLE_PRIVATE_KEY: undefined } as unknown as Env;
    const apple = getProvider("apple");
    const res = await apple!.startLogin(envNoKey);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("callback exchanges the code, reads the profile from id_token (no userinfo fetch), and signs in", async () => {
    const { env, store } = makeEnv();
    const apple = getProvider("apple");
    const state = await createState(env);
    const idToken = makeIdToken({
      iss: "https://appleid.apple.com",
      aud: "com.example.service",
      sub: APPLE_SUB,
      email: "user@example.com",
      email_verified: "true",
      nonce: state,
    });
    const captured = installAppleFetch(idToken);
    const auditStore = createMemoryAuditStore();
    const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
      auditStore,
      auditTenantId: "primary",
      postLoginEnabled: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    expect(res.headers.get("Set-Cookie")).toContain("session_id=");
    expect(sessionKeys(store)).toHaveLength(1);
    // Exactly one upstream call: the token exchange. Apple has no
    // userinfo endpoint, so a second fetch would be a bug.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://appleid.apple.com/auth/token");
    expect(captured[0].body).toContain("code=fake-code");
    expect(captured[0].body).toContain("client_id=com.example.service");
    const secret = new URLSearchParams(captured[0].body).get("client_secret") ?? "";
    expect(secret.split(".")).toHaveLength(3);
    expect(decodeJwtPart(secret, 0)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    const events = await auditStore.list();
    expect(events.filter((e) => e.type === "auth.login" && e.decision === "allow")).toHaveLength(1);
  });

  it("identity is keyed on subject: a relay address and a real address for one subject are one user", async () => {
    const { env } = makeEnv();
    const apple = getProvider("apple");
    const auditStore = createMemoryAuditStore();
    const logins: string[] = [];
    for (const email of ["abc@privaterelay.appleid.com", "user@example.com"]) {
      const state = await createState(env);
      const idToken = makeIdToken({
        iss: "https://appleid.apple.com",
        aud: "com.example.service",
        sub: APPLE_SUB,
        email,
        email_verified: "true",
        nonce: state,
      });
      installAppleFetch(idToken);
      const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
        auditStore,
        auditTenantId: "primary",
        postLoginEnabled: true,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
      vi.unstubAllGlobals();
    }
    const successes = (await auditStore.list()).filter(
      (e) => e.type === "auth.login" && e.decision === "allow"
    );
    expect(successes).toHaveLength(2);
    expect(successes[0].actorPrincipalId).toBe(successes[1].actorPrincipalId);
    expect(successes[0].actorPrincipalId).not.toBe("unknown");
  });

  it("rejects a nonce mismatch with no session and no binding", async () => {
    const { env, store } = makeEnv();
    const apple = getProvider("apple");
    const state = await createState(env);
    const idToken = makeIdToken({
      iss: "https://appleid.apple.com",
      aud: "com.example.service",
      sub: APPLE_SUB,
      email: "user@example.com",
      email_verified: "true",
      nonce: "some-other-login-attempt",
    });
    installAppleFetch(idToken);
    const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
      auditStore: createMemoryAuditStore(),
      auditTenantId: "primary",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(sessionKeys(store)).toHaveLength(0);
  });

  it("fails closed when the token response carries no id_token", async () => {
    const { env, store } = makeEnv();
    const apple = getProvider("apple");
    const state = await createState(env);
    installAppleFetch(null);
    const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
      auditStore: createMemoryAuditStore(),
      auditTenantId: "primary",
    });
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionKeys(store)).toHaveLength(0);
  });

  it("fails closed on an unverified email, like the Google adapter", async () => {
    const { env, store } = makeEnv();
    const apple = getProvider("apple");
    const state = await createState(env);
    const idToken = makeIdToken({
      iss: "https://appleid.apple.com",
      aud: "com.example.service",
      sub: APPLE_SUB,
      email: "user@example.com",
      email_verified: "false",
      nonce: state,
    });
    installAppleFetch(idToken);
    const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
      auditStore: createMemoryAuditStore(),
      auditTenantId: "primary",
    });
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionKeys(store)).toHaveLength(0);
  });

  it("fails closed on a missing subject, with the MISSING_SUBJECT_ID failure audit", async () => {
    const { env, store } = makeEnv();
    const apple = getProvider("apple");
    const state = await createState(env);
    const idToken = makeIdToken({
      iss: "https://appleid.apple.com",
      aud: "com.example.service",
      email: "user@example.com",
      email_verified: "true",
      nonce: state,
    });
    installAppleFetch(idToken);
    const auditStore = createMemoryAuditStore();
    const res = await apple!.handleCallback(env, await callbackRequest(env, state), {
      auditStore,
      auditTenantId: "primary",
    });
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionKeys(store)).toHaveLength(0);
    const failures = (await auditStore.list()).filter(
      (e) => e.type === "auth.login" && e.decision === "deny"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].errorCode).toBe("MISSING_SUBJECT_ID");
  });

  it("a factory provider with nonce but no ID-token profile is misconfigured and fails closed at start", async () => {
    const misconfigured: OidcProviderOptions = {
      providerId: "badnonce",
      issuer: "https://bad.example",
      displayName: "Bad",
      authorizationEndpoint: "https://bad.example/oauth/authorize",
      tokenEndpoint: "https://bad.example/oauth/token",
      userinfoEndpoint: "https://bad.example/oauth/userinfo",
      clientIdEnv: "BAD_CLIENT_ID",
      clientSecretEnv: "BAD_CLIENT_SECRET",
      scope: "openid",
      loginKeyField: "email",
      useStateAsNonce: true,
    };
    const provider = createOidcProvider(misconfigured);
    const { env } = makeEnv();
    const res = await provider.startLogin({
      ...env,
      BAD_CLIENT_ID: "x",
      BAD_CLIENT_SECRET: "y",
    } as unknown as Env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("a clientSecretResolver supplies the exchange secret instead of a static env secret", async () => {
    const options: OidcProviderOptions = {
      providerId: "acme-jwt",
      issuer: "https://acme-jwt.example",
      displayName: "AcmeJwt",
      authorizationEndpoint: "https://acme-jwt.example/oauth/authorize",
      tokenEndpoint: "https://acme-jwt.example/oauth/token",
      userinfoEndpoint: "https://acme-jwt.example/oauth/userinfo",
      clientIdEnv: "ACME_JWT_CLIENT_ID",
      scope: "openid email profile",
      loginKeyField: "email",
      clientSecretResolver: async () =>
        mintAppleClientSecret({
          teamId: "TEAM1234567",
          keyId: "KEY1234567",
          privateKeyPem: applePrivateKeyPem,
          clientId: "com.example.service",
          nowMs: Date.now(),
        }),
    };
    const provider = createOidcProvider(options);
    const { env } = makeEnv();
    const envWithId = { ...env, ACME_JWT_CLIENT_ID: "acme-jwt-id" } as unknown as Env;
    const start = await provider.startLogin(envWithId);
    expect(start.status).toBe(302);
    expect((start.headers.get("Location") ?? "").startsWith("https://acme-jwt.example/oauth/authorize?")).toBe(true);
    const state = await createState(envWithId);
    const captured: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: unknown, init?: Record<string, unknown>) => {
        const url = String(input);
        captured.push({
          url,
          method: (init?.method as string) ?? "GET",
          body: typeof init?.body === "string" ? init.body : "",
        });
        if (url.includes("/oauth/token")) {
          return new Response(JSON.stringify({ access_token: "t" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ sub: "s1", email: "u@acme-jwt.example", email_verified: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    const res = await provider.handleCallback(
      envWithId,
      new Request(
        `https://agent.test/auth/callback/acme-jwt?code=c&state=${encodeURIComponent(state)}`
      ),
      { auditStore: createMemoryAuditStore(), auditTenantId: "primary" }
    );
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    const tokenCall = captured.find((c) => c.url.includes("/oauth/token"));
    expect(tokenCall).toBeDefined();
    const secret = new URLSearchParams(tokenCall!.body).get("client_secret") ?? "";
    expect(secret.split(".")).toHaveLength(3);
    expect(decodeJwtPart(secret, 1)).toMatchObject({ iss: "TEAM1234567" });
  });
});
