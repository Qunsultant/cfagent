/**
 * Workflow Runs — the operational ledger of every workflow execution
 * the platform recorded: one row per run (a job chain, a standalone
 * job, or an outcome with no job twin), and one expandable detail per
 * run showing what really happened.
 *
 * The page is deliberately a read surface. It fetches
 * `GET /api/workflow-runs` and renders only what the server recorded:
 *  - the trigger and the evidence for it ("Scheduled — recorded by
 *    job-tree"), or "Not recorded" when no store carries one;
 *  - every stage in execution order, its status, timing, the reason a
 *    skipped/held/failed stage ended that way, and whether the stage
 *    came from a job row or a recorded stage transition;
 *  - the normalized inputs/outputs the stage persisted, artifacts, and
 *    per-channel delivery states;
 *  - the run's first coded error, verbatim.
 *  - for a run backed by a canonical row, the Docs RunDetail sections
 *    (request, provenance, lineage, stages, reasons) from the same
 *    /api/runs/details payload the Docs tab renders (issue #2786
 *    losslessness fix) — additive only; every section above stays.
 *
 * Compliance (docs/agents/ux-architecture.md §20): ui/ primitives only,
 * semantic tokens only, server state is authoritative, and a field the
 * stores do not record renders as absent/not recorded — never invented.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./workflowRuns.css";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  Notice,
  PageSection,
  PageShell,
  PillGroup,
  Table,
  TextInput,
} from "./components/ui";
import type {
  WorkflowRun,
  WorkflowRunStage,
  WorkflowRunStatus,
  WorkflowRunTrigger,
} from "../services/workflowRuns";
import type {
  WorkflowLifecycleState,
  WorkflowScheduleMechanism,
} from "../services/workflowLifecycle";
import {
  WORKFLOW_RUN_SORT_DEFAULT,
  nextWorkflowRunSort,
  sortWorkflowRuns,
  type WorkflowRunSort,
  type WorkflowRunSortKey,
} from "./workflowRunSort";
import { isAdBeaconsPaused, setAdBeaconsPaused } from "./adBeacons";
import { RunDetailSections } from "./components/RunDetailsModal";
import type { RunDetail } from "./runDetails";

interface WorkflowRunsResponse {
  count?: number;
  runs?: WorkflowRun[];
  summary?: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    active: number;
    /** Issue #3021: runs in the scheduled lifecycle state. */
    scheduled?: number;
    byTrigger: Record<WorkflowRunTrigger, number>;
  };
  storeErrors?: Record<string, string>;
  generatedAt?: string;
  error?: string;
  /** Read traces hidden from this window when the toggle hides them. */
  hiddenTraceCount?: number;
  /** Runs matching the server filters, before paging. */
  totalMatched?: number;
  offset?: number;
  limit?: number;
}

type TriggerFilter = "all" | WorkflowRunTrigger;
type StatusFilter = "all" | "completed" | "partial" | "failed" | "active";
type ReportsFilter = "all" | "reports";
// Issue #3021: lifecycle + schedule-type filters are server-side
// (like Reports) so scheduled rows past the fetched window still
// show; the client window filter below mirrors them for
// mock-backed servers that ignore the params.
type LifecycleFilter = "all" | WorkflowLifecycleState;
type ScheduleFilter = "all" | WorkflowScheduleMechanism;

const TRIGGER_LABEL: Record<WorkflowRunTrigger, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  autonomous: "Autonomous",
  webhook: "Webhook",
  agent: "Agent",
  unknown: "Not recorded",
};

const TRIGGER_TONE: Record<WorkflowRunTrigger, "neutral" | "info" | "purple" | "accent"> = {
  manual: "neutral",
  scheduled: "info",
  autonomous: "purple",
  webhook: "accent",
  agent: "accent",
  unknown: "neutral",
};

const TRIGGER_OPTIONS: Array<{ id: TriggerFilter; label: string }> = [
  { id: "all", label: "All triggers" },
  { id: "scheduled", label: "Scheduled" },
  { id: "manual", label: "Manual" },
  { id: "autonomous", label: "Autonomous" },
  { id: "webhook", label: "Webhook" },
  { id: "unknown", label: "Not recorded" },
];

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All statuses" },
  { id: "completed", label: "Completed" },
  { id: "partial", label: "Partial" },
  { id: "failed", label: "Failed" },
  { id: "active", label: "In flight" },
];

// Issue #2786 Part 3: the Reports filter is server-side (unlike
// Trigger/Status, which filter the fetched window client-side) —
// selecting it refetches with reports=only so report runs past the
// 50-window still show.
const REPORTS_OPTIONS: Array<{ id: ReportsFilter; label: string }> = [
  { id: "all", label: "All runs" },
  { id: "reports", label: "Reports only" },
];

const LIFECYCLE_LABEL: Record<WorkflowLifecycleState, string> = {
  scheduled: "Scheduled",
  "in-progress": "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

const LIFECYCLE_OPTIONS: Array<{ id: LifecycleFilter; label: string }> = [
  { id: "all", label: "All lifecycles" },
  { id: "scheduled", label: "Scheduled" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "cancelled", label: "Cancelled" },
];

const SCHEDULE_MECHANISM_LABEL: Record<WorkflowScheduleMechanism, string> = {
  "workflow-binding": "Workflow binding",
  "agent-scheduler": "Agent scheduler",
  "cron-trigger": "Cron trigger",
  queue: "Delayed queue",
  manual: "Manual",
  unknown: "Not recorded",
};

const SCHEDULE_OPTIONS: Array<{ id: ScheduleFilter; label: string }> = [
  { id: "all", label: "All schedule types" },
  { id: "workflow-binding", label: "Workflow binding" },
  { id: "agent-scheduler", label: "Agent scheduler" },
  { id: "cron-trigger", label: "Cron trigger" },
  { id: "queue", label: "Delayed queue" },
  { id: "manual", label: "Manual" },
  { id: "unknown", label: "Not recorded" },
];

// Issue #2786 Part 3: the Docs-tab Source column. A run with
// canonical documents shows the canonical family (a discovery-kind
// row reads "Strategy", exactly as Docs labels it); every other run
// shows its engine family.
const SOURCE_LABEL: Record<string, string> = {
  stock: "Stock",
  options: "Options",
  goal: "Goal",
  strategy: "Strategy",
  discovery: "Strategy",
  delivery: "Delivery",
  feed: "Feed",
  tool: "Tool",
  nlq: "NLQ",
  other: "Other",
};

const STATUS_TONE: Record<WorkflowRunStatus, "success" | "warning" | "danger" | "info" | "neutral"> = {
  completed: "success",
  partial: "warning",
  awaiting: "warning",
  failed: "danger",
  running: "info",
  queued: "info",
  skipped: "neutral",
  unknown: "neutral",
};

const STAGE_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  completed: "success",
  partial: "warning",
  held: "warning",
  failed: "danger",
  running: "info",
  queued: "info",
  skipped: "neutral",
  unknown: "neutral",
};

function statusLabel(status: WorkflowRunStatus): string {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "awaiting") return "Awaiting decision";
  if (status === "skipped") return "Skipped";
  return "Unknown";
}

/**
 * Issue #3784: the run-level status display. "Stuck" is a display
 * derivation on running + flagged (`run.stuck`, derived in
 * src/services/workflowRuns.ts runFromJobs from the stuck-alert
 * claim) — NOT a new WorkflowRunStatus and NOT a lifecycle state,
 * so the recorded status and the STATUS_TONE map stay untouched.
 * A stuck run renders with the warning tone: it needs operator
 * attention, unlike a healthy running run.
 */
function runStatusLabel(run: WorkflowRun): string {
  if (run.stuck === true && run.status === "running") return "Stuck";
  return statusLabel(run.status);
}

function runStatusTone(run: WorkflowRun): "success" | "warning" | "danger" | "info" | "neutral" {
  if (run.stuck === true && run.status === "running") return "warning";
  return STATUS_TONE[run.status];
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stageStatus(stage: WorkflowRunStage): string {
  return stage.status || "unknown";
}

function runMatchesQuery(run: WorkflowRun, query: string): boolean {
  if (!query) return true;
  const haystack = [
    run.title,
    run.runId,
    run.workflow,
    run.triggerDetail,
    run.error ?? "",
    ...run.stages.flatMap((stage) => [stage.stage, stage.label, stage.reason ?? "", stage.error ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function runMatchesStatus(run: WorkflowRun, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return run.status === "running" || run.status === "queued" || run.status === "awaiting";
  return run.status === filter;
}

/**
 * Sortable column header, Docs-tab pattern (#2786 Part 2, scope c):
 * ghost button, direction indicator, and a stable "Sort by" aria-label
 * (the column's aria-sort carries the direction).
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: WorkflowRunSortKey;
  sort: WorkflowRunSort;
  onSort: (key: WorkflowRunSortKey) => void;
}) {
  const active = sort.key === sortKey;
  const direction = sort.dir === "asc" ? "ascending" : "descending";
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`ui-table-sort${active ? " active" : ""}`}
      onClick={() => onSort(sortKey)}
      title={active ? `Sorted ${direction} — click to reverse` : `Sort by ${label}`}
      aria-label={`Sort by ${label}`}
    >
      <span>{label}</span>
      <span className="ui-table-sort-indicator" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </Button>
  );
}
/**
 * Issue #2786 Part 3: the run's Docs cells. Canonical documents win
 * (they carry generation statuses and failure reasons); without
 * them, the outcome's artifact urls are the fallback, with no status
 * — a link when the outcome recorded the key, "—" otherwise. Never
 * a link to a key the run did not record.
 */
function documentsForRun(run: WorkflowRun): {
  pdfUrl: string | null;
  pdfStatus: string | null;
  pdfError: string | null;
  xlsxUrl: string | null;
  xlsxStatus: string | null;
  xlsxError: string | null;
  csvUrl: string | null;
  csvStatus: string | null;
  csvError: string | null;
} {
  const docs = run.documents ?? null;
  const artifact = (kind: string) => run.artifacts.find((a) => a.kind === kind)?.url ?? null;
  return {
    pdfUrl: docs?.pdfUrl ?? artifact("pdf") ?? artifact("report"),
    pdfStatus: docs?.pdfStatus ?? null,
    pdfError: docs?.pdfError ?? null,
    xlsxUrl: docs?.xlsxUrl ?? artifact("xlsx"),
    xlsxStatus: docs?.xlsxStatus ?? null,
    xlsxError: docs?.xlsxError ?? null,
    csvUrl: docs?.csvUrl ?? artifact("csv"),
    csvStatus: docs?.csvStatus ?? null,
    csvError: docs?.csvError ?? null,
  };
}

/** Issue #3810: a run produced no documents at all — no canonical
 *  row, no artifact urls. Its document cells render "None" (none
 *  produced), not the bare "—" a missing format renders. */
function noDocumentsProduced(run: WorkflowRun): boolean {
  const d = documentsForRun(run);
  return !d.pdfUrl && !d.xlsxUrl && !d.csvUrl && run.artifacts.length === 0;
}

/** Issue #2786 Part 3: one Docs artifact cell — the Docs tab's
 *  ArtifactLink semantics (link / failed badge with reason / "—").
 *  Issue #3810: when the run produced no documents at all, the
 *  cell renders "None" instead of "—" — none-produced is a fact,
 *  not missing data. */
function DocumentCell({
  url,
  status,
  error,
  kind,
  none,
}: {
  url: string | null;
  status: string | null;
  error: string | null;
  kind: "PDF" | "XLSX" | "CSV";
  none?: boolean;
}) {
  if (!url && status === "failed") {
    // Issue #2088: a recorded leg failure renders as a failure
    // state with its reason, never a bare "—".
    return (
      <span title={error ?? undefined}>
        <Badge size="sm" tone="danger">failed</Badge>
      </span>
    );
  }
  if (!url) {
    return none ? (
      <span className="workflow-runs-muted" title="This run produced no documents">
        None
      </span>
    ) : (
      <span className="workflow-runs-muted">—</span>
    );
  }
  return (
    <a href={url} download aria-label={`Download the ${kind}`}>
      {kind}
    </a>
  );
}

export function WorkflowRunsPanel() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [summary, setSummary] = useState<WorkflowRunsResponse["summary"] | null>(null);
  const [storeErrors, setStoreErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [reportsFilter, setReportsFilter] = useState<ReportsFilter>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("all");
  const [scheduleFilter, setScheduleFilter] = useState<ScheduleFilter>("all");
  // Issue #2777 — deep link by run id: `?tab=workflow-runs&run=<id>`
  // pre-fills the search so a link from another view lands on that run.
  const [query, setQuery] = useState(() => {
    try {
      if (typeof window === "undefined") return "";
      const params = new URLSearchParams(window.location.search);
      // `run` wins (it names one run); `q` carries the catalog's family link.
      return params.get("run") ?? params.get("q") ?? "";
    } catch {
      return "";
    }
  });
  // Search is debounced server-side (300 ms) so typing does not fire
  // a request per keystroke; the client filter below still applies
  // instantly to the loaded window.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  // #2786 Part 2 (scope d-i): read traces hide by default, but the
  // toggle is visible and shows the hidden count — never silent.
  const [showTraces, setShowTraces] = useState(false);
  const [hiddenTraceCount, setHiddenTraceCount] = useState(0);
  const [totalMatched, setTotalMatched] = useState<number | null>(null);
  const [sort, setSort] = useState<WorkflowRunSort>(WORKFLOW_RUN_SORT_DEFAULT);
  // #2786 Part 2 (scope d-ii): per-browser beacon preference.
  const [beaconsPaused, setBeaconsPaused] = useState(() => isAdBeaconsPaused());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Issue #3163: a deep link can name the run to open (`?run=<id>`), which is
   * how the workflow catalog links a stage's last run to its full record.
   * Read once on mount; an id that is not in the loaded page simply leaves
   * the ledger closed rather than opening an empty dialog.
   */
  const [pendingRunId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const id = new URLSearchParams(window.location.search).get("run");
    return id && id.trim() ? id.trim() : null;
  });
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  // #2786 Part 2 (scope d-iii): session-scoped prune, preview first.
  const [pruneOpen, setPruneOpen] = useState(false);
  const [prunePreview, setPrunePreview] = useState<{
    wouldDelete: number;
    breakdown: Record<string, number>;
    skippedRunning: number;
  } | null>(null);
  const [pruneLoading, setPruneLoading] = useState(false);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadRuns = useCallback(
    async (mode: "replace" | "append", offsetValue: number) => {
      if (mode === "replace") setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (offsetValue > 0) params.set("offset", String(offsetValue));
        if (showTraces) params.set("traces", "all");
        if (triggerFilter !== "all") params.set("trigger", triggerFilter);
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (lifecycleFilter !== "all") params.set("lifecycle", lifecycleFilter);
        if (scheduleFilter !== "all") params.set("schedule", scheduleFilter);
        const search = debouncedQuery.trim();
        if (search) params.set("search", search);
        if (reportsFilter === "reports") params.set("reports", "only");
        const res = await fetch(`/api/workflow-runs?${params.toString()}`);
        const data = (await res.json().catch(() => null)) as WorkflowRunsResponse | null;
        if (!res.ok) throw new Error(`Could not load workflow runs (HTTP ${res.status})${data?.error ? `: ${data.error}` : "."}`);
        const next = Array.isArray(data?.runs) ? data.runs : [];
        if (mode === "replace") {
          setRuns(next);
          setSummary(data?.summary ?? null);
        } else {
          setRuns((prev) => [...prev, ...next]);
        }
        setHiddenTraceCount(typeof data?.hiddenTraceCount === "number" ? data.hiddenTraceCount : 0);
        setTotalMatched(typeof data?.totalMatched === "number" ? data.totalMatched : next.length);
        setStoreErrors(data?.storeErrors ?? {});
        setLoadedAt(data?.generatedAt ?? new Date().toISOString());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load workflow runs.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [showTraces, triggerFilter, statusFilter, lifecycleFilter, scheduleFilter, debouncedQuery, reportsFilter],
  );

  // Any filter change refetches from offset 0; the mount load is this
  // same effect's first run.
  useEffect(() => {
    void loadRuns("replace", 0);
  }, [loadRuns]);

  const loadPrunePreview = useCallback(async () => {
    setPruneLoading(true);
    setPruneError(null);
    setPrunePreview(null);
    try {
      const res = await fetch("/api/maintenance/clear-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: "mas_async_jobs" }),
      });
      const data = (await res.json().catch(() => null)) as {
        wouldDelete?: number;
        breakdown?: Record<string, number>;
        skippedRunning?: number;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(`Could not preview prune (HTTP ${res.status})${data?.error ? `: ${data.error}` : "."}`);
      setPrunePreview({
        wouldDelete: typeof data?.wouldDelete === "number" ? data.wouldDelete : 0,
        breakdown: data?.breakdown ?? {},
        skippedRunning: typeof data?.skippedRunning === "number" ? data.skippedRunning : 0,
      });
    } catch (cause) {
      setPruneError(cause instanceof Error ? cause.message : "Could not preview prune.");
    } finally {
      setPruneLoading(false);
    }
  }, []);

  const confirmPrune = useCallback(async () => {
    setPruneLoading(true);
    setPruneError(null);
    try {
      const res = await fetch("/api/maintenance/clear-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: "mas_async_jobs", confirm: true }),
      });
      const data = (await res.json().catch(() => null)) as { deleted?: number; error?: string } | null;
      if (!res.ok) throw new Error(`Could not prune history (HTTP ${res.status})${data?.error ? `: ${data.error}` : "."}`);
      const deleted = typeof data?.deleted === "number" ? data.deleted : 0;
      setPruneNotice(`Deleted ${deleted} history rows. Running rows were never deleted.`);
      setPruneOpen(false);
      setPrunePreview(null);
      void loadRuns("replace", 0);
    } catch (cause) {
      setPruneError(cause instanceof Error ? cause.message : "Could not prune history.");
    } finally {
      setPruneLoading(false);
    }
  }, [loadRuns]);

  // Server filters make deep matches reachable; the client filter
  // over the loaded window is retained for responsiveness and for
  // the existing panel contract (a mock-backed server ignores the
  // params, and the pills still filter what is shown).
  const displayed = useMemo(
    () =>
      sortWorkflowRuns(runs, sort).filter(
        (run) =>
          (triggerFilter === "all" || run.trigger === triggerFilter) &&
          runMatchesStatus(run, statusFilter) &&
          (lifecycleFilter === "all" || run.lifecycle === lifecycleFilter) &&
          (scheduleFilter === "all" || run.schedule?.mechanism === scheduleFilter) &&
          runMatchesQuery(run, query.trim()),
      ),
    [runs, sort, triggerFilter, statusFilter, lifecycleFilter, scheduleFilter, query],
  );

  const hasMore = totalMatched !== null && runs.length < totalMatched;
  const filtersActive =
    triggerFilter !== "all" ||
    statusFilter !== "all" ||
    lifecycleFilter !== "all" ||
    scheduleFilter !== "all" ||
    query.trim() !== "";

  const selected = useMemo(() => runs.find((run) => run.id === selectedId) ?? null, [runs, selectedId]);
  useEffect(() => {
    if (!pendingRunId) return;
    if (runs.some((run) => run.id === pendingRunId)) setSelectedId(pendingRunId);
  }, [pendingRunId, runs]);

  const columns = [
    {
      key: "started",
      header: <SortHeader label="Started" sortKey="started" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "started" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-when">
          <span>{formatTimestamp(run.startedAt)}</span>
          <span className="workflow-runs-muted">{run.finishedAt ? `Ended ${formatTimestamp(run.finishedAt)}` : "No end recorded"}</span>
        </div>
      ),
    },
    {
      key: "workflow",
      header: <SortHeader label="Workflow" sortKey="workflow" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "workflow" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-workflow">
          <span className="workflow-runs-title">{run.title}</span>
          <span className="workflow-runs-muted">
            {run.workflow} ·{" "}
            <Button
              variant="ghost"
              size="sm"
              className="workflow-runs-mono"
              onClick={() => setSelectedId(run.id)}
              aria-label={`View details for ${run.runId}`}
            >
              {run.runId}
            </Button>
          </span>
        </div>
      ),
    },
    {
      key: "trigger",
      header: <SortHeader label="Trigger" sortKey="trigger" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "trigger" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <div className="workflow-runs-trigger">
          <Badge tone={TRIGGER_TONE[run.trigger]} size="sm">
            {TRIGGER_LABEL[run.trigger]}
          </Badge>
          <span className="workflow-runs-muted">{run.triggerDetail}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: <SortHeader label="Status" sortKey="status" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "status" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <Badge tone={runStatusTone(run)} size="sm" dot>
          {runStatusLabel(run)}
        </Badge>
      ),
    },
    {
      key: "lifecycle",
      header: <SortHeader label="Lifecycle" sortKey="lifecycle" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "lifecycle" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <span className="workflow-runs-muted">
          {run.lifecycle ? LIFECYCLE_LABEL[run.lifecycle] : "Not recorded"}
        </span>
      ),
    },
    {
      key: "schedule",
      header: <SortHeader label="Schedule" sortKey="schedule" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "schedule" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => {
        const schedule = run.schedule ?? null;
        if (!schedule) {
          // Issue #3810: a run whose trigger is a non-scheduled
          // origin was never scheduled — "Not scheduled", not
          // "Not recorded". A scheduled / autonomous / unknown
          // trigger with no schedule evidence is data that should
          // exist but doesn't, so it keeps "Not recorded".
          return run.trigger === "manual" || run.trigger === "agent" || run.trigger === "webhook" ? (
            <span className="workflow-runs-muted">Not scheduled</span>
          ) : (
            <span className="workflow-runs-muted">Not recorded</span>
          );
        }
        // #3813: a schedule object stamped "not-scheduled" renders
        // "Not scheduled" (kept from main; composes with #3810's
        // trigger-based rule above for runs with no schedule object).
        if (schedule.identity === "not-scheduled") {
          return <span className="workflow-runs-muted">Not scheduled</span>;
        }
        return (
          <div className="workflow-runs-trigger">
            <span className="workflow-runs-muted">{SCHEDULE_MECHANISM_LABEL[schedule.mechanism]}</span>
            {schedule.identity && <span className="workflow-runs-muted">{schedule.identity}</span>}
            {schedule.reason && <span className="workflow-runs-muted">{schedule.reason}</span>}
            {schedule.nextFiringAt && (
              <span className="workflow-runs-muted">Next: {formatTimestamp(schedule.nextFiringAt)}</span>
            )}
            {typeof schedule.delaySeconds === "number" && (
              <span className="workflow-runs-muted">Delay: {schedule.delaySeconds}s</span>
            )}
          </div>
        );
      },
    },
    {
      key: "source",
      header: <SortHeader label="Source" sortKey="source" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "source" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => (
        <span className="workflow-runs-muted">
          {run.documents
            ? (SOURCE_LABEL[run.documents.family] ?? run.documents.family)
            : (SOURCE_LABEL[run.family] ?? run.family)}
        </span>
      ),
    },
    {
      key: "pdf",
      header: <SortHeader label="PDF" sortKey="pdf" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "pdf" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => {
        const d = documentsForRun(run);
        return <DocumentCell url={d.pdfUrl} status={d.pdfStatus} error={d.pdfError} kind="PDF" none={noDocumentsProduced(run)} />;
      },
    },
    {
      key: "xlsx",
      header: <SortHeader label="XLSX" sortKey="xlsx" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "xlsx" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => {
        const d = documentsForRun(run);
        return <DocumentCell url={d.xlsxUrl} status={d.xlsxStatus} error={d.xlsxError} kind="XLSX" none={noDocumentsProduced(run)} />;
      },
    },
    {
      key: "csv",
      header: <SortHeader label="CSV" sortKey="csv" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "csv" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => {
        const d = documentsForRun(run);
        return <DocumentCell url={d.csvUrl} status={d.csvStatus} error={d.csvError} kind="CSV" none={noDocumentsProduced(run)} />;
      },
    },
    {
      key: "duration",
      header: <SortHeader label="Duration" sortKey="duration" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "duration" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      align: "right" as const,
      render: (run: WorkflowRun) => <span className="workflow-runs-mono">{formatDuration(run.durationMs)}</span>,
    },
    {
      key: "stages",
      header: <SortHeader label="Stages" sortKey="stages" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "stages" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) =>
        run.stageCount === 0 ? (
          <span className="workflow-runs-muted">No stages recorded</span>
        ) : (
          <div className="workflow-runs-stages-cell">
            <span>
              {run.completedStages}/{run.stageCount} completed
            </span>
            {run.failedStages > 0 && (
              <Badge tone="danger" size="xs">
                {run.failedStages} failed
              </Badge>
            )}
          </div>
        ),
    },
    {
      key: "result",
      header: <SortHeader label="Result" sortKey="result" sort={sort} onSort={(key) => setSort(nextWorkflowRunSort(sort, key))} />,
      ariaSort: (sort.key === "result" ? (sort.dir === "asc" ? "ascending" : "descending") : "none") as "ascending" | "descending" | "none",
      render: (run: WorkflowRun) => {
        const outputs = (run.outputs ?? {}) as Record<string, any>;
        const outcome = outputs.outcome ?? {};
        const counts =
          typeof outcome.scanned === "number" || typeof outcome.matched === "number"
            ? `${outcome.matched ?? "—"} matched / ${outcome.scanned ?? "—"} scanned`
            : null;
        return (
          <div className="workflow-runs-result">
            {counts && <span>{counts}</span>}
            {run.artifacts.length > 0 && (
              <span className="workflow-runs-muted">
                {run.artifacts.length} artifact{run.artifacts.length === 1 ? "" : "s"}
              </span>
            )}
            {!counts && run.artifacts.length === 0 && <span className="workflow-runs-muted">—</span>}
          </div>
        );
      },
    },
    {
      key: "detail",
      header: "",
      render: (run: WorkflowRun) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSelectedId(run.id)}
          aria-haspopup="dialog"
          aria-label={`Details for ${run.title}`}
        >
          Details
        </Button>
      ),
    },
  ];

  const failedSources = Object.entries(storeErrors);

  return (
    <div className="workflow-runs-page">
      <PageShell
      title="Workflow Runs"
      scopeNote="Every run the workflow engine recorded — job chains (feed → generate → serve → deliver) and standalone screener, goal, and discovery outcomes. Each run shows its stages, inputs, outputs, failures, artifacts, and how it was triggered. Trade approvals and payments stay in their own ledgers (Approvals, Billing)."
      loading={loading && runs.length === 0}
      loadingLabel="Loading workflow runs"
    >
      {/* #2283 stream 3: the load error used to ride PageShell's error
          prop, which hides ALL children — including the Refresh button
          below. A failed load left no retry on the page. The error now
          renders inline with its own Retry, and Refresh stays visible. */}
      {error && (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-3)" }}>
          <Notice tone="danger">{error}</Notice>
          <Button variant="secondary" size="sm" onClick={() => void loadRuns("replace", 0)} loading={loading} disabled={loading}>
            Retry
          </Button>
        </div>
      )}
      {pruneNotice && (
        <Notice tone="success" density="compact" variant="strip">
          {pruneNotice}
        </Notice>
      )}
      <PageSection
        title="Runs"
        description={
          loadedAt
            ? `${runs.length} of ${totalMatched ?? runs.length} matching runs shown · snapshot ${formatTimestamp(loadedAt)}`
            : "Workflow runs"
        }
      >
        <Card padding="md" className="workflow-runs-controls">
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Trigger</span>
            <PillGroup options={TRIGGER_OPTIONS} value={triggerFilter} onChange={setTriggerFilter} size="sm" ariaLabel="Filter runs by trigger" />
          </div>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Status</span>
            <PillGroup options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} size="sm" ariaLabel="Filter runs by status" />
          </div>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Lifecycle</span>
            <PillGroup options={LIFECYCLE_OPTIONS} value={lifecycleFilter} onChange={setLifecycleFilter} size="sm" ariaLabel="Filter runs by lifecycle state" />
          </div>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Schedule</span>
            <PillGroup options={SCHEDULE_OPTIONS} value={scheduleFilter} onChange={setScheduleFilter} size="sm" ariaLabel="Filter runs by schedule type" />
          </div>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-filter-label">Reports</span>
            <PillGroup options={REPORTS_OPTIONS} value={reportsFilter} onChange={setReportsFilter} size="sm" ariaLabel="Filter runs by report documents" />
          </div>
          <div className="workflow-runs-filter workflow-runs-filter-grow">
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search run id, workflow, stage, or error"
              aria-label="Search workflow runs"
              size="sm"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadRuns("replace", 0)} loading={loading} disabled={loading}>
            ↻ Refresh
          </Button>
          {/* #2786 Part 2 (scope d): the add-ons are visible toolbar
              controls with observable effects, never silent switches. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowTraces((value) => !value)}
            title={showTraces ? "Hide standalone GET/HEAD read traces" : "Show standalone GET/HEAD read traces"}
          >
            {showTraces ? "Read traces: shown" : `Read traces: hidden (${hiddenTraceCount})`}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const next = !beaconsPaused;
              setAdBeaconsPaused(next);
              setBeaconsPaused(next);
            }}
            title={
              beaconsPaused
                ? "Resume ad impression and click beacons in this browser"
                : "Pause ad impression and click beacons in this browser (undercounts ad attribution while paused)"
            }
          >
            {beaconsPaused ? "Ad beacons: off" : "Ad beacons: on"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPruneOpen(true);
              void loadPrunePreview();
            }}
          >
            Prune history
          </Button>
          <div className="workflow-runs-filter">
            <span className="workflow-runs-muted">
              Pausing ad beacons is per-browser and undercounts ad attribution while paused. Prune is session-scoped;
              running rows are never deleted.
            </span>
          </div>
        </Card>

        {summary && (
          <div className="workflow-runs-stats" aria-label="Run summary">
            {[
              { label: "Runs loaded", value: summary.total },
              { label: "Completed", value: summary.completed },
              { label: "Partial", value: summary.partial },
              { label: "Failed", value: summary.failed },
              { label: "In flight", value: summary.active },
              ...(typeof summary.scheduled === "number"
                ? [{ label: "Scheduled lifecycle", value: summary.scheduled }]
                : []),
              { label: "Scheduled", value: summary.byTrigger.scheduled },
              { label: "Manual", value: summary.byTrigger.manual },
              { label: "Autonomous", value: summary.byTrigger.autonomous },
            ].map((stat) => (
              <Card key={stat.label} padding="sm" className="workflow-runs-stat">
                <span className="workflow-runs-stat-value">{stat.value}</span>
                <span className="workflow-runs-stat-label">{stat.label}</span>
              </Card>
            ))}
          </div>
        )}

        {failedSources.length > 0 && (
          <Notice tone="warning" variant="strip" density="compact">
            Some stores could not be read — the rest of the ledger is unaffected:{" "}
            {failedSources.map(([name, message]) => `${name}: ${message}`).join(" · ")}
          </Notice>
        )}

        <Card padding="none" className="workflow-runs-table-card">
          <Table
            columns={columns}
            rows={displayed}
            rowKey={(run) => run.id}
            caption="Workflow runs"
            containerClassName="workflow-runs-table-container"
            empty={
              <EmptyState
                framed
                icon="🧭"
                title={filtersActive ? "No runs match these filters" : "No workflow runs recorded yet"}
                description={
                  filtersActive
                    ? "Clear the trigger, status, reports, or search filters to see the recorded runs."
                    : "Runs appear here as the engine records a screen, options scan, goal run, discovery, or delivery chain — with every stage it executed."
                }
                action={
                  filtersActive ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setTriggerFilter("all");
                        setStatusFilter("all");
                        setReportsFilter("all");
                        setQuery("");
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </Card>

        {hasMore && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadRuns("append", runs.length)}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load more
          </Button>
        )}
      </PageSection>

      {pruneOpen && (
        <Modal open onClose={() => setPruneOpen(false)} title="Prune history">
          <p className="workflow-runs-muted">
            Session-scoped: only this session&apos;s async-job rows are counted. Running rows are never deleted.
          </p>
          {pruneLoading && !prunePreview && <p>Loading preview…</p>}
          {pruneError && <Notice tone="danger">{pruneError}</Notice>}
          {prunePreview && (
            <div>
              <p>
                {prunePreview.wouldDelete} rows would be deleted.
              </p>
              <p>
                {prunePreview.skippedRunning} running rows will be kept — running rows are never deleted.
              </p>
              {Object.entries(prunePreview.breakdown).length > 0 && (
                <ul>
                  {Object.entries(prunePreview.breakdown).map(([status, count]) => (
                    <li key={status}>
                      {status}: {count}
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="secondary" size="sm" onClick={() => void confirmPrune()} loading={pruneLoading} disabled={pruneLoading}>
                Confirm prune
              </Button>
            </div>
          )}
        </Modal>
      )}

      {selected && (
        <Modal
          open
          onClose={() => setSelectedId(null)}
          title="Workflow run detail"
          size="xl"
        >
          <RunDetail run={selected} />
        </Modal>
      )}
      </PageShell>
    </div>
  );
}

function RunDetail({ run }: { run: WorkflowRun }) {
  // Issue #2786 Part 3: when canonical documents exist they are the
  // authoritative doc links — the outcome's doc-kind artifacts are
  // the same files, so they are hidden here and the modal never
  // links the same document twice.
  const visibleArtifacts = run.documents
    ? run.artifacts.filter(
        (a) => a.kind !== "report" && a.kind !== "pdf" && a.kind !== "xlsx" && a.kind !== "csv",
      )
    : run.artifacts;
  // Issue #2786 losslessness fix: a run backed by a canonical row
  // carries the Docs RunDetail sections (request, provenance,
  // lineage, stages, reasons) from the same /api/runs/details payload
  // the Docs tab renders — fetched by canonical row id, so a run
  // whose runId is an asyncJobId twin resolves too. Runs without
  // canonical documents keep exactly today's detail: no fetch, no
  // section, nothing removed.
  const docsReportId = run.documents?.reportId ?? null;
  const [docsDetail, setDocsDetail] = useState<RunDetail | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  useEffect(() => {
    if (!docsReportId) return;
    let cancelled = false;
    setDocsLoading(true);
    setDocsError(null);
    fetch(`/api/runs/details?id=${encodeURIComponent(docsReportId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Docs run details unavailable (${res.status})`);
        const payload = (await res.json()) as { detail?: RunDetail | null };
        if (!cancelled) setDocsDetail(payload.detail ?? null);
      })
      .catch((err) => {
        if (!cancelled) setDocsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docsReportId]);
  return (
    <div className="workflow-runs-detail">
      <div className="workflow-runs-detail-header">
        <div>
          <h3 className="workflow-runs-detail-title">{run.title}</h3>
          <div className="workflow-runs-detail-subtitle">
            <span>{run.workflow}</span>
            <span className="workflow-runs-mono">{run.runId}</span>
            <span className="workflow-runs-muted">{run.source === "job-chain" ? "Job tree" : run.source === "report" ? "Report record only" : run.stageCount > 0 ? "Unified run record" : "Outcome record only"}</span>
          </div>
        </div>
        <div className="workflow-runs-detail-actions">
          <Badge tone={TRIGGER_TONE[run.trigger]} size="sm">
            {TRIGGER_LABEL[run.trigger]}
          </Badge>
          <Badge tone={runStatusTone(run)} size="sm" dot>
            {runStatusLabel(run)}
          </Badge>
        </div>
      </div>

      {run.error && (
        <Notice tone="danger" density="compact" variant="strip" title="Recorded failure">
          {run.error}
        </Notice>
      )}

      {/* Issue #3039: what the contract recorded about fan-out and resume —
          absent renders nothing, never an invented "no cap" claim. */}
      {run.fanoutCapReason && (
        <Notice tone="info" density="compact" variant="strip" title="Fan-out capped">
          {run.fanoutCapReason}
        </Notice>
      )}
      {(run.resumedSkippedUnits ?? []).length > 0 && (
        <Notice tone="neutral" density="compact" variant="strip" title="Resumed run">
          Skipped {run.resumedSkippedUnits.length} unit(s) already recorded as complete:{" "}
          {(run.resumedSkippedUnits ?? []).join(", ")}
        </Notice>
      )}

      <dl className="workflow-runs-facts">
        <div className="workflow-runs-fact">
          <dt>Trigger</dt>
          <dd>{run.triggerDetail}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Triggered by</dt>
          <dd>{run.triggeredBy || "Not recorded"}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Started</dt>
          <dd>{formatTimestamp(run.startedAt)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Finished</dt>
          <dd>{formatTimestamp(run.finishedAt)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Duration</dt>
          <dd>{formatDuration(run.durationMs)}</dd>
        </div>
        <div className="workflow-runs-fact">
          <dt>Stages</dt>
          <dd>
            {run.stageCount} recorded · {run.completedStages} completed
            {run.failedStages > 0 ? ` · ${run.failedStages} failed` : ""}
          </dd>
        </div>
      </dl>

      <h4 className="workflow-runs-subheading">Stages</h4>
      {run.stages.length === 0 ? (
        <Notice tone="neutral" density="compact">
          {run.source === "report"
            ? "No stage records exist for this run — its canonical row records documents, not an execution trace. Stages are never inferred."
            : "No stage records exist for this run — the producing store recorded only the run outcome. Stages are never inferred."}
        </Notice>
      ) : (
        <div className="workflow-runs-stage-list">
          <Table
            columns={[
              {
                key: "order",
                header: "#",
                align: "right" as const,
                render: (stage: WorkflowRunStage) => <span className="workflow-runs-mono">{stage.order}</span>,
              },
              {
                key: "stage",
                header: "Stage",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-workflow">
                    <span className="workflow-runs-title">{stage.label}</span>
                    <span className="workflow-runs-muted">
                      {stage.stage}
                      {stage.capability ? ` · ${stage.capability}` : ""}
                      {stage.channel ? ` · ${stage.channel}` : ""}
                    </span>
                  </div>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (stage: WorkflowRunStage) => (
                  <Badge tone={STAGE_TONE[stageStatus(stage)] ?? "neutral"} size="sm">
                    {stageStatus(stage)}
                  </Badge>
                ),
              },
              {
                key: "recorded",
                header: "Recorded",
                render: (stage: WorkflowRunStage) => (
                  <span className="workflow-runs-muted">
                    {stage.recordedBy === "job" ? (stage.jobKind ? `${stage.jobKind} job` : "Job") : "Stage record"}
                  </span>
                ),
              },
              {
                key: "timing",
                header: "Started / duration",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-when">
                    <span>{formatTimestamp(stage.startedAt)}</span>
                    <span className="workflow-runs-muted">{formatDuration(stage.durationMs)}</span>
                  </div>
                ),
              },
              {
                key: "what",
                header: "What happened",
                render: (stage: WorkflowRunStage) => (
                  <div className="workflow-runs-what">
                    <span>{stage.detail || "No description recorded"}</span>
                    {stage.reason && <span className="workflow-runs-muted">Reason: {stage.reason}</span>}
                    {stage.error && (
                      <span className="workflow-runs-error">{stage.error}</span>
                    )}
                  </div>
                ),
              },
            ]}
            rows={run.stages}
            rowKey={(stage) => stage.key}
            caption="Stages in execution order"
          />
        </div>
      )}

      <div className="workflow-runs-io-grid">
        <section className="workflow-runs-io" aria-label="Run inputs">
          <h4 className="workflow-runs-subheading">Inputs</h4>
          <pre className="workflow-runs-pre">{formatJson(run.inputs)}</pre>
        </section>
        <section className="workflow-runs-io" aria-label="Run outputs">
          <h4 className="workflow-runs-subheading">Outputs</h4>
          <pre className="workflow-runs-pre">{formatJson(run.outputs)}</pre>
        </section>
      </div>

      {run.documents && (
        <section className="workflow-runs-io" aria-label="Documents">
          <h4 className="workflow-runs-subheading">Documents</h4>
          <div className="workflow-runs-artifacts">
            <DocumentCell url={run.documents.pdfUrl} status={run.documents.pdfStatus} error={run.documents.pdfError} kind="PDF" />
            <DocumentCell url={run.documents.xlsxUrl} status={run.documents.xlsxStatus} error={run.documents.xlsxError} kind="XLSX" />
            <DocumentCell url={run.documents.csvUrl} status={run.documents.csvStatus} error={run.documents.csvError} kind="CSV" />
          </div>
          <p className="workflow-runs-muted">Canonical row {run.documents.reportId}</p>
        </section>
      )}

      {run.documents && (
        <section className="workflow-runs-io" aria-label="Docs run details">
          <h4 className="workflow-runs-subheading">Docs run details</h4>
          {docsLoading && <p className="workflow-runs-muted">Loading docs run details…</p>}
          {docsError && !docsLoading && (
            <Notice tone="neutral" density="compact">
              Docs run details could not be loaded: {docsError}
            </Notice>
          )}
          {docsDetail && !docsLoading && !docsError && (
            <RunDetailSections detail={docsDetail} levelFilter="all" />
          )}
        </section>
      )}

      <section className="workflow-runs-io" aria-label="Artifacts and delivery">
        <h4 className="workflow-runs-subheading">Artifacts & delivery</h4>
        {visibleArtifacts.length === 0 && Object.keys(run.deliveryStates).length === 0 ? (
          <p className="workflow-runs-muted">No artifacts or delivery states recorded for this run.</p>
        ) : (
          <div className="workflow-runs-artifacts">
            {visibleArtifacts.map((artifact) => (
              <a key={`${artifact.kind}:${artifact.url}`} href={artifact.url} target="_blank" rel="noreferrer">
                {artifact.label}
              </a>
            ))}
            {Object.entries(run.deliveryStates).map(([channel, state]) => (
              <Badge key={channel} tone={state === "sent" ? "success" : state === "failed" ? "danger" : "neutral"} size="sm">
                {channel}: {state}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {run.stages.some((stage) => stage.input !== null || stage.output !== null) && (
        <section className="workflow-runs-stage-io" aria-label="Per-stage inputs and outputs">
          <h4 className="workflow-runs-subheading">Per-stage inputs & outputs</h4>
          {run.stages
            .filter((stage) => stage.input !== null || stage.output !== null)
            .map((stage) => (
              <details key={stage.key} className="workflow-runs-stage-details">
                <summary>
                  {stage.order}. {stage.label} — {stageStatus(stage)}
                </summary>
                <div className="workflow-runs-io-grid">
                  <section className="workflow-runs-io" aria-label={`${stage.label} inputs`}>
                    <h5 className="workflow-runs-subheading-sm">Inputs</h5>
                    <pre className="workflow-runs-pre">{formatJson(stage.input)}</pre>
                  </section>
                  <section className="workflow-runs-io" aria-label={`${stage.label} outputs`}>
                    <h5 className="workflow-runs-subheading-sm">Outputs</h5>
                    <pre className="workflow-runs-pre">{formatJson(stage.output)}</pre>
                  </section>
                </div>
              </details>
            ))}
        </section>
      )}
    </div>
  );
}
