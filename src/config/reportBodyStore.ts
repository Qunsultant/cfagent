/**
 * Issue #6659 — the report-body store's POLICY, externalized.
 *
 * The access point (`src/services/reportBodyStore.ts`) is the one place that
 * touches report bodies in R2. Its behaviour is decided here, from the
 * environment, never hard-coded at a call site: how many attempts an error
 * earns, how long an "absent" answer is remembered, and how many ids that
 * memory may hold.
 *
 * Every value is clamped to a sane band and an invalid value falls back to
 * the documented default with an error recorded for the caller to surface —
 * a typo must not silently disable the protection.
 */

export interface ReportBodyStorePolicy {
  /** Attempts on a TRANSIENT read error (1 = no retry). Absence never retries. */
  readAttempts: number;
  /** Delay before attempt 2..n, in ms (linear: n-1 × this). */
  retryBackoffMs: number;
  /** How long a report id is remembered as absent. 0 disables the cache. */
  negativeTtlMs: number;
  /** Cap on remembered ids; oldest entries are evicted first. 0 disables. */
  negativeMaxEntries: number;
}

/** Conservative defaults: one retry, 50 ms apart, 30 s of "absent" memory. */
export const DEFAULT_REPORT_BODY_STORE_POLICY: ReportBodyStorePolicy = {
  readAttempts: 2,
  retryBackoffMs: 50,
  negativeTtlMs: 30_000,
  negativeMaxEntries: 500,
};

/** The env var each policy field reads. One home, so the docs cannot drift. */
export const REPORT_BODY_STORE_ENV_KEYS = {
  readAttempts: "REPORT_BODY_READ_ATTEMPTS",
  retryBackoffMs: "REPORT_BODY_RETRY_BACKOFF_MS",
  negativeTtlMs: "REPORT_BODY_NEGATIVE_TTL_MS",
  negativeMaxEntries: "REPORT_BODY_NEGATIVE_MAX_ENTRIES",
} as const;

const BOUNDS: Record<keyof ReportBodyStorePolicy, [number, number]> = {
  readAttempts: [1, 5],
  retryBackoffMs: [0, 2_000],
  negativeTtlMs: [0, 300_000],
  negativeMaxEntries: [0, 5_000],
};

function readInt(
  raw: string | undefined,
  fallback: number,
  [min, max]: [number, number],
  envKey: string,
  errors: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${envKey} must be an integer in [${min}, ${max}]; got ${JSON.stringify(raw)} — using ${fallback}.`);
    return fallback;
  }
  return value;
}

/**
 * Resolve the policy from the environment. `errors` is never thrown: a bad
 * value degrades to the default and is reported, because a broken knob must
 * not turn into a failing read.
 */
export function resolveReportBodyStorePolicy(
  env?: Record<string, string | undefined> | null,
): { policy: ReportBodyStorePolicy; errors: string[] } {
  const errors: string[] = [];
  const source = env ?? {};
  const policy: ReportBodyStorePolicy = {
    readAttempts: readInt(
      source[REPORT_BODY_STORE_ENV_KEYS.readAttempts],
      DEFAULT_REPORT_BODY_STORE_POLICY.readAttempts,
      BOUNDS.readAttempts,
      REPORT_BODY_STORE_ENV_KEYS.readAttempts,
      errors,
    ),
    retryBackoffMs: readInt(
      source[REPORT_BODY_STORE_ENV_KEYS.retryBackoffMs],
      DEFAULT_REPORT_BODY_STORE_POLICY.retryBackoffMs,
      BOUNDS.retryBackoffMs,
      REPORT_BODY_STORE_ENV_KEYS.retryBackoffMs,
      errors,
    ),
    negativeTtlMs: readInt(
      source[REPORT_BODY_STORE_ENV_KEYS.negativeTtlMs],
      DEFAULT_REPORT_BODY_STORE_POLICY.negativeTtlMs,
      BOUNDS.negativeTtlMs,
      REPORT_BODY_STORE_ENV_KEYS.negativeTtlMs,
      errors,
    ),
    negativeMaxEntries: readInt(
      source[REPORT_BODY_STORE_ENV_KEYS.negativeMaxEntries],
      DEFAULT_REPORT_BODY_STORE_POLICY.negativeMaxEntries,
      BOUNDS.negativeMaxEntries,
      REPORT_BODY_STORE_ENV_KEYS.negativeMaxEntries,
      errors,
    ),
  };
  return { policy, errors };
}
