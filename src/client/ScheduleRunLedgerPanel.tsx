/**
 * Issue #3121 Slice S2 — the consolidated run ledger view.
 *
 * The `view=runs` / `view=ledger` view of the one schedules home. It
 * reads the S1 ledger (`job_run_records`, §4 columns `trigger`,
 * `scheduleId`, `asyncJobId`, `workflowId`) through the existing reads
 * (`jobsApi.listScheduleRuns` + `listGoalRuns` — the same reads
 * `JobsPanel` uses; no second ledger read path) and normalizes every
 * row with `normalizeJobRunRecord`, so a legacy row reads as
 * `trigger: "unknown"` with null ids instead of dropping out.
 *
 * Null-handling is the §4 rule, rendered not hidden: a null linkage id
 * shows as "—" (title "not applicable"), never a reason to drop the
 * row; an unjoinable run is a defect, not a gap to note — and the
 * ledger makes it visible by construction. A run row's identity is its
 * `jobId` (schedule/goal id) plus its start time; the S1 ledger mints
 * no standalone run id, so `run=<id>` deep-links that job's run
 * history, newest first, and `schedule=<id>` filters to that schedule.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Spinner,
  Table,
  type TableColumn,
} from "./components/ui";
import { listGoalRuns, listScheduleRuns } from "./jobsApi";
import {
  normalizeJobRunRecord,
  type JobRunRecord,
} from "../services/jobRunRecords";
import { navigateToTab } from "./router";
import { AsyncJobResultViewer } from "./AsyncJobResultViewer";

/** A null linkage id is a recorded fact: rendered, never dropped. */
export function ledgerLinkageCell(value: string | null | undefined): string {
  return typeof value === "string" && value ? value : "—";
}

export function ledgerLinkageTitle(value: string | null | undefined): string {
  return typeof value === "string" && value ? value : "not applicable";
}

function outcomeTone(outcome: JobRunRecord["outcome"]): "success" | "danger" | "warning" {
  if (outcome === "success") return "success";
  if (outcome === "failure") return "danger";
  return "warning";
}

function runSummary(run: JobRunRecord): string {
  if (run.outcome === "failure") return run.error ?? "failed";
  if (run.outcome === "skipped") return run.detail ?? "skipped";
  return run.descriptor ?? "ok";
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Merge the two ledger read streams into one newest-first list. Both
 * streams are already newest-first; the merge re-sorts by start time
 * so a goal run and a schedule run interleave correctly.
 */
export function mergeLedgerRuns(
  scheduleRuns: JobRunRecord[],
  goalRuns: JobRunRecord[],
): JobRunRecord[] {
  const merged = [...scheduleRuns, ...goalRuns].map(normalizeJobRunRecord);
  merged.sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  return merged;
}

/** Apply the home's deep-link filter: a run id is a job id (see the header). */
export function filterLedgerRuns(
  runs: JobRunRecord[],
  scheduleId: string | null | undefined,
  runId: string | null | undefined,
): JobRunRecord[] {
  if (runId) return runs.filter((r) => r.jobId === runId);
  if (scheduleId) {
    return runs.filter((r) => r.scheduleId === scheduleId || r.jobId === scheduleId);
  }
  return runs;
}

export interface ScheduleRunLedgerPanelProps {
  scheduleId?: string | null;
  runId?: string | null;
}

/**
 * Issue #3605 — the Job and Async job ids are clickable links to the
 * job's detail, so nobody types `/api/jobs/<id>` by hand:
 * - Job: opens that job's run history via the existing `run=<id>`
 *   deep link — the ledger's own detail view for a job.
 * - Async job: opens the shared `AsyncJobResultViewer` (the one
 *   detail view, also used by the queue panel) below the table.
 * The visible label is the id itself. A null async-job id renders as
 * "—" with no control — never a dead link. Schedule / Workflow ids
 * stay plain text (out of scope for #3605).
 */
function ledgerColumns(
  onJobClick: (jobId: string) => void,
  onAsyncJobClick: (asyncJobId: string) => void,
): TableColumn<JobRunRecord>[] {
  return [
  { key: "jobId", header: "Job", render: (r) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onJobClick(r.jobId)}
      title={`Show run history for ${r.jobId}`}
    >
      {r.jobId}
    </Button>
  ) },
  { key: "operation", header: "Operation", render: (r) => <>{r.operation}</> },
  { key: "system", header: "System", render: (r) => <>{r.system}</> },
  { key: "started", header: "Started", render: (r) => <>{fmtTime(r.started)}</> },
  {
    key: "outcome",
    header: "Outcome",
    render: (r) => <Badge size="xs" tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>,
  },
  { key: "triggeredBy", header: "Triggered by", render: (r) => <>{r.triggeredBy}</> },
  {
    key: "trigger",
    header: "Trigger",
    render: (r) => (
      <span title={r.trigger === "unknown" ? "Legacy row — producing path not recorded" : r.trigger}>
        {r.trigger ?? "unknown"}
      </span>
    ),
  },
  {
    key: "scheduleId",
    header: "Schedule",
    render: (r) => (
      <span title={ledgerLinkageTitle(r.scheduleId)}>{ledgerLinkageCell(r.scheduleId)}</span>
    ),
  },
  {
    key: "asyncJobId",
    header: "Async job",
    render: (r) => (
      typeof r.asyncJobId === "string" && r.asyncJobId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onAsyncJobClick(r.asyncJobId as string)}
          title={`Open job detail for ${r.asyncJobId}`}
        >
          {r.asyncJobId}
        </Button>
      ) : (
        <span title={ledgerLinkageTitle(r.asyncJobId)}>{ledgerLinkageCell(r.asyncJobId)}</span>
      )
    ),
  },
  {
    key: "workflowId",
    header: "Workflow",
    render: (r) => (
      <span title={ledgerLinkageTitle(r.workflowId)}>{ledgerLinkageCell(r.workflowId)}</span>
    ),
  },
  {
    // Issue #3655: broker + mode recorded on the schedule at creation.
    // Legacy rows without them read as "—", never a guessed broker.
    // Issue #3655 (effective mode): a pinned mode is annotated — a
    // run that executed live under an ALPACA_TRADING_TYPE=live pin
    // reads "Alpaca · live · pin", never just "live".
    key: "broker",
    header: "Broker",
    render: (r) => (
      <span>
        {r.brokerId
          ? `${r.brokerId === "etrade" ? "E*TRADE" : r.brokerId}${r.mode ? ` · ${r.mode}` : ""}${r.modeSource === "pin" ? " · pin" : ""}`
          : "—"}
      </span>
    ),
  },
  { key: "summary", header: "Summary", render: (r) => <>{runSummary(r)}</> },
  ];
}

export function ScheduleRunLedgerPanel({
  scheduleId = null,
  runId = null,
}: ScheduleRunLedgerPanelProps = {}) {
  const [runs, setRuns] = useState<JobRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scheduleRuns, goalRuns] = await Promise.all([
        listScheduleRuns(undefined, 200),
        listGoalRuns(undefined, 200),
      ]);
      setRuns(mergeLedgerRuns(scheduleRuns, goalRuns));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run ledger");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = filterLedgerRuns(runs, scheduleId, runId);
  const filterLabel = runId ?? scheduleId;
  // Issue #3605 — the async job whose detail is open below the table.
  const [selectedAsyncJobId, setSelectedAsyncJobId] = useState<string | null>(null);
  const columns = useMemo(
    () =>
      ledgerColumns(
        (jobId) => navigateToTab("schedules", "runs", { run: jobId }),
        (asyncJobId) => setSelectedAsyncJobId(asyncJobId),
      ),
    [],
  );

  return (
    <div className="schedule-run-ledger">
      <div className="schedules-toolbar">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          loading={loading}
          title="Reload the consolidated run ledger"
        >
          ↻ Refresh
        </Button>
        {filterLabel && (
          <>
            <span className="ui-meta">
              Showing runs for <code>{filterLabel}</code>
              {runId ? " (run history for this job)" : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigateToTab("schedules", "runs")}
              title="Show every run in the ledger"
            >
              Clear filter
            </Button>
          </>
        )}
      </div>

      {error && (
        <Notice tone="danger" title="Run ledger could not be loaded">
          {error}{" "}
          <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </Notice>
      )}

      {loading && runs.length === 0 ? (
        <Spinner />
      ) : (
        <Table
          columns={columns}
          rows={visible}
          rowKey={(r, i) => `${r.jobId}:${r.started}:${i}`}
          rowTitle={(r) => `${r.jobId} · ${r.operation} · ${r.started}`}
          caption="Consolidated run ledger — every run with its schedule, async-job, and workflow linkage"
          empty={
            <EmptyState
              title="No runs in the ledger"
              description={
                filterLabel
                  ? "No run in the ledger links to this id — the filter, not the ledger, is empty."
                  : "No schedule or goal has recorded a run yet."
              }
            />
          }
        />
      )}

      {selectedAsyncJobId && (
        <div>
          <div className="schedules-toolbar">
            <span className="ui-meta">
              Job detail: <code>{selectedAsyncJobId}</code>
            </span>
          </div>
          <AsyncJobResultViewer
            jobId={selectedAsyncJobId}
            variant="standalone"
            onClose={() => setSelectedAsyncJobId(null)}
          />
        </div>
      )}
    </div>
  );
}
