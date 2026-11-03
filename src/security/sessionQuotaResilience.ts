/**
 * Issue #2666 (slice 2.11 second run, #1819 headroom) — session-store
 * quota resilience: limit-error classification + breaker for the
 * provider-limited session path.
 *
 * The gap this closes: the error boundary only classified KV limit
 * errors. The real Durable Objects rows-read message ("Exceeded
 * allowed rows read in Durable Objects free tier.") and D1 free-tier
 * row-limit messages match NEITHER the KV regex (no "limit exceeded",
 * no "quota", no 429) — so a DO/D1 exhaustion fell through to a 500
 * (or an edge 1101 if it escaped the boundary). And on the wired
 * session path, a freshRead throw propagated with no catch, killing
 * the request even when a valid cached session existed in-isolate —
 * the 2026-10-26 sign-in-down failure mode.
 *
 * Design to the CONSTRAINT, not to today's free-tier numbers: these
 * patterns match any quota/rate-limit tightening, free or paid.
 *
 * Breaker semantics (mirrors src/security/kvResilience.ts):
 * - Trips ONLY on real limit errors (never on ordinary failures).
 * - While blocked, validations attempt ZERO store reads; each
 *   suppressed validation is counted, never re-trips (no indefinite
 *   extension under sustained traffic).
 * - Blocked validations THROW a typed limit error — they never
 *   return null. Auth null means "unauthenticated"; returning it
 *   during an outage would lie and could drop cookies. The caller
 *   (validateAndTouchWiredSession) serves a locally-validated
 *   cached session degraded, or lets the throw become a 503 via
 *   the error boundary.
 * - SQLITE_FULL is explicitly NOT a limit error here: per provider
 *   docs, disk-full fails writes while reads still work, so a
 *   read path must not degrade on it.
 */
import { isKvLimitError } from "./kvResilience";

/** Block window after a tripped breaker (matches the KV breaker). */
export const SESSION_STORE_BREAKER_BLOCK_MS = 5 * 60_000;

/**
 * Durable Objects free-tier rows-read/written messages, as reported
 * first-hand (Cloudflare community): "Exceeded allowed rows read in
 * Durable Objects free tier."
 */
const DO_ROWS_LIMIT_RE =
  /exceeded allowed rows (read|written) in durable objects/i;

/** D1 free-tier daily row read/write limit messages. */
const D1_ROW_LIMIT_RE =
  /free tier daily row (read|write) limit/i;

export function isSessionStoreLimitError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  // SQLITE_FULL is disk-full, not quota: reads still work, so the
  // read path must not treat it as a limit error.
  if (/SQLITE_FULL/i.test(message)) return false;
  return (
    DO_ROWS_LIMIT_RE.test(message) ||
    D1_ROW_LIMIT_RE.test(message) ||
    isKvLimitError(error)
  );
}

interface SessionStoreBreakerState {
  blockedUntil: number;
  lastError: string | null;
  suppressedReads: number;
}

const breaker: SessionStoreBreakerState = {
  blockedUntil: 0,
  lastError: null,
  suppressedReads: 0,
};

export function isSessionStoreBreakerOpen(): boolean {
  return Date.now() < breaker.blockedUntil;
}

/** Trip the breaker, but only on a real limit error. */
export function tripSessionStoreBreaker(error: unknown): void {
  if (!isSessionStoreLimitError(error)) return;
  breaker.blockedUntil = Date.now() + SESSION_STORE_BREAKER_BLOCK_MS;
  breaker.lastError =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "provider limit error";
}

/** Count a validation that skipped the store because the breaker is open. */
export function noteSuppressedSessionStoreRead(): void {
  breaker.suppressedReads += 1;
}

export function sessionStoreBreakerState(): Readonly<SessionStoreBreakerState> {
  return { ...breaker };
}

/** Test seam: the breaker is module-level state. */
export function __resetSessionStoreBreaker(): void {
  breaker.blockedUntil = 0;
  breaker.lastError = null;
  breaker.suppressedReads = 0;
}
