/**
 * Issue #3121 Slice S2 — the consolidated run ledger view.
 *
 * The `view=runs` / `view=ledger` view of the one schedules home. It
 * reads the S1 ledger (`job_run_records`, §4 columns `trigger`,
 * `scheduleId`, `asyncJobId`, `workflowId`) through the one merged
 * read (`jobsApi.listAllRuns` — server-side merge of the
 * orchestrator DO-SQLite half and the ScheduledAgent KV half; the
 * same read `JobsPanel` uses; no second ledger read path) and
 * normalizes every row with `normalizeJobRunRecord`, so a legacy row
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
  Modal,
  Notice,
  SegmentedControl,
  Spinner,
  Table,
  type TableColumn,
} from "./components/ui";
import { listAllRuns } from "./jobsApi";
import { apiFetch } from "./apiFetch";
import { attachWorkflowRuns, type WorkflowLedgerEntry } from "../services/runLedgerWorkflowRuns";
import type { WorkflowRun } from "../services/workflowRuns";
import { RunDetail } from "./WorkflowRunsPanel";
import {
  isMissingIdLiteral,
  normalizeJobRunRecord,
  type JobRunRecord,
} from "../services/jobRunRecords";
import { navigateToTab } from "./router";
import {
  RUN_LEDGER_FILTER_LABELS,
  resolveRunLedgerDefaultFilter,
  resolveRunLedgerFilters,
  type RunLedgerFilter,
  type RunLedgerKind,
} from "../config/runLedgerModes";
import {
  classifyRunKind,
  countRunsByKind,
  filterRunsByKind,
} from "../services/runLedgerKinds";
import { AsyncJobResultViewer } from "./AsyncJobResultViewer";

/**
 * A null linkage id is a recorded fact: rendered, never dropped.
 * Issue #3650 — the literal "undefined"/"null" is a missing id
 * stringified upstream, so it reads as missing here too, never as
 * an id. One definition for every layer: `isMissingIdLiteral`.
 */
export function ledgerLinkageCell(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim() || isMissingIdLiteral(value)) return "—";
  return value;
}

export function ledgerLinkageTitle(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim() || isMissingIdLiteral(value)) {
    return "not applicable";
  }
  return value;
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
  /** The selected kind filter (issue #4262); an unknown/absent id uses the configured default. */
  kind?: RunLedgerFilter | null;
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
 *
 * Issue #3650 — the Job cell has the same guard the Async-job cell
 * already had: a missing jobId, or the literal "undefined"/"null" a
 * missing id stringifies to, renders as "—" with no control — never
 * a clickable "undefined" button, and the `run=<id>` deep link can
 * never navigate to `run=undefined`.
 */
function ledgerColumns(
  onJobClick: (jobId: string) => void,
  onAsyncJobClick: (asyncJobId: string) => void,
): TableColumn<JobRunRecord>[] {
  return [
  { key: "jobId", header: "Job", render: (r) => (
    typeof r.jobId === "string" && r.jobId.trim() && !isMissingIdLiteral(r.jobId) ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onJobClick(r.jobId)}
        title={`Show run history for ${r.jobId}`}
      >
        {r.jobId}
      </Button>
    ) : (
      <span title={ledgerLinkageTitle(r.jobId)}>{ledgerLinkageCell(r.jobId)}</span>
    )
  ) },
  { key: "operation", header: "Operation", render: (r) => <>{r.operation}</> },
  {
    // Issue #4262 (S1) — the row's kind, visible rather than implied.
    key: "kind",
    header: "Kind",
    render: (r) => (
      <Badge size="xs" tone="neutral">{RUN_LEDGER_FILTER_LABELS[classifyRunKind(r)]}</Badge>
    ),
  },
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
  kind = null,
}: ScheduleRunLedgerPanelProps = {}) {
  const [runs, setRuns] = useState<JobRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Issue #4262 (S2) — the workflow-runs read is attached to the ledger rows,
  // never listed beside them: a run the ledger already carries is dropped by
  // linkage in `attachWorkflowRuns`.
  const [workflowEntries, setWorkflowEntries] = useState<WorkflowLedgerEntry[]>([]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { runs } = await listAllRuns(undefined, 200);
      let attached: WorkflowLedgerEntry[] = [];
      try {
        const res = await apiFetch("/api/workflow-runs?limit=100");
        if (res.ok) {
          const body = (await res.json()) as { runs?: WorkflowRun[] };
          attached = attachWorkflowRuns(runs, body.runs ?? []);
        }
      } catch {
        // The workflow-runs read is additive: a failed store must not empty
        // the ledger (docs/agents/workflow-runs.md, honesty rules).
        attached = [];
      }
      setRuns(runs);
      setWorkflowEntries(attached);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run ledger");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const workflowByJobId = useMemo(() => {
    const map = new Map<string, WorkflowRun>();
    for (const entry of workflowEntries) map.set(entry.row.jobId, entry.run);
    return map;
  }, [workflowEntries]);
  const mergedRuns = useMemo(
    () => [...runs, ...workflowEntries.map((entry) => entry.row)],
    [runs, workflowEntries],
  );
  const visible = filterLedgerRuns(mergedRuns, scheduleId, runId);
  // Issue #4262 (S1) — the one ledger's kind filters. The filter set and the
  // default come from config (src/config/runLedgerModes.ts), never literals.
  const filters = useMemo(() => resolveRunLedgerFilters(), []);
  const activeFilter: RunLedgerFilter =
    kind && filters.includes(kind) ? kind : resolveRunLedgerDefaultFilter({}, filters);
  const counts = useMemo(() => countRunsByKind(visible), [visible]);
  const rows = useMemo(() => filterRunsByKind(visible, activeFilter), [visible, activeFilter]);
  const filterLabel = runId ?? scheduleId;
  // Issue #3605 — the async job whose detail is open below the table.
  const [selectedAsyncJobId, setSelectedAsyncJobId] = useState<string | null>(null);
  // Issue #4262 (S2) — the folded workflow run whose detail is open.
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const columns = useMemo(
    () =>
      ledgerColumns(
        (jobId) => {
          const folded = workflowByJobId.get(jobId);
          if (folded) setSelectedRun(folded);
          else navigateToTab("schedules", "runs", { run: jobId });
        },
        (asyncJobId) => setSelectedAsyncJobId(asyncJobId),
      ),
    [workflowByJobId],
  );

  return (
    <div className="schedule-run-ledger">
      <div className="schedules-toolbar">
        {/* Issue #4262 (S1) — one ledger, filtered by kind. The set comes from
            config, so a deployment can show fewer (or different) buttons. */}
        {filters.length > 1 && (
          <SegmentedControl
            ariaLabel="Run kind"
            size="sm"
            options={filters.map((id) => ({
              id,
              label: RUN_LEDGER_FILTER_LABELS[id],
              badge:
                id === "all"
                  ? visible.length
                  : counts[id as RunLedgerKind] ?? 0,
            }))}
            value={activeFilter}
            onChange={(id) =>
              navigateToTab("schedules", "runs", {
                kind: id,
                ...(scheduleId ? { schedule: scheduleId } : {}),
                ...(runId ? { run: runId } : {}),
              })
            }
          />
        )}
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
          rows={rows}
          rowKey={(r, i) => `${r.jobId}:${r.started}:${i}`}
          rowTitle={(r) => `${r.jobId} · ${r.operation} · ${r.started}`}
          caption="Consolidated run ledger — every run with its schedule, async-job, and workflow linkage"
          empty={
            <EmptyState
              title="No runs in the ledger"
              description={
                filterLabel
                  ? "No run in the ledger links to this id — the filter, not the ledger, is empty."
                  : activeFilter === "all"
                    ? "No schedule or goal has recorded a run yet."
                    : "No " + RUN_LEDGER_FILTER_LABELS[activeFilter] + " run is recorded in the ledger — switch to All to see every kind."
              }
            />
          }
        />
      )}

      {selectedRun && (
        <Modal
          open
          onClose={() => setSelectedRun(null)}
          title="Workflow run detail"
          size="xl"
        >
          <RunDetail run={selectedRun} />
        </Modal>
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
