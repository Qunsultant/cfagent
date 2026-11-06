/**
 * Issue #278 (Assessment P2, part of #143): bounded in-isolate TTL cache
 * for Cloudflare AI Search queries.
 *
 * The AI Search instance was queried per search with zero caching —
 * every identical query paid a full round trip (historically a fetch
 * of the public endpoint; since #3342 the namespace binding, through
 * src/agents/mas.ts). This module is the single cache owner; its
 * reader is src/agents/mas.ts `searchKnowledge`, invoked by the
 * SearchHub MAS Search tab via POST /search/mas (#1169 S4-2).
 *
 * Honesty note (same class as the rate limiter's per-isolate state):
 * the cache lives in isolate memory — it is NOT shared across isolates,
 * NOT durable, and disappears on eviction/restart. Entries expire after
 * TTL; a stale entry is never served older than its TTL, and only
 * successful upstream results are cached (errors are never cached).
 *
 * This module is SDK-free so it is unit-testable in Vitest.
 */

/** Default TTL: 5 minutes. */
export const AI_SEARCH_CACHE_DEFAULT_TTL_MS = 5 * 60_000;
/** Default capacity: 200 entries (oldest evicted first). */
export const AI_SEARCH_CACHE_DEFAULT_MAX_ENTRIES = 200;

export interface AiSearchCacheConfig {
  ttlMs: number;
  maxEntries: number;
}

/**
 * Resolve cache config from env vars, with sane defaults.
 * AI_SEARCH_CACHE_TTL_MS — milliseconds an entry stays fresh.
 * AI_SEARCH_CACHE_MAX_ENTRIES — max entries before oldest-first eviction.
 */
export function resolveAiSearchCacheConfig(env?: unknown): AiSearchCacheConfig {
  const e = env as Record<string, string | undefined> | undefined;
  const ttl = Number(e?.AI_SEARCH_CACHE_TTL_MS);
  const max = Number(e?.AI_SEARCH_CACHE_MAX_ENTRIES);
  return {
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : AI_SEARCH_CACHE_DEFAULT_TTL_MS,
    maxEntries:
      Number.isFinite(max) && max > 0
        ? Math.floor(max)
        : AI_SEARCH_CACHE_DEFAULT_MAX_ENTRIES,
  };
}

/**
 * Cache key: normalized query + the caller-supplied scope (session or
 * user login). Scope prevents one tenant/session from reading another's
 * cached results.
 */
export function aiSearchCacheKey(query: string, scope: string, topK = 5): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  const s = (scope || "default").trim().toLowerCase().replace(/\s+/g, " ");
  const k = Number.isFinite(topK) ? Math.max(1, Math.min(50, Math.floor(topK))) : 5;
  return `aisearch:${s}:${k}:${q}`;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class AiSearchCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly config: AiSearchCacheConfig,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (this.store.size >= this.config.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: this.now() + this.config.ttlMs });
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

// One shared cache per isolate; config comes from the first env seen
// (vars are static per deployment, so this is stable in practice).
let sharedCache: AiSearchCache | null = null;

export function getAiSearchCache(env?: unknown): AiSearchCache {
  if (!sharedCache) {
    sharedCache = new AiSearchCache(resolveAiSearchCacheConfig(env));
  }
  return sharedCache;
}

/** Test-only: drop the shared isolate cache between tests. */
export function __resetAiSearchCacheForTests(): void {
  sharedCache = null;
}
