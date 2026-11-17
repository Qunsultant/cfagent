/**
 * Issue #4930 — D1 retry/timeout policy: one shared helper at the D1
 * adapter boundary. No per-adapter copies: every D1 caller that needs
 * the policy goes through `withD1Retry`, and the DML executor
 * (`src/data/schemaComponent/dmlExecutor.ts`) wires it for every
 * catalogue DML execution, so the governed path gets the policy with
 * zero per-adapter changes.
 *
 * THE POLICY (recorded budgets — the slice's explicit numbers):
 * - maxAttempts 3 (one try + two retries). Never unbounded.
 * - baseDelayMs 100, doubling per retry, capped at maxDelayMs 1000:
 *   the delays between attempts are 100ms then 200ms. Total backoff
 *   budget 300ms per call. Delays are small on purpose: a D1
 *   contention fault clears in milliseconds, and a caller that waits
 *   seconds for a database is a caller whose run is already lost.
 * - jitterRatio 0 by default (deterministic, testable). The shape
 *   honours a nonzero ratio when an operator sets one; the default
 *   stays 0 because the retry volume is bounded (at most two retries
 *   per call) and D1 contention is a per-database lock, not a
 *   thundering-herd event.
 * - The shape (maxAttempts / baseDelayMs / maxDelayMs / jitterRatio)
 *   is the pipeline `RetryPolicy` shape (`src/services/pipelinePolicy.ts`),
 *   re-declared here so the data layer does not depend on services.
 *   The resolve function follows the same env + settings pattern with
 *   the same clamp bounds (attempts [1,10], delays [0,120000]ms).
 *
 * CLASSIFICATION is an allowlist, never a denylist. An unrecognized
 * error is never retried, so a real bug surfaces immediately with its
 * original error instead of being masked behind the exhaustion error
 * after three wasted attempts. Two retryable classes:
 * - did-not-run: the statement never executed, so re-execution IS the
 *   first execution and is safe for ANY operation, idempotent or not.
 *   SQLITE_BUSY / SQLITE_LOCKED / "database is locked" (lock
 *   contention at statement start). This is the realistic D1 transient
 *   mode: D1 is a single-writer store and a contended write fails
 *   before it runs.
 * - ambiguous: the statement may or may not have executed, so a retry
 *   is safe ONLY for an idempotent operation. Timeouts (ETIMEDOUT,
 *   "timed out") and transport failures (ECONNRESET, EAI_AGAIN,
 *   "fetch failed", "network connection lost", "socket hang up").
 *   Deliberately NOT matched: a bare "D1_ERROR" prefix. The D1 binding
 *   prefixes SQL errors with it too ("D1_ERROR: no such table"), and
 *   retrying those would mask the root cause behind the exhaustion
 *   error. Never retryable, by name: SQLITE_FULL, SQLITE_ERROR,
 *   constraint violations, "no such table/column", syntax errors, and
 *   any already-coded SchemaComponentError (a validation or catalogue
 *   error is a programmer error, never a transient fault).
 *
 * IDEMPOTENCY (ADR 0033 R-1 — the composition decision). ADR 0033
 * states the rule this policy implements: "retrying a dual-write is
 * safe only once R-1 holds". The executor derives safety per entry:
 * a read is always safe; an upsert is safe by construction
 * (ON CONFLICT); an entry carrying `idempotent: true` is safe by
 * audited declaration; anything else is retried ONLY for did-not-run
 * errors. A non-idempotent write that fails ambiguously fails fast
 * with its original error — the caller, not the retry, owns the
 * decision to re-issue it (it alone knows whether the occurrence is
 * safe to replay, e.g. whether its event id is stable per R-1c).
 * The DML catalogue audit that fixes the flag is recorded in the
 * census pin (`tests/d1_retry_policy_4930.test.ts`): 54 executed
 * entries, 38 fully retryable (read 24 + upsert 4 + flagged 10),
 * 16 did-not-run-only (plain insert 10 + non-idempotent update 6).
 * Fragment entries are never executed by the executor, so the policy
 * does not reach them; the counter-increment fragments are
 * non-idempotent by construction (col = col + delta) and must never
 * be retried by a future wiring.
 *
 * COMPOSITION WITH THE TRANSACTION ASPECT (ADR 0022 D-C, #2288).
 * The retry wraps the WHOLE unit call — never resumes mid-unit:
 * `withD1Retry(() => withTransaction(backend, ctx, fn), { idempotent })`.
 * On the D1 leg the unit buffers its statements and applies them with
 * ONE batch(); a failed attempt discards its buffer, so the retry
 * re-buffers the same deterministic statements and applies them once.
 * A unit whose statements are not idempotent is retried only for
 * did-not-run errors (the batch never ran, so nothing was applied).
 * The helper never calls `db.transaction()` (sequential BEGIN/COMMIT,
 * not atomic — forbidden by the #4937 pin).
 *
 * TELEMETRY rides the structured-logging seam (the transactionAspect
 * module-logger pattern): `d1_retry.attempt` per retry, `d1_retry.recovered`
 * when a call succeeds after a retry, `d1_retry.exhausted` on exhaustion.
 * No statement text or parameter values are ever logged.
 *
 * EXCLUDED (issue scope): provider retry policies (the breaker machinery
 * owns them — linked, not changed); DO-leg retry (N/A: synchronous local
 * SQLite has no transient-failure mode). Direct-builder-call adapters
 * (24 files, 30 inserts) are NOT wired in this slice — there is no shared
 * seam for them and per-adapter wrapping is forbidden; the follow-up
 * sub-issue under #4930 owns that wiring.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  createSchemaError,
  SchemaComponentError,
  SchemaErrorCode,
} from "./schemaComponent/schemaErrors";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "data/d1RetryPolicy",
});

/**
 * The retry budget shape — the pipeline RetryPolicy shape
 * (`src/services/pipelinePolicy.ts`), re-declared in the data layer.
 */
export interface D1RetryPolicy {
  /** Total attempts including the first try (>= 1). */
  maxAttempts: number;
  /** Delay before the first retry; doubles per retry. */
  baseDelayMs: number;
  /** Backoff cap. */
  maxDelayMs: number;
  /** Symmetric jitter ratio (0..1): delay varies by ±ratio. */
  jitterRatio: number;
}

/** The recorded budgets: 3 attempts, 100ms doubling to a 1000ms cap. */
export const DEFAULT_D1_RETRY_POLICY: D1RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterRatio: 0,
};

/** Clamp bounds — the pipelinePolicy bounds, reused, not re-invented. */
const ATTEMPTS_MIN = 1;
const ATTEMPTS_MAX = 10;
const DELAY_MIN_MS = 0;
const DELAY_MAX_MS = 120_000;

/** Shared by the D1 policy resolvers (#4930, #4933): parse + clamp one integer. */
export function parseIntClamped(
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return undefined;
  }
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the effective policy from operator settings and env, with the
 * defaults as the base. `env` is any string-valued record (Worker env
 * bindings read as strings); `settings` is the operator-settings map
 * (`d1.retry.*`). Precedence per key: settings, then env, then default.
 * Out-of-range values clamp to the bounds instead of throwing — a
 * misconfigured budget degrades to the nearest sane budget, never to
 * an unbounded retry.
 */
export function resolveD1RetryPolicy(
  env?: Record<string, unknown>,
  settings?: Record<string, string | undefined>,
): D1RetryPolicy {
  const e = (key: string): string | undefined => {
    const v = env?.[key];
    return v === undefined || v === null ? undefined : String(v);
  };
  const s = (key: string): string | undefined => settings?.[key];
  const d = DEFAULT_D1_RETRY_POLICY;
  return {
    maxAttempts:
      parseIntClamped(
        s("d1.retry.attempts") ?? e("D1_RETRY_ATTEMPTS"),
        ATTEMPTS_MIN,
        ATTEMPTS_MAX,
      ) ?? d.maxAttempts,
    baseDelayMs:
      parseIntClamped(
        s("d1.retry.baseDelayMs") ?? e("D1_RETRY_BASE_DELAY_MS"),
        DELAY_MIN_MS,
        DELAY_MAX_MS,
      ) ?? d.baseDelayMs,
    maxDelayMs:
      Math.max(
        parseIntClamped(
          s("d1.retry.maxDelayMs") ?? e("D1_RETRY_MAX_DELAY_MS"),
          DELAY_MIN_MS,
          DELAY_MAX_MS,
        ) ?? d.maxDelayMs,
        parseIntClamped(
          s("d1.retry.baseDelayMs") ?? e("D1_RETRY_BASE_DELAY_MS"),
          DELAY_MIN_MS,
          DELAY_MAX_MS,
        ) ?? d.baseDelayMs,
      ),
    jitterRatio: d.jitterRatio,
  };
}

/** The classification of one failure: retryable, and if so, how safe. */
export interface D1ErrorClassification {
  /** The error is in a retryable class at all. */
  retryable: boolean;
  /**
   * The statement never executed (lock contention before execution).
   * True only for the did-not-run class; an ambiguous failure leaves
   * this false, so only an idempotent operation may retry it.
   */
  didNotRun: boolean;
  /** The class name, for the log line — never the raw error text. */
  reason: string;
}

/** Did-not-run: lock contention — the statement never started. */
const DID_NOT_RUN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /SQLITE_BUSY/i, reason: "sqlite_busy" },
  { pattern: /SQLITE_LOCKED/i, reason: "sqlite_locked" },
  { pattern: /database is locked/i, reason: "database_is_locked" },
];

/** Ambiguous: the statement may or may not have executed. */
const AMBIGUOUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /ETIMEDOUT/i, reason: "etimedout" },
  { pattern: /timed?\s*out/i, reason: "timeout" },
  { pattern: /ECONNRESET/i, reason: "econnreset" },
  { pattern: /EAI_AGAIN/i, reason: "eai_again" },
  { pattern: /fetch failed/i, reason: "fetch_failed" },
  { pattern: /network connection (was )?lost/i, reason: "network_connection_lost" },
  { pattern: /socket hang up/i, reason: "socket_hang_up" },
];

/**
 * Classify one failure. An already-coded SchemaComponentError is never
 * retryable: a catalogue, validation, or exhaustion error is a
 * programmer error or a decided outcome, not a transient fault — and
 * re-entering the classifier on a wrapped EXECUTION_FAILED whose detail
 * quotes a transient cause must not resurrect a retry the executor
 * already decided against.
 */
export function classifyD1Error(error: unknown): D1ErrorClassification {
  if (error instanceof SchemaComponentError) {
    return { retryable: false, didNotRun: false, reason: "coded_error" };
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const { pattern, reason } of DID_NOT_RUN_PATTERNS) {
    if (pattern.test(message)) {
      return { retryable: true, didNotRun: true, reason };
    }
  }
  for (const { pattern, reason } of AMBIGUOUS_PATTERNS) {
    if (pattern.test(message)) {
      return { retryable: true, didNotRun: false, reason };
    }
  }
  return { retryable: false, didNotRun: false, reason: "not_retryable" };
}

/**
 * The delay before retry number `retryIndex` (0 = the first retry):
 * base doubling per retry, capped at maxDelayMs, with symmetric jitter
 * when the policy carries a nonzero ratio. The random source is
 * injectable so tests can pin the delay exactly.
 */
export function delayForAttempt(
  retryIndex: number,
  policy: D1RetryPolicy,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    policy.baseDelayMs * 2 ** retryIndex,
    policy.maxDelayMs,
  );
  if (policy.jitterRatio <= 0) return base;
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, base + jitter);
}

/** Options for one retried operation. */
export interface WithD1RetryOptions {
  /** The operation name for the log line and the exhaustion details. */
  operationName: string;
  /**
   * True when re-executing the operation is a no-op under redelivery
   * (a read, an upsert, or an audited `idempotent: true` entry). A
   * false operation is retried only for did-not-run errors.
   */
  idempotent: boolean;
  /** Budget override; the recorded default applies when omitted. */
  policy?: D1RetryPolicy;
  /** Delay source — the repo's injectable-sleep idiom; real timers by default. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source — injectable so tests can pin the delay exactly. */
  random?: () => number;
}

/** Details carried on the exhaustion error. */
export interface D1RetryExhaustionDetails {
  operationName: string;
  attempts: number;
  lastError: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one D1 operation under the bounded retry policy. The operation is
 * invoked at most `policy.maxAttempts` times. A failure that is not
 * retryable, or an ambiguous failure on a non-idempotent operation,
 * is rethrown immediately with the ORIGINAL error — never wrapped, so
 * the caller still sees the real cause. When the budget exhausts, the
 * throw is the coded SCHEMA_RETRY_EXHAUSTED error with the attempt
 * count and the last error in its details.
 *
 * The operation must be re-invocable: a retry calls it again from the
 * start. A transaction unit passes its whole wrapped call here, so a
 * retry re-runs the whole unit (re-buffer + one batch apply), never
 * resumes mid-unit.
 */
export async function withD1Retry<T>(
  operation: () => Promise<T>,
  options: WithD1RetryOptions,
): Promise<T> {
  const policy = options.policy ?? DEFAULT_D1_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation();
      if (attempt > 1) {
        structuredLog.info("d1_retry.recovered", {
          operationName: options.operationName,
          attempts: attempt,
          message: `[d1Retry] ${options.operationName} recovered on attempt ${attempt} of ${maxAttempts}`,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const classification = classifyD1Error(err);
      const safeToRetry =
        classification.retryable &&
        (classification.didNotRun || options.idempotent);
      if (!safeToRetry || attempt >= maxAttempts) {
        if (classification.retryable && attempt >= maxAttempts) {
          const lastMessage = err instanceof Error ? err.message : String(err);
          structuredLog.error("d1_retry.exhausted", {
            operationName: options.operationName,
            attempts: attempt,
            reason: classification.reason,
            lastError: lastMessage.slice(0, 200),
            message: `[d1Retry] ${options.operationName} exhausted ${attempt} attempts (${classification.reason})`,
          });
          throw createSchemaError(
            SchemaErrorCode.RETRY_EXHAUSTED,
            `operation ${options.operationName} failed after ${attempt} attempts (${classification.reason}); last error: ${lastMessage.slice(0, 200)}`,
            {
              operationName: options.operationName,
              attempts: attempt,
              lastError: lastMessage,
            } satisfies D1RetryExhaustionDetails,
          );
        }
        throw err;
      }
      const delayMs = delayForAttempt(attempt - 1, policy, random);
      structuredLog.warn("d1_retry.attempt", {
        operationName: options.operationName,
        attempt,
        maxAttempts,
        reason: classification.reason,
        willRetry: true,
        delayMs,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        message: `[d1Retry] ${options.operationName} attempt ${attempt} failed (${classification.reason}); retrying after ${delayMs}ms`,
      });
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws on every path.
  throw lastError;
}
