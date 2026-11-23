/**
 * Issue #2964 — pure per-run record domain code: builder with
 * validation, newest-first cap prune, and the schedule-run identity
 * resolvers shared by the orchestrator method wrappers and the
 * trigger route. No storage, no imports from the data layer beyond
 * the record types (the same direction as scheduleManagement.ts
 * importing its types from the paused-schedule port).
 *
 * Validation is the honesty gate: a failure without error text and
 * a skip without a reason cannot be constructed, so a silent skip
 * or silent failure is unrepresentable, not just discouraged.
 */
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  normalizeJobRunKind,
  type JobRunKind,
  type JobRunLedgerTrigger,
  type JobRunOutcome,
  type JobRunRecord,
  type JobRunSystem,
  type JobRunTrigger,
} from "../data/jobRunRecordPorts";
import {
  isLedgerTrigger,
  isMissingIdLiteral,
  normalizeLedgerLinkage,
  resolveLedgerTrigger,
} from "./consolidatedScheduling";
import { RENEWAL_DISPATCH_CRON, RETENTION_DISPATCH_CRON, RETENTION_RECORD_ID, TOKEN_RENEWAL_RECORD_ID } from "./heartbeatDueChecks";
import { SCHEDULE_WATCHDOG_RECORD_ID } from "./sweepWatchdogSchedule";
import { SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID } from "./scheduleWatchdog";

export type {
  JobRunLedgerTrigger,
  JobRunOutcome,
  JobRunRecord,
  JobRunSystem,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";

// Issue #3650 — the one missing-id-literal definition, re-exported
// for the ledger cell (the panel's only import surface for it).
export { isMissingIdLiteral } from "./consolidatedScheduling";

export { JOB_RUN_RECORDS_PER_JOB_CAP } from "../data/jobRunRecordPorts";

/** Newest-first records kept for the ScheduledAgent's own key. */
export const SCHEDULED_AGENT_JOB_RUN_CAP = 500;

/** Default list limit for run-history reads. */
export const JOB_RUN_LIST_DEFAULT_LIMIT = 50;

export type JobRunRecordInput = Omit<JobRunRecord, "system"> & {
  system: JobRunSystem;
};

const SYSTEMS: readonly string[] = [
  "scheduled-agent-goal",
  "orchestrator-schedule",
  // Issue #3534 (Pipeline J1) — pipeline jobs record through this machinery.
  "job-pipeline",
  // Issue #3121 S6 (S5 decision 9 follow-up) — Worker-cron dispatches
  // record through this machinery. Admitted now that #3650 has landed
  // (Qunsultant/cfagent#3723); the S5 restamp in `buildCronDispatchRecord`
  // is retained as-is (explicit system, zero behavior change).
  "worker-cron",
];
const OUTCOMES: readonly string[] = ["success", "failure", "skipped"];
const TRIGGERS: readonly string[] = [
  "scheduled",
  "manual",
  "triggered",
  "copilot",
  "autopilot",
];

/**
 * Build and validate a run record. Throws on: unknown system /
 * outcome / trigger, empty jobId or operation, unparseable dates,
 * finished before started, failure without error text, skip
 * without a detail reason.
 *
 * Issue #3121 S1 — the §4 consolidated-ledger linkage: `trigger`,
 * `scheduleId`, `asyncJobId`, `workflowId` are stamped on every NEW
 * row (extended, not a rewrite). An explicit `trigger` must be a
 * valid ledger trigger and is never `"unknown"` (unknown is
 * legacy-rows-only — a new row that cannot name its path derives
 * from `triggeredBy` instead, so no new row is ever unknown or
 * null); an absent `trigger` derives from `triggeredBy` via
 * `resolveLedgerTrigger`. Absent linkage ids default to explicit
 * nulls (a recorded fact, never a missing column).
 */
export function buildJobRunRecord(input: JobRunRecordInput): JobRunRecord {
  if (!SYSTEMS.includes(input.system)) {
    throw new Error(`Unknown job run system: ${String(input.system)}`);
  }
  if (!input.jobId || !input.jobId.trim() || isMissingIdLiteral(input.jobId)) {
    throw new Error(
      'Job run jobId is required: a literal "undefined"/"null" id is a missing id, never a real one (#3650).',
    );
  }
  if (!input.operation || !input.operation.trim()) {
    throw new Error("Job run operation is required.");
  }
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error(`Unknown job run outcome: ${String(input.outcome)}`);
  }
  if (!TRIGGERS.includes(input.triggeredBy)) {
    throw new Error(`Unknown job run trigger: ${String(input.triggeredBy)}`);
  }
  let trigger: JobRunLedgerTrigger;
  if (input.trigger !== undefined) {
    if (!isLedgerTrigger(input.trigger)) {
      throw new Error(`Unknown job run ledger trigger: ${String(input.trigger)}`);
    }
    if (input.trigger === "unknown") {
      throw new Error(
        'A new job run record cannot carry trigger "unknown": unknown is legacy rows only; derive from triggeredBy instead.',
      );
    }
    trigger = input.trigger;
  } else {
    trigger = resolveLedgerTrigger(undefined, input.triggeredBy);
  }
  for (const key of ["scheduleId", "asyncJobId", "workflowId", "originRunId"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`Job run ${key} must be a string or null.`);
    }
    if (typeof value === "string" && !value.trim()) {
      throw new Error(`Job run ${key} must be a non-empty string or null.`);
    }
    // Issue #3650 — a poisoned literal is a missing id stringified
    // upstream, never a real linkage id; the honesty gate rejects it
    // rather than stamping it onto a new row.
    if (typeof value === "string" && isMissingIdLiteral(value)) {
      throw new Error(
        `Job run ${key} must be a real id or null: a literal "undefined"/"null" id is a missing id (#3650).`,
      );
    }
  }
  // Issue #5102 (F5 of #5094): the binding tuple fields validate
  // exactly like the linkage ids — a string-or-null, non-empty, real
  // id, never a poisoned literal (#3650). The tuple is optional on
  // the input (legacy call sites omit it); when present it must be
  // a real value, never a stringified missing id.
  for (const key of ["accountType", "accountId", "bindingScope", "bindingSource"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`Job run ${key} must be a string or null.`);
    }
    if (typeof value === "string" && !value.trim()) {
      throw new Error(`Job run ${key} must be a non-empty string or null.`);
    }
    if (typeof value === "string" && isMissingIdLiteral(value)) {
      throw new Error(
        `Job run ${key} must be a real id or null: a literal "undefined"/"null" id is a missing id (#3650).`,
      );
    }
  }
  // Issue #5887 — the definition version a run executed with is a
  // non-negative integer or an explicit null (a row written before the
  // stamp). Anything else is a bug at the call site, not a value to store.
  if (
    input.definitionVersion !== undefined &&
    input.definitionVersion !== null &&
    (!Number.isInteger(input.definitionVersion) || input.definitionVersion < 0)
  ) {
    throw new Error("Job run definitionVersion must be a non-negative integer or null.");
  }
  const startedMs = Date.parse(input.started);
  const finishedMs = Date.parse(input.finished);
  if (!Number.isFinite(startedMs)) {
    throw new Error(`Job run started is not an ISO timestamp: ${input.started}`);
  }
  if (!Number.isFinite(finishedMs)) {
    throw new Error(`Job run finished is not an ISO timestamp: ${input.finished}`);
  }
  if (finishedMs < startedMs) {
    throw new Error("Job run finished precedes started.");
  }
  if (input.outcome === "failure" && (!input.error || !input.error.trim())) {
    throw new Error("A failed job run requires error text.");
  }
  if (input.outcome === "skipped" && (!input.detail || !input.detail.trim())) {
    throw new Error("A skipped job run requires a detail reason.");
  }
  return {
    system: input.system,
    jobId: input.jobId,
    operation: input.operation,
    started: input.started,
    finished: input.finished,
    outcome: input.outcome,
    triggeredBy: input.triggeredBy,
    trigger,
    scheduleId: input.scheduleId ?? null,
    asyncJobId: input.asyncJobId ?? null,
    workflowId: input.workflowId ?? null,
    // Issue #4767 — the run kind and origin link, stamped on
    // every NEW row. An absent kind reads as "original" (a first
    // dispatch); an absent origin reads as null (no lineage).
    kind: normalizeJobRunKind(input.kind),
    originRunId: input.originRunId ?? null,
    definitionVersion: input.definitionVersion ?? null,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.descriptor !== undefined ? { descriptor: input.descriptor } : {}),
    ...(input.artifactRefs !== undefined ? { artifactRefs: input.artifactRefs } : {}),
    // Issue #3655: broker + data-provider + mode provenance.
    ...(input.brokerId !== undefined ? { brokerId: input.brokerId } : {}),
    ...(input.dataProviderId !== undefined ? { dataProviderId: input.dataProviderId } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.modeSource !== undefined ? { modeSource: input.modeSource } : {}),
    // Issue #5100 (F3 of #5094): the binding tuple the run executed against.
    ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.bindingScope !== undefined ? { bindingScope: input.bindingScope } : {}),
    ...(input.bindingSource !== undefined ? { bindingSource: input.bindingSource } : {}),
  };
}

/**
 * Issue #3121 S1 — normalize a run record read back from storage.
 * Rows stored before S1 carry none of the four §4 fields; they read
 * as `trigger: "unknown"` with all three ids null (the §4
 * null-handling rule: a null is a value the ledger stores and the
 * read path renders, never a reason to drop the row). No silent
 * backfill: this normalizes the READ value only and never writes
 * anything back. A record that already carries the fields passes
 * through unchanged.
 *
 * Issue #3650 — the jobId is sanitized the same way: a stored row
 * whose jobId is the literal "undefined"/"null" (a missing id
 * stringified at write or read time — the DO-SQLite adapter's
 * `String(row.job_id)` is the one String() coercion on the read
 * path) reads as jobless (""), never as an id, so the ledger renders
 * it as "—". A missing jobId key reads as jobless too.
 *
 * Issue #4767 — the kind and origin link read the same way: a row
 * stored before #4767 carries neither, so it reads as kind
 * "original" with no origin (a first dispatch — the fail-closed
 * default, never an invented re-run); an origin that is not a
 * real non-empty id reads as null, never as a link.
 */
export function normalizeJobRunRecord(record: JobRunRecord): JobRunRecord {
  const linkage = normalizeLedgerLinkage({
    trigger: record.trigger,
    scheduleId: record.scheduleId,
    asyncJobId: record.asyncJobId,
    workflowId: record.workflowId,
  });
  const jobId =
    typeof record.jobId === "string" &&
    record.jobId.trim() &&
    !isMissingIdLiteral(record.jobId)
      ? record.jobId
      : "";
  const kind = normalizeJobRunKind(record.kind);
  // Issue #5887 — a version that is not a non-negative integer reads as
  // null (pre-retention), never as a guessed number.
  const definitionVersion =
    typeof record.definitionVersion === "number" &&
    Number.isInteger(record.definitionVersion) &&
    record.definitionVersion >= 0
      ? record.definitionVersion
      : null;
  const originRunId =
    typeof record.originRunId === "string" &&
    record.originRunId.trim() &&
    !isMissingIdLiteral(record.originRunId)
      ? record.originRunId
      : null;
  // Issue #5102 (F5 of #5094) — the binding tuple reads the same
  // way: a row stored before F5 carries none of the four fields,
  // so it reads as explicit nulls (unbound), never a guessed
  // binding; a stored value that is not a real non-empty id reads
  // as null, never as a link.
  const binding = (value: unknown): string | null =>
    typeof value === "string" && value.trim() && !isMissingIdLiteral(value)
      ? value
      : null;
  const accountType = binding(record.accountType);
  const accountId = binding(record.accountId);
  const bindingScope = binding(record.bindingScope);
  const bindingSource = binding(record.bindingSource);
  return {
    ...record,
    jobId,
    kind,
    originRunId,
    definitionVersion,
    accountType,
    accountId,
    bindingScope,
    bindingSource,
    ...linkage,
  };
}

/** Keep the newest `cap` records of a newest-first list. */
export function pruneJobRuns(records: JobRunRecord[], cap: number): JobRunRecord[] {
  return records.slice(0, Math.max(0, cap));
}

/**
 * Resolve the job id for an orchestrator schedule run, in priority
 * order: the SDK schedule object's id (SDK firings pass it as the
 * method's second argument — proven from the Agents SDK resolver,
 * which calls method.call(this, payload, schedule)); the
 * payload's scheduleId (the trigger route stamps it on manual
 * triggers); else a callback-scoped fallback, never fabricated
 * as a schedule id (the UI groups those under the callback name).
 */
export function resolveScheduleRunJobId(
  callback: string,
  payload: unknown,
  schedule: { id?: unknown } | undefined,
): string {
  // Issue #3650 — a poisoned literal is absent, never an id: a
  // schedule/payload id of "undefined" falls through to the
  // `callback:<name>` fallback instead of becoming the row's jobId.
  if (
    schedule &&
    typeof schedule.id === "string" &&
    schedule.id &&
    !isMissingIdLiteral(schedule.id)
  ) {
    return schedule.id;
  }
  if (payload && typeof payload === "object") {
    const stamped = (payload as Record<string, unknown>).scheduleId;
    if (typeof stamped === "string" && stamped && !isMissingIdLiteral(stamped)) {
      return stamped;
    }
  }
  return `callback:${callback}`;
}

/**
 * Issue #3121 #4239 — the ledger jobId a Schedules home id
 * reads its runs under. Derived records have no alarm id of
 * their own, so the runs routes cannot read `listByJob(id)`
 * directly: the token-renewal record reads the renewal dispatch
 * rows (jobId = its cron). Every other id reads its own rows.
 * Issue #4240 — the retention record reads the retention
 * dispatch rows the same way (jobId = its cron).
 * Issue #4242 — the watchdog record reads the heartbeat rows its
 * sweeps already write (jobId = schedule-watchdog-heartbeat).
 */
export function scheduleIdToLedgerJobId(scheduleId: string): string {
  if (scheduleId === TOKEN_RENEWAL_RECORD_ID) return RENEWAL_DISPATCH_CRON;
  if (scheduleId === RETENTION_RECORD_ID) return RETENTION_DISPATCH_CRON;
  // Issue #3121 #4242 — the watchdog record reads the heartbeat
  // rows its sweeps already write (jobId =
  // schedule-watchdog-heartbeat), the same mapping shape as token
  // renewal / retention reading their dispatch rows.
  if (scheduleId === SCHEDULE_WATCHDOG_RECORD_ID) return SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID;
  return scheduleId;
}

/** The payload's trigger when it names one of the five dispatch modes; everything else is scheduled. */
export function resolveScheduleRunTrigger(payload: unknown): JobRunTrigger {
  if (payload && typeof payload === "object") {
    const trigger = (payload as Record<string, unknown>).trigger;
    if (
      trigger === "manual" ||
      trigger === "scheduled" ||
      trigger === "triggered" ||
      trigger === "copilot" ||
      trigger === "autopilot"
    ) {
      return trigger;
    }
  }
  return "scheduled";
}
