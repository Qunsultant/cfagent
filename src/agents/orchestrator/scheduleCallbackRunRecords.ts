/**
 * Issue #2964 — the per-run recording wrapper for orchestrator
 * schedule callbacks. One helper serves both firing paths:
 *
 * - SDK firings: the Agents SDK calls the agent method as
 *   method.call(this, payload, schedule), so the method wrapper
 *   passes the schedule object and the job id resolves from
 *   schedule.id.
 * - Manual triggers: the trigger route stamps trigger "manual" +
 *   scheduleId into the payload (and makeRunScheduleCallback passes
 *   only the payload), so the job id resolves from payload.scheduleId.
 *
 * The delegate's outcome object is the record's truth (the
 * callbacks deliberately never throw for failed/skipped runs, so a
 * throw-based record would mislabel them). A delegate that returns
 * void (non-creatable callbacks invoked from the trigger route)
 * records an invocation-level success — documented as such, since
 * the callback itself reports no outcome. A throwing delegate
 * records a failure and the throw still propagates (SDK retry
 * policy and trigger-route error handling are preserved).
 * Recording itself never breaks the callback: store failures are
 * swallowed.
 */
import { SqlJobRunRecordStore } from "../../data/doSqliteJobRunRecordAdapter";
import type { SqlStorage } from "../../orm";
import {
  buildCronDispatchRecord,
  type CronDispatchRecordInput,
} from "../../services/consolidatedCronEntries";
import {
  buildJobRunRecord,
  resolveScheduleRunJobId,
  resolveScheduleRunTrigger,
  type JobRunRecord,
} from "../../services/jobRunRecords";
import { buildLedgerLinkage } from "../../services/consolidatedScheduling";
import type { ScheduledCallbackOutcome } from "./scheduledCallbacks";

type OutcomeInput = ScheduledCallbackOutcome | void;

function normalize(outcome: OutcomeInput): ScheduledCallbackOutcome {
  if (!outcome) {
    return { outcome: "success", descriptor: "manual trigger invoked" };
  }
  if (outcome.outcome === "failure" && !outcome.error) {
    return { ...outcome, error: "callback failed" };
  }
  if (outcome.outcome === "skipped" && !outcome.detail) {
    return { ...outcome, detail: "skipped by callback" };
  }
  return outcome;
}

function storeRecord(sql: SqlStorage, record: Omit<JobRunRecord, "system">): void {
  try {
    const store = new SqlJobRunRecordStore(sql);
    store.record(buildJobRunRecord({ system: "orchestrator-schedule", ...record }));
  } catch {
    // Recording never breaks the callback.
  }
}

/**
 * Issue #3121 S5 — record one Worker cron dispatch. The entry
 * points report their dispatch (success / failure / skipped) back
 * through the background-gated record route; this helper builds the
 * row via `buildCronDispatchRecord` and stores it with the same
 * `SqlJobRunRecordStore` the callback recorder uses. A build or
 * store failure throws so the route can answer 500 — the
 * Worker-side poster logs that and moves on; a failed record must
 * never silently read as a stored one.
 */
export function recordCronDispatchRun(
  sql: SqlStorage,
  parsed: CronDispatchRecordInput,
): void {
  const store = new SqlJobRunRecordStore(sql);
  store.record(buildCronDispatchRecord(parsed));
}

export async function recordScheduleCallbackRun(
  sql: SqlStorage,
  callback: string,
  payload: unknown,
  schedule: { id?: unknown } | undefined,
  run: () => Promise<OutcomeInput>,
): Promise<void> {
  const started = new Date().toISOString();
  // Issue #3121 S1 — the §4 consolidated-ledger linkage, stamped at
  // this write site: the trigger resolves from the firing payload
  // (the trigger route stamps `trigger: "manual"` + `scheduleId` on
  // manual triggers; SDK firings carry the stored schedule payload),
  // the schedule id is the real schedule id when one exists (the
  // `callback:<name>` job-id fallback is never laundered into a
  // schedule id), and asyncJobId/workflowId ride the payload when a
  // producer stamped them — explicit nulls otherwise.
  const jobId = resolveScheduleRunJobId(callback, payload, schedule);
  const linkage = buildLedgerLinkage({
    payload,
    schedule,
    triggeredBy: resolveScheduleRunTrigger(payload),
  });
  try {
    const outcome = normalize(await run());
    storeRecord(sql, {
      jobId,
      operation: callback,
      started,
      finished: new Date().toISOString(),
      outcome: outcome.outcome,
      triggeredBy: resolveScheduleRunTrigger(payload),
      ...linkage,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.descriptor ? { descriptor: outcome.descriptor } : {}),
      ...(outcome.artifactRefs ? { artifactRefs: outcome.artifactRefs } : {}),
    });
  } catch (err) {
    storeRecord(sql, {
      jobId,
      operation: callback,
      started,
      finished: new Date().toISOString(),
      outcome: "failure",
      triggeredBy: resolveScheduleRunTrigger(payload),
      ...linkage,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
