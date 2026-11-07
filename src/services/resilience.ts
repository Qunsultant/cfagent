/**
 * Shared resilience executor (issue #1181, slice R1 of the #1173
 * screener trust program).
 *
 * One implementation of retry-with-exponential-backoff for the whole
 * pipeline — every provider, every fetch class — driven by the
 * pipeline policy (pipelinePolicy.ts). Before this module, retry
 * behavior was whatever each path happened to hardcode: the E*TRADE
 * acquisition retried 3× with linear delays (liveScreener.withRetries),
 * Yahoo never retried, deliveries and report generation had ad-hoc
 * single attempts. The owner's requirement (#1173, 2026-10-23) is
 * that ALL failures are retried with exponential timeouts under
 * configurable policy — this is the executor that makes that true.
 *
 * Testability: sleep and the jitter source are injected, so tests
 * assert the schedule without waiting.
 */

import type { RetryPolicy } from "./pipelinePolicy";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/resilience",
});


/**
 * Delay before retry number `retryIndex` (1 = first retry):
 * baseDelayMs × 2^(retryIndex-1), capped at maxDelayMs, with
 * symmetric jitter of ±jitterRatio applied last.
 */
export function computeBackoffDelayMs(
  policy: RetryPolicy,
  retryIndex: number,
  rng: () => number = Math.random
): number {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, Math.max(0, retryIndex - 1))
  );
  if (!policy.jitterRatio || policy.jitterRatio <= 0) return Math.round(exp);
  const spread = exp * Math.min(1, policy.jitterRatio);
  const delta = (rng() * 2 - 1) * spread;
  return Math.max(0, Math.round(exp + delta));
}

export interface RetryEvent {
  label?: string;
  /** The attempt that just failed (1-based). */
  attempt: number;
  maxAttempts: number;
  /** Delay before the next attempt. */
  delayMs: number;
  error: string;
}

export interface WithRetryOptions {
  /** Names the operation in retry log lines (e.g. "yahoo:AAPL"). */
  label?: string;
  /** Return false for a permanent failure (auth, validation) that
   *  retrying cannot heal — it is rethrown immediately. */
  shouldRetry?: (err: unknown) => boolean;
  /** Observability hook, fired before each retry sleep. Defaults to
   *  a structured console.warn. */
  onRetry?: (event: RetryEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issue #1355: a 429 failure that carries a Retry-After. The
 * existing backoff below is policy-driven; when the server names
 * its own wait, that wait wins for THAT attempt — a shard that
 * hits a limit backs off alone while sibling shards proceed.
 * retryAfterSeconds is in seconds (HTTP semantics); callers that
 * read a raw header use parseRetryAfterSeconds first.
 */
export class RateLimitError extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Issue #1355: parse a Retry-After value — bare seconds, a numeric
 * string, or an HTTP-date — into seconds. Invalid input yields
 * undefined (the caller falls back to policy backoff); never throws.
 */
export function parseRetryAfterSeconds(value: unknown, nowMs = Date.now()): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - nowMs) / 1000));
  }
  return undefined;
}

/**
 * Issue #1355: the Retry-After wait in milliseconds for an error
 * that carries one — a RateLimitError's field, a 429-shaped error
 * with retryAfterSeconds / retry-after / Retry-After, or undefined
 * when the error names no wait (policy backoff applies).
 */
export function retryAfterMsForError(err: unknown): number | undefined {
  if (err instanceof RateLimitError && err.retryAfterSeconds !== undefined) {
    return err.retryAfterSeconds * 1000;
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const status = rec.status ?? rec.statusCode;
    if (status === 429) {
      const raw = rec.retryAfterSeconds ?? rec["retry-after"] ?? rec["Retry-After"];
      const seconds = parseRetryAfterSeconds(raw);
      if (seconds !== undefined) return seconds * 1000;
    }
  }
  return undefined;
}

/**
 * Run `fn` until it succeeds or the policy's attempts are exhausted.
 * The LAST error is rethrown unwrapped — callers keep their own
 * error semantics (the catalog mapping is R4's concern).
 *
 * Issue #1355: a Retry-After on the failed attempt overrides the
 * policy backoff for that retry (the server's wait wins); the
 * attempt cap is unchanged, so a misconfigured backoff cannot
 * retry-storm — the cap, not the delay, bounds the storm.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: WithRetryOptions = {}
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.trunc(policy.maxAttempts) || 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(err)) break;
      // Issue #1355: Retry-After wins over policy backoff for this
      // retry only; without one the policy schedule applies.
      const delayMs =
        retryAfterMsForError(err) ?? computeBackoffDelayMs(policy, attempt, opts.rng);
      const event: RetryEvent = {
        label: opts.label,
        attempt,
        maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      };
      if (opts.onRetry) {
        opts.onRetry(event);
      } else {
        structuredLog.warn("resilience.retry", {
          message: `[resilience] retry ${attempt}/${maxAttempts - 1}${opts.label ? ` ${opts.label}` : ""} in ${delayMs}ms after: ${event.error}`,
          label: opts.label,
          attempt,
          maxAttempts,
          delayMs,
          error: event.error,
        });
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}
