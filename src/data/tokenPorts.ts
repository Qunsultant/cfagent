/**
 * Issue #2434 (#1976 step 5c, ADR 0022 D-A.1 / D-I.5) — the
 * OAuth token family ports: E*TRADE access/request tokens
 * (bucket "etrade") and Public token sets + pending-flow
 * records (bucket "public").
 *
 * WHY ONE FAMILY, TWO NAMED PORTS: the two providers' token
 * lifecycles share ONE backend (the SessionStore DO), ONE
 * flag, and ONE composition root, but their contracts are
 * NOT interchangeable — E*TRADE's read path is the hottest,
 * most side-effectful read in the system (audit §3.2–3.3),
 * while Public's is a verify-before-store PAT/OAuth record
 * with a credential-reference seam. Q-6 therefore lands as
 * two named ports on one family aggregate — no generic
 * KvPort with an `ns` string (step-5 audit §6).
 *
 * FLAG (Q-2(b), #1169 semantics): `TOKEN_PORTS_ENABLED` —
 * "1"/"true"/"on" (trimmed, case-insensitive) = ON; absence
 * or any other value = OFF. The var is deliberately NOT in
 * wrangler.jsonc; rollback is unsetting it. Flag-off
 * composition is today's funnel composition inside
 * security/etradeOAuth.ts / security/publicOAuth.ts,
 * byte-identical; flag-on composition is the adapters in
 * this family over the SAME SessionStore DO and the SAME
 * kv_store table — the flag switches the serving code path
 * only. No data migration, no dual-write, and NO change to
 * any stored key or value shape: a token stored before this
 * slice reads identically after it, in both flag states
 * (pinned by the conformance suite's cross-composition
 * test).
 *
 * ADAPTER CONFIGURATION (declared, not incidental): both
 * production adapters declare `legacyFallback: false` —
 * KV is not part of this store at all (the #604 migration
 * window closed; auth material never moves back to KV).
 *
 * THE RESOLUTION SEAM IS CONTRACT (#2386): every E*TRADE
 * token read resolves through `resolveTokenSet`'s candidate
 * order — internal-id scoped, alias-login scoped, login
 * scoped, then the unscoped variants in the same order — and
 * a corrupt candidate is skipped for a healthy fallback,
 * never fatal. The matched key is returned alongside the
 * token because `getValidTokens`' unscoped-environment
 * guard depends on WHICH key matched.
 *
 * GETVALIDTOKENS' DECISION TREE IS CONTRACT (§3.2): the
 * isolate cache serves identity-LESS reads only (identity-
 * aware reads bypass — session-facing reads must never serve
 * a stale verdict, the #2386 snap-back); the cache write is
 * epoch-guarded (#1218: a read in flight across an
 * invalidation must not resurrect its result); an unscoped
 * hit counts only when its recorded environment matches;
 * and an expired (past midnight ET) resolved set makes the
 * read REVOKE the full set, invalidate the cache, and
 * return null — "post-midnight missing" is the designed
 * end-state of a token, produced by this read.
 *
 * REVOCATION IS AN EXPLICIT DOMAIN OPERATION (D-E.3):
 * `revokeStoredTokens` deletes, for the login, its
 * lowercase and uppercase variants, the identity's
 * internal-id keys, and the alias-login keys — each across
 * BOTH environments, scoped and unscoped, for access AND
 * request tokens (6 keys per login form). It spans
 * environments by design; the overrideEnv argument never
 * narrows the set.
 *
 * CACHE INVALIDATION OBLIGATION (port-adjacent, named):
 * the isolate token cache (security/etradeTokenCache.ts)
 * stays isolate-side and is NOT part of this port — but
 * every mutating operation here (storeAccessTokens,
 * revokeStoredTokens, and the expiry revocation inside
 * getValidTokens) MUST invalidate it for every login form
 * whose keys were written or deleted (login + internal id;
 * the cache drops all environment variants for a login).
 * A write path that skips this obligation resurrects
 * revoked tokens for the cache's positive TTL; the
 * obligation is discharged by the shared implementation
 * (tokenFamilyKvImpl.ts) and pinned by the conformance
 * suite.
 *
 * RENEWAL (§3.3): renewal READS resolve through this port
 * (renewETradeAccessToken reads via getStoredTokens and
 * re-stores via storeAccessTokens; renewAllStoredETradeTokens
 * lists via listTokenEntries, whose DO restriction —
 * etrade bucket, `etrade:token:` prefix only — is a
 * security property of the store, preserved by the adapter).
 * The TOKEN_EXPIRED window rule is the midnight-ET
 * predicate the façade exports (isTokenExpiredEt): a token
 * stored on ET day D renews at 23:59:59 ET on D and is
 * expired at 00:00:00 ET on D+1. The renewal single-flight
 * CLAIM (#1245) is not token storage: it stays in the
 * façade module in both compositions (the named ClaimPort
 * is slice 5e's, per Q-6).
 *
 * VERIFY-BEFORE-STORE (Public): `storeTokenSet`'s named
 * precondition is that the caller has verified the
 * credential against the upstream MCP server (tools/list)
 * BEFORE invoking it — a credential that cannot list tools
 * is never stored. The verifying flows are the façade's
 * completePublicOAuth / connectPublicPersonalToken
 * (security/publicOAuth.ts); the port stores only what
 * they hand it.
 *
 * TRANSACTION HONESTY (ADR D-C / §7): no operation here
 * claims atomicity it does not have. The E*TRADE dual-write
 * (login key + internal-id key) and the revocation set are
 * independent puts/deletes issued together (the incumbent
 * Promise.all shape); a partial failure surfaces as a
 * rejected promise, never a silent half-state claim.
 *
 * #CDO-mha7
 */
import type {
  ETradeTokenIdentity,
  ETradeTokenScopePresence,
  ETradeTokenSet,
} from "../security/etradeOAuth";
import type {
  PublicOAuthPending,
  PublicTokenSet,
} from "../security/publicOAuth";

export type {
  ETradeTokenIdentity,
  ETradeTokenScopePresence,
  ETradeTokenSet,
  PublicOAuthPending,
  PublicTokenSet,
};

/** The family's buckets inside the SessionStore DO. */
export const ETRADE_TOKEN_BUCKET = "etrade";
export const PUBLIC_TOKEN_BUCKET = "public";

/** Q-2(b) flag name for this family. */
export const TOKEN_PORTS_FLAG = "TOKEN_PORTS_ENABLED";

/**
 * #1169 flag semantics: "1"/"true"/"on" (trimmed,
 * case-insensitive) = ON; absence = OFF; NOT in wrangler.
 */
export function isTokenPortsEnabled(
  env?: { TOKEN_PORTS_ENABLED?: string } | null,
): boolean {
  const v = env?.TOKEN_PORTS_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/*
 * Stored-key formulas — CONTRACT, identical to the façade
 * modules' (security/etradeOAuth.ts, security/publicOAuth.ts).
 * These strings are the on-disk key shapes in the
 * SessionStore DO; they must never change (a pre-slice token
 * is reachable only under exactly these keys). The dual-run
 * characterization pins the two compositions to them.
 */
export const ETRADE_ACCESS_TOKEN_KEY_PREFIX = "etrade:token:";
export const ETRADE_REQUEST_TOKEN_KEY_PREFIX = "etrade:req_token:";
export const PUBLIC_TOKEN_KEY_PREFIX = "public:token:";
export const PUBLIC_PENDING_KEY_PREFIX = "public:oauth_pending:";

export function etradeAccessTokenKey(userLogin: string, envName?: string): string {
  return envName
    ? `etrade:token:${envName.toUpperCase()}:${userLogin}`
    : `etrade:token:${userLogin}`;
}

export function etradeRequestTokenKey(userLogin: string, envName?: string): string {
  return envName
    ? `etrade:req_token:${envName.toUpperCase()}:${userLogin}`
    : `etrade:req_token:${userLogin}`;
}

export function publicTokenKey(userLogin: string): string {
  return `public:token:${userLogin}`;
}

export function publicPendingKey(state: string): string {
  return `public:oauth_pending:${state}`;
}

/**
 * Host services the family semantics need from the composing
 * environment, injected by the composition root (production)
 * or by tests (conformance). Everything else the semantics
 * need is backend-shaped (the bucket KvLikes + the lister).
 */
export interface TokenFamilyHost {
  /**
   * The effective E*TRADE environment name ("TEST"/"PROD")
   * for an optional per-call override — production resolves
   * via config/environment's resolveEnvironmentConfig.
   */
  envName(overrideEnv?: string): string;
  /**
   * The alias login for an internal user id, best-effort:
   * any store failure yields null and resolution falls back
   * to login-only keys — an alias-store blip must never
   * break token reads (the façade's resolveAliasLogin rule).
   */
  aliasLogin(internalUserId: string): Promise<string | null>;
}

/** Per-call options every E*TRADE port operation accepts. */
export interface EtradeTokenCallOptions {
  overrideEnv?: string;
  identity?: ETradeTokenIdentity;
}

/** E*TRADE token sub-contract (bucket "etrade"). */
export interface EtradeTokenPort {
  /**
   * THE resolution seam (#2386): candidate order
   * internal-id scoped → alias scoped → login scoped →
   * unscoped variants in the same order; corrupt candidates
   * skipped. Returns the matched key with the token set.
   */
  resolveTokenSet(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<{ tokens: ETradeTokenSet; key: string } | null>;
  /** The resolved token set only (getStoredTokens' shape). */
  getStoredTokens(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<ETradeTokenSet | null>;
  /**
   * The full validity decision tree (see the header): cache
   * rules, epoch guard, unscoped-environment guard, and
   * expired → revoke-all + cache-invalidate + null.
   */
  getValidTokens(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<ETradeTokenSet | null>;
  /**
   * Store confirmed access tokens: the environment-scoped
   * login key only (#329 P3 — the unscoped legacy key is
   * read, never written), plus the internal-id scoped key
   * when the identity is known (#1759 dual-write). Discharges
   * the cache invalidation obligation for both login forms.
   */
  storeAccessTokens(
    userLogin: string,
    accessToken: string,
    accessTokenSecret: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<void>;
  /** Store the handshake request-token secret (scoped + unscoped, 15-minute TTL). */
  storeRequestTokenSecret(
    userLogin: string,
    requestToken: string,
    requestTokenSecret: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<void>;
  /** Read the handshake secret through the candidate seam. */
  getRequestTokenSecret(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<{ requestToken: string; requestTokenSecret: string } | null>;
  /**
   * THE revocation operation (D-E.3): the full enumerated
   * key set (see the header) is deleted and the cache
   * invalidated for every login form. Spans environments
   * by design.
   */
  revokeStoredTokens(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<void>;
  /**
   * Presence-only probe of the resolution scopes (#2438):
   * booleans only — never a token value, never a key string.
   * A corrupt value counts as present (presence, not
   * validity); an unreadable scope reports false.
   */
  getTokenScopePresence(
    userLogin: string,
    opts?: EtradeTokenCallOptions,
  ): Promise<ETradeTokenScopePresence>;
  /**
   * Bulk-renewal listing: the etrade bucket's list op for a
   * prefix (production callers pass "etrade:token:" — the
   * DO restricts etrade listings to that prefix). Null when
   * the listing is unavailable (fail-visible).
   */
  listTokenEntries(
    prefix: string,
  ): Promise<Array<{ key: string; value: string }> | null>;
}

/** Public token sub-contract (bucket "public"). */
export interface PublicTokenPort {
  /**
   * Store a token set under `public:token:<login>`.
   * PRECONDITION (verify-before-store): the credential has
   * been verified against the upstream MCP server
   * (tools/list) by the calling flow — see the header.
   */
  storeTokenSet(tokenSet: PublicTokenSet): Promise<void>;
  /** Parse-or-null read; a record without a usable accessToken reads null. */
  getTokenSet(userLogin: string): Promise<PublicTokenSet | null>;
  /** Delete the stored token set locally (no upstream call). */
  deleteTokenSet(userLogin: string): Promise<void>;
  /** Store a pending-flow record at its state key (pending-TTL write). */
  storePending(pending: PublicOAuthPending): Promise<void>;
  /** Parse-or-null pending read. */
  getPending(state: string): Promise<PublicOAuthPending | null>;
  /** Delete a pending-flow record. */
  deletePending(state: string): Promise<void>;
  /**
   * Read the raw record a `sessionstore:<ns>:<key>`
   * credential reference names — the referenced bucket is
   * composed per call; null on miss. The reference names
   * WHERE a token lives, never its value.
   */
  readRefRecord(ns: string, key: string): Promise<string | null>;
}

/**
 * The family aggregate returned by the composition root
 * (createTokenPorts.ts).
 */
export interface TokenFamilyPorts {
  etrade: EtradeTokenPort;
  public: PublicTokenPort;
  /** Declared adapter configuration: KV is never a fallback. */
  readonly legacyFallback: false;
}
