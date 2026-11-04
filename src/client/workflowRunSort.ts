/**
 * Workflow Runs sortable columns — Docs-tab parity (#2786 Part 2, scope c).
 *
 * Mirrors src/client/docsAndReports.ts exactly in semantics:
 *  - every shown column is sortable (the Details button column is an
 *    action, not data, and has no sort key — same as Docs, whose
 *    details affordance is not a column);
 *  - same column reverses, a new column starts at its default direction
 *    (dates and counts read best newest/largest-first; labels and ids
 *    read best A→Z);
 *  - absent values sort last in BOTH directions: "not recorded" is not
 *    a small value, it is the absence of one;
 *  - stable fallback order: newest first, then run id descending, so
 *    equal primary keys never reshuffle between renders;
 *  - the input array is untouched.
 *
 * Sort keys cover the columns the Workflow Runs table shows on main
 * (Started, Workflow, Trigger, Status, Duration, Stages, Result, run id
 * inside Workflow). Part 3's Source/document columns (unpushed, r112)
 * Part 3 columns gained their keys at the Part 2 ship reconciliation:
 * source sorts by displayed source label; pdf/xlsx/csv sort by
 * artifact presence (a run with the artifact first).
 */
import type { WorkflowRun } from "../services/workflowRuns";

export type WorkflowRunSortKey =
  | "started"
  | "workflow"
  | "trigger"
  | "status"
  | "lifecycle"
  | "schedule"
  | "source"
  | "pdf"
  | "xlsx"
  | "csv"
  | "duration"
  | "stages"
  | "result"
  | "runId";

export type WorkflowRunSortDirection = "asc" | "desc";

export interface WorkflowRunSort {
  key: WorkflowRunSortKey;
  dir: WorkflowRunSortDirection;
}

/** The page's default: newest run first, exactly as the API returns it. */
export const WORKFLOW_RUN_SORT_DEFAULT: WorkflowRunSort = { key: "started", dir: "desc" };

const SORT_DEFAULT_DIRECTION: Record<WorkflowRunSortKey, WorkflowRunSortDirection> = {
  started: "desc",
  workflow: "asc",
  trigger: "asc",
  status: "asc",
  lifecycle: "asc",
  schedule: "asc",
  source: "asc",
  pdf: "desc",
  xlsx: "desc",
  csv: "desc",
  duration: "desc",
  stages: "desc",
  result: "desc",
  runId: "asc",
};

/** Next sort state for a header click: same column reverses, a new one starts fresh. */
export function nextWorkflowRunSort(current: WorkflowRunSort, key: WorkflowRunSortKey): WorkflowRunSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: SORT_DEFAULT_DIRECTION[key] };
}

type SortValue = string | number | null;

function outcomeMatched(run: WorkflowRun): number | null {
  const outputs = (run.outputs ?? {}) as Record<string, unknown>;
  const outcome = outputs.outcome as Record<string, unknown> | undefined;
  if (!outcome) return null;
  if (typeof outcome.matched === "number") return outcome.matched;
  if (typeof outcome.scanned === "number") return outcome.scanned;
  return null;
}

function workflowRunSortValue(run: WorkflowRun, key: WorkflowRunSortKey): SortValue {
  switch (key) {
    case "started": {
      const time = Date.parse(run.startedAt);
      return Number.isNaN(time) ? null : time;
    }
    case "workflow":
      return run.workflow || null;
    case "trigger":
      // Recorded triggers only; an unrecorded trigger stays null (last).
      // Labels sort A→Z, matching Docs' label-sorting spirit.
      return run.trigger === "unknown" ? null : run.trigger;
    case "status":
      return run.status === "unknown" ? null : run.status;
    case "lifecycle":
      // Issue #3021: the four-state lifecycle, labels A→Z; a run
      // without a lifecycle (older shapes) sorts last, never first.
      return run.lifecycle ?? null;
    case "schedule": {
      // Issue #3021: mechanism + identity as one label; a run with
      // no schedule provenance sorts last.
      const schedule = run.schedule ?? null;
      if (!schedule) return null;
      return schedule.identity ? `${schedule.mechanism} ${schedule.identity}` : schedule.mechanism;
    }
    case "duration":
      return typeof run.durationMs === "number" ? run.durationMs : null;
    case "stages":
      return typeof run.stageCount === "number" ? run.stageCount : null;
    case "result":
      return outcomeMatched(run);
    case "source": {
      // Displayed source label: canonical family wins, with
      // discovery-kind rows reading "Strategy" exactly as Docs
      // labels them; otherwise the run family. Compared
      // case-insensitively, so raw values order like labels.
      const fam = run.documents ? run.documents.family : run.family;
      return fam === "discovery" ? "strategy" : fam;
    }
    case "pdf":
    case "xlsx":
    case "csv": {
      // Mirrors documentsForRun in the panel: canonical URL wins,
      // outcome artifact urls are the fallback. Presence first.
      const docs = run.documents ?? null;
      const artifact = (kind: string) => run.artifacts.find((a) => a.kind === kind)?.url ?? null;
      const url = key === "pdf"
        ? (docs?.pdfUrl ?? artifact("pdf") ?? artifact("report"))
        : key === "xlsx"
          ? (docs?.xlsxUrl ?? artifact("xlsx"))
          : (docs?.csvUrl ?? artifact("csv"));
      return url ? 1 : 0;
    }
    case "runId":
      return run.runId || null;
    default:
      return null;
  }
}

function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function compareWorkflowRunFallback(a: WorkflowRun, b: WorkflowRun): number {
  const aTime = Date.parse(a.startedAt);
  const bTime = Date.parse(b.startedAt);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Sorts the run rows for the active column. Absent values sort last in
 * BOTH directions. The input array is untouched.
 */
export function sortWorkflowRuns(rows: readonly WorkflowRun[], sort: WorkflowRunSort): WorkflowRun[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = workflowRunSortValue(a, sort.key);
    const bValue = workflowRunSortValue(b, sort.key);

    if (aValue === null || bValue === null) {
      if (aValue === null && bValue === null) return compareWorkflowRunFallback(a, b);
      return aValue === null ? 1 : -1;
    }

    const primary = compareSortValues(aValue, bValue) * sign;
    return primary !== 0 ? primary : compareWorkflowRunFallback(a, b);
  });
}
