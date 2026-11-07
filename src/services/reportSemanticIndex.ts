/**
 * Semantic report indexing (issue #337).
 *
 * Report retrieval is lexical today (SQL token search, #278/#308). This adds
 * the semantic half: each canonical report is embedded at generation time
 * (Workers AI) into the shared Vectorize index keyed by report id, and
 * search merges lexical + semantic results.
 *
 * Research reports (#319) are first-class citizens from the start — every
 * stored report is indexed, not just research ones.
 *
 * Best-effort throughout: indexing never fails report storage, and search
 * degrades to lexical-only when the AI/Vectorize bindings are absent.
 */

import type { SqlStorage } from "../orm";
import { createCanonicalReportStorePorts } from "../data/createCanonicalReportStorePorts";
import { VectorMemory } from "../memory/vector-memory";
import { createBlobStore } from "./blobStoreR2Adapter";
import { blobText } from "./blobStorePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/reportSemanticIndex",
});

/**
 * Qunsultant/cfagent#1775 (Adapter S1): the duplicate local embed()
 * is deleted — the single embedding implementation is VectorMemory's
 * (same model "@cf/baai/bge-base-en-v1.5", same index). EQUIVALENCE,
 * preserved here so the fail-soft contract is byte-identical:
 * text is truncated to 8000 chars before embedding (as the deleted
 * embed did); an embedding throw or a missing vector maps to null,
 * and callers map null to index=false / search=[] exactly as before.
 * The upsert/query argument shapes are unchanged.
 */
async function embedViaMemory(vm: VectorMemory, text: string): Promise<number[] | null> {
  try {
    const values = await vm.embedText(text.slice(0, 8000));
    return Array.isArray(values) ? values : null;
  } catch (err) {
    structuredLog.warn("embedViaMemory.embed_failed", {
      message: "[reportSemanticIndex] embed failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ReportIndexInput {
  reportId: string;
  title: string;
  source: string;
  /** Searchable text: summary + key sections. */
  text: string;
}

/**
 * Index one canonical report. Safe to call without AI/Vectorize bindings
 * (no-op). Never throws.
 */
export async function indexReport(
  env: { AI?: any; VECTOR_MEMORY?: any },
  input: ReportIndexInput
): Promise<boolean> {
  try {
    if (!env.AI || !env.VECTOR_MEMORY || !input.reportId) return false;
    const vm = new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined);
    const values = await embedViaMemory(vm, `${input.title}\n${input.text}`);
    if (!values) return false;
    await vm.upsertVectors([
      {
        id: `report:${input.reportId}`,
        values,
        metadata: {
          kind: "report",
          reportId: input.reportId,
          title: input.title.slice(0, 200),
          source: input.source,
        },
      },
    ]);
    return true;
  } catch (err) {
    structuredLog.warn("indexReport.index_failed", {
      message: "[reportSemanticIndex] index failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Issue #1169 S4-1: the bindings subset the canonical store seams pass
 * to the index hook. All fields optional — a seam caller that has no
 * bindings passes undefined and the hook is a silent no-op.
 */
export interface IndexEnv {
  AI?: any;
  VECTOR_MEMORY?: any;
  REPORTS_BUCKET?: any;
}

/** One canonical report row, as the store seams hand it to the hook. */
export interface CanonicalReportForIndex {
  reportId: string;
  title: string;
  source: string;
  summary: string;
  /** The stored body string (JSON for most sources; may be "" for R2 rows). */
  body: string;
  /** R2 object key when the body lives in REPORTS_BUCKET (WithR2 rows). */
  bodyR2Key?: string | null;
}

/** Sources the index hook never indexes (storage-pruning notices). */
export const INDEX_EXCLUDED_SOURCES = ["retention"] as const;

function parseBody(body: string): Record<string, any> {
  try {
    const parsed = JSON.parse(body || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function lines(...parts: Array<string | undefined | null>): string {
  return parts.filter((p) => p && p.trim().length > 0).join("\n");
}

/**
 * Issue #1169 S4-1: per-source searchable text for a canonical report.
 * `options_research` reproduces researchPublish's formula VERBATIM
 * (summary + first 5 ideas as `symbol outlook structure: thesis`) so the
 * seam migration changes no indexed text for the already-indexed source.
 * All other sources are new coverage; their builders are defensive
 * (malformed bodies degrade to summary + title, never a throw).
 */
export function buildCanonicalIndexText(report: {
  source: string;
  summary: string;
  title: string;
  body: string;
}): string {
  const { source, summary, title } = report;
  if (source === "options_research") {
    const parsed = parseBody(report.body);
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
    const ideaText = ideas
      .slice(0, 5)
      .map((i: any) => `${i.symbol} ${i.outlook} ${i.structure}: ${i.thesis}`)
      .join("\n");
    return `${summary}\n${ideaText}`;
  }
  if (source === "screener") {
    const parsed = parseBody(report.body);
    const opps = Array.isArray(parsed.opportunities)
      ? parsed.opportunities
      : Array.isArray(parsed.result?.opportunities)
        ? parsed.result.opportunities
        : [];
    const desc = opps
      .slice(0, 10)
      .map((o: any) => `${o.symbol ?? "?"} ${o.structure ?? ""}`.trim())
      .join("\n");
    return lines(summary, desc);
  }
  if (source === "goal_screen") {
    const parsed = parseBody(report.body);
    const result = parsed.result ?? {};
    const counts = result.counts ?? {};
    const desc = lines(
      parsed.taskId ? `task ${parsed.taskId}` : undefined,
      parsed.trigger ? `trigger ${parsed.trigger}` : undefined,
      parsed.scenarioSource ? `scenario ${parsed.scenarioSource}` : undefined,
      result.goalKind ? `goal ${result.goalKind}` : undefined,
      result.outlook ? `outlook ${result.outlook}` : undefined,
      result.status ? `status ${result.status}` : undefined,
      typeof counts.hits === "number" ? `${counts.hits} hit(s)` : undefined,
      typeof counts.stocksScanned === "number" ? `${counts.stocksScanned} stocks scanned` : undefined,
      typeof counts.optionsUnderlyingsScanned === "number"
        ? `${counts.optionsUnderlyingsScanned} option underlyings scanned`
        : undefined
    );
    return lines(summary, desc);
  }
  if (source === "options_scanner") {
    const parsed = parseBody(report.body);
    const symbols = Array.isArray(parsed.symbols)
      ? parsed.symbols
      : Array.isArray(parsed.filter?.underlyingSymbols)
        ? parsed.filter.underlyingSymbols
        : [];
    const desc = lines(
      symbols.slice(0, 20).join(", "),
      parsed.thesis ? `thesis ${parsed.thesis}` : undefined,
      typeof parsed.matchedCount === "number" ? `${parsed.matchedCount} matched` : undefined,
      typeof parsed.result?.matchedCount === "number"
        ? `${parsed.result.matchedCount} matched`
        : undefined
    );
    return lines(summary, desc);
  }
  if (source === "research_report") {
    const parsed = parseBody(report.body);
    const candidates = [parsed.content, parsed.text, parsed.body].filter(
      (c): c is string => typeof c === "string" && c.length > 0
    );
    if (candidates.length > 0) {
      return lines(summary, candidates.join("\n").slice(0, 4000));
    }
    return lines(summary, JSON.stringify(parsed).slice(0, 4000));
  }
  return lines(summary, title);
}

/**
 * Issue #1169 S4-1: shared post-store hook for the canonical seams.
 * Called whenever a reportId is returned (fresh insert or redelivery —
 * redeliveries re-upsert the same `report:<id>` vector id, idempotent).
 * Best-effort: `retention` rows are skipped, absent bindings are a
 * silent no-op, R2 bodies resolve best-effort when the bucket is bound,
 * and this function NEVER throws (indexReport itself never throws, and
 * the R2 resolution is guarded) — a store must never fail on indexing.
 */
export async function indexCanonicalReport(
  env: IndexEnv | undefined,
  report: CanonicalReportForIndex
): Promise<boolean> {
  try {
    if (!env || !env.AI || !env.VECTOR_MEMORY || !report.reportId) return false;
    if ((INDEX_EXCLUDED_SOURCES as readonly string[]).includes(report.source)) return false;
    let body = report.body;
    const store = createBlobStore(env);
    if (!body && report.bodyR2Key && store) {
      try {
        const obj = await store.get(report.bodyR2Key);
        const text = obj ? blobText(obj) : undefined;
        if (typeof text === "string" && text.length > 0) body = text;
      } catch {
        // R2 resolution is best-effort; fall back to summary + title.
      }
    }
    const text = buildCanonicalIndexText({
      source: report.source,
      summary: report.summary,
      title: report.title,
      body,
    });
    return await indexReport(env, {
      reportId: report.reportId,
      title: report.title,
      source: report.source,
      text,
    });
  } catch (err) {
    structuredLog.warn("indexCanonicalReport.index_failed", {
      message: "[reportSemanticIndex] indexCanonicalReport failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Issue #1169 S4-4: one page of the S4-1 canonical-index backfill,
 * extracted VERBATIM from the reports route handler
 * (POST /trading/reports/index-backfill) so the route and the
 * sweep below share one implementation. (Until #3527 S4 the sweep
 * rode the corpus sync; it is reports machinery and lives here
 * now.) The route calls this with its parsed limit/offset and
 * returns the result as-is — response shape and counting are
 * identical to the inline version.
 */
export interface CanonicalIndexBackfillPage {
  upserted: number;
  skippedRetention: number;
  rows: number;
  nextOffset: number | null;
}

export async function runCanonicalIndexBackfillPage(
  env: IndexEnv | undefined,
  sql: SqlStorage,
  opts: { limit: number; offset: number }
): Promise<CanonicalIndexBackfillPage> {
  const { limit, offset } = opts;
  // Issue #2359 (#1976 step 4d): the page read serves through
  // the canonical-report read port (same projection, same
  // oldest-first page) instead of raw SQL.
  const rows = createCanonicalReportStorePorts(sql as never).read.listIndexBackfillRows(
    limit,
    offset
  ) as Array<Record<string, unknown>>;
  let upserted = 0;
  let skippedRetention = 0;
  for (const row of rows) {
    const ok = await indexCanonicalReport(env, {
      reportId: typeof row.id === "string" ? row.id : "",
      title: typeof row.title === "string" ? row.title : "",
      source: typeof row.source === "string" ? row.source : "",
      summary: typeof row.summary === "string" ? row.summary : "",
      body: typeof row.body === "string" ? row.body : "",
      bodyR2Key: typeof row.body_r2_key === "string" ? row.body_r2_key : null,
    });
    if (row.source === "retention") skippedRetention += 1;
    else if (ok) upserted += 1;
  }
  return {
    upserted,
    skippedRetention,
    rows: rows.length,
    nextOffset: rows.length < limit ? null : offset + rows.length,
  };
}

/** Durable marker key for the last completed reports index-backfill
 * sweep, in mas_settings (issue #3527 S4 — the sweep's own marker,
 * split from the corpus sync's `corpus_sync_last_run`). */
export const REPORTS_INDEX_BACKFILL_LAST_RUN_KEY =
  "reports_index_backfill_last_run";

/** Weekly cadence: fire when >= 7 days since the last completed sweep. */
export const REPORTS_INDEX_BACKFILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportsIndexBackfillDecision =
  | { fire: true }
  | { fire: false; reason: "too-soon"; lastFiredAt: string };

/**
 * Pure weekly fire/no-fire decision for the reports sweep (no SDK
 * imports, unit-testable) — the same semantics the corpus guard has
 * always had, owned here since #3527 S4 unbundled the sweep from the
 * corpus sync: never fired -> fire; unparseable marker -> fire (the
 * sweep is idempotent, so firing is harmless); otherwise fire only
 * when the elapsed time reaches the full 7-day interval.
 */
export function shouldFireReportsIndexBackfillTick(
  now: Date,
  lastFiredAtIso: string | null
): ReportsIndexBackfillDecision {
  if (lastFiredAtIso === null) return { fire: true };
  const last = Date.parse(lastFiredAtIso);
  if (Number.isNaN(last)) return { fire: true };
  if (now.getTime() - last >= REPORTS_INDEX_BACKFILL_INTERVAL_MS) {
    return { fire: true };
  }
  return { fire: false, reason: "too-soon", lastFiredAt: lastFiredAtIso };
}

export interface CanonicalIndexBackfillOutcome {
  upserted: number;
  skippedRetention: number;
  rows: number;
  pages: number;
  complete: boolean;
}

/**
 * Issue #3527 S4: sweep the whole canonical-report table through the
 * shared backfill page fn, 100 rows per page, until nextOffset is
 * null. This is the reports workflow's own repair sweep — until S4
 * it lived in corpusSync.ts and rode the corpus sync's weekly guard;
 * it now runs from its own route + tick rider under its own guard
 * (above). Idempotent (re-upserts the same `report:<id>` vector ids).
 */
export async function runCanonicalIndexBackfillAll(
  env: IndexEnv | undefined,
  sql: SqlStorage
): Promise<CanonicalIndexBackfillOutcome> {
  let upserted = 0;
  let skippedRetention = 0;
  let rows = 0;
  let pages = 0;
  let offset = 0;
  for (;;) {
    const page = await runCanonicalIndexBackfillPage(env, sql, {
      limit: 100,
      offset,
    });
    upserted += page.upserted;
    skippedRetention += page.skippedRetention;
    rows += page.rows;
    pages += 1;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return { upserted, skippedRetention, rows, pages, complete: true };
}

export interface SemanticHit {
  reportId: string;
  score: number;
}

export interface HybridHit {
  reportId: string;
  /** 0..1 blended rank: lexical presence + semantic score. */
  rank: number;
  via: "lexical" | "semantic" | "both";
}

/**
 * Merge lexical hits (report ids) with semantic hits into one ranked list.
 * Pure function — the caller fetches each side.
 */
export function mergeSearchHits(
  lexicalIds: string[],
  semantic: SemanticHit[]
): HybridHit[] {
  const byId = new Map<string, HybridHit>();
  for (const id of lexicalIds) {
    byId.set(id, { reportId: id, rank: 0.5, via: "lexical" });
  }
  for (const s of semantic) {
    const existing = byId.get(s.reportId);
    if (existing) {
      existing.rank = Math.min(1, existing.rank + s.score * 0.5);
      existing.via = "both";
    } else {
      byId.set(s.reportId, {
        reportId: s.reportId,
        rank: s.score * 0.5,
        via: "semantic",
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.rank - a.rank);
}

/**
 * Semantic search over indexed reports. Returns report ids by similarity.
 * Empty array when bindings are absent or the query fails — callers fall
 * back to lexical-only.
 */
export async function semanticSearchReports(
  env: { AI?: any; VECTOR_MEMORY?: any },
  query: string,
  topK = 8
): Promise<SemanticHit[]> {
  try {
    if (!env.AI || !env.VECTOR_MEMORY || !query.trim()) return [];
    const vm = new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined);
    const values = await embedViaMemory(vm, query);
    if (!values) return [];
    const res = await vm.queryVectors(values, {
      topK,
      filter: { kind: "report" },
      returnMetadata: true,
    });
    const matches = (res as { matches?: Array<{ id?: string; score?: number; metadata?: { reportId?: string } }> }).matches ?? [];
    return matches
      .map((m) => ({
        reportId: String(m.metadata?.reportId ?? String(m.id ?? "").replace(/^report:/, "")),
        score: typeof m.score === "number" ? m.score : 0,
      }))
      .filter((h) => h.reportId);
  } catch (err) {
    structuredLog.warn("semanticSearchReports.search_failed", {
      message: "[reportSemanticIndex] search failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
