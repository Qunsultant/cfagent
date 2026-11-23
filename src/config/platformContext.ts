/**
 * Platform-context cache limits — the single source of truth.
 *
 * Every value the one shared resolution's session-facts cache
 * enforces lives in `config/platform-context.json`; no module
 * hardcodes a TTL or a bound. Change the JSON to change
 * behavior, then update the pins in the tests that quote the
 * value. Units are explicit in the key names: `*Ms` are
 * milliseconds (comparisons against the caller-supplied nowMs).
 *
 * Values follow the session-cache precedent
 * (`config/session-limits.json`): the same 60-second positive
 * TTL and the same 2000-entry bound — the facts cache is the
 * same class of in-isolate cache, and the same staleness bound
 * applies. Re-resolution on the defined events (sign-in,
 * subscription change, role change, tenant change) is the
 * freshness mechanism; the TTL is only the backstop.
 */
import raw from "../../config/platform-context.json";

export interface PlatformContextCacheLimits {
  /** Session-facts cache: positive hit TTL (60 seconds). */
  cacheTtlMs: number;
  /** Session-facts cache: maximum entries (oldest-out eviction). */
  cacheMaxEntries: number;
}

export const PLATFORM_CONTEXT_LIMITS: PlatformContextCacheLimits =
  raw as PlatformContextCacheLimits;
