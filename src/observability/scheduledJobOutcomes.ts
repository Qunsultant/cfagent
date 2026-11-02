/**
 * Issue Qunsultant/cfagent#2037 — internal-dispatch observability for
 * the scheduled jobs that ride the 30-minute tick (research, reflection,
 * adaptation).
 *
 * The 2026-10-27 reflection-dispatch exception was invisible to our
 * own systems: the Worker fetch wrapper (#1743) never sees a DO stub
 * fetch, scheduled() fire-and-forgets without catching, and even a
 * Tuesday skip leaves no record anywhere except Cloudflare logs.
 *
 * This module is the cloud-agnostic core (no Worker/DO imports; all
 * sinks are injected):
 *
 * - ONE outcome sink: mas_events rows of type
 *   `scheduled_job.outcome`, payload { job, outcome, traceId,
 *   errorCode?, reason? }. Never a second audit system. The rows
 *   are retrievable through the existing GET /audit read route
 *   (a record that cannot be read is not an audit record, #1968).
 * - Codes, never messages: error events and outcome rows carry a
 *   short error code only. AE keeps the #1743 no-message rule;
 *   the dashboard remains the source for the cause (stack).
 * - Repeat alerting: a failed outcome counts the job's consecutive
 *   failure streak from the sink itself (no second store, no
 *   SessionStore counter — the #1819 quota lesson rules that out);
 *   the existing Slack route fires when the streak hits the
 *   configured threshold, and again at every further multiple.
 * - Dispatch observation: observeInternalDispatch wraps a stub
 *   fetch promise with the #1743 withObservability interceptor,
 *   so a rejected dispatch emits an AE error event correlated to
 *   its tick trace, then records the failure through the sink.
 *   A 500 Response is NOT a dispatch failure — the DO handler
 *   already recorded that outcome; recording it again here would
 *   double-count one failure.
 */
import { withObservability } from "./aspects";
import type {
  ObservabilitySink,
  TraceContext,
} from "./observabilityPorts";

/** The single outcome sink type in mas_events. */
export const SCHEDULED_JOB_OUTCOME_TYPE = "scheduled_job.outcome";

export type ScheduledJobId = "reflection" | "research" | "adaptation";
export type ScheduledJobOutcomeValue = "ran" | "skipped" | "failed";

const SCHEDULED_JOB_IDS: readonly ScheduledJobId[] = [
  "reflection",
  "research",
  "adaptation",
];

const SCHEDULED_JOB_OUTCOMES: readonly ScheduledJobOutcomeValue[] = [
  "ran",
  "skipped",
  "failed",
];

export function isScheduledJobId(value: unknown): value is ScheduledJobId {
  return (
    typeof value === "string" &&
    (SCHEDULED_JOB_IDS as readonly string[]).includes(value)
  );
}

function isScheduledJobOutcome(
  value: unknown,
): value is ScheduledJobOutcomeValue {
  return (
    typeof value === "string" &&
    (SCHEDULED_JOB_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The three scheduled-job dispatches, by DO route path. Only these
 * ride the onRequest-tail observability wrap: wrapping every DO
 * route would multiply AE volume for all API traffic.
 */
export function isScheduledJobDispatchPath(
  path: string,
  method: string,
): boolean {
  if (method !== "POST") return false;
  return (
    path.endsWith("/reflection/run") ||
    path.endsWith("/research/scheduled-tick") ||
    path.endsWith("/adaptation/weights/run")
  );
}

/**
 * Error codes are short tokens, never prose. Anything shaped like a
 * message (whitespace, overlong, non-string) degrades to "unknown"
 * rather than leaking message text into AE or audit rows.
 */
export function sanitizeScheduledJobErrorCode(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return "unknown";
  if (/\s/.test(trimmed)) return "unknown";
  return trimmed;
}

export interface ScheduledJobOutcomeInput {
  job: ScheduledJobId;
  outcome: ScheduledJobOutcomeValue;
  /** Tick trace id, or null when the dispatch carried no trace. */
  traceId: string | null;
  /** Failed only; sanitized to a code on build. */
  errorCode?: string;
  /** Skipped only; an internal skip reason, capped, never a message. */
  reason?: string;
}

export interface ScheduledJobOutcomePayload {
  job: ScheduledJobId;
  outcome: ScheduledJobOutcomeValue;
  traceId: string | null;
  errorCode?: string;
  reason?: string;
}

export function buildScheduledJobOutcomePayload(
  input: ScheduledJobOutcomeInput,
): ScheduledJobOutcomePayload {
  const payload: ScheduledJobOutcomePayload = {
    job: input.job,
    outcome: input.outcome,
    traceId:
      typeof input.traceId === "string" && /^[0-9a-f]{32}$/.test(input.traceId)
        ? input.traceId
        : null,
  };
  if (input.outcome === "failed") {
    payload.errorCode = sanitizeScheduledJobErrorCode(input.errorCode);
  }
  if (
    input.outcome === "skipped" &&
    typeof input.reason === "string" &&
    input.reason.trim().length > 0 &&
    input.reason.length <= 64
  ) {
    payload.reason = input.reason;
  }
  return payload;
}

/** Minimal store surface the streak logic needs (mas_events via ORM). */
export interface ScheduledJobOutcomeStore {
  writeOutcome(input: ScheduledJobOutcomeInput): void | Promise<void>;
  /**
   * Newest-first outcome rows, bounded: the caller asks for at most
   * maxRows because a streak decision never needs more than the
   * threshold's worth of one job's rows among the three jobs'
   * interleaved rows. Unbounded reads over a growing mas_events
   * table would turn every tick into a full-table scan.
   */
  recentOutcomes(maxRows: number): Array<{
    job: string;
    outcome: string;
    createdAt: string;
  }> | Promise<
    Array<{ job: string; outcome: string; createdAt: string }>
  >;
}

/**
 * Parse one mas_events row back into a streak row. Payloads arrive
 * as objects (DO SQLite adapter) or JSON strings (other adapters);
 * anything else is not an outcome row.
 */
export function parseScheduledJobOutcomeRow(row: {
  payload?: unknown;
  createdAt?: string;
  created_at?: string;
}): { job: string; outcome: string; createdAt: string } | null {
  let parsed: Record<string, unknown> | null = null;
  if (row.payload && typeof row.payload === "object") {
    parsed = row.payload as Record<string, unknown>;
  } else if (typeof row.payload === "string") {
    try {
      parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (
    !parsed ||
    typeof parsed.job !== "string" ||
    typeof parsed.outcome !== "string"
  ) {
    return null;
  }
  return {
    job: parsed.job,
    outcome: parsed.outcome,
    createdAt: row.createdAt ?? row.created_at ?? "",
  };
}

/**
 * Build a store over an ORM events port. The getters are lazy on
 * purpose: a handler passes `() => ctx.getOrm().events` and any
 * failure surfaces inside recordScheduledJobOutcome's guarded
 * paths (streak fallback, recorded:false) instead of failing the
 * response the handler owes its caller.
 */
export function scheduledJobOutcomeStoreFromOrmEvents(
  getEvents: () => {
    create?: unknown;
    findMany?: unknown;
  } | null | undefined,
  sessionId = "",
): ScheduledJobOutcomeStore {
  return {
    writeOutcome: async (entry) => {
      const events = getEvents() as {
        create: (row: Record<string, unknown>) => void | Promise<void>;
      };
      await events.create({
        id: crypto.randomUUID(),
        sessionId,
        type: SCHEDULED_JOB_OUTCOME_TYPE,
        agent: "orchestrator",
        payload: buildScheduledJobOutcomePayload(entry),
        createdAt: new Date().toISOString(),
      });
    },
    recentOutcomes: async (maxRows) => {
      const events = getEvents() as {
        findMany: (options: {
          where: { type: string };
          orderBy?: string;
          limit?: number;
        }) => Array<{
          payload?: unknown;
          createdAt?: string;
          created_at?: string;
        }> | Promise<
          Array<{
            payload?: unknown;
            createdAt?: string;
            created_at?: string;
          }>
        >;
      };
      const rows = await events.findMany({
        where: { type: SCHEDULED_JOB_OUTCOME_TYPE },
        orderBy: "created_at DESC",
        limit: maxRows,
      });
      return rows
        .map(parseScheduledJobOutcomeRow)
        .filter(
          (row): row is { job: string; outcome: string; createdAt: string } =>
            row !== null,
        );
    },
  };
}

export interface RecordScheduledJobOutcomeResult {
  recorded: boolean;
  streak: number;
  alerted: boolean;
}

/**
 * Record one job outcome in the single sink and, for failures,
 * count the job's consecutive-failure streak from the sink's own
 * recent rows (newest first, stopping at the first non-failure).
 * Alerts at streak == threshold and at every further multiple.
 * Never throws: a failed write or alert is reported, not raised —
 * observation must never fail the tick it observes.
 */
export async function recordScheduledJobOutcome(
  deps: {
    store: ScheduledJobOutcomeStore;
    alert: (text: string) => void | Promise<void>;
    threshold: number;
  },
  input: ScheduledJobOutcomeInput,
): Promise<RecordScheduledJobOutcomeResult> {
  if (!isScheduledJobId(input.job) || !isScheduledJobOutcome(input.outcome)) {
    return { recorded: false, streak: 0, alerted: false };
  }
  const payload = buildScheduledJobOutcomePayload(input);
  let streak = 0;
  if (input.outcome === "failed") {
    // Bound: three jobs interleave one row per tick, so a job's
    // threshold-th newest row sits within 3*threshold rows (+4
    // margin); the store orders newest-first, so the leading
    // failures in that window decide the streak.
    const maxRows =
      deps.threshold > 0 ? deps.threshold * 3 + 4 : 4;
    try {
      const recent = (await deps.store.recentOutcomes(maxRows)) ?? [];
      const mine = recent
        .filter((row) => row.job === input.job)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      let leading = 0;
      for (const row of mine) {
        if (row.outcome === "failed") leading += 1;
        else break;
      }
      streak = 1 + leading;
    } catch (err) {
      console.warn(
        `[scheduled-job-outcome] streak read failed for ${input.job} (recording stands):`,
        err,
      );
      streak = 1;
    }
  }
  try {
    await deps.store.writeOutcome(input);
  } catch (err) {
    console.warn(
      `[scheduled-job-outcome] outcome write failed for ${input.job}:`,
      err,
    );
    return { recorded: false, streak, alerted: false };
  }
  if (
    input.outcome !== "failed" ||
    deps.threshold <= 0 ||
    streak < deps.threshold ||
    streak % deps.threshold !== 0
  ) {
    return { recorded: true, streak, alerted: false };
  }
  const text =
    `Scheduled job ${input.job} failed ${streak} consecutive ticks ` +
    `(threshold ${deps.threshold}); latest trace ${payload.traceId ?? "n/a"}; ` +
    `error code ${payload.errorCode ?? "unknown"}. ` +
    `Outcome records: mas_events type ${SCHEDULED_JOB_OUTCOME_TYPE}.`;
  try {
    await deps.alert(text);
    return { recorded: true, streak, alerted: true };
  } catch (err) {
    console.warn(
      `[scheduled-job-outcome] alert delivery failed for ${input.job}:`,
      err,
    );
    return { recorded: true, streak, alerted: false };
  }
}

export interface DispatchObservationDeps {
  job: ScheduledJobId;
  sink: ObservabilitySink;
  trace: TraceContext;
  /** Records the failure through the single sink (DO outcome route). */
  recordFailure: (input: ScheduledJobOutcomeInput) => void | Promise<void>;
  /** Fail-loud fallback when even the outcome record is unreachable. */
  alertUnreachable: (
    job: ScheduledJobId,
    trace: TraceContext,
  ) => void | Promise<void>;
}

/**
 * Observe one internal dispatch promise. Success (any Response,
 * including 5xx — the DO handler already recorded that outcome)
 * emits one AE info event correlated to the tick trace. Rejection
 * emits one AE error event (code, never message, via the #1743
 * interceptor), then records the failure; if the record itself is
 * unreachable, the fail-loud Slack alert fires. Never rejects.
 */
export async function observeInternalDispatch(
  promise: Promise<unknown>,
  deps: DispatchObservationDeps,
): Promise<void> {
  try {
    await withObservability(
      {
        sink: deps.sink,
        operation: "worker.internal_dispatch",
        trace: deps.trace,
        fields: { job: deps.job, layer: "worker_dispatch" },
      },
      () => promise,
    );
    return;
  } catch (err) {
    const errorCode = sanitizeScheduledJobErrorCode(
      (err as { code?: unknown } | null)?.code,
    );
    try {
      await deps.recordFailure({
        job: deps.job,
        outcome: "failed",
        traceId: deps.trace.traceId,
        errorCode,
      });
    } catch {
      try {
        await deps.alertUnreachable(deps.job, deps.trace);
      } catch (alertErr) {
        console.warn(
          `[scheduled-job-outcome] fail-loud alert failed for ${deps.job}:`,
          alertErr,
        );
      }
    }
  }
}
