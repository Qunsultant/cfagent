/**
 * In-isolate cache in front of the E*TRADE token-store read (issue #329
 * follow-up).
 *
 * Why this exists: `getValidTokens` runs from every auth-header builder, i.e.
 * once per E*TRADE request, and pays a store `get()` (two when the legacy
 * unscoped key is the one holding the token). A single options scan over 25
 * underlyings paid that dozens of times. Sessions already had this treatment
 * (`security/sessionCache.ts`); tokens did not, even though they change far
 * less often — an access token lives until midnight US Eastern, not until the
 * next minute.
 *
 * Properties that matter for review:
 * - Per-isolate and best-effort; a cold isolate simply misses.
 * - Invalidated on every write path (`storeAccessTokens`, `revokeStoredTokens`),
 *   so a renewed or revoked token is never served stale from here.
 * - Misses are cached briefly, so an unauthenticated caller cannot turn every
 *   E*TRADE attempt into a token-store read — but a token that appears moments later is
 *   not pinned for long.
 */
export interface CachedTokenSet {
  accessToken: string;
  accessTokenSecret: string;
  storedAt: string;
  environment: string;
  userLogin: string;
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  tokens: CachedTokenSet | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Tokens are namespaced per tenant + environment (#4618): tenants and TEST/PROD never share an entry. */
export function tokenCacheKey(
  envName: string,
  userLogin: string,
  tenantId: string = "default",
): string {
  const normalizedTenant = tenantId.trim() || "default";
  return `${normalizedTenant}:${envName.toUpperCase()}:${userLogin.toLowerCase()}`;
}

/** `undefined` means "not cached"; `null` means "cached: no tokens". */
export function readTokenCache(key: string): CachedTokenSet | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.tokens;
}

/**
 * Per-login invalidation epochs (issue #1218). A reader whose store
 * read is in flight across a concurrent invalidation (connect / renew /
 * revoke all invalidate after writing) must not repopulate the cache
 * with its stale result when it lands — that resurrects a null for the
 * negative TTL or, worse, revoked tokens for the positive TTL. Readers
 * capture tokenCacheEpoch(key) when their read begins and pass it to
 * writeTokenCache; a moved epoch drops the write.
 */
const loginEpochs = new Map<string, number>();

function epochScopeOfKey(key: string): string {
  const parts = key.split(":");
  if (parts.length >= 3) {
    const tenant = parts[0] || "default";
    const login = parts.slice(2).join(":").toLowerCase();
    return `${tenant}:${login}`;
  }
  const i = key.indexOf(":");
  return `default:${(i >= 0 ? key.slice(i + 1) : key).toLowerCase()}`;
}

export function tokenCacheEpoch(key: string): number {
  const scoped = epochScopeOfKey(key);
  const loginOnly = scoped.slice(scoped.indexOf(":") + 1);
  return (loginEpochs.get(scoped) ?? 0) + (loginEpochs.get(`*:${loginOnly}`) ?? 0);
}

export function writeTokenCache(key: string, tokens: CachedTokenSet | null, epoch?: number): void {
  if (epoch !== undefined && epoch !== tokenCacheEpoch(key)) return;
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    tokens,
    expiresAt: Date.now() + (tokens ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/**
 * Drops every environment variant for a login. `revokeStoredTokens` deletes
 * PROD, TEST and unscoped keys, so a single-variant invalidation would leave
 * the other two serving a revoked token.
 */
export function invalidateTokenCacheFor(userLogin: string, tenantId?: string): void {
  // Bump the epoch even when nothing is cached: an in-flight reader
  // holds no entry yet, and its landing write must still be dropped.
  const login = userLogin.toLowerCase();
  const suffix = `:${login}`;
  if (tenantId && tenantId.trim().length > 0) {
    const scoped = `${tenantId.trim()}:${login}`;
    loginEpochs.set(scoped, (loginEpochs.get(scoped) ?? 0) + 1);
    const prefix = `${tenantId.trim()}:`;
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) cache.delete(key);
    }
    return;
  }
  const wildcardScope = `*:${login}`;
  loginEpochs.set(wildcardScope, (loginEpochs.get(wildcardScope) ?? 0) + 1);
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/** Test seam: the cache is module-level and must be resettable per test. */
export function __resetTokenCache(): void {
  cache.clear();
  loginEpochs.clear();
}
