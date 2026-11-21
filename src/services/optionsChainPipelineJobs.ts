/**
 * Issue #4780 ([Sub-issue] Route the options sharded chain through
 * the one engine) — the options sharded chain as ONE engine job.
 *
 * Before this slice the chain START was bespoke: autonomousOptionsAnalysis
 * built per-symbol `shard.execute` specs (planOptionsFeedShards) and
 * submitted each through the `shardSubmit` port into mas_async_jobs,
 * where the completion hook advanced the chain stage by stage. The
 * per-symbol scans already ran on the engine (executeOptionsSymbol
 * dispatches each symbol through runStrategyScreenViaEngine, #4420,
 * or the host, #4855) and the chain ADVANCE ran on the mas_async_jobs
 * completion hook — only the START was outside the engine.
 *
 * After this slice the whole chain is one engine job,
 * `options-chain:<chainId>` (the chain id IS the job id, the stock
 * chain's idiom from #4280), a nested chain of six nodes — feed →
 * assemble → generate → store → serve → deliver — submitted through
 * the workflow host (startOptionsChainWorkflow). The step handlers
 * are THIN: each delegates to the function the async-job executor
 * already used (the same scan dispatch, the same collation, the same
 * report pipeline, the same canonical leg, the same delivery door),
 * so the chain's behavior is the executor's behavior, moved onto
 * the engine's journaled, durable, stage-controllable execution.
 *
 * Per-symbol staggering / subrequest budget (the reason
 * planOptionsFeedShards existed): the feed node is SHARDED by
 * symbol with SEQUENTIAL units, and every step invocation is
 * wrapped in `journal.do` with the shard key in the name — on the
 * workflow host each unit is its own workflow step, its own Worker
 * invocation, its own subrequest budget. The 1s stagger / `runAt`
 * is retired: the step boundary replaces it structurally (a unit
 * cannot start before the previous unit's step settles, and no two
 * units share an invocation). The feed unit still retries the scan
 * under the acquisition bucket (#4424) before recording a failed
 * outcome, and a failed feed unit is a per-symbol failed outcome,
 * never a thrown chain failure.
 *
 * Per-format non-fatal generate/store (options #2599 F2/F4) is
 * preserved at the step level: a generate or store unit that
 * cannot produce its format returns a failed outcome for that
 * format; the run still ships the formats that generated. Feed
 * and assemble failures still throw (a chain with no evaluable
 * symbol has nothing to assemble — the executor's rule).
 *
 * The chain job is NOT in workflowCatalog: its six stages differ
 * from the options-screener family's eight, so no catalog spec
 * exists for them. That is a known gap, recorded in the #4780 PR
 * body — verify Workflow Runs lists jobs from the definitions
 * store, not the catalog, when the first chain lands.
 *
 * Issue #5170 — the serve step now writes the serve-record summary
 * row (`recordOptionsServeReport`) through the orchestrator's
 * `recordOptionsServeSummary` door (`DatabaseORM` + DO storage).
 */
import { recordOptionsRun } from "../agents/optionsRuns";
import { actorGateway } from "./cloudflareActorGateway";
import type { Env, ShardChainContext } from "../types";
import type { JobNodeConfig } from "../data/jobPipelinePorts";
import { createJobPipelineStoresFromD1 } from "../data/createJobPipelinePorts";
import type { ScheduledTasksPipelineContext } from "../agents/scheduledTasksPipeline";
import { pipelineSql } from "../agents/scheduledTasksPipeline";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  adaptOpportunityScanToOptionScreenResult,
  collateOpportunityScanShards,
  generateOptionsCsv,
  generateOptionsXlsx,
  optionsCsvFileName,
  optionsPdfFileName,
  optionsXlsxFileName,
  type OptionChainSource,
  type OpportunityScanResult,
} from "../trading";
import { getSymbolEventCalendar } from "./eventCalendar";
import { resolvePipelinePolicy } from "./pipelinePolicy";
import { SHARD_RETRY_BUCKET } from "./shardJobs";
import { withRetry } from "./resilience";
import { getReportPdf, putReportPdf } from "./reportBlobStore";
import type { PipelineGenerateReportDoor } from "./canonicalReportLeg";
import type { ScreenerRunOutcome } from "./screenerFollowups";
import type { ScheduledReportInput } from "./scheduledReports";
import {
  assembleOptionsResultForServe,
  runReportPipeline,
  serveReportStage,
  type ShardArtifactRow,
} from "./unifiedReportPipeline";
import { consumeTabularGenerate } from "../workflows/stageTabularConsumer";
import { buildShardScanRequest, shardBrokerStageInput } from "./shardExecutors";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../workflows/optionsScreenWorkflow";
import { optionsArtifactKey } from "../workflows/optionsScreenPorts";
import { createScannerScreenPorts } from "../workflows/strategyScreenPorts";
import {
  optionsEngineStoresFromSql,
  runStrategyScreenViaEngine,
  type OptionsEngineStores,
} from "../workflows/optionsScreenEngine";
import { shardScanRunId } from "./executionTreeIds";
import { createD1JobRunRecordDb, D1JobRunRecordStore } from "../data/d1JobRunRecordAdapter";
import type { JobRunRecorder } from "./jobPipelineEngine";
import { resolveChainSourceForRequest } from "../workflows/brokerChainSourceResidency";
import { stampBrokerStageInput } from "../workflows/optionsStepPorts";
import { stageQueueSendFromEnv } from "../workflows/stageQueueTransport";
import { createBuiltinStepRegistry, type JobStepContext, type JobStepRegistry, type JobStepResult } from "./jobPipelineSteps";
import {
  OPTIONS_CHAIN_ASSEMBLE_STEP,
  OPTIONS_CHAIN_DELIVER_STEP,
  OPTIONS_CHAIN_FEED_STEP,
  OPTIONS_CHAIN_FORMATS,
  OPTIONS_CHAIN_GENERATE_STEP,
  OPTIONS_CHAIN_SERVE_STEP,
  OPTIONS_CHAIN_STORE_STEP,
  optionsChainJobId,
  type OptionsChainFormat,
} from "./optionsChainJobDefinition";

/* ------------------------------------------------------------------ */
/* Step dependencies                                                   */
/* ------------------------------------------------------------------ */

/** One feed unit's outcome — completed with the scan result, or failed with the reason. */
export interface OptionsChainFeedUnitOutput {
  symbol: string;
  status: "completed" | "failed";
  result?: OpportunityScanResult;
  error?: string;
}

/** One generate/store unit's outcome for a format. */
export interface OptionsChainFormatOutput {
  format: OptionsChainFormat;
  status: "generated" | "stored" | "failed";
  key?: string;
  fileName?: string;
  canonicalReportId?: string;
  error?: string;
  /** The assembled dataset, carried through so the serve step can assemble the outcome. */
  dataset?: Record<string, unknown>;
}

/**
 * What one chain step needs. The defaults are the production seams
 * (workflow residency / ScheduledAgent residency); tests inject fakes
 * at these seams and never touch a broker, R2, or the orchestrator.
 */
export interface OptionsChainStepDeps {
  env: Env;
  /**
   * Issue #4782 S3 — the per-tenant settings map (`pipeline.*`
   * values), when the caller has one (settings beat env in the
   * resolver). Neither residency builder sets it today — the
   * scheduled host and the workflow residency have no
   * per-tenant settings reader, and the shared engine must never
   * read a host-global map — so the steps resolve env-only until
   * the definition-carried policy lands (follow-up, #4782 PR 2).
   */
  settings?: Record<string, string | undefined>;
  /** The durable engine stores the inner per-symbol dispatches define their jobs on. */
  engineStores: OptionsEngineStores;
  /** The stage-message queue the inner dispatches publish through (null: publish nothing). */
  queue: Parameters<typeof runStrategyScreenViaEngine>[1]["queue"];
  /** Resolve the broker chain source for one per-symbol scan (broker-aware, per invocation). */
  chainSourceFor: (args: {
    userLogin: string;
    request: unknown;
    runId: string;
  }) => OptionChainSource | undefined;
  /** Write one report blob (R2 when bound — the default refuses when unbound). */
  blobPut: (key: string, fileName: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  /** Read one report blob back (the store step's read-back verification). */
  blobGet: (key: string) => Promise<{ bytes: Uint8Array; fileName: string } | undefined>;
  /** Write one per-format canonical mas_reports row through the orchestrator door. */
  storeReport: (input: ScheduledReportInput) => Promise<unknown>;
  /** Write the serve-record summary row (`recordOptionsServeReport`) through the orchestrator door (#5170). */
  recordServeReport?: (outcome: ScreenerRunOutcome & { userLogin?: string }) => Promise<boolean>;
  /** Deliver the assembled outcome through the orchestrator door. */
  deliverOutcome: (
    payload: unknown,
    userLogin: string,
    deliveryId: string,
    chainId?: string,
  ) => Promise<void>;
  /**
   * The options-run history store (the assemble step records the run
   * there). Absent: the record is honestly skipped — recordOptionsRun
   * returns the run unwritten, exactly as the executor's absent-storage
   * path did. The residencies bind none: no DO storage lives there.
   */
  optionsRunStorage?: unknown;
}

/** The orchestrator door the chain's store/deliver steps write through (the shared instance). */
function orchestratorDoor(env: Env): {
  recordPipelineGenerateReport: PipelineGenerateReportDoor["recordPipelineGenerateReport"];
  recordOptionsServeSummary: (outcome: ScreenerRunOutcome & { userLogin?: string }) => Promise<boolean>;
  deliverWorkflowScreenOutcome: (
    payload: unknown,
    userLogin: string,
    deliveryId: string,
    chainId?: string,
  ) => Promise<void>;
} {
  if (!env.ORCHESTRATOR_AGENT) {
    throw new Error(
      "OPTIONS_CHAIN_ORCHESTRATOR_UNBOUND: the options-chain store/deliver doors need the ORCHESTRATOR_AGENT binding — refusing an unwired door.",
    );
  }
  return actorGateway.stub<{
    recordPipelineGenerateReport: PipelineGenerateReportDoor["recordPipelineGenerateReport"];
    recordOptionsServeSummary: (outcome: ScreenerRunOutcome & { userLogin?: string }) => Promise<boolean>;
    deliverWorkflowScreenOutcome: (
      payload: unknown,
      userLogin: string,
      deliveryId: string,
      chainId?: string,
    ) => Promise<void>;
  }>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
}

/**
 * The blob meta store the report pipeline writes through: a no-op.
 * The meta is a cache, not the source of truth — with R2 bound the
 * bytes live in R2 and the fileName rides R2 customMetadata, and the
 * read-back uses the direct-R2 fallback, so dropping the meta loses
 * nothing recoverable. The blob seam refuses by name when R2 is
 * unbound (below), so the legacy DO-storage path — bytes base64'd
 * into the meta store — is never silently dropped.
 */
const nullBlobMetaStorage = {
  get: async <T>(_key: string): Promise<T | undefined> => undefined,
  put: async (_key: string, _value: unknown): Promise<void> => undefined,
};

/** The production blob seam: R2 is the blob home; without it the chain cannot generate reports. */
function defaultBlobPut(env: Env) {
  return async (key: string, fileName: string, bytes: Uint8Array, contentType: string): Promise<void> => {
    if (!env.REPORTS_BUCKET) {
      throw new Error(
        "OPTIONS_CHAIN_REPORTS_BUCKET_UNBOUND: the options-chain generate step needs the REPORTS_BUCKET binding — refusing to generate a report with nowhere durable to put it.",
      );
    }
    await putReportPdf(env, nullBlobMetaStorage as never, key, fileName, bytes, contentType);
  };
}

function defaultBlobGet(env: Env) {
  return async (key: string): Promise<{ bytes: Uint8Array; fileName: string } | undefined> => {
    const found = await getReportPdf(env, nullBlobMetaStorage as never, key);
    return found ?? undefined;
  };
}

/**
 * The D1-backed run recorder for the workflow residency — the same
 * adapter the start seam builds (optionsWorkflowHost's
 * jobRunRecorderFromD1, same shape). It lives here so the chain
 * module never imports the host module (which imports this module
 * for the definition builder — a cycle the other way would follow).
 */
function chainJobRunRecorderFromD1(db: D1Database): JobRunRecorder {
  const runs = new D1JobRunRecordStore(createD1JobRunRecordDb(db));
  return {
    recordRun: (record: Parameters<JobRunRecorder["recordRun"]>[0]) => runs.record(record),
    listRuns: (jobIdArg: string, limit?: number) => runs.listByJob(jobIdArg, limit),
    latestRun: (jobIdArg: string) => runs.latestByJob(jobIdArg),
  };
}

/**
 * The workflow residency's stores + run recorder from env, refusing
 * by name when the AGENT_DB binding the residency reads is not
 * configured — the same refusal the start seam throws.
 */
function chainWorkflowRunDepsFromEnv(env: Env): {
  stores: OptionsEngineStores["stores"];
  runRecorder: JobRunRecorder;
} {
  if (!env.AGENT_DB) {
    throw new Error(
      "job_pipeline_workflow_not_configured: the AGENT_DB binding the workflow residency reads is not configured in this deployment; the run cannot be read back.",
    );
  }
  return {
    stores: createJobPipelineStoresFromD1(env.AGENT_DB),
    runRecorder: chainJobRunRecorderFromD1(env.AGENT_DB),
  };
}

/** The production step deps for the workflow residency (D1 engine stores, env-bound seams). */
export function optionsChainStepDepsForWorkflow(env: Env): OptionsChainStepDeps {
  const { stores, runRecorder } = chainWorkflowRunDepsFromEnv(env);
  return {
    env,
    engineStores: { stores, runRecorder },
    queue: stageQueueSendFromEnv(env),
    chainSourceFor: (args) => resolveChainSourceForRequest(env, args),
    blobPut: defaultBlobPut(env),
    blobGet: defaultBlobGet(env),
    storeReport: (input) => orchestratorDoor(env).recordPipelineGenerateReport(input),
    recordServeReport: (outcome) => orchestratorDoor(env).recordOptionsServeSummary(outcome),
    deliverOutcome: (payload, userLogin, deliveryId, chainId) =>
      orchestratorDoor(env).deliverWorkflowScreenOutcome(payload, userLogin, deliveryId, chainId),
    optionsRunStorage: undefined,
  };
}

/** The production step deps for the ScheduledAgent residency (the agent's SQL is the engine home). */
export function optionsChainStepDepsForScheduledAgent(
  ctx: ScheduledTasksPipelineContext,
): OptionsChainStepDeps {
  const env = ctx.env;
  return {
    env,
    engineStores: optionsEngineStoresFromSql(pipelineSql(ctx)),
    queue: stageQueueSendFromEnv(env),
    chainSourceFor: (args) => resolveChainSourceForRequest(env, args),
    blobPut: defaultBlobPut(env),
    blobGet: defaultBlobGet(env),
    storeReport: (input) => orchestratorDoor(env).recordPipelineGenerateReport(input),
    recordServeReport: (outcome) => orchestratorDoor(env).recordOptionsServeSummary(outcome),
    deliverOutcome: (payload, userLogin, deliveryId, chainId) =>
      orchestratorDoor(env).deliverWorkflowScreenOutcome(payload, userLogin, deliveryId, chainId),
    optionsRunStorage: undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Step handlers                                                       */
/* ------------------------------------------------------------------ */

/** Read the chain back out of a step's params — refusing by name when it is absent or malformed. */
function chainParam(params: Record<string, unknown>): ShardChainContext {
  const chain = params.chain as ShardChainContext | undefined;
  if (!chain || typeof chain !== "object" || typeof chain.chainId !== "string" || !chain.chainId) {
    throw new Error(
      "options-chain step requires params.chain (the ShardChainContext) — refusing to run a chain step without its chain.",
    );
  }
  return chain;
}

/** The assembled dataset a step received, or undefined when the parent produced none. */
function datasetInput(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/**
 * The feed unit: one symbol's scan through the one engine. The
 * per-symbol dispatch is executeOptionsSymbol's sync path verbatim
 * (buildShardScanRequest → runStrategyScreenViaEngine → shapeReport
 * read-back → skipped-verdict retry contract), with two differences
 * the engine forces: the broker chain source is resolved per
 * invocation through the deps' chainSourceFor (the executor read it
 * off the service; a journaled step has no service), and a failure
 * that survives the acquisition bucket's retries is a per-symbol
 * FAILED outcome, not a throw — the assemble step partitions on it,
 * exactly as the executor's shard rows partitioned.
 */
async function runOptionsChainFeedUnit(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const symbol = ctx.shardKey;
  if (!symbol) {
    throw new Error(
      "options-chain.feed requires a shard key (the symbol) — refusing to scan without one.",
    );
  }
  if (!chain.options) {
    throw new Error(
      `options-chain.feed for ${symbol} requires chain.options — refusing to scan without the chain's screen inputs.`,
    );
  }
  const shardRunId = shardScanRunId(chain.chainId, symbol);
  const eventCalendar =
    chain.options.eventCalendarBySymbol?.[symbol] ?? (await getSymbolEventCalendar(symbol));
  const scanRequest = buildShardScanRequest(chain, chain.options, symbol, eventCalendar, shardRunId);
  // A chain with no broker stage input falls back to the residency's
  // default chain source (resolveChainSourceForRequest's own rule) —
  // the request goes unstamped rather than inventing a broker.
  const brokerInput = shardBrokerStageInput(chain, deps.env);
  const stampedRequest = brokerInput
    ? stampBrokerStageInput(scanRequest, brokerInput)
    : scanRequest;
  const chainSource = deps.chainSourceFor({
    userLogin: chain.userLogin,
    request: stampedRequest,
    runId: shardRunId,
  });
  if (!chainSource) {
    return {
      output: {
        symbol,
        status: "failed",
        error: `chain source for ${symbol} could not be resolved (no user login on the chain)`,
      } satisfies OptionsChainFeedUnitOutput,
      descriptor: `options-chain feed ${symbol}: failed — no chain source`,
    };
  }
  const policy = resolvePipelinePolicy(deps.env as unknown as Record<string, unknown>, deps.settings).retry[
    SHARD_RETRY_BUCKET.feed
  ];
  type RecordedRun = Parameters<JobRunRecorder["recordRun"]>[0];
  const rawEngineStores = deps.engineStores;
  const realRunRecorder = rawEngineStores?.runRecorder;
  let bufferedRecord: RecordedRun | null = null;
  try {
    const result = await withRetry(async () => {
      const storage = memoryStageStorage();
      const captured: { record: RecordedRun | null } = { record: null };
      const attemptEngineStores =
        rawEngineStores && realRunRecorder
          ? {
              ...rawEngineStores,
              runRecorder: {
                ...realRunRecorder,
                recordRun: async (record: RecordedRun) => {
                  captured.record = record;
                  bufferedRecord = record;
                },
              },
            }
          : rawEngineStores;
      const outcome = await runStrategyScreenViaEngine(
        {
          runId: shardRunId,
          userLogin: chain.userLogin,
          trigger: chain.trigger ?? "scheduled",
          request: scanRequest,
        },
        {
          stages: createScannerScreenPorts({
            agents: {
              data: new OptionsDataAgent(new DynamicOptionsScreener(chainSource)),
              risk: new StrategyRiskAgent(),
              recommender: new RecommendationAgent(),
            },
            storage,
          }),
          claims: memoryStageClaims(),
          queue: deps.queue,
          engineStores: attemptEngineStores,
        },
      );
      if (outcome.outcome !== "completed") {
        throw new Error(`strategy screen ${shardRunId} ended ${outcome.outcome}`);
      }
      const stored = await storage.get<OpportunityScanResult>(
        optionsArtifactKey(shardRunId, "shapeReport"),
      );
      if (!stored) {
        const missingMessage = `strategy screen ${shardRunId} completed without a shapeReport artifact`;
        if (captured.record) {
          bufferedRecord = { ...captured.record, outcome: "failure", error: missingMessage };
        }
        throw new Error(missingMessage);
      }
      if (stored.matrix?.[0]?.verdict === "skipped") {
        const skipMessage = stored.matrix[0].skipReason || `symbol ${symbol} skipped`;
        if (captured.record) {
          bufferedRecord = { ...captured.record, outcome: "skipped", detail: skipMessage };
        }
        throw new Error(skipMessage);
      }
      if (realRunRecorder && captured.record) {
        await realRunRecorder.recordRun(captured.record);
      }
      return stored;
    }, policy);
    const output: OptionsChainFeedUnitOutput = { symbol, status: "completed", result };
    return { output, descriptor: `options-chain feed ${symbol}: scanned` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (realRunRecorder && bufferedRecord) {
      await realRunRecorder.recordRun(bufferedRecord);
    }
    const output: OptionsChainFeedUnitOutput = { symbol, status: "failed", error: message };
    return { output, descriptor: `options-chain feed ${symbol}: failed — ${message}` };
  }
}

/**
 * The assemble step: partition the feed units into results + failures
 * and collate, the generateAssembleOptions logic with the feed rows
 * replaced by the feed node's composed output (the engine's
 * stage-output IS the latest result; retries are journaled, not
 * rowed). A chain with no evaluable symbol still throws — there is
 * nothing to assemble, and the executor's rule stands.
 */
async function runOptionsChainAssemble(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const feedOutputs = (ctx.input ?? {}) as Record<string, OptionsChainFeedUnitOutput>;
  const symbols = [
    ...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ];
  const results: OpportunityScanResult[] = [];
  const failed: Array<{ symbol: string; reason: string }> = [];
  for (const symbol of symbols) {
    const unit = feedOutputs[symbol];
    if (unit?.status === "completed" && unit.result) {
      results.push(unit.result);
    } else {
      failed.push({
        symbol,
        reason:
          unit?.status === "failed"
            ? (unit.error ?? `feed unit for ${symbol} failed`)
            : `no feed outcome for ${symbol}`,
      });
    }
  }
  if (results.length === 0) {
    const topFailure = failed[0];
    throw new Error(
      `Options chain shards produced no evaluable symbols.${topFailure ? ` ${topFailure.symbol}: ${topFailure.reason}` : ""}`,
    );
  }
  const assembled = collateOpportunityScanShards(
    symbols,
    results,
    failed,
    new Date(chain.timestamp),
    chain.options?.candidateLimit,
  );
  if (assembled.coverage.evaluated === 0) {
    const top = (assembled as { partial?: { topSkipReason?: string } }).partial?.topSkipReason;
    throw new Error(
      `Options chain shards produced no evaluable symbols.${top ? ` Top skip reason: ${top}` : ""}`,
    );
  }
  // The run history is the executor's record, verbatim. With no
  // options-run storage bound the record is honestly skipped —
  // recordOptionsRun returns the run unwritten, exactly as the
  // executor's absent-storage path did.
  await recordOptionsRun(deps.optionsRunStorage, {
    timestamp: chain.timestamp,
    success: true,
    trigger: chain.trigger ?? "scheduled",
    thesis: chain.options?.thesis ?? "bullish",
    symbols,
    withTrades: assembled.withTrades,
    summary: `Options screen — ${chain.options?.thesis ?? "bullish"}: ${assembled.withTrades} actionable setups; evaluated ${assembled.coverage.evaluated} of ${assembled.coverage.considered} underlyings.`,
    opportunities: assembled.opportunities,
  });
  const output = assembled as unknown as Record<string, unknown>;
  return {
    output,
    descriptor: `options-chain assemble ${chain.chainId}: ${assembled.coverage.evaluated} evaluated, ${failed.length} failed`,
  };
}

/**
 * The generate unit: one format's report from the assembled dataset.
 * The PDF leg delegates to runReportPipeline (ReportAssetAgent's
 * pipeline, the executor's generatePdf); the tabular legs run through
 * consumeTabularGenerate with the options generators (the executor's
 * generateTabular, minus the shard-row claim path — a journaled step
 * is its own exactly-once guard, and no claims store is passed,
 * deliberately). A renderer failure is a per-format FAILED outcome,
 * never a throw (options #2599 F2/F4); a missing dataset is a
 * blocker and still throws.
 */
async function runOptionsChainGenerate(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const format = ctx.shardKey as OptionsChainFormat | null;
  if (!format || !(OPTIONS_CHAIN_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      "options-chain.generate requires a format shard key (pdf, xlsx, or csv) — refusing to generate without one.",
    );
  }
  const dataset = datasetInput(ctx.input);
  if (!dataset) {
    throw new Error(`Generate ${format} blocked: assemble produced no dataset.`);
  }
  const failed = (error: string): JobStepResult => ({
    output: { format, status: "failed", error, dataset } satisfies OptionsChainFormatOutput,
    descriptor: `options-chain generate ${format}: failed — ${error}`,
  });
  try {
    if (format === "pdf") {
      // runReportPipeline ignores its storage argument (void storage)
      // and stores through the env bindings (R2 / the report-asset
      // agent) — the no-op adapter below is the honest stand-in.
      const out = await runReportPipeline(
        deps.env as { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
        { put: async () => undefined, get: async () => undefined },
        {
          type: "options",
          trigger: chain.trigger ?? "scheduled",
          result: dataset,
          userLogin: chain.userLogin,
          title: `Options scanner — ${chain.options?.thesis ?? "bullish"} (${chain.timestamp.slice(0, 10)})`,
          summary: `Evaluated ${(dataset.coverage as { evaluated?: number } | undefined)?.evaluated ?? (dataset as { scanned?: number }).scanned ?? 0} of ${(dataset.coverage as { considered?: number } | undefined)?.considered ?? (dataset as { scanned?: number }).scanned ?? 0} underlyings; ${(dataset as { withTrades?: number }).withTrades ?? 0} actionable setups.`,
          timestamp: chain.timestamp,
        },
      );
      if (out.pdfStatus !== "generated" || !out.pdfKey) {
        return failed(out.pdfError || "PDF generation failed in the report pipeline.");
      }
      const output: OptionsChainFormatOutput = {
        format,
        status: "generated",
        key: out.pdfKey,
        fileName: optionsPdfFileName(dataset as never),
        dataset,
      };
      return { output, descriptor: `options-chain generate pdf: ${out.pdfKey}` };
    }
    const policy = resolvePipelinePolicy(deps.env as unknown as Record<string, unknown>, deps.settings).retry[
      SHARD_RETRY_BUCKET.generate
    ];
    const prefix = format === "xlsx" ? "options:xlsx:" : "options:csv:";
    const outcome = await consumeTabularGenerate({
      runId: `options:${chain.chainId}`,
      format,
      dataset,
      keyPrefix: prefix,
      generate: async ({ format: fmt, dataset: ds }) =>
        withRetry(async () => {
          const adapted = adaptOpportunityScanToOptionScreenResult(ds as never);
          if (fmt === "xlsx") {
            return { fileName: optionsXlsxFileName(adapted), bytes: generateOptionsXlsx(adapted) };
          }
          return {
            fileName: optionsCsvFileName(adapted),
            bytes: new TextEncoder().encode(generateOptionsCsv(adapted)),
          };
        }, policy),
      store: async ({ key, fileName, bytes, contentType }) => {
        await deps.blobPut(key, fileName, bytes, contentType);
      },
      deadLetter: async ({ reason }) => {
        // The dead letter is not silent: the outcome below records
        // the failure per format, and the step journal records the
        // step's output. No log line is needed to name it.
        void reason;
      },
    });
    if (outcome.status !== "generated" || !outcome.key || !outcome.fileName) {
      return failed(
        outcome.status === "generated"
          ? "tabular generate produced no blob"
          : ((outcome as { reason?: string }).reason ?? "tabular generate produced no blob"),
      );
    }
    const output: OptionsChainFormatOutput = {
      format,
      status: "generated",
      key: outcome.key,
      fileName: outcome.fileName,
      dataset,
    };
    return { output, descriptor: `options-chain generate ${format}: ${outcome.key}` };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The store unit: read the generated blob back, then write the
 * per-format canonical mas_reports row through the orchestrator door.
 * The read-back is the verification — a row must never point at bytes
 * that are not there. A failed generate, an unreadable blob, or a
 * door that returns no row is a per-format FAILED outcome, never a
 * throw (options #2599 F2/F4): the serve step drops the format from
 * the run's links. The generate outcome rides through on the output
 * so the serve step can rebuild the shard rows the assembler reads.
 */
async function runOptionsChainStore(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const format = ctx.shardKey as OptionsChainFormat | null;
  if (!format || !(OPTIONS_CHAIN_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      "options-chain.store requires a format shard key (pdf, xlsx, or csv) — refusing to store without one.",
    );
  }
  const generated = (ctx.input ?? {}) as Record<string, OptionsChainFormatOutput>;
  const unit = generated[format];
  const dataset = unit?.dataset;
  const failed = (error: string): JobStepResult => ({
    output: {
      format,
      status: "failed",
      error,
      ...(dataset ? { dataset } : {}),
      ...(unit ? { generate: unit } : {}),
    } satisfies OptionsChainFormatOutput & { generate?: OptionsChainFormatOutput },
    descriptor: `options-chain store ${format}: failed — ${error}`,
  });
  if (!unit || unit.status === "failed") {
    return failed(unit?.error ?? `generate produced no ${format} artifact`);
  }
  if (!unit.key || !unit.fileName) {
    return failed(`generate produced no key for ${format}`);
  }
  const stored = await deps.blobGet(unit.key);
  if (!stored) {
    return failed(`Store ${format} blocked: blob ${unit.key} is not readable.`);
  }
  // Issue #4423's retry lineage (shard ids, retried-shard counts)
  // is not carried here: the engine chain has no shard rows — the
  // workflow step journal is the retry record. The body carries the
  // evaluated symbols from the dataset instead, so the row still
  // names what the run covered.
  const matrix = (dataset?.matrix as Array<{ symbol?: string }> | undefined) ?? [];
  const symbols = [...new Set(matrix.map((row) => String(row.symbol ?? "").toUpperCase()).filter(Boolean))];
  const input: ScheduledReportInput = {
    runId: `options:${chain.chainId}`,
    generationId: `options:${chain.chainId}:${format}`,
    userLogin: chain.userLogin,
    title: `Options scanner — ${chain.options?.thesis ?? "bullish"} (${format})`,
    source: "options_scanner",
    summary: `Sharded options screen: ${chain.options?.thesis ?? "bullish"}, ${format} report.`,
    body: {
      format,
      key: unit.key,
      fileName: unit.fileName,
      universe: chain.universe,
      thesis: chain.options?.thesis,
      chainId: chain.chainId,
      symbols,
      trigger: chain.trigger ?? "scheduled",
    },
    createdAt: chain.timestamp,
  };
  const storedRow = (await deps.storeReport(input)) as { reportId?: string } | null;
  if (!storedRow?.reportId) {
    return failed(
      "canonical store returned no row (no resolvable report owner) — refusing to publish a format with no record.",
    );
  }
  const output: OptionsChainFormatOutput & { generate?: OptionsChainFormatOutput } = {
    format,
    status: "stored",
    key: unit.key,
    fileName: unit.fileName,
    canonicalReportId: storedRow.reportId,
    ...(dataset ? { dataset } : {}),
    generate: unit,
  };
  return { output, descriptor: `options-chain store ${format}: ${storedRow.reportId}` };
}

/**
 * The serve step: rebuild the shard rows the assembler reads (one
 * generate row + one store row per format, from the store units'
 * outputs, which carry their generate outcome through), assemble the
 * run's outcome, and verify every generated format's blob reads back
 * through serveReportStage. A verification failure throws — the run
 * cannot publish an artifact that is not there. The serve-record
 * summary row (recordOptionsServeReport) is NOT written here: it
 * needs a DatabaseORM and the residency has none (known gap, see the
 * module header) — the per-format canonical rows carry the run's
 * provenance.
 */
async function runOptionsChainServe(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const storeOutputs = (ctx.input ?? {}) as Record<
    string,
    OptionsChainFormatOutput & { generate?: OptionsChainFormatOutput }
  >;
  const rows: ShardArtifactRow[] = [];
  let dataset: Record<string, unknown> | undefined;
  for (const format of OPTIONS_CHAIN_FORMATS) {
    const store = storeOutputs[format];
    const generate = store?.generate;
    if (generate) {
      rows.push({
        stage: "generate",
        shardKey: format,
        status: "completed",
        result: {
          status: generate.status,
          ...(generate.key ? { key: generate.key } : {}),
          ...(generate.fileName ? { fileName: generate.fileName } : {}),
          ...(generate.error ? { error: generate.error } : {}),
        },
      });
      if (!dataset) dataset = generate.dataset;
    } else {
      rows.push({
        stage: "generate",
        shardKey: format,
        status: "failed",
        error: `No ${format} generate outcome for this run.`,
      });
    }
    if (store) {
      rows.push({
        stage: "store",
        shardKey: format,
        status: "completed",
        result: {
          status: store.status,
          ...(store.error ? { error: store.error } : {}),
        },
      });
      if (!dataset) dataset = store.dataset;
    } else {
      rows.push({
        stage: "store",
        shardKey: format,
        status: "failed",
        error: `No ${format} store outcome for this run.`,
      });
    }
  }
  if (!dataset) {
    throw new Error("options-chain.serve blocked: no assembled dataset reached the serve step.");
  }
  const outcome = assembleOptionsResultForServe(rows, dataset);
  for (const format of OPTIONS_CHAIN_FORMATS) {
    const artifact = outcome.artifacts[format];
    if (artifact?.status !== "generated" || !artifact.key) continue;
    // The canonical half verifies the store step's claimed row id is
    // present in this run's store outputs; the durable proof is the
    // blob read-back plus the mas_reports row the door wrote.
    const checked = await serveReportStage({
      canonicalReportId: storeOutputs[format]?.canonicalReportId,
      pdfKey: artifact.key,
      findCanonicalReport: async (id: string) =>
        storeOutputs[format]?.canonicalReportId === id ? { id } : null,
      resolvePdfKey: async (key: string) => deps.blobGet(key),
    });
    if (!checked.verified) {
      throw new Error(`options-chain.serve verification failed for ${format}: ${checked.reason}`);
    }
  }
  if (deps.recordServeReport) {
    const pdfArtifact = outcome.artifacts.pdf;
    const xlsxArtifact = outcome.artifacts.xlsx;
    const csvArtifact = outcome.artifacts.csv;
    const symbols = Array.isArray(dataset.symbols) ? (dataset.symbols as string[]) : [];
    const opportunities = Array.isArray(dataset.opportunities)
      ? (dataset.opportunities as ScreenerRunOutcome["opportunities"])
      : [];
    const matchedCount =
      typeof dataset.withTrades === "number"
        ? dataset.withTrades
        : typeof dataset.matchedCount === "number"
          ? dataset.matchedCount
          : opportunities?.length ?? 0;
    await deps.recordServeReport({
      kind: "options",
      success: outcome.generatedFormats.length > 0,
      trigger: chain.trigger ?? "scheduled",
      timestamp: chain.timestamp,
      thesis: typeof dataset.thesis === "string" ? dataset.thesis : "bullish",
      symbols,
      matchedCount,
      opportunities,
      summary: typeof dataset.summary === "string" ? dataset.summary : undefined,
      pdfKeys: pdfArtifact?.key ? [pdfArtifact.key] : [],
      xlsxKey: xlsxArtifact?.key,
      csvKey: csvArtifact?.key,
      pdfStatus: pdfArtifact?.status,
      ...(pdfArtifact?.error ? { pdfError: pdfArtifact.error } : {}),
      xlsxStatus: xlsxArtifact?.status,
      ...(xlsxArtifact?.error ? { xlsxError: xlsxArtifact.error } : {}),
      csvStatus: csvArtifact?.status,
      ...(csvArtifact?.error ? { csvError: csvArtifact.error } : {}),
      userLogin: chain.userLogin,
    });
  }
  return {
    output: outcome,
    descriptor: `options-chain serve ${chain.chainId}: ${outcome.generatedFormats.join(", ") || "no formats"} generated`,
  };
}

/**
 * The deliver step: hand the assembled outcome to the orchestrator's
 * delivery door with the `workflow:<jobId>` delivery id (the #3943
 * suppression key), the stock chain's idiom.
 */
async function runOptionsChainDeliver(
  deps: OptionsChainStepDeps,
  ctx: JobStepContext,
): Promise<JobStepResult> {
  const chain = chainParam(ctx.params);
  const outcome = ctx.input as Record<string, unknown> | undefined;
  if (!outcome || typeof outcome !== "object") {
    throw new Error("options-chain.deliver requires the serve step's outcome — refusing to deliver nothing.");
  }
  const jobId = optionsChainJobId(chain.chainId);
  const deliveryId = `workflow:${jobId}`;
  await deps.deliverOutcome(
    {
      kind: "options",
      chainId: chain.chainId,
      runId: chain.chainId,
      userLogin: chain.userLogin,
      timestamp: chain.timestamp,
      outcome,
    },
    chain.userLogin,
    deliveryId,
    chain.chainId,
  );
  return {
    output: { status: "delivered", chainId: chain.chainId, deliveryId },
    descriptor: `options-chain deliver ${chain.chainId}: delivered (${deliveryId})`,
  };
}

/**
 * The chain step registry: the six chain steps, one per stage.
 * Hosts compose this wherever a pipeline control plane is built for
 * options-chain work — one registry, every residency (the same
 * composition the workflow residency uses for the options steps).
 */
export function registerOptionsChainSteps(
  registry: JobStepRegistry,
  deps: OptionsChainStepDeps,
): JobStepRegistry {
  registry.register(OPTIONS_CHAIN_FEED_STEP, (ctx) => runOptionsChainFeedUnit(deps, ctx));
  registry.register(OPTIONS_CHAIN_ASSEMBLE_STEP, (ctx) => runOptionsChainAssemble(deps, ctx));
  registry.register(OPTIONS_CHAIN_GENERATE_STEP, (ctx) => runOptionsChainGenerate(deps, ctx));
  registry.register(OPTIONS_CHAIN_STORE_STEP, (ctx) => runOptionsChainStore(deps, ctx));
  registry.register(OPTIONS_CHAIN_SERVE_STEP, (ctx) => runOptionsChainServe(deps, ctx));
  registry.register(OPTIONS_CHAIN_DELIVER_STEP, (ctx) => runOptionsChainDeliver(deps, ctx));
  return registry;
}

/** The chain step registry: the J1 built-ins plus the six chain steps. */
export function createOptionsChainStepRegistry(deps: OptionsChainStepDeps): JobStepRegistry {
  return registerOptionsChainSteps(createBuiltinStepRegistry(), deps);
}
