/**
 * Issue #2842 (#2837 sub-issue) — per-user report-run quota policy.
 *
 * Pure policy: no storage, no I/O, no DO access. The durable
 * counters live behind UserRequestQuotaPort (src/data), so this
 * module is unit-testable under Node and the gate stays
 * synchronous — the DO's single-threaded execution is what makes
 * the probe-then-charge sequence below atomic (the same
 * atomicity argument as the #1993 screen lock: no await ever
 * intervenes between probe and charge).
 *
 * Decisions (recorded for owner correction):
 * - ONE pool: screen + goalScreen runs share a single per-user
 *   report-run pool. The kind is recorded per charge for
 *   attribution, but the count ignores kind — "how many reports
 *   a user can run" is one number, not one per kind.
 * - Windows are UTC CALENDAR windows (matching #1819's UTC day
 *   boundary): day = UTC date, week = Monday 00:00 UTC through
 *   Sunday 24:00 UTC, month = UTC calendar month. A tenant/user
 *   timezone window is NOT built here: it needs a stored
 *   per-user timezone plus DST-safe boundaries, and inventing
 *   one from a request header would silently move resets.
 * - Initial value set, ALL TIERS, PENDING CBO/owner decision:
 *   daily 10, weekly 70, monthly 300. No tiers, prices, or
 *   commercial terms are built — the tier → quota mapping
 *   comes from the CBO plan / owner decision.
 * - Fail-closed, no fail-open path: an unrecognized enabled
 *   value enforces (never disables); an invalid numeric value
 *   falls back to the default (never 0, never unlimited); a
 *   counter-store failure refuses the run with
 *   UserRequestQuotaUnavailableError (never an uncounted run).
 * - Charge at acceptance, before any work: a run refused at
 *   the gate charges nothing; an accepted run that later fails
 *   still consumed its slot (acceptance consumed capacity).
 *   A crash between the per-window writes leaves partial
 *   charges; a retry with the same run id charges only the
 *   missing windows, never double-charges any window.
 * - Tenant scope: every charge carries (tenantId, userLogin).
 *   The gate enforces per-user counters partitioned by tenant;
 *   one tenant's usage can never consume another's (proven by
 *   the isolation tests). A tenant-TOTAL cap is NOT enforced
 *   here: it needs a cross-user sum no per-owner instance can
 *   see. Production tenantId defaults to the run owner's login
 *   (the #2426 partition rule) when the caller supplies none.
 */
import type {
  UserRequestQuotaOverride,
  UserRequestQuotaOverrideInput,
  UserRequestQuotaPort,
  UserRequestQuotaWindowKind,
} from "../data/userRequestQuotaPorts";

export type { UserRequestQuotaWindowKind };

export const USER_REQUEST_QUOTA_WINDOWS: UserRequestQuotaWindowKind[] = [
  "daily",
  "weekly",
  "monthly",
];

/** Initial value set, all tiers, PENDING CBO/owner decision. */
export const DEFAULT_USER_REQUEST_QUOTA = {
  daily: 10,
  weekly: 70,
  monthly: 300,
} as const;

export interface UserRequestQuotaPolicy {
  enabled: boolean;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface ResolvedUserRequestQuota extends UserRequestQuotaPolicy {
  /** Env keys that were invalid and fell back (never silent). */
  invalid: string[];
}

const ENV_KEYS = {
  enabled: "USER_REQUEST_QUOTA_ENABLED",
  daily: "USER_REQUEST_QUOTA_DAILY",
  weekly: "USER_REQUEST_QUOTA_WEEKLY",
  monthly: "USER_REQUEST_QUOTA_MONTHLY",
} as const;

function parseLimit(raw: unknown, fallback: number): { value: number; valid: boolean } {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return { value: raw, valid: true };
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return { value: n, valid: true };
  }
  return { value: fallback, valid: false };
}

/**
 * Resolve the quota policy from env. Unset numeric keys keep the
 * defaults silently (they are defaults, not misconfiguration);
 * PRESENT-but-invalid keys fall back AND are named in `invalid`.
 * An unrecognized enabled value fails closed to enabled.
 */
export function resolveUserRequestQuota(
  env: unknown,
): ResolvedUserRequestQuota {
  const record = (env ?? {}) as Record<string, unknown>;
  const invalid: string[] = [];
  const daily = parseLimit(record[ENV_KEYS.daily], DEFAULT_USER_REQUEST_QUOTA.daily);
  const weekly = parseLimit(record[ENV_KEYS.weekly], DEFAULT_USER_REQUEST_QUOTA.weekly);
  const monthly = parseLimit(record[ENV_KEYS.monthly], DEFAULT_USER_REQUEST_QUOTA.monthly);
  if (record[ENV_KEYS.daily] !== undefined && !daily.valid) invalid.push(ENV_KEYS.daily);
  if (record[ENV_KEYS.weekly] !== undefined && !weekly.valid) invalid.push(ENV_KEYS.weekly);
  if (record[ENV_KEYS.monthly] !== undefined && !monthly.valid) invalid.push(ENV_KEYS.monthly);
  const rawEnabled = record[ENV_KEYS.enabled];
  const enabled =
    rawEnabled === undefined
      ? true
      : rawEnabled === false || rawEnabled === "false"
        ? false
        : rawEnabled === true || rawEnabled === "true"
          ? true
          : true; // Unrecognized: fail closed to enforced.
  if (
    rawEnabled !== undefined &&
    rawEnabled !== true &&
    rawEnabled !== false &&
    rawEnabled !== "true" &&
    rawEnabled !== "false"
  ) {
    invalid.push(ENV_KEYS.enabled);
  }
  return { enabled, daily: daily.value, weekly: weekly.value, monthly: monthly.value, invalid };
}

// ---------------------------------------------------------------------------
// Phase 0 kind matrix (verified from code, not assumed)
// ---------------------------------------------------------------------------

export type QuotaConsumptionVerdict = "consumes" | "consumes-deferred" | "no-charge";

export interface QuotaKindVerdict {
  verdict: QuotaConsumptionVerdict;
  reason: string;
}

const KIND_MATRIX: Record<string, QuotaKindVerdict> = {
  screen: {
    verdict: "consumes",
    reason:
      "ScreenerAgent.runScreen is the one funnel for manual, scheduled, Trigger-Now, workflow-child, NLQ-with-screen, and A2A screen runs.",
  },
  goalScreen: {
    verdict: "consumes",
    reason:
      "ScreenerAgent.runGoalScreen produces goal-screen report artifacts (PDF/CSV/XLSX) from a goal-driven screen.",
  },
  research: {
    verdict: "consumes-deferred",
    reason:
      "Options-research publish runs genuinely produce reports, but their run path lives in the per-login OrchestratorAgent instance; a second counter store there would split the per-user pool, so enforcement is carried to a shared-counter follow-up and research runs are NOT silently counted here.",
  },
  "discovery-download": {
    verdict: "no-charge",
    reason: "Serves a stored discovery-report artifact by key; no run executes.",
  },
  "report-read": {
    verdict: "no-charge",
    reason: "Reads (getLatest/getHistory/report download) serve stored results; no run executes.",
  },
  chat: {
    verdict: "no-charge",
    reason: "Chat turns are not report runs. An NLQ turn that runs a screen charges via runScreen.",
  },
  "nlq-no-screen": {
    verdict: "no-charge",
    reason: "An NLQ turn that executes no screen produces no report run.",
  },
  "orchestrator-job": {
    verdict: "no-charge",
    reason: "Orchestrator jobs are execution containers, not report runs; a job's screen shard charges via runScreen.",
  },
  "workflow-no-screen": {
    verdict: "no-charge",
    reason: "Workflows without a screen leg produce no report run; a screen shard charges via runScreen.",
  },
  "goal-tick-no-report": {
    verdict: "no-charge",
    reason: "A goal tick that fires no screen (budget-rejected, skipped, non-screen goal) produces no report.",
  },
  "scheduled-report-store": {
    verdict: "no-charge",
    reason: "storeReportAtGeneration is the #308 storage seam delivering an already-generated report's canonical copy, not a run.",
  },
};

/** Closed list: anything not enumerated here does not consume quota. */
export function quotaConsumptionVerdict(kind: string): QuotaKindVerdict {
  return (
    KIND_MATRIX[kind] ?? {
      verdict: "no-charge" as const,
      reason: "Kind is not enumerated in the Phase 0 matrix; unenumerated kinds never consume.",
    }
  );
}

// ---------------------------------------------------------------------------
// UTC calendar windows
// ---------------------------------------------------------------------------

export interface QuotaWindowBounds {
  startMs: number;
  endMs: number;
  resetAtMs: number;
  resetAtIso: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Window key for a moment: D:YYYY-MM-DD, W:YYYY-MM-DD (Monday), M:YYYY-MM. */
export function quotaWindowKey(window: UserRequestQuotaWindowKind, nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (window === "daily") return `D:${y}-${pad(m + 1)}-${pad(day)}`;
  if (window === "monthly") return `M:${y}-${pad(m + 1)}`;
  // Weekly: back up to Monday 00:00 UTC.
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  const monday = new Date(Date.UTC(y, m, day - back));
  return `W:${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

export function quotaWindowBounds(
  window: UserRequestQuotaWindowKind,
  nowMs: number,
): QuotaWindowBounds {  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  let startMs: number;
  let endMs: number;
  if (window === "daily") {
    startMs = Date.UTC(y, m, day);
    endMs = Date.UTC(y, m, day + 1);
  } else if (window === "monthly") {
    startMs = Date.UTC(y, m, 1);
    endMs = Date.UTC(y, m + 1, 1);
  } else {
    const dow = d.getUTCDay();
    const back = (dow + 6) % 7;
    startMs = Date.UTC(y, m, day - back);
    endMs = startMs + 7 * 24 * 60 * 60 * 1000;
  }
  return { startMs, endMs, resetAtMs: endMs, resetAtIso: new Date(endMs).toISOString() };
}

/** End (exclusive) of the window a key names; throws on an unparseable key. */
export function quotaWindowEndForKey(
  window: UserRequestQuotaWindowKind,
  windowKey: string,
): number {
  let m: RegExpMatchArray | null;
  if (window === "daily") {
    m = windowKey.match(/^D:(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`Invalid daily quota window key: ${windowKey}`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  }
  if (window === "monthly") {
    m = windowKey.match(/^M:(\d{4})-(\d{2})$/);
    if (!m) throw new Error(`Invalid monthly quota window key: ${windowKey}`);
    return Date.UTC(Number(m[1]), Number(m[2]), 1);
  }
  m = windowKey.match(/^W:(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid weekly quota window key: ${windowKey}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + 7 * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Errors: the message carries the fields, because DO RPC drops class
// fields — the #2840 screenAlreadyRunningDetails pattern, applied to
// quota (routes parse the message back; see quotaExceededDetails).
// ---------------------------------------------------------------------------

export class UserRequestQuotaExceededError extends Error {
  readonly window: UserRequestQuotaWindowKind;
  readonly limit: number;
  readonly usage: number;
  readonly resetAtMs: number;
  readonly resetAtIso: string;
  readonly runId: string;
  constructor(input: {
    window: UserRequestQuotaWindowKind;
    limit: number;
    usage: number;
    resetAtMs: number;
    runId: string;
  }) {
    const resetAtIso = new Date(input.resetAtMs).toISOString();
    super(
      `User request quota exceeded: ${input.window} limit ${input.limit} used ${input.usage} resets ${resetAtIso} (run ${input.runId})`,
    );
    this.name = "UserRequestQuotaExceededError";
    this.window = input.window;
    this.limit = input.limit;
    this.usage = input.usage;
    this.resetAtMs = input.resetAtMs;
    this.resetAtIso = resetAtIso;
    this.runId = input.runId;
  }
}

export class UserRequestQuotaUnavailableError extends Error {
  constructor(detail: string) {
    super(`User request quota unavailable: ${detail}`);
    this.name = "UserRequestQuotaUnavailableError";
  }
}

export interface QuotaExceededDetails {
  window: UserRequestQuotaWindowKind;
  limit: number;
  usage: number;
  resetAtMs: number;
  resetAtIso: string;
  runId: string | null;
}

/** Parse limit/usage/reset back out of an exceeded message (RPC-safe). */
export function quotaExceededDetails(error: unknown): QuotaExceededDetails | null {
  if (error instanceof UserRequestQuotaExceededError) {
    return {
      window: error.window,
      limit: error.limit,
      usage: error.usage,
      resetAtMs: error.resetAtMs,
      resetAtIso: error.resetAtIso,
      runId: error.runId,
    };
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.includes("quota exceeded")) return null;
  const match = message.match(
    /User request quota exceeded: (daily|weekly|monthly) limit (\d+) used (\d+) resets (\S+)(?: \(run (\S+)\))?/,
  );
  if (!match) return null;
  const resetAtMs = Date.parse(match[4]);
  if (!Number.isFinite(resetAtMs)) return null;
  return {
    window: match[1] as UserRequestQuotaWindowKind,
    limit: Number(match[2]),
    usage: Number(match[3]),
    resetAtMs,
    resetAtIso: match[4],
    runId: match[5] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Gate + usage view (synchronous over the port: no await intervenes)
// ---------------------------------------------------------------------------

export interface QuotaGateInput {
  port: UserRequestQuotaPort;
  policy: UserRequestQuotaPolicy;
  tenantId: string;
  userLogin: string;
  kind: string;
  runId: string;
  nowMs?: number;
}

export interface QuotaGateOutcome {
  charged: boolean;
  alreadyCounted?: boolean;
  skipped?: "disabled" | "no-charge";
  usage: Partial<Record<UserRequestQuotaWindowKind, number>>;
}

function activeOverrides(
  overrides: UserRequestQuotaOverride[],
  nowMs: number,
): UserRequestQuotaOverride[] {
  return overrides.filter((o) => o.expiresMs === null || o.expiresMs > nowMs);
}

/**
 * Enforce-before-run gate. Probes all three windows first (no
 * writes), refuses on the first over window (daily, then weekly,
 * then monthly) without charging anything, then charges only the
 * windows that do not already hold this run id. A port throw at
 * any point fails closed as quota-unavailable.
 */
export function checkAndChargeUserRequestQuota(input: QuotaGateInput): QuotaGateOutcome {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.policy.enabled) return { charged: false, skipped: "disabled", usage: {} };
  if (quotaConsumptionVerdict(input.kind).verdict !== "consumes") {
    return { charged: false, skipped: "no-charge", usage: {} };
  }
  try {
    input.port.ensureSchema();
    const probes = USER_REQUEST_QUOTA_WINDOWS.map((window) => {
      const bounds = quotaWindowBounds(window, nowMs);
      const probe = input.port.probe({
        tenantId: input.tenantId,
        userLogin: input.userLogin,
        windowKind: window,
        windowKey: quotaWindowKey(window, nowMs),
        runId: input.runId,
        nowMs,
      });
      const limit = input.policy[window] + activeOverrides(probe.overrides, nowMs).reduce((s, o) => s + o.extraRuns, 0);
      return { window, bounds, probe, limit };
    });
    for (const p of probes) {
      if (!p.probe.alreadyCounted && p.probe.usage >= p.limit) {
        throw new UserRequestQuotaExceededError({
          window: p.window,
          limit: p.limit,
          usage: p.probe.usage,
          resetAtMs: p.bounds.resetAtMs,
          runId: input.runId,
        });
      }
    }
    const usage: Partial<Record<UserRequestQuotaWindowKind, number>> = {};
    let anyCharged = false;
    let allCounted = true;
    for (const p of probes) {
      if (p.probe.alreadyCounted) {
        usage[p.window] = p.probe.usage;
        continue;
      }
      allCounted = false;
      const charged = input.port.chargeWindow({
        tenantId: input.tenantId,
        userLogin: input.userLogin,
        windowKind: p.window,
        windowKey: quotaWindowKey(p.window, nowMs),
        kind: input.kind,
        runId: input.runId,
        nowMs,
      });
      usage[p.window] = charged.usage;
      anyCharged = true;
    }
    return { charged: anyCharged, alreadyCounted: allCounted && !anyCharged ? true : undefined, usage };
  } catch (err) {
    if (err instanceof UserRequestQuotaExceededError) throw err;
    throw new UserRequestQuotaUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

export interface QuotaWindowUsage {
  window: UserRequestQuotaWindowKind;
  limit: number;
  usage: number;
  remaining: number;
  resetAtMs: number;
  resetAtIso: string;
  overrides: UserRequestQuotaOverride[];
}

export interface QuotaUsageView {
  tenantId: string;
  userLogin: string;
  daily: QuotaWindowUsage;
  weekly: QuotaWindowUsage;
  monthly: QuotaWindowUsage;
}

export function getUserRequestQuotaUsage(input: {
  port: UserRequestQuotaPort;
  policy: UserRequestQuotaPolicy;
  tenantId: string;
  userLogin: string;
  nowMs?: number;
}): QuotaUsageView {
  const nowMs = input.nowMs ?? Date.now();
  try {
    input.port.ensureSchema();
  } catch (err) {
    throw new UserRequestQuotaUnavailableError(err instanceof Error ? err.message : String(err));
  }
  const view = {} as Record<UserRequestQuotaWindowKind, QuotaWindowUsage>;
  for (const window of USER_REQUEST_QUOTA_WINDOWS) {
    const bounds = quotaWindowBounds(window, nowMs);
    let probe;
    try {
      probe = input.port.probe({
        tenantId: input.tenantId,
        userLogin: input.userLogin,
        windowKind: window,
        windowKey: quotaWindowKey(window, nowMs),
        nowMs,
      });
    } catch (err) {
      throw new UserRequestQuotaUnavailableError(err instanceof Error ? err.message : String(err));
    }
    const overrides = activeOverrides(probe.overrides, nowMs);
    const limit = input.policy[window] + overrides.reduce((s, o) => s + o.extraRuns, 0);
    view[window] = {
      window,
      limit,
      usage: probe.usage,
      remaining: Math.max(0, limit - probe.usage),
      resetAtMs: bounds.resetAtMs,
      resetAtIso: bounds.resetAtIso,
      overrides,
    };
  }
  return { tenantId: input.tenantId, userLogin: input.userLogin, ...view };
}

/** Validate an admin override grant; throws Error naming the bad field (route maps to 400). */
export function validateQuotaOverrideInput(input: {
  tenantId: unknown;
  userLogin: unknown;
  windowKind: unknown;
  windowKey: unknown;
  extraRuns: unknown;
  grantedBy: unknown;
  reason: unknown;
}): UserRequestQuotaOverrideInput {
  const fail = (field: string): never => {
    throw new Error(`Invalid quota override: ${field}`);
  };
  if (typeof input.tenantId !== "string" || input.tenantId.trim() === "") fail("tenantId");
  if (typeof input.userLogin !== "string" || input.userLogin.trim() === "") fail("userLogin");
  if (
    input.windowKind !== "daily" &&
    input.windowKind !== "weekly" &&
    input.windowKind !== "monthly"
  ) {
    fail("windowKind");
  }
  if (typeof input.windowKey !== "string" || input.windowKey.trim() === "") fail("windowKey");
  if (typeof input.extraRuns !== "number" || !Number.isInteger(input.extraRuns) || input.extraRuns < 1) {
    fail("extraRuns");
  }
  if (typeof input.grantedBy !== "string" || input.grantedBy.trim() === "") fail("grantedBy");
  if (typeof input.reason !== "string" || input.reason.trim() === "") fail("reason");
  return {
    tenantId: input.tenantId as string,
    userLogin: input.userLogin as string,
    windowKind: input.windowKind as UserRequestQuotaWindowKind,
    windowKey: input.windowKey as string,
    extraRuns: input.extraRuns as number,
    grantedBy: input.grantedBy as string,
    reason: input.reason as string,
    createdMs: Date.now(),
    expiresMs: null,
  };
}
