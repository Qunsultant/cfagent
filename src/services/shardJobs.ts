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
 * Exception (issue #2599 F2/F4, options chains only): a failed
 * per-format generate/store leg does NOT stop the chain once
 * every leg of the stage is terminal — the completed formats
 * advance to store/serve and the failed leg's error rides the
 * serve outcome (see planServeJob), so one renderer failure
 * cannot silently strand the formats that generated. Stock
 * chains keep the C3 stop semantics unchanged.
 */

import { createAsyncJobPorts } from "../data/createAsyncJobPorts";
import { assembleOptionsResultForServe } from "./unifiedReportPipeline";
import {
  checkpointFromStageRows,
  type StageRowLike,
} from "../workflows/stageRunnerCheckpoint";
import {
  planNext,
  planRun,
  resumeUnits,
  type StageRunnerNext,
} from "../workflows/stageRunnerPlan";
import {
  DEFAULT_STAGE_TIMEOUT_MS,
  RUNNER_STAGE_ORDER,
  STAGE_RETRY_BUCKET,
  runnerStageForPipelineStage,
} from "../workflows/stageRunnerPorts";
import type {
  StageRunnerCheckpoint,
  StageRunnerPlan,
} from "../workflows/stageRunnerPorts";
import type { StageName } from "../messaging/messagingPorts";
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
  /** Issue #4423 — the job this row retried, read from the payload the retry
   *  paths stamp. Absent on an original attempt, never inferred. */
  retryOf?: string;
  /** Issue #4423 — how many failed attempts the row persisted (#4417), so the
   *  chain's report row can say a retry happened without re-reading jobs. */
  attempts: number;
}

/**
 * The chain stage order is the stage-runner order (issue #2601 seam A):
 * one order in the contract, projected here into the five stages that
 * carry a mas_async_jobs row. gather has no chain row (it runs inside the
 * analysis unit) and is the only contract stage the chain does not plan.
 * The relative order of the five is unchanged from the legacy literal, and
 * tests/stage_runner_seam_a_2601.test.ts pins that exact sequence.
 */
const CHAIN_STAGE_FOR_RUNNER_STAGE: Record<StageName, PipelineStage | null> = {
  feed: "feed",
  gather: null,
  analysis: "generate",
  store: "store",
  serve: "serve",
  deliver: "deliver",
};

export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = RUNNER_STAGE_ORDER
  .map((stage) => CHAIN_STAGE_FOR_RUNNER_STAGE[stage])
  .filter((stage): stage is PipelineStage => stage !== null);

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
  feed: STAGE_RETRY_BUCKET.feed,
  generate: STAGE_RETRY_BUCKET.analysis,
  store: STAGE_RETRY_BUCKET.store,
  deliver: STAGE_RETRY_BUCKET.deliver,
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
    // Issue #4415: the dispatch knew the trigger and actor; stamp them so the
    // row records provenance instead of NULLs ("Not recorded" in the panel).
    trigger: chain.trigger,
    triggeredBy: chain.userLogin,
    ...(chain.scheduleId ? { scheduleId: chain.scheduleId } : {}),
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
  // (Rebase note: this supersedes #2599 F2's pre-P0 overlay, which
  // the slice itself named as superseded once P0 lands — the
  // overlay and its unhealedFormatFailures helper are removed,
  // the assembler reads the same per-format failed outcomes.)
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
        reportUrl: (optionsAssembled ? optionsAssembled.links.pdfKey : byFormat.get("pdf")?.key)
          ? `${chain.reportBaseUrl ?? "https://agent.openaimp.com"}/api/options/report.pdf?key=${encodeURIComponent((optionsAssembled ? optionsAssembled.links.pdfKey : byFormat.get("pdf")!.key)!)}`
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
 * report. Read off the runner checkpoint (issue 2610): the gate is
 * the feed stage's entries over the three provider keys.
 *
 * The chain is optional for backwards compatibility (the gate's
 * contract is the three provider keys; a chain-less call projects
 * the same checkpoint with a predicate-only run id). Production
 * callers pass the chain so the gate reads the chain's own plan.
 */
export function assessFeedGate(
  rows: ShardRow[],
  chain?: ShardChainContext,
): { ready: true } | { ready: false; blockedBy: Array<{ shardKey: string; reason: string }> } {
  const checkpoint = chain
    ? chainStageCheckpoint(chain, rows, "feed")
    : stageCheckpointForUnits("feed-gate", rows, "feed", FEED_SHARD_KEYS);
  const blockedBy: Array<{ shardKey: string; reason: string }> = [];
  for (const key of FEED_SHARD_KEYS) {
    const entry = checkpoint.units.find((u) => u.unitId === key);
    if (entry?.status === "completed") continue;
    if (!entry || entry.status === "never-attempted") {
      blockedBy.push({ shardKey: key, reason: "feed shard not submitted" });
    } else if (entry.status === "failed") {
      blockedBy.push({ shardKey: key, reason: entry.error || "feed shard failed" });
    } else {
      blockedBy.push({ shardKey: key, reason: `feed shard status: ${entry.status}` });
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

/**
 * Issue 2610 — the chain → stage-runner bridge.
 *
 * The sharded chain is the async-alarm invocation of the one stage runner:
 * its advance decisions run on the stage-runner contract (one plan per
 * stage, one checkpoint, planNext for the next stage, resumeUnits for the
 * resume set), and only the submission construction (shard specs, stagger,
 * parent linkage) and the chain's domain rules (feed dependency order,
 * assemble gate, per-format options rules) stay in this module.
 *
 * Why one plan per stage: the runner's plan carries ONE unit list shared
 * across its stages, but the chain's stages have different shard sets
 * (feed = providers/symbols, generate = assemble+formats, store = formats,
 * serve/deliver = the run itself). One single-stage plan per stage is the
 * same shape the engine uses (one stage per job-tree node).
 */
export function chainStageUnits(chain: ShardChainContext, stage: PipelineStage): string[] {
  if (stage === "feed") {
    if (chain.screenType === "options") {
      return [...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
    }
    return [...FEED_SHARD_KEYS];
  }
  if (stage === "generate") return ["assemble", ...REPORT_FORMATS];
  if (stage === "store") return [...REPORT_FORMATS];
  return [];
}

function stagePlanForUnits(runId: string, stage: PipelineStage, unitIds: readonly string[]): StageRunnerPlan {
  const runnerStage = runnerStageForPipelineStage(stage);
  return planRun({
    runId,
    invocation: "async-alarm",
    stages: [
      {
        stage: runnerStage,
        execution: stage === "generate" || stage === "store" ? "parallel" : "sequential",
        timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
        retryBucket: STAGE_RETRY_BUCKET[runnerStage],
      },
    ],
    units: unitIds.map((unitId) => ({ unitId })),
  });
}

/** One stage of one chain, as a runner plan (invocation: async-alarm). */
export function chainStagePlan(chain: ShardChainContext, stage: PipelineStage): StageRunnerPlan {
  return stagePlanForUnits(chain.chainId, stage, chainStageUnits(chain, stage));
}

/** A chain stage's rows for one unit, oldest first (createdAt order — the
 *  store returns insertion order, but the bridge never assumes it). */
function chainStageUnitRows(rows: ShardRow[], stage: PipelineStage, runId: string, unitId: string): ShardRow[] {
  return rows
    .filter((r) => r.stage === stage && (r.shardKey ?? runId) === unitId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * One (stage, shard key) unit's current status, from its recorded rows.
 * This is the chain's C3 retry rule, stated once: a unit counts as healed
 * when ANY row for it completed — retryAsyncJob keeps the failed row (the
 * failure record) and adds a new row, so "every row completed" would stall
 * a healed chain forever. An unhealed failure blocks even while its retry
 * is queued or running: the retry has not healed anything yet, and the
 * chain waits for it (feed) or names it (generate/store) instead of
 * advancing past a unit that is still being re-run.
 *
 * The shared projection's statusFor reads "any failed row → failed", which
 * is correct for its one-unit (per-stage) use — a failed LEG blocks its
 * stage — but wrong for per-shard units, where a failed row is retry
 * history once a later row completed. So the heal rule lives here, in the
 * bridge, as one synthetic row per unit; the shared projection is untouched.
 * Rows for statuses the chain never records (e.g. a cancelled shard) read
 * as queued — in flight, waited on — which is the same stall the old
 * row-level predicates produced, never an advance.
 */
function chainUnitRow(pair: ShardRow[], stage: PipelineStage, unitId: string): StageRowLike {
  const newest = pair[pair.length - 1]!;
  const base = { unitId, stage, updatedAt: newest.createdAt };
  if (pair.some((r) => r.status === "completed")) return { ...base, status: "completed" };
  const failed = pair.find((r) => r.status === "failed");
  if (failed) {
    return { ...base, status: "failed", ...(failed.error ? { error: failed.error } : {}) };
  }
  if (pair.some((r) => r.status === "running")) return { ...base, status: "running" };
  return { ...base, status: "queued" };
}

function stageCheckpointForUnits(
  runId: string,
  rows: ShardRow[],
  stage: PipelineStage,
  unitIds: readonly string[],
): StageRunnerCheckpoint {
  const plan = stagePlanForUnits(runId, stage, unitIds);
  const effectiveUnits = unitIds.length > 0 ? unitIds : [runId];
  const synthetic: StageRowLike[] = [];
  for (const unitId of effectiveUnits) {
    const pair = chainStageUnitRows(rows, stage, runId, unitId);
    if (pair.length === 0) continue;
    // One synthetic row per recorded attempt, so the projected attempt
    // count stays the recorded row count (the checkpoint is the planner's
    // view — statuses only; attempt counts live on ShardRow.attempts).
    const derived = chainUnitRow(pair, stage, unitId);
    for (let i = 0; i < pair.length; i++) synthetic.push(derived);
  }
  return checkpointFromStageRows(runId, synthetic, plan);
}

/**
 * One stage of one chain, projected onto the runner checkpoint. The
 * checkpoint is the planner's view of the stage (statuses only); the rows
 * remain the audit record.
 */
export function chainStageCheckpoint(
  chain: ShardChainContext,
  rows: ShardRow[],
  stage: PipelineStage,
): StageRunnerCheckpoint {
  return stageCheckpointForUnits(chain.chainId, rows, stage, chainStageUnits(chain, stage));
}

/** The next stage to run for one chain stage, or null when every unit of
 *  the stage is terminal (completed/skipped/cancelled). Failed units are
 *  non-terminal here — the chain's per-format rule (advance past failed
 *  legs once every leg is terminal) is a chain-domain rule stated over the
 *  checkpoint in planShardAdvance, never a planNext substitution. */
export function chainStageNext(
  chain: ShardChainContext,
  rows: ShardRow[],
  stage: PipelineStage,
): StageRunnerNext | null {
  return planNext(chainStagePlan(chain, stage), chainStageCheckpoint(chain, rows, stage));
}

/**
 * The units a resume must re-run for one chain stage — only the ones that
 * did not complete. A completed unit never appears here. This is the one
 * resume operation for the chain: the failure hook's re-drive
 * (asyncJobs.ts) reaches it through planShardAdvance's checkpoint-based
 * terminal decision.
 */
export function chainStageResumeUnits(
  chain: ShardChainContext,
  rows: ShardRow[],
  stage: PipelineStage,
): string[] {
  return resumeUnits(chainStagePlan(chain, stage), chainStageCheckpoint(chain, rows, stage)).map(
    (r) => r.unit.unitId,
  );
}

/**
 * Units of one chain stage whose latest row is queued or running AFTER a
 * failed row — a retry is in flight for them. The feed branch waits on
 * these (assembly needs every symbol's data); the generate/store branches
 * do not (stageTerminal counts a failed leg terminal — the serve outcome
 * carries the leg error). The two terminal rules genuinely differ, and
 * the difference is named here instead of unified away.
 */
export function chainStageInflightRetries(
  chain: ShardChainContext,
  rows: ShardRow[],
  stage: PipelineStage,
): string[] {
  const units = chainStageUnits(chain, stage);
  const effectiveUnits = units.length > 0 ? units : [chain.chainId];
  const out: string[] = [];
  for (const unitId of effectiveUnits) {
    const pair = chainStageUnitRows(rows, stage, chain.chainId, unitId);
    if (pair.length === 0) continue;
    const latest = pair[pair.length - 1]!;
    if (
      (latest.status === "queued" || latest.status === "running") &&
      pair.some((r) => r.status === "failed")
    ) {
      out.push(unitId);
    }
  }
  return out;
}

function stageRows(rows: ShardRow[], stage: PipelineStage): ShardRow[] {
  return rows.filter((r) => r.stage === stage);
}

/** One (stage, unit) checkpoint entry, or undefined when the stage's plan
 *  carries no such unit. */
function checkpointEntry(
  chain: ShardChainContext,
  rows: ShardRow[],
  stage: PipelineStage,
  key: string,
): { status: string; error?: string } | undefined {
  return chainStageCheckpoint(chain, rows, stage).units.find((u) => u.unitId === key);
}

/** A shard key counts as healed when ANY row for it completed —
 *  retryAsyncJob keeps the failed row (the failure record) and
 *  adds a new row, so "every row completed" would stall a healed
 *  chain forever. Read off the runner checkpoint (issue 2610). */
function keyHasCompleted(chain: ShardChainContext, rows: ShardRow[], stage: PipelineStage, key: string): boolean {
  return checkpointEntry(chain, rows, stage, key)?.status === "completed";
}

/** True when every required key of the stage has a completed row. */
function stageComplete(chain: ShardChainContext, rows: ShardRow[], stage: PipelineStage, keys: readonly string[]): boolean {
  const checkpoint = chainStageCheckpoint(chain, rows, stage);
  return keys.every(
    (k) => checkpoint.units.find((u) => u.unitId === k)?.status === "completed",
  );
}

/** True when some required key has a failed row and NO completed
 *  row — an unhealed failure, the chain's stop point. A failed row
 *  WITH a completed retry row is healed, not blocking. Read off the
 *  runner checkpoint (issue 2610). */
function stageHasFailure(chain: ShardChainContext, rows: ShardRow[], stage: PipelineStage, keys: readonly string[]): boolean {
  const checkpoint = chainStageCheckpoint(chain, rows, stage);
  return keys.some(
    (k) => checkpoint.units.find((u) => u.unitId === k)?.status === "failed",
  );
}

/** Issue #2599 (F2): true when every key of the stage is terminal
 *  — completed, or failed with no completed row (unhealed). A
 *  still-running key is not terminal: advancing early would
 *  strand its late completion behind the next stage's
 *  already-submitted guard, so the planner waits for it. Read off
 *  the runner checkpoint (issue 2610). */
function stageTerminal(chain: ShardChainContext, rows: ShardRow[], stage: PipelineStage, keys: readonly string[]): boolean {
  const checkpoint = chainStageCheckpoint(chain, rows, stage);
  return keys.every((k) => {
    const status = checkpoint.units.find((u) => u.unitId === k)?.status;
    return status === "completed" || status === "failed";
  });
}

function nextStageSubmitted(chain: ShardChainContext, rows: ShardRow[], stage: PipelineStage): boolean {
  return chainStageCheckpoint(chain, rows, stage).units.some((u) => u.status !== "never-attempted");
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
      // Issue 2610: the terminal decision runs on the runner checkpoint.
      // The resume set (the runner's resume operation) names the failed
      // symbols — the units an operator retry must re-run. A symbol is
      // terminal when it completed or when it failed (and is therefore in
      // the resume set); a symbol whose retry is queued is NOT terminal
      // yet — assembly waits for its data, or its late completion would
      // arrive after assembly and be dropped.
      const symbols = chainStageUnits(chain, "feed");
      const plan = chainStagePlan(chain, "feed");
      const checkpoint = chainStageCheckpoint(chain, rows, "feed");
      const failed = new Set(
        resumeUnits(plan, checkpoint)
          .filter((r) => r.checkpoint.status === "failed")
          .map((r) => r.unit.unitId),
      );
      const terminal = symbols.every((symbol) => {
        const status = checkpoint.units.find((u) => u.unitId === symbol)?.status;
        return status === "completed" || failed.has(symbol);
      });
      const allTerminal =
        symbols.length > 0 &&
        terminal &&
        chainStageInflightRetries(chain, rows, "feed").length === 0;
      if (!allTerminal || nextStageSubmitted(chain, rows, "generate")) return [];
      return [planAssembleShard(chain, rootJobId)];
    }
    if (stageHasFailure(chain, rows, "feed", FEED_SHARD_KEYS)) return [];
    const next = planNextFeedShard(chain, completedKey, rootJobId);
    if (next) {
      // Retry safety: the successor already exists (a retried shard
      // completing after the chain advanced) — do not resubmit it.
      const nextKey = (next.payload as unknown as ShardPayload).shard.key;
      if (rows.some((r) => r.stage === "feed" && r.shardKey === nextKey)) return [];
      return [next];
    }
    // Feed fully submitted: advance only through the gate.
    const gate = assessFeedGate(rows, chain);
    if (!gate.ready) return [];
    if (nextStageSubmitted(chain, rows, "generate")) return [];
    return [planAssembleShard(chain, rootJobId)];
  }
  if (completedStage === "generate" && completedKey === "assemble") {
    // Retry safety: generate shards already planned — skip.
    if (stageRows(rows, "generate").some((r) => r.shardKey !== "assemble")) return [];
    return planGenerateShards(chain, input.assembleJobId ?? rootJobId, nowIso);
  }
  if (completedStage === "generate") {
    if (chain.screenType === "options") {
      // Issue #2599 (F2/F4): an options generate leg is a
      // per-format outcome, not a chain failure. The assemble
      // shard is still a blocker (a missing dataset blocks every
      // format, not one leg). Once assemble completed and every
      // format is terminal, the completed formats advance to
      // store; when NO format completed, serve is still planned
      // so the run ends as a coded skipped serve (the serve
      // outcome carries every leg's error) instead of a chain
      // stalled forever with no record. A still-running format
      // waits — see stageTerminal.
      if (!keyHasCompleted(chain, rows, "generate", "assemble")) return [];
      if (!stageTerminal(chain, rows, "generate", REPORT_FORMATS)) return [];
      if (nextStageSubmitted(chain, rows, "store")) return [];
      const generated = generateResultsFromRows(rows);
      if (generated.length === 0) {
        if (nextStageSubmitted(chain, rows, "serve")) return [];
        return [planServeJob(chain, input.assembleJobId ?? rootJobId, rows, nowIso)];
      }
      return planStoreShards(chain, input.assembleJobId ?? rootJobId, rows, nowIso);
    }
    if (stageHasFailure(chain, rows, "generate", ["assemble", ...REPORT_FORMATS])) return [];
    if (!stageComplete(chain, rows, "generate", ["assemble", ...REPORT_FORMATS])) return [];
    if (nextStageSubmitted(chain, rows, "store")) return [];
    return planStoreShards(chain, input.assembleJobId ?? rootJobId, rows, nowIso);
  }
  if (completedStage === "store") {
    if (chain.screenType === "options") {
      // Issue #2599 (F2/F4): same per-format rule for store —
      // only formats that were actually stored are terminal
      // candidates (a format that never generated has no store
      // row and is not waited on). Serve reads the generate
      // rows overlaid with store failures (see planServeJob),
      // so a store-failed format drops from the serve links
      // with its error, while stored formats still serve.
      const storedFormats = REPORT_FORMATS.filter((k) =>
        rows.some((r) => r.stage === "store" && r.shardKey === k),
      );
      if (!stageTerminal(chain, rows, "store", storedFormats)) return [];
      if (nextStageSubmitted(chain, rows, "serve")) return [];
      return [planServeJob(chain, input.assembleJobId ?? rootJobId, rows, nowIso)];
    }
    if (stageHasFailure(chain, rows, "store", REPORT_FORMATS)) return [];
    if (!stageComplete(chain, rows, "store", REPORT_FORMATS)) return [];
    if (nextStageSubmitted(chain, rows, "serve")) return [];
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
  // Issue #4423 — the retry history comes from the port too (this service
  // holds zero storage-exec sites, #2358 step 4a). The port answers an empty
  // map when the store predates the attempts column (#4417), so an unmigrated
  // table reads as "no recorded attempts" instead of failing the chain read.
  const attemptsByJob = createAsyncJobPorts(sql as never).read.chainAttemptCounts(
    chainId,
    sessionId,
  );
  for (const row of rows) {
    let shardKey: string | undefined;
    let retryOf: string | undefined;
    try {
      const parsed = JSON.parse(String(row.payload_json ?? "{}")) as {
        shard?: { key?: unknown };
        retryOf?: unknown;
      };
      if (typeof parsed?.shard?.key === "string") shardKey = parsed.shard.key;
      if (typeof parsed?.retryOf === "string" && parsed.retryOf) retryOf = parsed.retryOf;
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
      ...(retryOf ? { retryOf } : {}),
      attempts: attemptsByJob.get(String(row.job_id)) ?? 0,
    });
  }
  return out;
}
