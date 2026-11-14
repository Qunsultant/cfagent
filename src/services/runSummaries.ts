/**
 * Issue #1057 (consolidation S5): the ONE run-summary shape for the
 * Runs read surface (GET /api/runs), and the normalizers that map each
 * of the five run stores into it. This module is the single definition
 * site for the shape — the route merges, the client renders, neither
 * redefines it.
 *
 * The five stores (survey D9 + #3946):
 *  - mas_reports — the canonical store (scheduledReports hits). Rows
 *    whose source is a screening kind map to that kind; the remaining
 *    canonical sources (research_report, iv_collection, …) map to
 *    kind "report" so nothing ReportsPanel shows today disappears.
 *  - mas_opportunity_scans (ScanRunSummary) — options scans.
 *  - mas_discovery_runs (DiscoveryRunSummary) — scheduled discovery.
 *  - the ScreenerAgent latest/history feed (ScreenerRunResult) —
 *    stock screens as the agent itself recorded them.
 *  - the engine's D1 job run records (JobRunRecord, #3946 Option B)
 *    — deployment-level engine runs. They map to kind "report" with
 *    source "job-pipeline"; they carry no pdf/xlsx/csv, no reportId,
 *    and no resultCount, so those fields stay null (honest absence).
 *    They are deployment-level runs, never attributed to the
 *    signed-in user — the D1 table carries no login column.
 *
 * Honesty rule: a field a store does not record is null, never
 * invented (scan runs have no status; canonical rows have no status
 * unless their body records success/failure).
 *
 * De-duplication (mergeRunSummaries): a run stored twice — once in a
 * detail store, once canonically — appears ONCE, as the canonical
 * row. The joins are exact, never heuristic:
 *  - options scans: the canonical options_scanner body's embedded
 *    scan-run id (body.report.result.scanRunId, stamped by
 *    UnifiedOptionsService when it persists the run) equals the scan
 *    store's run id.
 *  - stock screens: the canonical screener row's runId is
 *    `screener:<timestamp>` (the persistScreenerReportCanonical /
 *    scheduled-callback generation id) and its createdAt is the feed
 *    run's timestamp.
 *  - discovery runs (consolidation C4, #1329): the canonical
 *    discovery body's body.discoveryRunId (stamped by the discovery
 *    store stage) equals the discovery store's run id.
 * A detail row with no canonical twin survives as its own row.
 */

import type { ScheduledReportHit } from "./scheduledReports";
import { scheduledReportPdfUrl } from "./scheduledReports";
// Via the src/trading barrel — the #290 boundary's sole public surface.
import type { ScanRunSummary, DiscoveryRunSummary, OptionsPartialQualification } from "../trading";
import type { ScreenerRunResult } from "../agents/screener-agent";
// Issue #3946 (Option B): the engine's D1 run records merge onto the
// Runs surface through this module's mapper, beside the DO stores.
import { d1JobRunRecordId, listD1JobRunRecords } from "./jobRunRecordReads";
import type { JobRunRecord } from "./jobRunRecords";

export type RunKind = "screener" | "options_scanner" | "discovery" | "goal" | "report";

export interface RunSummary {
  kind: RunKind;
  /** Row identity in the merged list: the canonical report id when the
   *  run is backed by mas_reports, else the detail-store run id (for
   *  screener-feed runs, the `screener:<timestamp>` generation id). */
  id: string;
  /** The run's own id in its home store (mas_reports run_id, scan id,
   *  discovery id, or `screener:<timestamp>`). */
  runId: string;
  title: string;
  summary: string;
  /** The recorded trigger ("manual" / "scheduled" / "manual-trigger" /
   *  a canonical body's trigger), or null when the store records none. */
  trigger: string | null;
  createdAt: string;
  /** "completed" / "failed" / the discovery store's status verbatim,
   *  or null when the store records no status. */
  status: string | null;
  /** The store's own headline count (matched / with-trades / evaluated
   *  / completed), or null when it records none. */
  resultCount: number | null;
  /** Issue #1850: the scan's partial-coverage qualification, when the
   *  run did not evaluate the full requested universe — carried
   *  through for scan-store rows so the list can say so. Null when
   *  the run evaluated completely or the home store records none
   *  (canonical rows: the qualification, when present, rides in the
   *  summary text instead). */
  partial?: OptionsPartialQualification | null;
  /**
   * Issue #4423 — the chain's retry lineage as its canonical row recorded it:
   * how many shard rows are retries (`retryOf`) and how many failed attempts
   * the chain persisted (#4417). Null when the body records none (a non-chain
   * row, or one written before the fields existed) — never 0-by-default, so
   * "no retry" and "not recorded" stay distinguishable.
   */
  retry?: { retriedShards: number; attempts: number } | null;
  pdfKey: string | null;
  reportUrl: string | null;
  /** Issue #1335: stored XLSX / CSV artifact keys + download urls, when
   *  the home store records them (goal-screen rows record all three;
   *  other rows null until their pipelines record keys). */
  xlsxKey: string | null;
  xlsxUrl: string | null;
  csvKey: string | null;
  csvUrl: string | null;
  /** Issue #1239 (#1209 F3): the run's recorded PDF generation state
   *  ("generated" / "failed" / …) and its failure reason, when the
   *  home store records them — so the Reports list can say a PDF is
   *  unavailable instead of silently showing no link. */
  pdfStatus: string | null;
  pdfError: string | null;
  /** Issue #2088: the run's recorded XLSX / CSV generation state
   *  ("generated" / "failed" / …) and failure reasons, when the home
   *  store records them — so the Docs list can show a failed leg
   *  instead of a bare "—". Optional: older rows lack them. */
  xlsxStatus?: string | null;
  xlsxError?: string | null;
  csvStatus?: string | null;
  csvError?: string | null;
  /** The canonical mas_reports id when this run has a canonical row
   *  (the detail/download affordance key), else null. */
  reportId: string | null;
  /** The mas_opportunity_scans run id this row corresponds to, when
   *  known: a canonical options row carries the id its body links to
   *  (the exact de-duplication join); a scan-store row carries its own
   *  id; every other row null. */
  scanRunId: string | null;
  /** Consolidation C4 (#1329): the mas_discovery_runs run id this row
   *  corresponds to, when known — the discovery twin of scanRunId. A
   *  canonical discovery row carries the id its body links to
   *  (body.discoveryRunId, stamped by the discovery store stage); a
   *  discovery-store row carries its own id; every other row null.
   *  Optional so pre-C4 literals still typecheck. */
  discoveryRunId?: string | null;
  /** Display source: the mas_reports source for canonical rows;
   *  "options_scanner" / "discovery" / "screener" for detail-only rows. */
  source: string;
  /** Issue #2062: the screener-workflow family the run recorded
   *  ("stock" / "options" / "goal" / "strategy"), when the store
   *  records one. Optional so pre-#2062 rows still typecheck. */
  runSource?: string | null;
  /**
   * Issue #2910 (G3): the child canonical run ids a parent
   * row absorbs (`screener:<timestamp>` per market shard),
   * carried so the merge below can drop the child rows and
   * so detail views can link parent → shards. Null/absent
   * on every non-parent row.
   */
  childRunIds?: string[] | null;
  /**
   * Issue #2910 (G3): the child canonical report ids a
   * parent row absorbs, when the child doors returned them
   * (the goal join — goal child rows do not key on
   * timestamps). Null/absent on every non-parent row.
   */
  childReportIds?: string[] | null;
}

function strArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return ids.length > 0 ? ids : null;
}

function parseBody(body: unknown): Record<string, any> {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body || "{}") : body;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The scan-run id a canonical options_scanner body links to, if any —
 *  the exact de-duplication join for the scan store. */
export function canonicalScanRunId(body: unknown): string | null {
  const parsed = parseBody(body);
  return (
    strOrNull(parsed?.report?.result?.scanRunId) ??
    strOrNull(parsed?.result?.scanRunId) ??
    strOrNull(parsed?.scanRunId)
  );
}

const KIND_BY_REPORT_SOURCE: Record<string, RunKind> = {
  screener: "screener",
  options_scanner: "options_scanner",
  options_screen: "options_scanner",
  // Issue #2167: options research runs are their own family; the Docs row
  // renders from the canonical body's artifact keys.
  options_research: "report",
  // Strategy Discovery panel runs (source "options_strategy") are the
  // same options-research family and belong under the options filter.
  options_strategy: "options_scanner",
  // Consolidation C4 (#1329): discovery runs store canonical reports
  // now (source "discovery"), so their canonical rows map to kind
  // "discovery" instead of falling through to "report".
  discovery: "discovery",
  // Consolidation C5 (#1361): goal-screen canonical rows get their own
  // kind (C4 limitation: they surfaced under "report" because the Runs
  // shape had no goal kind). The Reports panel filters goal_screen
  // client-side by source, so no client change is needed.
  goal_screen: "goal",
};

/** Issue #2062: the screener-workflow family a run records (body.runSource),
 *  falling back to its kind for rows written before the field existed. */
const RUN_SOURCE_BY_KIND: Record<string, string> = {
  screener: "stock",
  options_scanner: "options",
  goal: "goal",
  discovery: "strategy",
};

function xlsxUrlForSource(source: string, key: string): string | null {
  if (source === "screener") return `/api/screener/report.xlsx?key=${encodeURIComponent(key)}`;
  // Issue #2162: strategy runs store their workbook in the options family.
  if (source === "options_scanner" || source === "options_screen" || source === "options_strategy")
    return `/api/options/report.xlsx?key=${encodeURIComponent(key)}`;
  // Issue #2167: options research workbooks are served by the research route.
  if (source === "options_research")
    return `/api/research/report.xlsx?key=${encodeURIComponent(key)}`;
  // Issue #2180: discovery run workbooks are served by the discovery route.
  if (source === "discovery")
    return `/api/discovery/report.xlsx?key=${encodeURIComponent(key)}`;
  if (source === "goal_screen")
    return `/api/screening/goal-screen/report.xlsx?key=${encodeURIComponent(key)}`;
  return null;
}

/** Issue #1346: mirrors xlsxUrlForSource for the stored CSV artifact. */
function csvUrlForSource(source: string, key: string): string | null {
  if (source === "screener") return `/api/screener/report.csv?key=${encodeURIComponent(key)}`;
  // Issue #2162: strategy runs store their CSV in the options family.
  if (source === "options_scanner" || source === "options_screen" || source === "options_strategy")
    return `/api/options/report.csv?key=${encodeURIComponent(key)}`;
  // Issue #2167: options research CSVs are served by the research route.
  if (source === "options_research")
    return `/api/research/report.csv?key=${encodeURIComponent(key)}`;
  // Issue #2180: discovery run CSVs are served by the discovery route.
  if (source === "discovery")
    return `/api/discovery/report.csv?key=${encodeURIComponent(key)}`;
  if (source === "goal_screen")
    return `/api/screening/goal-screen/report.csv?key=${encodeURIComponent(key)}`;
  return null;
}

function statusFromResultStatus(v: unknown): string | null {
  if (v === "complete") return "completed";
  if (v === "partial") return "partial";
  if (v === "failed") return "failed";
  return null;
}

/** The discovery-run id a canonical discovery body links to, if any —
 *  the exact de-duplication join for the discovery store. */
export function canonicalDiscoveryRunId(body: unknown): string | null {
  const parsed = parseBody(body);
  return strOrNull(parsed?.discoveryRunId);
}

export function runSummaryFromReport(hit: ScheduledReportHit): RunSummary {
  const body = parseBody(hit.body);
  const kind = KIND_BY_REPORT_SOURCE[hit.source] ?? "report";
  const success = body?.success;
  let resultCount: number | null = null;
  if (kind === "screener") {
    resultCount = numOrNull(body?.matchedCount) ?? numOrNull(body?.report?.matchedCount);
  } else if (kind === "options_scanner") {
    resultCount =
      numOrNull(body?.withTrades) ??
      numOrNull(body?.report?.result?.withTrades) ??
      (Array.isArray(body?.opportunities) ? body.opportunities.length : null);
  }
  return {
    kind,
    id: hit.id,
    runId: hit.runId,
    title: hit.title,
    summary: hit.summary,
    trigger: strOrNull(body?.trigger),
    createdAt: hit.createdAt,
    status:
      success === true
        ? "completed"
        : success === false
          ? "failed"
          : // Issue #1335: goal-screen bodies carry no `success` — the
            // result's own status verb is the status.
            (statusFromResultStatus(body?.result?.status) ??
            statusFromResultStatus(body?.report?.result?.status)),
    resultCount,
    retry: (() => {
      const retried = numOrNull(body?.retriedShards);
      const attempts = numOrNull(body?.shardAttempts);
      if (retried === null && attempts === null) return null;
      return { retriedShards: retried ?? 0, attempts: attempts ?? 0 };
    })(),
    pdfKey: strOrNull(body?.pdfKey) ?? strOrNull(body?.report?.result?.pdfKey),
    reportUrl: scheduledReportPdfUrl(hit.source, hit.body) ?? null,
    xlsxKey: strOrNull(body?.xlsxKey) ?? strOrNull(body?.report?.result?.xlsxKey),
    xlsxUrl: (() => {
      const k = strOrNull(body?.xlsxKey) ?? strOrNull(body?.report?.result?.xlsxKey);
      return k ? xlsxUrlForSource(hit.source, k) : null;
    })(),
    csvKey: strOrNull(body?.csvKey) ?? strOrNull(body?.report?.result?.csvKey),
    csvUrl: (() => {
      const k = strOrNull(body?.csvKey) ?? strOrNull(body?.report?.result?.csvKey);
      return k ? csvUrlForSource(hit.source, k) : null;
    })(),
    pdfStatus:
      strOrNull(body?.pdfStatus) ??
      strOrNull(body?.report?.result?.pdfStatus) ??
      strOrNull(body?.result?.pdfStatus),
    pdfError:
      strOrNull(body?.pdfError) ??
      strOrNull(body?.report?.result?.pdfError) ??
      strOrNull(body?.result?.pdfError),
    xlsxStatus:
      strOrNull(body?.xlsxStatus) ??
      strOrNull(body?.report?.result?.xlsxStatus) ??
      strOrNull(body?.result?.xlsxStatus),
    xlsxError:
      strOrNull(body?.xlsxError) ??
      strOrNull(body?.report?.result?.xlsxError) ??
      strOrNull(body?.result?.xlsxError),
    csvStatus:
      strOrNull(body?.csvStatus) ??
      strOrNull(body?.report?.result?.csvStatus) ??
      strOrNull(body?.result?.csvStatus),
    csvError:
      strOrNull(body?.csvError) ??
      strOrNull(body?.report?.result?.csvError) ??
      strOrNull(body?.result?.csvError),
    reportId: hit.id,
    scanRunId: kind === "options_scanner" ? canonicalScanRunId(hit.body) : null,
    discoveryRunId: kind === "discovery" ? canonicalDiscoveryRunId(hit.body) : null,
    source: hit.source,
    runSource: strOrNull(body?.runSource) ?? RUN_SOURCE_BY_KIND[kind] ?? null,
    // Issue #2910 (G3): a parent canonical row carries its
    // child linkage in the body; the merge below absorbs
    // the child rows into this row.
    childRunIds: strArrayOrNull(body?.childRunIds),
    childReportIds: strArrayOrNull(body?.childReportIds),
  };
}

export function runSummaryFromScanRun(scan: ScanRunSummary): RunSummary {
  const gate = scan.gate;
  const evaluated = numOrNull(scan.coverage?.evaluated);
  const partial = scan.partial ?? null;
  return {
    kind: "options_scanner",
    id: scan.id,
    runId: scan.id,
    title: scan.profileRef?.name
      ? `Options scan — ${scan.mode} (${scan.profileRef.name})`
      : `Options scan — ${scan.mode}`,
    summary:
      `Gate: ${gate?.fit ?? 0} fit, ${gate?.borderline ?? 0} borderline, ${gate?.noFit ?? 0} no fit` +
      (evaluated !== null ? ` across ${evaluated} evaluated.` : ".") +
      // Issue #1850: the same partial segment the service summary
      // appends (R6), so a partial scan-store row reads exactly like
      // a partial canonical row in the same list.
      (partial
        ? ` Partial coverage — qualified partial results: evaluated ${partial.evaluatedCount} of ${partial.consideredCount} underlyings (${partial.coverageErrors} failures, ${partial.truncatedCount} truncated).`
        : ""),
    trigger: scan.trigger ?? null,
    createdAt: scan.generatedAt,
    status: null,
    resultCount: evaluated,
    partial,
    pdfKey: scan.pdfKey ?? null,
    reportUrl: scan.pdfKey
      ? `/api/options/report.pdf?key=${encodeURIComponent(scan.pdfKey)}`
      : null,
    // Issue #2091: workbook/CSV keys mirror the PDF key mapping —
    // a scan row that carries them surfaces its downloads in Docs.
    xlsxKey: scan.xlsxKey ?? null,
    xlsxUrl: scan.xlsxKey
      ? `/api/options/report.xlsx?key=${encodeURIComponent(scan.xlsxKey)}`
      : null,
    csvKey: scan.csvKey ?? null,
    csvUrl: scan.csvKey
      ? `/api/options/report.csv?key=${encodeURIComponent(scan.csvKey)}`
      : null,
    pdfStatus: scan.pdfKey ? "generated" : null,
    pdfError: null,
    xlsxStatus: scan.xlsxKey ? "generated" : null,
    xlsxError: null,
    csvStatus: scan.csvKey ? "generated" : null,
    csvError: null,
    reportId: null,
    scanRunId: scan.id,
    source: "options_scanner",
    runSource: "options",
  };
}

export function runSummaryFromDiscoveryRun(run: DiscoveryRunSummary): RunSummary {
  return {
    kind: "discovery",
    id: run.id,
    runId: run.id,
    title: `Strategy discovery — ${run.inputModel}`,
    summary:
      `${run.completedCount} completed, ${run.failedCount} failed, ${run.abstainedCount} abstained` +
      ` across ${run.symbols.length} symbols.`,
    trigger: run.trigger,
    createdAt: run.createdAt,
    status: run.status,
    resultCount: run.completedCount,
    pdfKey: null,
    reportUrl: null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: null,
    pdfError: null,
    xlsxStatus: null,
    xlsxError: null,
    csvStatus: null,
    csvError: null,
    reportId: null,
    scanRunId: null,
    discoveryRunId: run.id,
    source: "discovery",
    runSource: "strategy",
  };
}

export function runSummaryFromScreenerRun(run: ScreenerRunResult): RunSummary {
  const runId = `screener:${run.timestamp}`;
  return {
    kind: "screener",
    id: runId,
    runId,
    title: `Market screen — ${run.universe ?? run.sector ?? "ALL"}`,
    summary: run.success
      ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities?.length ?? 0} opportunities.`
      : `Screen failed: ${run.error ?? "unknown error"}.`,
    trigger: run.trigger ?? null,
    createdAt: run.timestamp,
    status: run.success ? "completed" : "failed",
    resultCount: numOrNull(run.matchedCount),
    pdfKey: run.pdfKey ?? null,
    reportUrl: run.pdfKey
      ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}`
      : null,
    xlsxKey: run.xlsxKey ?? null,
    xlsxUrl: run.xlsxKey
      ? `/api/screener/report.xlsx?key=${encodeURIComponent(run.xlsxKey)}`
      : null,
    csvKey: run.csvKey ?? null,
    csvUrl: run.csvKey
      ? `/api/screener/report.csv?key=${encodeURIComponent(run.csvKey)}`
      : null,
    pdfStatus: run.pdfStatus ?? null,
    pdfError: run.pdfError ?? null,
    xlsxStatus: run.xlsxStatus ?? null,
    xlsxError: run.xlsxError ?? null,
    csvStatus: run.csvStatus ?? null,
    csvError: run.csvError ?? null,
    reportId: null,
    scanRunId: null,
    source: "screener",
    runSource: "stock",
  };
}

/**
 * Issue #3946 (Option B): a D1 job run record → the one Runs shape.
 * The record carries no pdf/xlsx/csv, no reportId, and no
 * resultCount — those stay null, never invented. The summary is the
 * engine's recorded descriptor when present; otherwise the outcome
 * in words (failure carries the recorded error, skipped carries the
 * recorded reason). Kind "report": D1 rows surface under kind=all
 * only — "report" is not a valid kind filter value, so no other kind
 * ever claims them. The row is a deployment-level engine run, never
 * attributed to the signed-in user.
 */
export function runSummaryFromJobRunRecord(record: JobRunRecord): RunSummary {
  const id = d1JobRunRecordId(record);
  const status =
    record.outcome === "success"
      ? "completed"
      : record.outcome === "failure"
        ? "failed"
        : "skipped";
  const summary =
    record.descriptor ??
    (record.outcome === "failure"
      ? `Failed: ${record.error ?? "unknown error"}`
      : record.outcome === "skipped"
        ? `Skipped: ${record.detail ?? "no reason recorded"}`
        : `Completed ${record.operation} for ${record.jobId}`);
  return {
    kind: "report",
    id,
    runId: id,
    title: `Job ${record.jobId}`,
    summary,
    trigger: record.trigger ?? null,
    createdAt: record.started,
    status,
    resultCount: null,
    pdfKey: null,
    reportUrl: null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: null,
    pdfError: null,
    xlsxStatus: null,
    xlsxError: null,
    csvStatus: null,
    csvError: null,
    reportId: null,
    scanRunId: null,
    source: "job-pipeline",
  };
}

/**
 * Issue #3946 (Option B): the engine's D1 run records as Runs
 * summaries. Throws the reader's named error when AGENT_DB is
 * unbound — the route names it in storeErrors.
 */
export async function listD1JobRunRecordSummaries(
  env: unknown,
  limit: number,
): Promise<RunSummary[]> {
  const records = await listD1JobRunRecords(env, limit);
  return records.map(runSummaryFromJobRunRecord);
}

/**
 * Merge per-store summary lists into one newest-first list,
 * de-duplicated on the exact joins documented above (the canonical
 * row wins), then sliced to `limit`. Ties break by id descending so
 * the order is deterministic across stores.
 */
export function mergeRunSummaries(lists: RunSummary[][], limit: number): RunSummary[] {
  const canonicalScanIds = new Set<string>();
  const canonicalScreenerRunIds = new Set<string>();
  // Consolidation C4 (#1329): the discovery twin of the scan join —
  // canonical discovery rows link their detail run via
  // body.discoveryRunId (see canonicalDiscoveryRunId).
  const canonicalDiscoveryIds = new Set<string>();
  // Issue #1239 (#1209 F3): the detail-store twins a canonical row is
  // about to absorb, keyed by the same exact joins — the winner
  // inherits any PDF facts it lacks from the twin it drops.
  const scanTwins = new Map<string, RunSummary>();
  const screenerTwins = new Map<string, RunSummary>();
  const discoveryTwins = new Map<string, RunSummary>();
  // Issue #2910 (G3): the child rows a parent canonical row
  // absorbs, keyed by both joins — canonical run id
  // (market shards) and canonical report id (goal shards).
  // parentKeys guards the parent rows themselves: a parent
  // is never absorbed by its own linkage.
  const absorbedRunIds = new Set<string>();
  const absorbedReportIds = new Set<string>();
  const parentKeys = new Set<string>();
  for (const list of lists) {
    for (const row of list) {
      if (row.reportId === null) {
        if (row.kind === "options_scanner") scanTwins.set(row.id, row);
        if (row.kind === "screener") screenerTwins.set(row.runId, row);
        if (row.kind === "discovery" && row.discoveryRunId) discoveryTwins.set(row.discoveryRunId, row);
        continue;
      }
      if (row.kind === "options_scanner" && row.scanRunId) canonicalScanIds.add(row.scanRunId);
      if (row.kind === "screener") canonicalScreenerRunIds.add(row.runId);
      if (row.kind === "discovery" && row.discoveryRunId) canonicalDiscoveryIds.add(row.discoveryRunId);
      if (row.childRunIds || row.childReportIds) {
        parentKeys.add(`${row.kind}:${row.id}`);
        for (const id of row.childRunIds ?? []) absorbedRunIds.add(id);
        for (const id of row.childReportIds ?? []) absorbedReportIds.add(id);
      }
    }
  }
  const seen = new Set<string>();
  const merged: RunSummary[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (row.reportId === null && row.kind === "options_scanner" && canonicalScanIds.has(row.id)) {
        continue; // the canonical twin wins
      }
      if (row.reportId === null && row.kind === "screener" && canonicalScreenerRunIds.has(row.runId)) {
        continue; // the canonical twin wins
      }
      if (row.reportId === null && row.kind === "discovery" && row.discoveryRunId && canonicalDiscoveryIds.has(row.discoveryRunId)) {
        continue; // the canonical twin wins
      }
      const key = `${row.kind}:${row.id}`;
      // Issue #2910 (G3): a child row absorbed by a parent
      // canonical row is detail, not a top-level row — the
      // parent row carries the shard linkage, and the child
      // rows stay in mas_reports, reachable by id. The
      // parent row itself is exempt via parentKeys.
      if (
        !parentKeys.has(key) &&
        (absorbedRunIds.has(row.runId) || absorbedReportIds.has(row.id))
      ) {
        continue; // the parent row wins; the shard row is its detail
      }
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.reportId !== null) {
        const twin = row.kind === "options_scanner" && row.scanRunId
          ? scanTwins.get(row.scanRunId)
          : row.kind === "screener"
            ? screenerTwins.get(row.runId)
            : row.kind === "discovery" && row.discoveryRunId
              ? discoveryTwins.get(row.discoveryRunId)
              : undefined;
        if (twin) {
          // The status/error describe ONE artifact: they inherit only
          // when they belong to the winner's key — i.e. the key itself
          // was inherited, or both rows name the same key. A twin
          // pointing at a DIFFERENT artifact never rewrites the
          // winner's story.
          const sameArtifact = row.pdfKey === null || twin.pdfKey === row.pdfKey;
          // Issue #2088: the same rule extends to the workbook
          // artifacts — a canonical twin no longer hides the
          // detail record's XLSX/CSV keys (the 03:50 mechanism),
          // and a twin pointing at a DIFFERENT artifact never
          // rewrites the winner's story for that kind.
          const sameXlsx = row.xlsxKey === null || twin.xlsxKey === row.xlsxKey;
          const sameCsv = row.csvKey === null || twin.csvKey === row.csvKey;
          merged.push({
            ...row,
            pdfKey: row.pdfKey ?? twin.pdfKey,
            reportUrl: row.reportUrl ?? twin.reportUrl,
            pdfStatus: row.pdfStatus ?? (sameArtifact ? twin.pdfStatus : null),
            pdfError: row.pdfError ?? (sameArtifact ? twin.pdfError : null),
            xlsxKey: row.xlsxKey ?? twin.xlsxKey,
            xlsxUrl: row.xlsxUrl ?? twin.xlsxUrl,
            xlsxStatus: row.xlsxStatus ?? (sameXlsx ? (twin.xlsxStatus ?? null) : null),
            xlsxError: row.xlsxError ?? (sameXlsx ? (twin.xlsxError ?? null) : null),
            csvKey: row.csvKey ?? twin.csvKey,
            csvUrl: row.csvUrl ?? twin.csvUrl,
            csvStatus: row.csvStatus ?? (sameCsv ? (twin.csvStatus ?? null) : null),
            csvError: row.csvError ?? (sameCsv ? (twin.csvError ?? null) : null),
          });
          continue;
        }
      }
      merged.push(row);
    }
  }
  merged.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  return merged.slice(0, Math.max(0, limit));
}
