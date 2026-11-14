/**
 * Docs and Reports: the document index behind the nav page.
 *
 * The screener workflow persists one row per run in the Runs read surface
 * (GET /api/runs, src/services/runSummaries.ts) and records the artifacts
 * that run produced (PDF / XLSX / CSV keys → download urls). This module
 * turns those normalized RunSummary rows into the table model the page
 * renders: one row per document set, with the run's family (stock /
 * options / goal / strategy) and its trigger (manual / scheduled).
 *
 * Honesty rules, matching the Runs API:
 *  - A store that records no trigger yields `runType: null` (rendered as
 *    "—"), never a guessed "scheduled".
 *  - Only the four screener-workflow families are listed. Research
 *    reports and IV collection are different products with their own
 *    pages; they are filtered out rather than relabeled.
 *  - A missing artifact keeps a null url (rendered "—"), never a broken
 *    link to a key the run did not record.
 */

import type { RunSummary } from "../services/runSummaries";

/** The four screener-workflow run families the page lists. */
export type DocumentRunSource = "stock" | "options" | "goal" | "strategy";

/** How the run was started. `null` when the home store recorded no trigger. */
export type DocumentRunType = "manual" | "scheduled";

export interface DocumentRow {
  /** Stable row key (the RunSummary id — canonical report id or detail-store id). */
  id: string;
  runId: string;
  /** ISO timestamp of the run. */
  createdAt: string;
  /** Recorded trigger, normalized; null when the store records none. */
  runType: DocumentRunType | null;
  /** The recorded trigger verbatim (e.g. "manual-trigger"), for the tooltip. */
  rawTrigger: string | null;
  runSource: DocumentRunSource;
  title: string;
  status: string | null;
  pdfUrl: string | null;
  xlsxUrl: string | null;
  csvUrl: string | null;
  pdfStatus: string | null;
  pdfError: string | null;
  /**
   * Issue #4423 — the chain's retry lineage as the run recorded it: how many
   * shard rows are retries and how many failed attempts the chain persisted.
   * Null when the store records none, so "no retry" and "not recorded" stay
   * distinguishable on the row.
   */
  retry: { retriedShards: number; attempts: number } | null;
  /** Issue #2088: recorded leg failure state, when the run records it. */
  xlsxStatus: string | null;
  xlsxError: string | null;
  csvStatus: string | null;
  csvError: string | null;
}

const SOURCE_BY_KIND: Record<string, DocumentRunSource> = {
  screener: "stock",
  options_scanner: "options",
  goal: "goal",
  discovery: "strategy",
};

/**
 * Legacy/home-store source labels map onto the same four families, so a
 * detail-only row (kind "report") still lands in the right column when
 * its store names a family it belongs to.
 */
const SOURCE_BY_STORE_SOURCE: Record<string, DocumentRunSource> = {
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  // Issue #2167: options research runs belong to the options family, so their
  // rows (and artifact links) reach the Docs table.
  options_research: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

/** The explicit family a run records in its body (#2062). */
const RECORDED_SOURCES: Record<string, DocumentRunSource> = {
  stock: "stock",
  options: "options",
  goal: "goal",
  strategy: "strategy",
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

export const DOCUMENT_SOURCE_LABELS: Record<DocumentRunSource, string> = {
  stock: "Stock",
  options: "Options",
  goal: "Goal",
  strategy: "Strategy",
};

/** The document family a run belongs to, or null when it is not a screener-workflow run. */
export function documentRunSource(
  run: Pick<RunSummary, "kind" | "source" | "runSource">,
): DocumentRunSource | null {
  // Issue #2062: the family recorded on the run wins; the kind/source
  // derivation stays as the fallback for rows written before the field.
  const recorded = typeof run.runSource === "string" ? RECORDED_SOURCES[run.runSource] : undefined;
  if (recorded) return recorded;
  const byKind = SOURCE_BY_KIND[run.kind];
  if (byKind) return byKind;
  return SOURCE_BY_STORE_SOURCE[run.source] ?? null;
}

/**
 * Normalizes a recorded trigger onto manual/scheduled. Unknown or absent
 * triggers stay null — the page says "—" instead of inventing a value.
 */
export function documentRunType(
  run: Pick<RunSummary, "trigger">,
): DocumentRunType | null {
  const trigger = (run.trigger ?? "").trim().toLowerCase();
  if (!trigger) return null;
  if (trigger.startsWith("manual")) return "manual";
  if (trigger.startsWith("schedul") || trigger === "cron") return "scheduled";
  return null;
}

/** Turns Runs-API rows into the document index, newest first. */
export function toDocumentRows(
  runs: Pick<
    RunSummary,
    "id" | "runId" | "createdAt" | "trigger" | "kind" | "source" | "runSource" | "title" | "status" | "reportUrl" | "xlsxUrl" | "csvUrl" | "xlsxStatus" | "xlsxError" | "csvStatus" | "csvError" | "pdfStatus" | "pdfError" | "retry"
  >[],
): DocumentRow[] {
  const rows: DocumentRow[] = [];
  for (const run of runs) {
    const runSource = documentRunSource(run);
    if (!runSource) continue;
    const rawTrigger = (run.trigger ?? "").trim() || null;
    rows.push({
      id: String(run.id),
      runId: String(run.runId),
      createdAt: String(run.createdAt ?? ""),
      runType: documentRunType(run),
      rawTrigger,
      runSource,
      title: String(run.title ?? ""),
      status: run.status ?? null,
      retry: run.retry ?? null,
      pdfUrl: run.reportUrl ?? null,
      pdfStatus: run.pdfStatus ?? null,
      pdfError: run.pdfError ?? null,
      xlsxUrl: run.xlsxUrl ?? null,
      csvUrl: run.csvUrl ?? null,
      xlsxStatus: run.xlsxStatus ?? null,
      xlsxError: run.xlsxError ?? null,
      csvStatus: run.csvStatus ?? null,
      csvError: run.csvError ?? null,
    });
  }
  rows.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  return rows;
}

/** Format an ISO timestamp for the table with a timezone label;
 *  invalid values render the raw string. Issue #2534: the user
 *  timezone with label is the displayed time, never a bare ISO
 *  string or server time. */
export function formatRunTimestamp(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || undefined,
    timeZoneName: "short",
  });
}

/**
 * Sortable columns of the document index. Every column the table shows is
 * sortable — including the three artifact columns, where "present" is the
 * sortable fact (a run either recorded that artifact or did not).
 */
export type DocumentSortKey =
  | "createdAt"
  | "runType"
  | "runSource"
  | "pdf"
  | "xlsx"
  | "csv"
  | "runId";

export type DocumentSortDirection = "asc" | "desc";

export interface DocumentSort {
  key: DocumentSortKey;
  dir: DocumentSortDirection;
}

/** The page's default: newest run first, exactly as the API returns it. */
export const DOCUMENT_SORT_DEFAULT: DocumentSort = { key: "createdAt", dir: "desc" };

/**
 * The direction a column starts in when it becomes the active sort.
 * Dates and artifact presence read best newest/present-first; labels and
 * ids read best A→Z.
 */
const SORT_DEFAULT_DIRECTION: Record<DocumentSortKey, DocumentSortDirection> = {
  createdAt: "desc",
  runType: "asc",
  runSource: "asc",
  pdf: "desc",
  xlsx: "desc",
  csv: "desc",
  runId: "asc",
};

/** Next sort state for a header click: same column reverses, a new one starts fresh. */
export function nextDocumentSort(current: DocumentSort, key: DocumentSortKey): DocumentSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: SORT_DEFAULT_DIRECTION[key] };
}

type SortValue = string | number | null;

function documentSortValue(row: DocumentRow, key: DocumentSortKey): SortValue {
  switch (key) {
    case "createdAt": {
      const time = Date.parse(row.createdAt);
      return Number.isNaN(time) ? null : time;
    }
    case "runType":
      // Recorded triggers only; an unrecorded trigger stays null (last).
      return row.runType === "manual" ? 0 : row.runType === "scheduled" ? 1 : null;
    case "runSource":
      return DOCUMENT_SOURCE_LABELS[row.runSource] ?? null;
    case "pdf":
      return row.pdfUrl ? 1 : 0;
    case "xlsx":
      return row.xlsxUrl ? 1 : 0;
    case "csv":
      return row.csvUrl ? 1 : 0;
    case "runId":
      return row.runId || null;
    default:
      return null;
  }
}

function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Stable fallback order: newest first, then row id descending. It keeps
 * equal primary keys from reshuffling between renders.
 */
function compareDocumentFallback(a: DocumentRow, b: DocumentRow): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return bTime - aTime;
  return b.id < a.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Sorts the document rows for the active column. Absent values (`null`
 * run type, no recorded artifact) sort last in BOTH directions: "not
 * recorded" is not a small value, it is the absence of one, and burying
 * it keeps the recorded rows comparable. The input array is untouched.
 */
export function sortDocumentRows(rows: readonly DocumentRow[], sort: DocumentSort): DocumentRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = documentSortValue(a, sort.key);
    const bValue = documentSortValue(b, sort.key);

    if (aValue === null || bValue === null) {
      if (aValue === null && bValue === null) return compareDocumentFallback(a, b);
      return aValue === null ? 1 : -1;
    }

    const primary = compareSortValues(aValue, bValue) * sign;
    return primary !== 0 ? primary : compareDocumentFallback(a, b);
  });
}
