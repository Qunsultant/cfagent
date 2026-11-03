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
  type JobRunOutcome,
  type JobRunRecord,
  type JobRunSystem,
  type JobRunTrigger,
} from "../data/jobRunRecordPorts";

export type {
  JobRunOutcome,
  JobRunRecord,
  JobRunSystem,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";

export { JOB_RUN_RECORDS_PER_JOB_CAP } from "../data/jobRunRecordPorts";

/** Newest-first records kept for the ScheduledAgent's own key. */
export const SCHEDULED_AGENT_JOB_RUN_CAP = 500;

/** Default list limit for run-history reads. */
export const JOB_RUN_LIST_DEFAULT_LIMIT = 50;

export type JobRunRecordInput = Omit<JobRunRecord, "system"> & {
  system: JobRunSystem;
};

const SYSTEMS: readonly string[] = ["scheduled-agent-goal", "orchestrator-schedule"];
const OUTCOMES: readonly string[] = ["success", "failure", "skipped"];
const TRIGGERS: readonly string[] = ["scheduled", "manual"];

/**
 * Build and validate a run record. Throws on: unknown system /
 * outcome / trigger, empty jobId or operation, unparseable dates,
 * finished before started, failure without error text, skip
 * without a detail reason.
 */
export function buildJobRunRecord(input: JobRunRecordInput): JobRunRecord {
  if (!SYSTEMS.includes(input.system)) {
    throw new Error(`Unknown job run system: ${String(input.system)}`);
  }
  if (!input.jobId || !input.jobId.trim()) {
    throw new Error("Job run jobId is required.");
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
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.descriptor !== undefined ? { descriptor: input.descriptor } : {}),
    ...(input.artifactRefs !== undefined ? { artifactRefs: input.artifactRefs } : {}),
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
  if (schedule && typeof schedule.id === "string" && schedule.id) {
    return schedule.id;
  }
  if (payload && typeof payload === "object") {
    const stamped = (payload as Record<string, unknown>).scheduleId;
    if (typeof stamped === "string" && stamped) {
      return stamped;
    }
  }
  return `callback:${callback}`;
}

/** Manual only when the payload says so; everything else is scheduled. */
export function resolveScheduleRunTrigger(payload: unknown): JobRunTrigger {
  if (payload && typeof payload === "object") {
    const trigger = (payload as Record<string, unknown>).trigger;
    if (trigger === "manual") return "manual";
  }
  return "scheduled";
}
