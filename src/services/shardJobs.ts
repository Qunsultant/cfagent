/**
 * Sharded scheduled screens on the EXISTING async-job rails
 * (issue #1355).
 *
 * NO parallel job model lives here: a shard IS a mas_async_jobs
 * row (capability "shard.execute", stage + chainId + parentJobId
 * via submitAsyncJob), shard status persists in that table (so a
 * Worker restart loses nothing — recoverQueuedAsyncJobs re-arms
 * queued rows), per-shard retry is the existing withRetry under
 * the pipeline policy (resilience.ts; #1355 adds only the
 * Retry-After override there), and generate/store/serve/deliver
 * delegate to runReportPipeline, the blob store, followup.report,
 * and followup.deliver respectively.
 *
 * What IS new in this module (the #1355 scope):
 *   - the shard catalog: feed by provider (nasdaq → etrade →
 *     yahoo), generate by step (assemble → pdf/xlsx/csv), store
 *     by format, serve by the existing followup.report adoption,
 *     deliver by the existing followup.deliver per channel;
 *   - the chain planner: which specs the executor's completion
 *     hook submits next (advance is hook-driven, one hop per
 *     completion, exactly like report → deliveries in #1123);
 *   - the completeness gate: assembly runs only when ALL feed
 *     shards are completed, and names every blocking shard;
 *   - spacing: staggered runAt (not_before) between shard starts
 *     inside a stage, via the existing C3 timing machinery;
 *   - per-stage retry buckets (pinned): feed → acquisition (3),
 *     generate/store → report (2), deliver → delivery (3);
 *   - provenance: chain shard ids in pipeline order.
 *
 * Feed dependency order (data fact, not a concurrency limit):
 * etrade needs nasdaq's listings for symbols, and yahoo needs
 * nasdaq's listings for its technicals universe (issue #2144: the
 * Yahoo shard no longer needs etrade's quoted set — it fills
 * columns, never rows) — so feed shards advance nasdaq →
 * etrade → yahoo, each independently retryable (retryAsyncJob
 * reuses the recorded payload; a retried nasdaq does not
 * re-execute etrade). Generate/store shards within a stage are
 * independent of each other and start staggered. A failed shard
 * stops its chain (existing C3 stop-point semantics): nothing
 * downstream is submitted, and the failure names the blocker.
 */

import { createAsyncJobPorts } from "../data/createAsyncJobPorts";
import { assembleOptionsResultForServe } from "./unifiedReportPipeline";
import type {
  AsyncJobChannel,
  AsyncJobSubmission,
  PipelineStage,
  ShardChainContext,
} from "../types";

export type ReportFormat = "pdf" | "xlsx" | "csv";
export const REPORT_FORMATS: readonly ReportFormat[] = ["pdf", "xlsx", "csv"];

export type FeedShardKey = "nasdaq" | "etrade" | "yahoo";
export type GenerateShardKey = "assemble" | ReportFormat;
export const FEED_SHARD_KEYS: readonly FeedShardKey[] = ["nasdaq", "etrade", "yahoo"];

/** Payload of a shard.execute row. `inputs` carries the previous
 *  stage's outputs the planner embedded (e.g. store keys) — never
 *  datasets (those live in sibling rows' result_json). */
export interface ShardPayload {
  shard: { stage: "feed" | "generate" | "store"; key: string };
  chain: ShardChainContext;
  inputs?: Record<string, unknown>;
}

/** Minimal chain-row projection (from mas_async_jobs) the planner
 *  and gate read. The executor hook builds these from SQL; tests
 *  build them literally. */
export interface ShardRow {
  jobId: string;
  stage?: PipelineStage;
  status: string;
  shardKey?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  parentJobId?: string;
}

export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  "feed",
  "generate",
  "store",
  "serve",
  "deliver",
];

/**
 * Issue #1355, item 8: per-stage attempt caps are the existing
 * pipeline-policy buckets (resolvePipelinePolicy defaults:
 * acquisition 3, report 2, delivery 3; attempts clamped 1..10 by
 * the policy parser). Shards add no cap machinery — the mapping
 * is the pin. Serve (followup.report adoption) performs reads,
 * not fetches, and carries no withRetry; its terminal retry is
 * retryAsyncJob like every other stage job.
 */
export const SHARD_RETRY_BUCKET: Record<
  "feed" | "generate" | "store" | "deliver",
  "acquisition" | "report" | "delivery"
> = {
  feed: "acquisition",
  generate: "report",
  store: "report",
  deliver: "delivery",
};

/** Staggered not-before time for a shard index inside a stage. */
export function staggerRunAt(nowIso: string, index: number, staggerMs: number): string {
  const base = Date.parse(nowIso);
  const from = Number.isFinite(base) ? base : Date.now();
  return new Date(from + Math.max(0, index) * Math.max(0, staggerMs)).toISOString();
}

function shardSpec(
  chain: ShardChainContext,
  stage: "feed" | "generate" | "store",
  key: string,
  parentJobId: string | undefined,
  displayName: string,
  runAt?: string,
  inputs?: Record<string, unknown>
): AsyncJobSubmission {
  return {
    capability: "shard.execute",
    payload: { shard: { stage, key }, chain, ...(inputs ? { inputs } : {}) },
    parentJobId,
    jobKind: "main",
    displayName,
    stage,
    chainId: chain.chainId,
    ...(runAt ? { runAt } : {}),
  } as unknown as AsyncJobSubmission;
}

/** The chain's first spec: the nasdaq feed shard (the chain root —
 *  later shards parent to its job id). */
export function planFeedStart(chain: ShardChainContext): AsyncJobSubmission {
  return shardSpec(
    chain,
    "feed",
    "nasdaq",
    undefined,
    `Stock screen — ${chain.universe} (sharded chain)`
  );
}

/** Option chain acquisition has no cross-symbol data dependency: each
 *  underlying is an independently retryable feed shard. Jobs are
 *  staggered across invocations so each E*TRADE fan-out gets a fresh
 *  Worker subrequest budget. */
export function planOptionsFeedShards(
  chain: ShardChainContext,
  nowIso: string
): AsyncJobSubmission[] {
  const symbols = [...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const stagger = chain.staggerMs ?? 0;
  const { eventCalendarBySymbol, ...sharedOptions } = chain.options ?? { symbols: [], thesis: "bullish", targetDate: nowIso, riskProfile: "balanced" as const };
  const sharedChain = { ...chain, options: sharedOptions };
  return symbols.map((symbol, index) =>
    shardSpec(
      sharedChain,
      "feed",
      symbol,
      undefined,
      `Options chain — ${symbol}`,
      stagger > 0 ? staggerRunAt(nowIso, index, stagger) : undefined,
      eventCalendarBySymbol?.[symbol] !== undefined ? { eventCalendar: eventCalendarBySymbol[symbol] } : undefined
    )
  );
}

/** Next feed shard after `completedKey` (dependency order), or
 *  null when the feed stage's shards are all submitted. */
export function planNextFeedShard(
  chain: ShardChainContext,
  completedKey: string,
  rootJobId: string
): AsyncJobSubmission | null {
  const next = completedKey === "nasdaq" ? "etrade" : completedKey === "etrade" ? "yahoo" : null;
  if (!next) return null;
  return shardSpec(chain, "feed", next, rootJobId, `Feed — ${next} (${chain.universe})`);
}

/** The assemble shard (the chain's generate stage root). */
export function planAssembleShard(
  chain: ShardChainContext,
  rootJobId: string
): AsyncJobSubmission {
  return shardSpec(chain, "generate", "assemble", rootJobId, `Assemble — ${chain.universe}`);
}

/** Per-format generate shards, staggered. */
export function planGenerateShards(
  chain: ShardChainContext,
  assembleJobId: string,
  nowIso: string
): AsyncJobSubmission[] {
  const stagger = chain.staggerMs ?? 0;
  return REPORT_FORMATS.map((format, i) =>
    shardSpec(
      chain,
      "generate",
      format,
      assembleJobId,
      `Generate ${format.toUpperCase()} — ${chain.universe}`,
      stagger > 0 ? staggerRunAt(nowIso, i, stagger) : undefined
    )
  );
}

export interface GenerateResult {
  format: ReportFormat;
  key: string;
  fileName: string;
}

function generateResultsFromRows(rows: ShardRow[]): GenerateResult[] {
  const out: GenerateResult[] = [];
  for (const row of rows) {
    if (row.stage !== "generate" || row.status !== "completed") continue;
    const result = (row.result ?? {}) as Partial<GenerateResult> & { status?: unknown };
    // Issue #2621 P0: a completed generate row carrying a failed
    // outcome (options renderer failure) is not a generated
    // artifact — it must not earn a store shard or a serve link.
    if (result.status === "failed") continue;
    if (
      result.format &&
      (REPORT_FORMATS as readonly string[]).includes(result.format) &&
      typeof result.key === "string"
    ) {
      out.push({ format: result.format, key: result.key, fileName: String(result.fileName ?? "") });
    }
  }
  return out;
}

/** Per-format store shards, with the generate outputs embedded as
 *  inputs. Provenance is computed live by the store handler (it
 *  reads the chain rows at execution time, so it includes the
 *  store rows themselves) — not embedded here, where the store
 *  rows do not exist yet. */
export function planStoreShards(
  chain: ShardChainContext,
  assembleJobId: string,
  rows: ShardRow[],
  nowIso: string
): AsyncJobSubmission[] {
  const generated = generateResultsFromRows(rows);
  const stagger = chain.staggerMs ?? 0;
  return generated.map((g, i) =>
    shardSpec(
      chain,
      "store",
      g.format,
      assembleJobId,
      `Store ${g.format.toUpperCase()} — ${chain.universe}`,
      stagger > 0 ? staggerRunAt(nowIso, i, stagger) : undefined,
      { format: g.format, key: g.key, fileName: g.fileName }
    )
  );
}

/** The serve stage is the EXISTING followup.report job (serve
 *  stage in chain mode): it adopts the stored artifacts so the
 *  existing report → deliveries hook chains deliveries. The
 *  outcome carries all three keys; a failed/missing format is
 *  recorded on the outcome, never fabricated. */
export function planServeJob(
  chain: ShardChainContext,
  assembleJobId: string,
  rows: ShardRow[],
  nowIso: string
): AsyncJobSubmission {
  const generated = generateResultsFromRows(rows);
  const byFormat = new Map(generated.map((g) => [g.format, g]));
  const assemble = rows.find(
    (r) => r.stage === "generate" && r.shardKey === "assemble" && r.status === "completed"
  );
  const dataset = (assemble?.result ?? {}) as Record<string, any>;
  // Issue #2621 P0 (options only): the serve outcome is built by
  // the ONE assembler from the chain's generate + store rows, so
  // it agrees with the sync route's outcome for the same dataset:
  // a failed format keeps its status + error and contributes no
  // key/link, a store-downgraded format drops out the same way.
  // Stock chains keep the legacy mapping below, byte for byte.
  const optionsAssembled = chain.screenType === "options"
    ? (() => {
        // Dynamic import avoided: the assembler is pure and this
        // module already imports it statically (see top of file).
        const assembled = assembleOptionsResultForServe(rows, dataset, chain);
        return assembled;
      })()
    : null;
  const delaySeconds = chain.stageChain?.serveDelaySeconds;
  const runAt =
    delaySeconds !== undefined
      ? new Date(Date.parse(nowIso) + Math.max(0, delaySeconds) * 1000).toISOString()
      : undefined;
  return {
    capability: "followup.report",
    payload: {
      outcome: {
        kind: chain.screenType === "options" ? "options" : "stock",
        trigger: chain.trigger ?? "scheduled",
        success: true,
        pdfKeys: optionsAssembled
          ? (optionsAssembled.links.pdfKey ? [optionsAssembled.links.pdfKey] : [])
          : (byFormat.get("pdf") ? [byFormat.get("pdf")!.key] : []),
        pdfStatus: optionsAssembled ? optionsAssembled.links.pdfStatus : (byFormat.get("pdf") ? "generated" : "failed"),
        ...(optionsAssembled?.links.pdfError ? { pdfError: optionsAssembled.links.pdfError } : {}),
        xlsxKey: optionsAssembled ? optionsAssembled.links.xlsxKey : byFormat.get("xlsx")?.key,
        xlsxStatus: optionsAssembled ? optionsAssembled.links.xlsxStatus : (byFormat.get("xlsx") ? "generated" : "failed"),
        ...(optionsAssembled?.links.xlsxError ? { xlsxError: optionsAssembled.links.xlsxError } : {}),
        csvKey: optionsAssembled ? optionsAssembled.links.csvKey : byFormat.get("csv")?.key,
        csvStatus: optionsAssembled ? optionsAssembled.links.csvStatus : (byFormat.get("csv") ? "generated" : "failed"),
        ...(optionsAssembled?.links.csvError ? { csvError: optionsAssembled.links.csvError } : {}),
        universe: chain.universe,
        thesis: chain.options?.thesis,
        // Issue #2091: the serve stage records the run from these —
        // without them the outcome names artifacts but no run.
        timestamp: chain.timestamp,
        symbols: chain.options?.symbols ?? [],
        totalScanned: chain.screenType === "options" ? (dataset.scanned as number | undefined) : dataset.totalScanned,
        matchedCount: chain.screenType === "options" ? (dataset.withTrades as number | undefined) : dataset.matchedCount,
        summary: chain.screenType === "options"
          ? `Options screen — ${chain.options?.thesis ?? "bullish"}: ${String(dataset.withTrades ?? 0)} actionable setups; evaluated ${String((dataset.coverage as any)?.evaluated ?? 0)} of ${String((dataset.coverage as any)?.considered ?? 0)} underlyings.`
          : undefined,
        reportUrl: byFormat.get("pdf")
          ? `${chain.reportBaseUrl ?? "https://agent.openaimp.com"}/api/options/report.pdf?key=${encodeURIComponent(byFormat.get("pdf")!.key)}`
          : undefined,
        opportunities: Array.isArray(dataset.opportunities) ? dataset.opportunities.slice(0, 10).map((row: any) => ({
          symbol: row.symbol,
          signal: row.pick?.best?.candidate?.type,
        })) : undefined,
        emailTo: chain.emailTo,
        slackChannel: chain.slackChannel,
        webhookUrl: chain.webhookUrl,
        deliveryId: chain.screenType === "options"
          ? `${chain.trigger ?? "scheduled"}:options:${chain.chainId}`
          : `${chain.trigger ?? "scheduled"}:${chain.universe}:${chain.timestamp.slice(0, 16)}`,
        stageChain: chain.stageChain,
      },
      userLogin: chain.userLogin,
      stageChain: chain.stageChain,
      chainId: chain.chainId,
    },
    parentJobId: assembleJobId,
    jobKind: "report",
    displayName: `Serve report — ${chain.universe}`,
    stage: "serve",
    chainId: chain.chainId,
    ...(runAt ? { runAt } : {}),
  } as unknown as AsyncJobSubmission;
}

/**
 * Completeness gate (issue #1355 job2.1): assembly runs only when
 * ALL feed shards are completed. Anything else blocks assembly
 * and is NAMED — a failed shard names its error, a missing or
 * unfinished shard names its status — never a silent partial
 * report.
 */
export function assessFeedGate(
  rows: ShardRow[]
): { ready: true } | { ready: false; blockedBy: Array<{ shardKey: string; reason: string }> } {
  const blockedBy: Array<{ shardKey: string; reason: string }> = [];
  for (const key of FEED_SHARD_KEYS) {
    const completed = rows.find(
      (r) => r.stage === "feed" && r.shardKey === key && r.status === "completed"
    );
    if (completed) continue;
    const any = rows.find((r) => r.stage === "feed" && r.shardKey === key);
    if (!any) {
      blockedBy.push({ shardKey: key, reason: "feed shard not submitted" });
    } else if (any.status === "failed") {
      blockedBy.push({ shardKey: key, reason: any.error || "feed shard failed" });
    } else {
      blockedBy.push({ shardKey: key, reason: `feed shard status: ${any.status}` });
    }
  }
  return blockedBy.length === 0 ? { ready: true } : { ready: false, blockedBy };
}

/** Chain shard ids in pipeline order (then creation order) — the
 *  report provenance. Serve/deliver rows are excluded: they do
 *  not produce report content. */
export function shardProvenanceIds(rows: ShardRow[]): string[] {
  const order = new Map(PIPELINE_STAGE_ORDER.map((s, i) => [s, i]));
  return [...rows]
    .filter((r) => r.stage === "feed" || r.stage === "generate" || r.stage === "store")
    .sort((a, b) => {
      const byStage = (order.get(a.stage!) ?? 99) - (order.get(b.stage!) ?? 99);
      if (byStage !== 0) return byStage;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.jobId < b.jobId ? -1 : 1;
    })
    .map((r) => r.jobId);
}

function stageRows(rows: ShardRow[], stage: PipelineStage): ShardRow[] {
  return rows.filter((r) => r.stage === stage);
}

/** A shard key counts as healed when ANY row for it completed —
 *  retryAsyncJob keeps the failed row (the failure record) and
 *  adds a new row, so "every row completed" would stall a healed
 *  chain forever. */
function keyHasCompleted(rows: ShardRow[], stage: PipelineStage, key: string): boolean {
  return rows.some((r) => r.stage === stage && r.shardKey === key && r.status === "completed");
}

/** True when every required key of the stage has a completed row. */
function stageComplete(rows: ShardRow[], stage: PipelineStage, keys: readonly string[]): boolean {
  return keys.every((k) => keyHasCompleted(rows, stage, k));
}

/** True when some required key has a failed row and NO completed
 *  row — an unhealed failure, the chain's stop point. A failed row
 *  WITH a completed retry row is healed, not blocking. */
function stageHasFailure(rows: ShardRow[], stage: PipelineStage, keys: readonly string[]): boolean {
  return keys.some(
    (k) =>
      rows.some((r) => r.stage === stage && r.shardKey === k && r.status === "failed") &&
      !keyHasCompleted(rows, stage, k)
  );
}

function nextStageSubmitted(rows: ShardRow[], stage: PipelineStage): boolean {
  return stageRows(rows, stage).length > 0;
}

/**
 * The executor completion hook's decision: given the chain's rows
 * after one shard completed, which specs to submit next (possibly
 * none). Pure — the hook submits what this returns.
 *
 * Idempotency (retry safety): when the next stage's rows already
 * exist — e.g. a retried shard completing after the chain already
 * advanced — nothing is resubmitted, so a stage is never executed
 * twice by a retry. A failed sibling in the completed stage blocks
 * advancement (the C3 stop point); the failure path, not this
 * hook, records the blocker.
 */
export function planShardAdvance(input: {
  chain: ShardChainContext;
  rows: ShardRow[];
  completedStage: PipelineStage;
  completedKey: string;
  rootJobId: string;
  assembleJobId?: string;
  nowIso: string;
}): AsyncJobSubmission[] {
  const { chain, rows, completedStage, completedKey, rootJobId, nowIso } = input;
  if (completedStage === "feed") {
    if (chain.screenType === "options") {
      const symbols = [...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
      const allTerminal = symbols.length > 0 && symbols.every((symbol) => {
        const attempts = rows
          .filter((r) => r.stage === "feed" && r.shardKey === symbol)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const latest = attempts[attempts.length - 1];
        return latest?.status === "completed" || latest?.status === "failed";
      });
      if (!allTerminal || nextStageSubmitted(rows, "generate")) return [];
      return [planAssembleShard(chain, rootJobId)];
    }
    if (stageHasFailure(rows, "feed", FEED_SHARD_KEYS)) return [];
    const next = planNextFeedShard(chain, completedKey, rootJobId);
    if (next) {
      // Retry safety: the successor already exists (a retried shard
      // completing after the chain advanced) — do not resubmit it.
      const nextKey = (next.payload as unknown as ShardPayload).shard.key;
      if (rows.some((r) => r.stage === "feed" && r.shardKey === nextKey)) return [];
      return [next];
    }
    // Feed fully submitted: advance only through the gate.
    const gate = assessFeedGate(rows);
    if (!gate.ready) return [];
    if (nextStageSubmitted(rows, "generate")) return [];
    return [planAssembleShard(chain, rootJobId)];
  }
  if (completedStage === "generate" && completedKey === "assemble") {
    // Retry safety: generate shards already planned — skip.
    if (stageRows(rows, "generate").some((r) => r.shardKey !== "assemble")) return [];
    return planGenerateShards(chain, input.assembleJobId ?? rootJobId, nowIso);
  }
  if (completedStage === "generate") {
    if (stageHasFailure(rows, "generate", ["assemble", ...REPORT_FORMATS])) return [];
    if (!stageComplete(rows, "generate", ["assemble", ...REPORT_FORMATS])) return [];
    if (nextStageSubmitted(rows, "store")) return [];
    return planStoreShards(chain, input.assembleJobId ?? rootJobId, rows, nowIso);
  }
  if (completedStage === "store") {
    if (stageHasFailure(rows, "store", REPORT_FORMATS)) return [];
    if (!stageComplete(rows, "store", REPORT_FORMATS)) return [];
    if (nextStageSubmitted(rows, "serve")) return [];
    return [planServeJob(chain, input.assembleJobId ?? rootJobId, rows, nowIso)];
  }
  return [];
}

/**
 * Read a chain's rows from mas_async_jobs (executor hook use).
 * Filters to the chain; shard identity comes from each row's
 * payload_json (payload.shard.key). Tolerates legacy rows without
 * a shard payload (shardKey undefined — the gate treats them as
 * unmatched, never as a completed shard).
 */
/**
 * Read a chain's rows for the planner. The SELECT serves through
 * the async-job read port since #2358 (#1976 step 4a — the port
 * owns the statement; chainRows in src/data/asyncJobPorts.ts).
 * The row->ShardRow projection (shard-key + result parsing,
 * corrupt-tolerant) stays here: it is planner domain logic.
 */
export function chainRowsFromSql(
  sql: {
    exec: (query: string, ...params: unknown[]) => Iterable<Record<string, unknown>>;
  },
  chainId: string,
  sessionId: string
): ShardRow[] {
  const out: ShardRow[] = [];
  const rows = createAsyncJobPorts(sql as never).read.chainRows(chainId, sessionId) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    let shardKey: string | undefined;
    try {
      const parsed = JSON.parse(String(row.payload_json ?? "{}")) as {
        shard?: { key?: unknown };
      };
      if (typeof parsed?.shard?.key === "string") shardKey = parsed.shard.key;
    } catch {
      shardKey = undefined;
    }
    let result: unknown;
    if (typeof row.result_json === "string") {
      try {
        result = JSON.parse(row.result_json);
      } catch {
        result = undefined;
      }
    }
    out.push({
      jobId: String(row.job_id),
      stage: typeof row.stage === "string" ? (row.stage as PipelineStage) : undefined,
      status: String(row.status),
      shardKey,
      result,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at ?? ""),
      parentJobId:
        typeof row.parent_job_id === "string" && row.parent_job_id
          ? row.parent_job_id
          : undefined,
    });
  }
  return out;
}
