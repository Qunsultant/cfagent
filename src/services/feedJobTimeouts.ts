/**
 * Issue #3992 PR-1 — the feed-job deadline substrate: the timeout
 * catalogue, the timeout error, and the race helper the later PRs
 * wire into the feed runners and the feed.pull step.
 *
 * Why this exists (incident #3976's live confirmation): a feed
 * run could hang forever and record nothing, because every
 * awaited leg of the run — the index refresh, the provider
 * fetch, the capture write — was a bare await with no bound, and
 * the run's only record is written when the run ends. The
 * platform already owns this idiom at the job level:
 * createExecutionDeadline (src/agents/orchestrator/asyncJobs.ts,
 * #3907) races a leg against a catalogued deadline and cancels
 * the deadline on settle; the rejection abandons the hung leg
 * rather than aborting it, and the leg's late result is dropped
 * because the run is already terminal. This module mirrors that
 * shape at feed-leg granularity; the executor's 90-minute
 * deadline (ASYNC_JOB_MAX_RUNTIME_MINUTES) stays the outer
 * backstop, not the failure surface.
 *
 * Issue #4312 — the bounds are env-configurable, not literals:
 * FEED_JOB_TIMEOUTS below is the defaults table only. Production
 * callers resolve through resolveFeedJobTimeouts(env) instead,
 * so an operator changes a bound by setting its knob, never by
 * editing this file.
 *
 * Issue #4304 — the verify bound joins the catalogue: the
 * provider verify probe (a conformance kit over the adapter's
 * declared capabilities, run sequentially) gets verifyMs, with
 * its own knob FEED_JOB_VERIFY_MS, resolved the same way.
 */

/** The resolved bounds for one feed run, in milliseconds — plus the provider verify-probe bound (#4304). */
export interface FeedJobTimeouts {
  refreshMs: number;
  fetchMs: number;
  captureMs: number;
  executionMs: number;
  /** #4304 — bound for one provider verify probe. */
  verifyMs: number;
}

/**
 * The DEFAULTS table for one feed run's bounds, in
 * milliseconds — the values recorded on issue #3992, not
 * constants discovered in code. This is the fallback only:
 * production callers resolve through resolveFeedJobTimeouts(env),
 * which reads each bound from its env knob below and falls back
 * to this table per bound when the knob is absent.
 *
 * Basis for every value: the observed legs are seconds-scale —
 * one Wikipedia index page fetch (refresh), one batch quote
 * request for a ~100-symbol universe (fetch), one dataset store
 * write (capture), and a whole feed pull end to end
 * (execution). Each bound therefore sits far above the observed
 * durations, so a run that completes today is never cut by a
 * bound, and far below the async executor's 90-minute backstop
 * (ASYNC_JOB_MAX_RUNTIME_MINUTES, default 90), so a hung leg is
 * recorded as a named feed failure long before the executor
 * kills the job with no feed record at all.
 */
export const FEED_JOB_TIMEOUTS: FeedJobTimeouts = {
  /** Bound for the universe index-refresh leg. */
  refreshMs: 30_000,
  /** Bound for one provider fetch leg (the batch quote request). */
  fetchMs: 60_000,
  /** Bound for the capture/dataset store write leg. */
  captureMs: 30_000,
  /** Bound for a whole feed.pull execution, above every leg. */
  executionMs: 240_000,
  /**
   * Bound for one provider verify probe (#4304). Basis: the
   * probe is the conformance kit over the adapter's declared
   * capabilities, run SEQUENTIALLY — up to 4 round-trips
   * (quotes, historicalBars, fundamentals, news), each one
   * provider round-trip seconds-scale like the fetch leg. 120s
   * is 2x the fetch bound and half the execution bound: far
   * above the normal multi-probe duration (tens of seconds),
   * far below the executor's 90-minute backstop, and well
   * inside a single verify action (no pipeline run beneath it).
   */
  verifyMs: 120_000,
};

/**
 * The env knobs, one per bound (#4312). An operator changes a
 * bound by setting its knob — no code change, no redeploy of
 * this module. Values are milliseconds; a knob holds either a
 * decimal string ("60000") or a number (120000).
 */
export const FEED_JOB_TIMEOUT_KNOBS = {
  refreshMs: "FEED_JOB_REFRESH_MS",
  fetchMs: "FEED_JOB_FETCH_MS",
  captureMs: "FEED_JOB_CAPTURE_MS",
  executionMs: "FEED_JOB_EXECUTION_MS",
  verifyMs: "FEED_JOB_VERIFY_MS",
} as const;

/**
 * Resolve one bound from its env knob (#4312), in the feed-knob
 * idiom (an env record passed in, fallback to the recorded
 * default — cf. resolveFeedJobCadenceMinutes in feedJobs.ts).
 * Absent knob ⇒ the default. A present knob must name a
 * positive finite number of milliseconds; anything else is a
 * configuration error, refused by NAME (naming the knob and the
 * raw value) — never silently treated as the default, another
 * bound, or "no deadline". The withFeedDeadline guard stays as
 * the backstop for bounds that arrive any other way.
 */
export function resolveFeedJobTimeoutMs(
  env: Record<string, unknown>,
  knob: string,
  fallback: number,
): number {
  const raw = env[knob];
  if (raw === undefined) return fallback;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const shown = typeof raw === "string" ? `"${raw}"` : String(raw);
    throw new Error(
      `Invalid ${knob} value ${shown}: the bound must be a positive finite number of milliseconds.`,
    );
  }
  return parsed;
}

/**
 * Resolve all four feed-job bounds from env (#4312), plus the
 * verify-probe bound (#4304). Each knob is independent: a set
 * knob overrides only its own bound, the rest fall back to
 * FEED_JOB_TIMEOUTS per bound.
 */
export function resolveFeedJobTimeouts(
  env: Record<string, unknown> = {},
): FeedJobTimeouts {
  return {
    refreshMs: resolveFeedJobTimeoutMs(env, FEED_JOB_TIMEOUT_KNOBS.refreshMs, FEED_JOB_TIMEOUTS.refreshMs),
    fetchMs: resolveFeedJobTimeoutMs(env, FEED_JOB_TIMEOUT_KNOBS.fetchMs, FEED_JOB_TIMEOUTS.fetchMs),
    captureMs: resolveFeedJobTimeoutMs(env, FEED_JOB_TIMEOUT_KNOBS.captureMs, FEED_JOB_TIMEOUTS.captureMs),
    executionMs: resolveFeedJobTimeoutMs(env, FEED_JOB_TIMEOUT_KNOBS.executionMs, FEED_JOB_TIMEOUTS.executionMs),
    verifyMs: resolveFeedJobTimeoutMs(env, FEED_JOB_TIMEOUT_KNOBS.verifyMs, FEED_JOB_TIMEOUTS.verifyMs),
  };
}

/**
 * A feed leg exceeded its named bound. Carries the leg's stable
 * FEED_JOB_CODES entry in `code` so the run record, the job
 * outcome, and the panel name the timeout exactly like every
 * other coded feed failure — never a bare message where a code
 * belongs.
 */
export class FeedJobTimeoutError extends Error {
  readonly code: string;

  constructor(code: string, boundMs: number) {
    super(`Feed job leg timed out after ${boundMs}ms (${code}).`);
    this.name = "FeedJobTimeoutError";
    this.code = code;
  }
}

/**
 * The timer seam for withFeedDeadline. Injected in pins (vitest
 * fake timers reach the defaults; explicit stubs reach this
 * seam directly); production callers omit it and get the
 * globals.
 */
export interface FeedDeadlineTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const GLOBAL_TIMERS: FeedDeadlineTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Race `work` against a named bound, in the createExecutionDeadline
 * idiom: if the work settles first, its value or original
 * rejection propagates unchanged; if the bound passes first, the
 * race rejects with a FeedJobTimeoutError carrying `code`. The
 * rejection ABANDONS the leg — the underlying work is not
 * aborted and may still settle in the background, but the race
 * has settled exactly once, so its late result is dropped. The
 * timer is cleared on ANY settle, so a settled race leaves no
 * dangling timer behind.
 *
 * A non-positive or non-finite bound is a configuration error,
 * refused by name (synchronously, before any timer exists) —
 * never silently treated as "no deadline".
 */
export function withFeedDeadline<T>(
  work: Promise<T>,
  boundMs: number,
  code: string,
  timers: FeedDeadlineTimers = GLOBAL_TIMERS,
): Promise<T> {
  if (!Number.isFinite(boundMs) || boundMs <= 0) {
    throw new Error(
      `Invalid feed deadline bound ${String(boundMs)} for ${code}: the bound must be a positive finite number of milliseconds.`,
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new FeedJobTimeoutError(code, boundMs));
    }, boundMs);
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      complete();
    };
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
