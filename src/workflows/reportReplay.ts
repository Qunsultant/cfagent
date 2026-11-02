/**
 * Issue #2863 (Replay under #2764, prerequisite #2869) — report
 * replay from persisted data only.
 *
 * Definition (from #2863): the same report from any given day,
 * reproduced at any time from ALL data fetched/enriched and
 * persisted for that run — criteria, pinned patternRef,
 * resolved presetRef, universe, quotes, enrichment,
 * indicators/scores, full set + standouts, artifacts — with
 * ZERO live re-fetch, NO re-charge (distinct from a new live
 * screen, which IS charged), provenance to the original run,
 * partial marking if persisted data is incomplete, and loud
 * failure if data is missing.
 *
 * How the guarantees hold, by construction:
 *   - ZERO live re-fetch: buildReplayFromRecord takes the
 *     persisted canonical record as its ONLY input. It has
 *     no provider, fetch, quote, or engine input anywhere
 *     on its signature — a live call cannot be smuggled in
 *     without changing the signature. The endpoint reads
 *     one canonical row (plus its R2 body) and nothing else.
 *   - NO re-charge: the replay envelope carries charged:
 *     false and kind: "replay", and the endpoint never
 *     touches any payment/monetization path. A replay is
 *     not a run: it mints no job, starts no workflow, and
 *     writes no new canonical report.
 *   - Provenance: originalRunId + generationId + replayedAt
 *     ride every envelope, so a replay never presents as
 *     the original run.
 *   - Partial vs loud: a missing record, a missing body,
 *     or a body with no full set (allStocks) is a loud
 *     failure (throw — the endpoint maps it to 404/422/
 *     500, never a fabricated report). Incomplete data
 *     (rows present, but criteria, standouts, or artifacts
 *     absent — e.g. runs persisted before criteria were
 *     recorded) replays the rows with partial: true and a
 *     partialReasons entry per gap, never silently complete.
 *
 * Criteria recording (forward-looking): REST runs persist
 * their spec.filters as criteria through
 * persistScreenerReportCanonical (additive body fields
 * criteria/patternRef/presetRef — older readers ignore
 * them). Pattern/preset refs are undefined until the
 * patterns/presets slices populate them; a replay of a run
 * without them marks that gap partial, it does not invent
 * refs. Scheduled/workflow canonical writes that do not
 * pass criteria yet replay the same way (rows + partial
 * criteria gap).
 *
 * Research reports (source "research_report") replay
 * verbatim: the stored body IS the report, returned
 * as-is with replay provenance. No re-generation, no
 * live research call. Anything else (unknown source, or
 * a screener body with no full set) is a loud failure.
 */

export interface ReplayRecord {
  /** Canonical mas_reports row id. */
  id: string;
  /** Stored run_id (screener: `screener:<timestamp>` generation). */
  runId: string;
  /** Row source: "screener" for stock screens, "research_report" for research reports. */
  source: string;
  /** The persisted canonical body (parsed JSON). */
  body: unknown;
  /** Owning login when the row carries one (owner scoping is enforced by the row lookup, not here). */
  userLogin?: string;
}

export interface ReplayArtifacts {
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  reportUrl?: string;
}

export interface StockReplayEnvelope {
  kind: "replay";
  reportKind: "stock-screen";
  charged: false;
  liveFetch: false;
  originalRunId: string;
  generationId: string;
  replayedAt: string;
  timestamp: string;
  universe?: string;
  sector?: string;
  provider?: string;
  trigger?: string;
  success: boolean;
  /** The run's criteria, when recorded; null when not recorded (partial gap). */
  criteria: Record<string, unknown> | null;
  patternRef?: string;
  presetRef?: string;
  totalScanned: number;
  matchedCount: number;
  /** The full persisted scanned set — quotes, enrichment, indicators/scores as stored. */
  rows: unknown[];
  /** The persisted standouts (opportunities). */
  standouts: unknown[];
  artifacts: ReplayArtifacts;
  partial: boolean;
  partialReasons: string[];
  provenance: {
    originalRunId: string;
    generationId: string;
    source: "persisted canonical report";
  };
}

export interface ResearchReplayEnvelope {
  kind: "replay";
  reportKind: "research";
  charged: false;
  liveFetch: false;
  originalRunId: string;
  generationId: string;
  replayedAt: string;
  /** The stored research report body, verbatim — never regenerated. */
  body: unknown;
  partial: false;
  partialReasons: [];
  provenance: {
    originalRunId: string;
    generationId: string;
    source: "persisted canonical report";
  };
}

export type ReplayEnvelope = StockReplayEnvelope | ResearchReplayEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a replay envelope from one persisted canonical record. Throws loudly on missing/unreplayable data. */
export function buildReplayFromRecord(
  record: ReplayRecord,
  replayedAt: string = new Date().toISOString(),
): ReplayEnvelope {
  const generationId = record.runId;
  const provenance = {
    originalRunId: record.runId,
    generationId,
    source: "persisted canonical report" as const,
  };
  if (record.source === "research_report" || record.source === "research") {
    if (record.body === undefined || record.body === null) {
      throw new Error("not replayable: persisted research report body is missing.");
    }
    return {
      kind: "replay",
      reportKind: "research",
      charged: false,
      liveFetch: false,
      originalRunId: record.runId,
      generationId,
      replayedAt,
      body: record.body,
      partial: false,
      partialReasons: [],
      provenance,
    };
  }
  if (!isRecord(record.body)) {
    throw new Error("not replayable: persisted report body is not a report object.");
  }
  const body = record.body;
  if (!Array.isArray(body.allStocks)) {
    throw new Error("not replayable: persisted report has no full set (allStocks) — refusing to regenerate it.");
  }
  const partialReasons: string[] = [];
  const criteria = isRecord(body.criteria) ? (body.criteria as Record<string, unknown>) : null;
  if (!criteria) {
    partialReasons.push("criteria (filters) not recorded for this run — rows are reproduced, criteria cannot be shown.");
  }
  const standouts = Array.isArray(body.opportunities) ? body.opportunities : [];
  if (!Array.isArray(body.opportunities)) {
    partialReasons.push("standouts (opportunities) not recorded for this run.");
  }
  const artifacts: ReplayArtifacts = {
    ...(typeof body.pdfKey === "string" ? { pdfKey: body.pdfKey } : {}),
    ...(typeof body.xlsxKey === "string" ? { xlsxKey: body.xlsxKey } : {}),
    ...(typeof body.csvKey === "string" ? { csvKey: body.csvKey } : {}),
    ...(typeof body.reportUrl === "string" ? { reportUrl: body.reportUrl } : {}),
  };
  if (!artifacts.pdfKey && !artifacts.xlsxKey && !artifacts.csvKey) {
    partialReasons.push("artifacts (PDF/XLSX/CSV keys) not recorded for this run.");
  }
  return {
    kind: "replay",
    reportKind: "stock-screen",
    charged: false,
    liveFetch: false,
    originalRunId: record.runId,
    generationId,
    replayedAt,
    timestamp: typeof body.timestamp === "string" ? body.timestamp : "",
    ...(typeof body.universe === "string" ? { universe: body.universe } : {}),
    ...(typeof body.sector === "string" ? { sector: body.sector } : {}),
    ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
    ...(typeof body.trigger === "string" ? { trigger: body.trigger } : {}),
    success: body.success !== false,
    criteria,
    ...(typeof body.patternRef === "string" ? { patternRef: body.patternRef } : {}),
    ...(typeof body.presetRef === "string" ? { presetRef: body.presetRef } : {}),
    totalScanned: typeof body.totalScanned === "number" ? body.totalScanned : body.allStocks.length,
    matchedCount: typeof body.matchedCount === "number" ? body.matchedCount : standouts.length,
    rows: body.allStocks,
    standouts,
    artifacts,
    partial: partialReasons.length > 0,
    partialReasons,
    provenance,
  };
}
