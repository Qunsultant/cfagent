/**
 * Issue #2434 (#1976 step 5c) — the Kv-backed implementation
 * shared by the token family's adapters. Both adapters (DO
 * wire-protocol and in-memory) run THIS code over their
 * backend handles, so the conformance suite proves one
 * semantics, not two copies: the E*TRADE semantics mirror
 * src/security/etradeOAuth.ts statement-for-statement (the
 * #2386 resolution seam, the #329/#1218 cache discipline,
 * the §3.2 expired-read revocation, the §3.3 renewal
 * listing), and the Public semantics mirror
 * src/security/publicOAuth.ts (token-set record, pending
 * records, the credential-reference read).
 *
 * The backend is supplied by the adapters / composition
 * root: the two bucket KvLikes, the etrade lister, a
 * per-call bucket factory (the credential-reference seam's
 * arbitrary namespaces), and the host services (environment
 * resolution + alias lookup) from tokenPorts.ts.
 *
 * The isolate token cache stays where it lives
 * (security/etradeTokenCache.ts): this implementation
 * discharges the cache invalidation obligation named in
 * tokenPorts.ts on every mutation.
 *
 * #CDO-mha7
 */
import { SESSION_LIMITS } from "../config/sessionLimits";
import type { KvLike } from "../security/kvResilience";
import {
  invalidateTokenCacheFor,
  readTokenCache,
  tokenCacheEpoch,
  tokenCacheKey,
  writeTokenCache,
} from "../security/etradeTokenCache";
import {
  etradeAccessTokenKey,
  etradeRequestTokenKey,
  publicPendingKey,
  publicTokenKey,
  type EtradeTokenCallOptions,
  type EtradeTokenPort,
  type PublicTokenPort,
  type TokenFamilyHost,
  type TokenFamilyPorts,
} from "./tokenPorts";
import type {
  ETradeTokenIdentity,
  ETradeTokenSet,
} from "../security/etradeOAuth";
import type { PublicTokenSet } from "../security/publicOAuth";

export type TokenLister = (
  prefix: string,
) => Promise<Array<{ key: string; value: string }> | null>;

export interface TokenFamilyBackend {
  etradeKv: KvLike;
  publicKv: KvLike;
  listEtrade: TokenLister;
  /** Per-call bucket composition (credential-reference reads). */
  bucketKv: (ns: string) => KvLike;
  host: TokenFamilyHost;
}

const PENDING_MAX_AGE_MS = SESSION_LIMITS.publicOAuthPendingMaxAgeMs;

/*
 * Ordered candidate keys for one token read — the #2386 seam,
 * identical to security/etradeOAuth.ts: internal-id scoped
 * first, then the alias login, then the current login, then
 * the unscoped variants in the same order.
 */
function tokenCandidateKeys(
  keyFn: (login: string, envName?: string) => string,
  userLogin: string,
  envName: string | undefined,
  identity: ETradeTokenIdentity | undefined,
  aliasLogin: string | null,
): string[] {
  const keys: string[] = [];
  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  if (identity?.internalUserId) push(keyFn(identity.internalUserId, envName));
  if (aliasLogin) push(keyFn(aliasLogin, envName));
  push(keyFn(userLogin, envName));
  if (aliasLogin) push(keyFn(aliasLogin));
  push(keyFn(userLogin));
  return keys;
}

async function readFirstParsable<T>(
  kv: KvLike,
  keys: readonly string[],
  parse: (raw: string) => T | null,
): Promise<T | null> {
  for (const key of keys) {
    const raw = await kv.get(key);
    if (!raw) continue;
    const parsed = parse(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Build the family over any backend (the adapters' shared core). */
export function createKvBackedTokenFamily(
  backend: TokenFamilyBackend,
): TokenFamilyPorts {
  const kv = backend.etradeKv;
  const host = backend.host;

  async function aliasLoginFor(
    identity: ETradeTokenIdentity | undefined,
  ): Promise<string | null> {
    if (!identity?.internalUserId) return null;
    return host.aliasLogin(identity.internalUserId);
  }

  async function resolveTokenSet(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<{ tokens: ETradeTokenSet; key: string } | null> {
    const envName = host.envName(opts?.overrideEnv);
    const aliasLogin = await aliasLoginFor(opts?.identity);
    const keys = tokenCandidateKeys(
      etradeAccessTokenKey,
      userLogin,
      envName,
      opts?.identity,
      aliasLogin,
    );
    for (const key of keys) {
      const raw = await kv.get(key);
      if (!raw) continue;
      try {
        return { tokens: JSON.parse(raw) as ETradeTokenSet, key };
      } catch {
        // Corrupt candidate: fall through to the next key.
      }
    }
    return null;
  }

  async function revokeStoredTokens(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<void> {
    const logins = Array.from(
      new Set([userLogin, userLogin.toLowerCase(), userLogin.toUpperCase()]),
    );
    const aliasLogin = await aliasLoginFor(opts?.identity);
    const extraLogins = [
      ...(opts?.identity?.internalUserId ? [opts.identity.internalUserId] : []),
      ...(aliasLogin ? [aliasLogin] : []),
    ];
    const deletes: Promise<unknown>[] = [];
    for (const login of [...logins, ...extraLogins]) {
      deletes.push(
        kv.delete(etradeAccessTokenKey(login, "PROD")),
        kv.delete(etradeAccessTokenKey(login, "TEST")),
        kv.delete(etradeRequestTokenKey(login, "PROD")),
        kv.delete(etradeRequestTokenKey(login, "TEST")),
        kv.delete(etradeAccessTokenKey(login)),
        kv.delete(etradeRequestTokenKey(login)),
      );
    }
    await Promise.all(deletes);
    invalidateTokenCacheFor(userLogin);
    for (const login of extraLogins) invalidateTokenCacheFor(login);
  }

  const etrade: EtradeTokenPort = {
    resolveTokenSet,

    async getStoredTokens(userLogin, opts) {
      const resolved = await resolveTokenSet(userLogin, opts);
      return resolved?.tokens ?? null;
    },

    async getValidTokens(userLogin, opts) {
      const envName = host.envName(opts?.overrideEnv);
      // Identity-aware reads bypass the cache (see tokenPorts.ts).
      const useCache = !opts?.identity?.internalUserId;
      const cacheKey = tokenCacheKey(envName, userLogin);
      if (useCache) {
        const cached = readTokenCache(cacheKey);
        if (cached !== undefined) return cached;
      }
      // #1218 epoch guard: capture now; the cache writes below
      // no-op if a write path invalidated while this read was
      // in flight.
      const readEpoch = useCache ? tokenCacheEpoch(cacheKey) : 0;

      const resolved = await resolveTokenSet(userLogin, opts);
      let tokens: ETradeTokenSet | null = resolved?.tokens ?? null;

      // The unscoped-environment guard: a token found only
      // under an unscoped legacy key counts only when its
      // recorded environment matches (or is absent).
      if (tokens && resolved) {
        const scopedPrefix = `etrade:token:${envName.toUpperCase()}:`;
        if (
          !resolved.key.startsWith(scopedPrefix) &&
          tokens.environment &&
          tokens.environment.toUpperCase() !== envName.toUpperCase()
        ) {
          tokens = null;
        }
      }

      if (!tokens) {
        if (useCache) writeTokenCache(cacheKey, null, readEpoch);
        return null;
      }

      // §3.2: the expired read revokes. The predicate is the
      // façade's midnight-ET rule (security/etradeOAuth.ts
      // isTokenExpiredEt), restated below rather than
      // imported — the façade imports this family, and the
      // restatement is pinned to the façade's rule by the
      // conformance suite's boundary pins (both compositions,
      // both boundary instants).
      if (isExpiredAtMidnightEt(tokens.storedAt)) {
        console.warn(`E*TRADE tokens for ${userLogin} expired at midnight ET.`);
        await revokeStoredTokens(userLogin, opts);
        if (useCache) writeTokenCache(cacheKey, null, readEpoch);
        return null;
      }

      if (useCache) writeTokenCache(cacheKey, tokens, readEpoch);
      return tokens;
    },

    async storeAccessTokens(userLogin, accessToken, accessTokenSecret, opts) {
      const envName = host.envName(opts?.overrideEnv);
      const payload: ETradeTokenSet = {
        accessToken,
        accessTokenSecret,
        storedAt: new Date().toISOString(),
        environment: envName,
        userLogin,
      };
      // #329 P3: only the environment-scoped key is written.
      await kv.put(etradeAccessTokenKey(userLogin, envName), JSON.stringify(payload), {
        expirationTtl: 86400,
      });
      // #1759: the internal-id scoped key is dual-written when
      // the caller's identity is known.
      if (opts?.identity?.internalUserId) {
        await kv.put(
          etradeAccessTokenKey(opts.identity.internalUserId, envName),
          JSON.stringify(payload),
          { expirationTtl: 86400 },
        );
      }
      invalidateTokenCacheFor(userLogin);
      if (opts?.identity?.internalUserId) {
        invalidateTokenCacheFor(opts.identity.internalUserId);
      }
    },

    async storeRequestTokenSecret(userLogin, requestToken, requestTokenSecret, opts) {
      const envName = host.envName(opts?.overrideEnv);
      const payload = {
        requestToken,
        requestTokenSecret,
        createdAt: new Date().toISOString(),
      };
      await Promise.all([
        kv.put(etradeRequestTokenKey(userLogin, envName), JSON.stringify(payload), {
          expirationTtl: 900,
        }),
        kv.put(etradeRequestTokenKey(userLogin), JSON.stringify(payload), {
          expirationTtl: 900,
        }),
      ]);
    },

    async getRequestTokenSecret(userLogin, opts) {
      const envName = host.envName(opts?.overrideEnv);
      const aliasLogin = await aliasLoginFor(opts?.identity);
      return readFirstParsable(
        kv,
        tokenCandidateKeys(
          etradeRequestTokenKey,
          userLogin,
          envName,
          opts?.identity,
          aliasLogin,
        ),
        (raw) => {
          try {
            return JSON.parse(raw) as {
              requestToken: string;
              requestTokenSecret: string;
            };
          } catch {
            return null;
          }
        },
      );
    },

    revokeStoredTokens,

    async getTokenScopePresence(userLogin, opts) {
      const none = {
        loginScoped: false,
        unscoped: false,
        internalId: false,
        aliasLogin: false,
      };
      if (!userLogin) return none;
      const envName = host.envName(opts?.overrideEnv);
      const aliasLogin = await aliasLoginFor(opts?.identity);
      const present = async (key: string): Promise<boolean> => {
        try {
          return (await kv.get(key)) !== null;
        } catch {
          return false;
        }
      };
      const [loginScoped, unscoped, internalId, aliasScoped, aliasUnscoped] =
        await Promise.all([
          present(etradeAccessTokenKey(userLogin, envName)),
          present(etradeAccessTokenKey(userLogin)),
          opts?.identity?.internalUserId
            ? present(etradeAccessTokenKey(opts.identity.internalUserId, envName))
            : Promise.resolve(false),
          aliasLogin
            ? present(etradeAccessTokenKey(aliasLogin, envName))
            : Promise.resolve(false),
          aliasLogin
            ? present(etradeAccessTokenKey(aliasLogin))
            : Promise.resolve(false),
        ]);
      return {
        loginScoped,
        unscoped,
        internalId,
        aliasLogin: aliasScoped || aliasUnscoped,
      };
    },

    async listTokenEntries(prefix) {
      return backend.listEtrade(prefix);
    },
  };

  const publicKv = backend.publicKv;
  const pub: PublicTokenPort = {
    async storeTokenSet(tokenSet: PublicTokenSet) {
      await publicKv.put(publicTokenKey(tokenSet.userLogin), JSON.stringify(tokenSet));
    },

    async getTokenSet(userLogin) {
      const raw = await publicKv.get(publicTokenKey(userLogin));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as PublicTokenSet;
        return typeof parsed?.accessToken === "string" && parsed.accessToken
          ? parsed
          : null;
      } catch {
        return null;
      }
    },

    async deleteTokenSet(userLogin) {
      await publicKv.delete(publicTokenKey(userLogin));
    },

    async storePending(pending) {
      await publicKv.put(publicPendingKey(pending.state), JSON.stringify(pending), {
        expirationTtl: Math.floor(PENDING_MAX_AGE_MS / 1000),
      });
    },

    async getPending(state) {
      const raw = await publicKv.get(publicPendingKey(state));
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    async deletePending(state) {
      await publicKv.delete(publicPendingKey(state));
    },

    async readRefRecord(ns, key) {
      return backend.bucketKv(ns).get(key);
    },
  };

  return { etrade, public: pub, legacyFallback: false };
}

/*
 * The midnight-ET expiry predicate — the same rule as
 * security/etradeOAuth.ts's isTokenExpiredEt (invalid stored
 * date reads expired; a future stored date is not yet
 * expired; >= 26h elapsed has crossed midnight regardless of
 * DST, #2742; otherwise the ET calendar days decide). It is
 * restated here because the façade module imports this
 * family (a runtime import back would be a cycle); the
 * dual-run characterization and the boundary pins in the
 * conformance suite pin the two statements of the rule to
 * the same outcomes.
 */
function isExpiredAtMidnightEt(storedAtIso: string, nowMs: number = Date.now()): boolean {
  try {
    const storedDate = new Date(storedAtIso);
    if (isNaN(storedDate.getTime())) return true;
    if (nowMs < storedDate.getTime()) return false;
    if (nowMs - storedDate.getTime() >= 26 * 3600 * 1000) return true;

    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const storedDay = fmt.format(storedDate);
    const nowDay = fmt.format(new Date(nowMs));

    return nowDay > storedDay;
  } catch {
    return true;
  }
}
