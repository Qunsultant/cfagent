/**
 * Issue #2386: E*TRADE Disconnect no-ops and Renew fails while the panel
 * still shows connected (token-key split).
 *
 * The panel label, renew, and revoke must resolve through ONE
 * identity-aware token seam: login keys + internal-id key + alias-login
 * key, fail-closed. These tests pin that seam:
 * - a token reachable only under the internal-id key is found by
 *   identity-aware reads and deleted by identity-aware revoke;
 * - a token reachable only under an alias login is found and deleted
 *   the same way;
 * - unknown/blank logins resolve to nothing and revoke deletes
 *   nothing belonging to another login;
 * - renew distinguishes missing tokens (no upstream call) from an
 *   upstream rejection (token kept);
 * - renew failure reasons map to existing catalog codes.
 *
 * Harness mirrors tests/etrade_oauth.test.ts: the SessionStore fake
 * speaks the store protocol over an in-memory map (namespaces collapse
 * in the fake, keys stay distinct strings).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getETradeAuthStatus,
  getValidTokens,
  getStoredTokens,
  storeAccessTokens,
  revokeStoredTokens,
  revokeRemoteAccessToken,
  renewETradeAccessToken,
  renewFailureDetail,
  etradeIdentityFromSession,
} from "../src/services/etradeOAuth";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import { sessionStore } from "../src/security/session";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import type { Env } from "../src/types";
import { __resetTokenCache } from "../src/security/etradeTokenCache";

describe("E*TRADE unified token resolution (#2386)", () => {
  let env: Env;
  const LOGIN = "mha786sh@gmail.com";
  const OTHER = "dhmprstw@gmail.com";
  const ALIAS = "old-login";
  const INTERNAL_ID = "v1:0123456789abcdef";

  function makeSessionStore() {
    const store = new Map<string, string>();
    const claims = new Map<string, number>();
    return {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = (await req.json()) as {
            op: string;
            key: string;
            value?: string;
            ttl?: number;
          };
          if (body.op === "get") {
            return Response.json({ value: store.get(body.key) ?? null });
          }
          if (body.op === "put") {
            store.set(body.key, body.value ?? "");
            return Response.json({ ok: true });
          }
          if (body.op === "delete") {
            store.delete(body.key);
            claims.delete(body.key);
            return Response.json({ ok: true });
          }
          if (body.op === "consume") {
            const heldUntil = claims.get(body.key);
            if (heldUntil !== undefined && heldUntil > Date.now()) {
              return Response.json({ consumed: false });
            }
            claims.set(body.key, Date.now() + (typeof body.ttl === "number" ? body.ttl * 1000 : 0));
            store.set(body.key, body.value ?? "");
            return Response.json({ consumed: true });
          }
          return Response.json({ error: "unknown op" }, { status: 400 });
        },
      }),
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_123",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      SESSION_STORE: makeSessionStore() as any,
    } as Env;
  });

  it("finds a token stored only under the internal-id key via identity-aware reads", async () => {
    // Dual-write, then remove the login-keyed copy with an identity-less
    // revoke: only the internal-id copy survives.
    await storeAccessTokens(env, LOGIN, "tok", "secret", undefined, { internalUserId: INTERNAL_ID });
    await revokeStoredTokens(env, LOGIN);
    expect(await getValidTokens(env, LOGIN)).toBeNull();

    const found = await getValidTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID });
    expect(found).not.toBeNull();
    expect(found?.accessToken).toBe("tok");
    const status = await getETradeAuthStatus(env, LOGIN, undefined, { internalUserId: INTERNAL_ID });
    expect(status.authenticated).toBe(true);
  });

  it("revoke with identity deletes the full resolved key set", async () => {
    await storeAccessTokens(env, LOGIN, "tok", "secret", undefined, { internalUserId: INTERNAL_ID });
    await revokeStoredTokens(env, LOGIN);
    expect(await getValidTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID })).not.toBeNull();

    const result = await revokeRemoteAccessToken(env, LOGIN, undefined, { internalUserId: INTERNAL_ID });
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(await getValidTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID })).toBeNull();
    expect(await getStoredTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID })).toBeNull();
  });

  it("finds and deletes a token stored only under an alias login", async () => {
    await recordLoginAlias(sessionStore(env), {
      githubLogin: ALIAS,
      internalUserId: INTERNAL_ID,
      nowMs: Date.now(),
    });
    await storeAccessTokens(env, ALIAS, "tok-alias", "secret-alias");

    expect(await getValidTokens(env, LOGIN)).toBeNull();
    const found = await getValidTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID });
    expect(found).not.toBeNull();
    expect(found?.accessToken).toBe("tok-alias");

    await revokeStoredTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID });
    expect(await getValidTokens(env, LOGIN, undefined, { internalUserId: INTERNAL_ID })).toBeNull();
  });

  it("fails closed for unknown and blank logins, and never deletes another login's tokens", async () => {
    await storeAccessTokens(env, LOGIN, "tok", "secret");
    expect((await getETradeAuthStatus(env, OTHER)).authenticated).toBe(false);
    expect(await getValidTokens(env, "")).toBeNull();
    expect(await renewETradeAccessToken(env, OTHER)).toBeNull();

    const result = await revokeRemoteAccessToken(env, OTHER, undefined, { internalUserId: "v1:does-not-exist" });
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
    expect(await getValidTokens(env, LOGIN)).not.toBeNull();
  });

  it("renew with no tokens makes no upstream call; upstream rejection keeps the token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await renewETradeAccessToken(env, OTHER)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    await storeAccessTokens(env, LOGIN, "tok", "secret");
    fetchSpy.mockResolvedValueOnce(new Response("upstream down", { status: 500 }));
    expect(await renewETradeAccessToken(env, LOGIN)).toBeNull();
    expect(await getStoredTokens(env, LOGIN)).not.toBeNull();
  });

  it("renew failure reasons map to existing catalog codes", () => {
    expect(renewFailureDetail("NO_TOKENS").code).toBe("ETRADE_AUTH_REQUIRED");
    expect(renewFailureDetail("TOKEN_EXPIRED").code).toBe("ETRADE_TOKEN_EXPIRED");
    expect(renewFailureDetail("CREDENTIALS_MISSING").code).toBe("ETRADE_CREDENTIALS_MISSING");
    // Issue #3197: the upstream-rejection reason is an outcome-catalog code now.
    expect(renewFailureDetail("UPSTREAM_REJECTED").code).toBe("FAILURE_ETRADE_OAUTH_RENEW_FAILED");
    const messages = new Set([
      renewFailureDetail("NO_TOKENS").message,
      renewFailureDetail("TOKEN_EXPIRED").message,
      renewFailureDetail("CREDENTIALS_MISSING").message,
      renewFailureDetail("UPSTREAM_REJECTED").message,
    ]);
    expect(messages.size).toBe(4);
  });

  it("broker flag resolves through the same seam (internal-id-only token)", async () => {
    // The platform resolves its login's identity from the alias
    // record, then reads through the seam — so the broker flag
    // agrees with oauth/status for the same session.
    await recordLoginAlias(sessionStore(env), {
      githubLogin: LOGIN,
      internalUserId: INTERNAL_ID,
      nowMs: Date.now(),
    });
    await storeAccessTokens(env, LOGIN, "tok", "secret", undefined, { internalUserId: INTERNAL_ID });
    await revokeStoredTokens(env, LOGIN);
    const platform = new ETradeTradingPlatform(env, undefined, LOGIN);
    expect((await platform.getStatus()).oauthAuthenticated).toBe(true);
    const other = new ETradeTradingPlatform(env, undefined, OTHER);
    expect((await other.getStatus()).oauthAuthenticated).toBe(false);
  });

  it("etradeIdentityFromSession passes session identity through and never invents one", () => {
    expect(etradeIdentityFromSession({ internalUserId: INTERNAL_ID })).toEqual({
      internalUserId: INTERNAL_ID,
    });
    expect(etradeIdentityFromSession({})).toEqual({});
    expect(etradeIdentityFromSession(null)).toEqual({});
    expect(etradeIdentityFromSession(undefined)).toEqual({});
  });
});
