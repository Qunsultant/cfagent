/**
 * Resilient wrapper around a KV binding.
 *
 * Why: Workers KV has a hard daily `get()` quota on the Free plan. When it is
 * exhausted every `get()` throws `KV get() limit exceeded for the day.`, and an
 * uncaught throw is exactly what surfaces to the visitor as Cloudflare error
 * 1101. One exhausted quota therefore turned into a site-wide outage instead of
 * a degraded state.
 *
 * This wrapper makes KV failure a normal, handled outcome:
 * - reads never throw; a failure reads as `null` (callers treat it as a miss),
 * - a quota/limit error opens a breaker for a few minutes, so the Worker stops
 *   hammering KV and stops generating one exception per request,
 * - writes and deletes never throw either (a failed session write is logged,
 *   not fatal — the caller already redirects).
 *
 * It is deliberately small and dependency-free so it can wrap any KV-like
 * object, including the Durable Object adapter in `durableKv.ts`.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * #1756 — atomic claim: set `key` to `value` only if it is absent,
   * returning true iff this call created the key. The check and the
   * set are one indivisible backend operation: two concurrent
   * callers cannot both observe "absent" and both win (the race a
   * get-then-put leaves open). A present-but-expired row counts as
   * absent on backends with TTLs (the Durable Object consume op's
   * rule). A false return means "not claimed by this caller" —
   * either the key was already present or the store could not be
   * reached — and callers must treat both the same way: fail
   * closed, never assume the claim. Optional: backends that cannot
   * offer atomicity (plain Workers KV has no compare-and-swap)
   * omit it, and callers fall back to the documented legacy
   * check-then-set path for those backends only.
   */
  putIfAbsent?(key: string, value: string): Promise<boolean>;
}

const DEFAULT_BLOCK_MS = 5 * 60_000;

interface KvHealth {
  blockedUntil: number;
  lastError: string | null;
  suppressedReads: number;
}

const health = new Map<string, KvHealth>();

function healthFor(label: string): KvHealth {
  let entry = health.get(label);
  if (!entry) {
    entry = { blockedUntil: 0, lastError: null, suppressedReads: 0 };
    health.set(label, entry);
  }
  return entry;
}

/**
 * True for the errors that mean "the daily quota is gone" rather than "this key
 * is bad". Both Workers KV's message and the 429 the REST API returns are
 * covered; the match is intentionally loose so a wording change still trips it.
 */
export function isKvLimitError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");
  return /limit exceeded|quota|too many requests|\b429\b/i.test(message);
}

/** Test seam: the breaker is module-level state. */
export function __resetKvHealth(): void {
  health.clear();
}

export function kvHealth(label: string): Readonly<KvHealth> {
  return { ...healthFor(label) };
}

/**
 * Wraps `kv` so no call can throw. When `kv` is undefined the wrapper is a
 * no-op backend (reads miss, writes vanish), which keeps callers free of
 * `if (kv)` branches.
 */
export function createResilientKv(
  kv: KvLike | KVNamespace | null | undefined,
  label: string,
  // #3515 S3 batch 8 — optional observability sink for the quota
  // warning (the d1QueryLogger precedent); absent, the structured
  // console fallback (never an empty-env sink, #5587).
  options: { blockMs?: number; sink?: ObservabilitySink } = {}
): KvLike {
  const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
  const state = healthFor(label);
  const structuredLog = createStructuredLogger(
    options.sink ?? new ConsoleObservabilitySink(),
    { component: "security/kvResilience" },
  );

  const trip = (error: unknown): void => {
    state.lastError = error instanceof Error ? error.message : String(error);
    if (isKvLimitError(error)) {
      state.blockedUntil = Date.now() + blockMs;
      structuredLog.warn("kvResilience.quota_error", {
        message: `[kv:${label}] quota error — pausing KV reads for ${Math.round(blockMs / 1000)}s: ${state.lastError}`,
        label,
        blockSeconds: Math.round(blockMs / 1000),
        error: state.lastError,
      });
    }
  };

  return {
    async get(key: string): Promise<string | null> {
      if (!kv) return null;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return null;
      }
      try {
        return await kv.get(key);
      } catch (error) {
        trip(error);
        return null;
      }
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      if (!kv) return;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return;
      }
      try {
        await kv.put(key, value, putOptions);
      } catch (error) {
        trip(error);
      }
    },

    async delete(key: string): Promise<void> {
      if (!kv) return;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return;
      }
      try {
        await kv.delete(key);
      } catch (error) {
        trip(error);
      }
    },

    // #1756: forward the atomic claim when the wrapped backend offers
    // it; backends without it keep the method absent, so callers see
    // the same "no atomic claim" signal they would unwrapped. A
    // failure reads as "not claimed" (fail closed — the caller must
    // never grant on an unknown claim outcome), matching the
    // wrapper's never-throws contract for reads and writes.
    ...(typeof (kv as KvLike | null | undefined)?.putIfAbsent === "function"
      ? {
          putIfAbsent: async (key: string, value: string): Promise<boolean> => {
            if (!kv) return false;
            if (Date.now() < state.blockedUntil) {
              state.suppressedReads += 1;
              return false;
            }
            try {
              return await (kv as KvLike).putIfAbsent!(key, value);
            } catch (error) {
              trip(error);
              return false;
            }
          },
        }
      : {}),
  };
}
