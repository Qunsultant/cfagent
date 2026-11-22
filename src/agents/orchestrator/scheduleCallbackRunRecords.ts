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
  resolveScheduleRunJobId,
  resolveScheduleRunTrigger,
  type JobRunRecord,
} from "../../services/jobRunRecords";
import { recordLedgerRun } from "../../services/unifiedLedger";
import { buildLedgerLinkage } from "../../services/consolidatedScheduling";
import type { ScheduledCallbackOutcome } from "./scheduledCallbacks";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { OBS_LEDGER_WRITE_FAILED, formatCatalogMessage } from "../../observability/otelMessages";

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

/**
 * Issue #4001 (follow-up): what a failed ledger write reports. The hook
 * runs only when the store throws; recording still never breaks the
 * callback, and a throwing hook is swallowed the same way.
 */
export interface ScheduleCallbackRecordFailure {
  jobId: string;
  operation: string;
  outcome: JobRunRecord["outcome"];
  error: string;
}

export interface RecordScheduleCallbackRunOptions {
  /**
   * Called (best-effort) when the ledger store throws, so a silent
   * production-only write failure is named instead of vanishing.
   * When omitted and `audit` is present, the default is the shared
   * namer `nameLedgerWriteFailure(audit,
   * "schedule.ledger_write_failed")` — see below.
   */
  onRecordFailure?: (failure: ScheduleCallbackRecordFailure) => void;
  /**
   * Issue #5085 (S6) — the audit sink for the default failure
   * namer. The nine orchestrator.ts sites (under the #992 line
   * budget) pass this one field instead of a per-site hook; the
   * copilot site passes an explicit `onRecordFailure` with its own
   * event type instead. A site with neither gets the OBS-1020 log
   * floor in `storeRecord` (named, never silent), just no audit
   * event.
   */
  audit?: LedgerWriteFailureAudit;
}

/**
 * Issue #5085 (S6, observability program #5080) — the ONE namer
 * for a failed runs-ledger write. A failed write is always named
 * twice: once as an audit event (the attributable record, with the
 * job id and the store error) and once as a coded OBS-1020
 * structured-log line (the queryable signal). Sites reach it two
 * ways: an explicit `onRecordFailure` hook (the copilot site, with
 * its own event type `stock_copilot.ledger_write_failed`), or the
 * `audit` option on `recordScheduleCallbackRun`, which applies this
 * namer by default with `schedule.ledger_write_failed`. A site with
 * neither still gets the OBS-1020 log floor in `storeRecord`
 * (named, never silent), just no audit event. The #4921 KV marker
 * sink is the follow-up mechanism for naming a failure the SQL
 * path cannot report at all; OBS-1020 names it on the audit/log
 * path that exists today.
 *
 * The hook itself never breaks the callback: a throwing audit is
 * swallowed, and the structured logger never fails its caller.
 */
export type LedgerWriteFailureAudit = (
  type: string,
  agent: "orchestrator",
  payload: Record<string, unknown>,
) => void;

const ledgerWriteFailureLog = createStructuredLogger(
  createObservabilitySink({}),
  { component: "agents/orchestrator/scheduleCallbackRunRecords" },
);

export function nameLedgerWriteFailure(
  audit: LedgerWriteFailureAudit,
  eventType: string,
  extra?: Record<string, unknown>,
): (failure: ScheduleCallbackRecordFailure) => void {
  return (failure) => {
    try {
      audit(eventType, "orchestrator", {
        code: "ledger_write_failed",
        jobId: failure.jobId,
        operation: failure.operation,
        error: failure.error,
        ...(extra ?? {}),
      });
    } catch {
      // Reporting a failed record must never break the callback.
    }
    ledgerWriteFailureLog.error(
      "ledger.write_failed",
      {
        message: `[run-ledger] ${formatCatalogMessage(OBS_LEDGER_WRITE_FAILED, { jobId: failure.jobId, error: failure.error })}`,
        jobId: failure.jobId,
        operation: failure.operation,
      },
      { errorCode: OBS_LEDGER_WRITE_FAILED },
    );
  };
}

function storeRecord(
  sql: SqlStorage,
  record: Omit<JobRunRecord, "system">,
  onRecordFailure?: RecordScheduleCallbackRunOptions["onRecordFailure"],
): void {
  try {
    const store = new SqlJobRunRecordStore(sql);
    recordLedgerRun(store, { system: "orchestrator-schedule", ...record });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Recording never breaks the callback — but a swallowed store
    // failure is unobservable, so a caller that supplied a hook hears
    // about it (best-effort; a throwing hook is swallowed too). A
    // caller with no hook still gets the OBS-1020 log floor below:
    // named, never silent.
    if (onRecordFailure) {
      try {
        onRecordFailure({
          jobId: record.jobId,
          operation: record.operation,
          outcome: record.outcome,
          error,
        });
      } catch {
        // Reporting a failed record must never break the callback either.
      }
    } else {
      ledgerWriteFailureLog.error(
        "ledger.write_failed",
        {
          message: `[run-ledger] ${formatCatalogMessage(OBS_LEDGER_WRITE_FAILED, { jobId: record.jobId, error })}`,
          jobId: record.jobId,
          operation: record.operation,
        },
        { errorCode: OBS_LEDGER_WRITE_FAILED },
      );
    }
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
  // Issue #3121 Phase 2 (#3123): the dispatch row is pre-built by
  // buildCronDispatchRecord (which validates through the same
  // builder, then restamps the system to "worker-cron"); it records
  // through the one entry, which re-validates the built row.
  recordLedgerRun(store, buildCronDispatchRecord(parsed));
}

/**
 * Issue #3655: broker + data-provider + mode provenance for the ledger
 * row, read from the firing schedule payload (recorded at creation).
 * A payload without them records no provenance — never a fresh ambient
 * read at fire time, never a guessed broker.
 *
 * Issue #5100 (F3 of #5094): the binding tuple rides the same way —
 * read from the firing payload, so a refused run's skipped record
 * still proves which account was (not) executed against.
 */
function payloadProvenance(payload: unknown): {
  brokerId?: string;
  dataProviderId?: string;
  mode?: "live" | "paper";
  modeSource?: "pin" | "selection" | "inference";
  accountType?: string;
  accountId?: string;
  bindingScope?: string;
  bindingSource?: string;
} {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    ...(typeof p.brokerId === "string" && p.brokerId ? { brokerId: p.brokerId } : {}),
    ...(typeof p.dataProviderId === "string" && p.dataProviderId
      ? { dataProviderId: p.dataProviderId }
      : {}),
    ...(p.mode === "live" || p.mode === "paper" ? { mode: p.mode } : {}),
    // Issue #3655 (effective mode): the resolver source rides the
    // ledger row with the mode (creation-stamped, never re-derived).
    ...(p.modeSource === "pin" || p.modeSource === "selection" || p.modeSource === "inference"
      ? { modeSource: p.modeSource }
      : {}),
    ...(typeof p.accountType === "string" && p.accountType ? { accountType: p.accountType } : {}),
    ...(typeof p.accountId === "string" && p.accountId ? { accountId: p.accountId } : {}),
    ...(typeof p.bindingScope === "string" && p.bindingScope ? { bindingScope: p.bindingScope } : {}),
    ...(typeof p.bindingSource === "string" && p.bindingSource ? { bindingSource: p.bindingSource } : {}),
  };
}

export async function recordScheduleCallbackRun(
  sql: SqlStorage,
  callback: string,
  payload: unknown,
  schedule: { id?: unknown } | undefined,
  run: () => Promise<OutcomeInput>,
  options?: RecordScheduleCallbackRunOptions,
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
  // Issue #5085 (S6) — the default namer: an explicit hook wins;
  // otherwise an `audit` sink applies the shared namer, and a site
  // with neither still gets the OBS-1020 log floor in storeRecord.
  const onRecordFailure =
    options?.onRecordFailure ??
    (options?.audit
      ? nameLedgerWriteFailure(options.audit, "schedule.ledger_write_failed")
      : undefined);
  try {
    const outcome = normalize(await run());
    storeRecord(sql, {
      jobId,
      operation: callback,
      started,
      finished: new Date().toISOString(),
      outcome: outcome.outcome,
      triggeredBy: resolveScheduleRunTrigger(payload),
      ...payloadProvenance(payload),
      ...linkage,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.descriptor ? { descriptor: outcome.descriptor } : {}),
      ...(outcome.artifactRefs ? { artifactRefs: outcome.artifactRefs } : {}),
    }, onRecordFailure);
  } catch (err) {
    storeRecord(sql, {
      jobId,
      operation: callback,
      started,
      finished: new Date().toISOString(),
      outcome: "failure",
      triggeredBy: resolveScheduleRunTrigger(payload),
      ...payloadProvenance(payload),
      ...linkage,
      error: err instanceof Error ? err.message : String(err),
    }, onRecordFailure);
    throw err;
  }
}
