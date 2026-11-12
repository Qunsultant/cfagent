/**
 * Issue #4068 — the options screen on the J1–J7 engine: the engine-routed
 * dispatch every options entry point drives instead of calling
 * runOptionsScreenWorkflow directly. One job per run, one dispatch per
 * call site, the same eight stages through the engine's stage runner.
 *
 * Why one job per run: JobPipelineControl.runJob refuses a dispatch while
 * the job's instance is queued/running/paused (job_already_running), and
 * options screens are ad-hoc and concurrent (a manual screen, a scheduled
 * scan, an NLQ leg and per-symbol shards can all be in flight at once), so
 * a single shared `options-screen` job id would refuse concurrent screens
 * — a regression against the direct composer, which never refused one.
 * The job id is `options-screen:<runId>` (the options runId is already
 * unique per run) and the definition is the static eight-node tree. The
 * definition + instance rows accumulate one per run (the same order as run
 * records); a retention/reaper for one-shot job definitions is a follow-up.
 *
 * Engine stores: legs WITH a Durable Object SQL handle (the manual route,
 * the unified route, the manual panel when getSql is present, the shard
 * executor) run over that SQL — the run record is durable in the caller's
 * DO. Legs WITHOUT one (the strategy service, the NLQ legs, the goal leg,
 * the scheduled scan) run over in-memory engine stores: the #4069
 * accepted-absent discipline — the durable record for those runs is the
 * canonical write + downstream record, and the engine run record is
 * run-duration only. The caller chooses explicitly; there is no silent
 * fallback to in-memory.
 *
 * Feed interaction (#4065, PR #4176 still open, not on main): legs that
 * need the feed use the live-pull chainFetch exactly as on main. This
 * slice does not duplicate the feed slice; once #4065 lands, the
 * chainFetch stage reads the registered feed job's dataset with no
 * call-site change (the step's ports are the seam).
 *
 * The dispatch returns the exact OptionsScreenWorkflowOutcome shape the
 * call sites already consume, so consumers do not change. A stage failure
 * stops the run: the step throws, the engine marks the stage and the run
 * failed, and the wrapper maps the holder's failed record onto the
 * outcome's failedStage + reason.
 */
import type { SqlStorage } from "../orm";
import {
  createJobPipelineStoresFromSql,
  type JobPipelineStores,
} from "../data/createJobPipelinePorts";
import { createInMemoryJobPipelineStores } from "../data/inMemoryJobPipelineAdapter";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";
import { InMemoryJobRunRecordStore } from "../data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobRunRecorder,
} from "../services/jobPipelineEngine";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
  type JobStepRegistry,
} from "../services/jobPipelineSteps";
import { OPTIONS_BLOCKS } from "./blocks/optionsBlocks";
import { createOptionsScreenPorts, optionsArtifactKey } from "./optionsScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
  runOptionsStageOnce,
  type OptionsScreenWorkflowDeps,
  type OptionsScreenWorkflowOutcome,
  type OptionsStageInput,
  type OptionsStagePort,
  type OptionsStageRecord,
} from "./optionsScreenWorkflow";
import {
  createScannerScreenPorts,
  createStrategyScreenPorts,
  panelResultToPipelineResult,
} from "./strategyScreenPorts";
import type { StageMessage } from "./stageMessage";
import { OPTIONS_PIPELINE_STAGES, type OptionsPipelineStage } from "./stageRuntimeIds";
import type { PanelDiscoveryResult } from "../services/recommendationKernel";
import type { ScanRunStore } from "../data/scanRunPorts";
import type { EtapiScreenerConfig } from "../config/etapiConfig";
import type { OptionScreenFetchError, OptionScreenResult, OptionScreenerFilter } from "../types";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  sanitizeOptionScreenerFilter,
  type OptionChainSource,
  type NasdaqUniverseDeps,
  type OpportunityScanOptions,
  type OpportunityScanResult,
  type PipelineOptions,
  type PipelineResult,
  type ScanRequestRecord,
  type ScanRequestTemplate,
  type StrategyRequest,
} from "../trading";

/** The engine job id prefix: one job per options run (see the module doc). */
export const OPTIONS_SCREEN_JOB_ID_PREFIX = "options-screen";

/** The step name the options job's nodes reference. */
export const OPTIONS_SCREEN_STEP = "options.runStage";

/** The engine job id for one options run. */
export function optionsScreenJobId(runId: string): string {
  return `${OPTIONS_SCREEN_JOB_ID_PREFIX}:${runId}`;
}

/**
 * The options screen job definition, as raw configuration for
 * JobPipelineControl.defineJob: a root with one child per options stage,
 * each child one `options.runStage` step carrying its stageId. Sequential
 * + batch + sync + monolith: the stages run in pipeline order, the
 * dispatch awaits the terminal state, and the run is one unit.
 */
export function optionsScreenJobDefinition(jobId: string): Record<string, unknown> {
  return {
    jobId,
    name: `Options screen ${jobId}`,
    root: {
      kind: "options-screen",
      executionMode: {
        concurrency: "sequential",
        pacing: "batch",
        delivery: "sync",
        shape: "monolith",
      },
      children: OPTIONS_PIPELINE_STAGES.map((stageId) => ({
        kind: stageId,
        steps: [{ step: OPTIONS_SCREEN_STEP, params: { stageId } }],
      })),
    },
  };
}

/** The engine stores + run recorder one dispatch runs over. */
export interface OptionsEngineStores {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
}

/**
 * Engine stores over a host Durable Object's SQLite: the run record is
 * durable in the caller's DO (the same handle the leg's stage claims and
 * delivery suppressor already use).
 */
export function optionsEngineStoresFromSql(sql: SqlStorage): OptionsEngineStores {
  return {
    stores: createJobPipelineStoresFromSql(sql),
    runRecorder: jobRunRecorderFromStore(new SqlJobRunRecordStore(sql)),
  };
}

/**
 * In-memory engine stores: the run record lives only for the run's
 * duration (the #4069 accepted-absent discipline for legs with no SQL
 * handle). Constructed explicitly — never a silent fallback.
 */
export function optionsEngineStoresInMemory(): OptionsEngineStores {
  return {
    stores: createInMemoryJobPipelineStores(),
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
  };
}

/**
 * What the `options.runStage` step closes over: the run's identity and
 * request (the definition is static, so per-run facts ride the deps, not
 * the job config), the workflow deps the stage executes against, and the
 * per-dispatch holder the wrapper reads the outcome from.
 */
export interface OptionsScreenStepDeps {
  runId: string;
  userLogin?: string;
  request: unknown;
  workflow: OptionsScreenWorkflowDeps;
  /** The stage records + published messages, in pipeline order. */
  stageRecords: OptionsStageRecord[];
  published: StageMessage[];
}

const optionsBlocks = new Map(OPTIONS_BLOCKS.map((block) => [block.id, block]));

/**
 * Register the `options.runStage` step on a registry: one step per stage,
 * the stageId riding its params. The step runs the shared per-stage body
 * (runOptionsStageOnce — the same body the thin composer calls), records
 * the stage in the holder, and throws on failure so the engine stops the
 * run and marks it failed. The hand-off to the next step is the artifact
 * keys the next stage reads.
 */
export function registerOptionsScreenStep(
  registry: JobStepRegistry,
  deps: OptionsScreenStepDeps,
): JobStepRegistry {
  registry.register(OPTIONS_SCREEN_STEP, async (ctx: JobStepContext) => {
    const stageId = ctx.params?.stageId;
    if (typeof stageId !== "string" || !(OPTIONS_PIPELINE_STAGES as readonly string[]).includes(stageId)) {
      throw new Error(
        `options.runStage: params.stageId must be one of ${OPTIONS_PIPELINE_STAGES.join(", ")}; got ${JSON.stringify(stageId)}`,
      );
    }
    const input: OptionsStageInput = {
      runId: deps.runId,
      userLogin: deps.userLogin,
      stageId: stageId as OptionsPipelineStage,
      artifactKeys: ((ctx.input as { artifactKeys?: unknown } | null)?.artifactKeys as string[] | undefined) ?? [],
      request: deps.request,
    };
    const result = await runOptionsStageOnce(
      input,
      deps.workflow,
      optionsBlocks.get(`options-${stageId}`)!,
    );
    // Upsert by stageId, never push: the engine retries a failed step
    // within its budget, so one stage can be invoked more than once in
    // a run — the holder keeps the stage's LATEST record, one entry per
    // stage, in pipeline order (the first invocation's position).
    const existing = deps.stageRecords.findIndex((record) => record.stageId === stageId);
    if (existing >= 0) {
      deps.stageRecords[existing] = result.record;
    } else {
      deps.stageRecords.push(result.record);
    }
    if (result.publishedMessage) {
      deps.published.push(result.publishedMessage);
    }
    if (result.failed) {
      throw new Error(result.reason ?? `options stage ${stageId} failed`);
    }
    return {
      output: { stageId, artifactKeys: result.nextArtifactKeys },
      descriptor: `options stage ${stageId} ${result.record.status}`,
    };
  });
  return registry;
}

/**
 * Issue #4068 — the single-name panel run on the engine: the shared
 * successor to UnifiedOptionsService.runStrategyPipeline (site 4) AND to
 * runPanelPipelineRetired4068 (the bypass), so the panel runs go through the one
 * engine-routed workflow instead of the direct composer / the direct
 * panel pipeline. The agents are constructed exactly as runPanelPipelineRetired4068
 * built them (data agent over the given screener — fresh risk +
 * recommender); the optional universeDeps ride the screener's third
 * constructor argument for callers that thread them (the evaluate
 * route), exactly as runPanelPipelineRetired4068's callers passed them. All four PipelineOptions fields ride the
 * classInput (the feed seam's snapshotOverride included), so the
 * contract is preserved for callers that pass a stored snapshot. The
 * service holds no DO storage/queue handle, so stage storage/claims are
 * the shared in-memory helpers and publishing is skipped (queue null);
 * the durable record for these runs is the caller's downstream record,
 * unchanged. The engine stores are in-memory (the #4069 accepted-absent
 * discipline for legs with no SQL handle).
 */
export async function runOptionsPanelViaEngine(
  source: OptionChainSource | undefined,
  request: StrategyRequest,
  options: PipelineOptions = {},
  userLogin?: string,
  universeDeps?: NasdaqUniverseDeps,
): Promise<PipelineResult> {
  const runId = `options-panel:service:${request.symbol}:${new Date().toISOString()}`;
  const storage = memoryStageStorage();
  const outcome = await runOptionsScreenViaEngine(
    {
      runId,
      userLogin,
      trigger: "manual",
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: {
          strategyRequest: request,
          strategyFilter: options.strategyFilter,
          riskProfile: options.riskProfile,
          alternatives: options.alternatives,
          snapshotOverride: options.snapshotOverride,
        },
      },
    },
    {
      stages: createStrategyScreenPorts({
        agents: {
          data: new OptionsDataAgent(
            new DynamicOptionsScreener(source, undefined, universeDeps),
          ),
          risk: new StrategyRiskAgent(),
          recommender: new RecommendationAgent(),
        },
        storage,
      }),
      claims: memoryStageClaims(),
      queue: null,
    },
  );
  if (outcome.outcome !== "completed") {
    throw new Error(
      `Options strategy screen failed at ${outcome.failedStage}: ${outcome.reason}`,
    );
  }
  const panelResult = await storage.get<PanelDiscoveryResult>(
    optionsArtifactKey(runId, "shapeReport"),
  );
  if (!panelResult) {
    throw new Error(
      "Options strategy screen completed without a report artifact; refusing to answer from nothing.",
    );
  }
  return panelResultToPipelineResult(panelResult);
}

/**
 * Issue #4068 — the bare options screen on the engine: the shared
 * successor to the direct screen (DynamicOptionsScreener.screenOptions /
 * screenOptionsWithSourceRetired4068 / UnifiedOptionsService.screenContractsRetired4068), for
 * callers that want the screen result, not a report. The screen
 * computation is identical (chainFetch → enrich → screen over the same
 * screener + filter); the shapeReport stage returns the screen result
 * itself and the deliver stage defers to the caller, so no PDF, no
 * delivery, and no canonical row is produced (the persist stage records
 * the honest omission). The caller owns the run's durable record (the
 * route's response / the service's cache + downstream record). The
 * engine stores are in-memory (no SQL handle on either caller). A real
 * userLogin is required: the plain ports are owner-scoped (requireLogin
 * in persist/shapeReport/deliver) — callers fail closed without one,
 * exactly as the manual route does.
 */
export async function runOptionsPlainScreenViaEngine(
  source: OptionChainSource | undefined,
  filter: OptionScreenerFilter,
  userLogin: string,
  config?: Partial<EtapiScreenerConfig>,
): Promise<OptionScreenResult> {
  if (!userLogin) {
    throw new Error("options plain screen: a real userLogin is required (the plain ports are owner-scoped)");
  }
  const screener = new DynamicOptionsScreener(source, config);
  // Issue #4068 (fix): the direct screen (DynamicOptionsScreener.screenOptions)
  // answers a fetch/validation failure with an ERROR RESULT, never a throw —
  // and the paid/premium callers (PaidOptionsScreenerCommand,
  // /premium/options-scan) depend on that shape (they read
  // result.status === "error" and answer 200). The engine path fails the
  // run instead, so this helper translates the two failure shapes
  // screenOptions converts: the fetchChains validation gate (checked here,
  // before dispatch, with the same conditions and verbatim messages
  // fetchChains throws) and the no-chains screen failure (translated from
  // the persisted chainFetch artifact below). Any other engine failure
  // still throws, as before.
  const { filter: saneFilter, warnings } = sanitizeOptionScreenerFilter(filter, screener.config);
  if (saneFilter.sector && !["all", "any"].includes(saneFilter.sector.toLowerCase())) {
    return {
      ...screener.evaluateChains([], saneFilter, 0, { warnings }),
      status: "error",
      validationError:
        "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols.",
    };
  }
  if (
    (!saneFilter.underlyingSymbols || saneFilter.underlyingSymbols.length === 0) &&
    saneFilter.maxUnderlyings === undefined
  ) {
    return {
      ...screener.evaluateChains([], saneFilter, 0, { warnings }),
      status: "error",
      validationError:
        "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains.",
    };
  }
  const runId = `options-screen:plain:${new Date().toISOString()}`;
  const storage = memoryStageStorage();
  const outcome = await runOptionsScreenViaEngine(
    {
      runId,
      userLogin,
      trigger: "manual",
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: { request: { filter } },
      },
    },
    {
      stages: createOptionsScreenPorts({
        screener,
        storage,
        // The bare screen's report IS the screen result; delivery is
        // deferred to the caller (no Slack/email from a raw screen).
        shapeReport: async ({ screen }) => screen,
        deliver: async () => ({ terminal: "completed", deliveryState: "deferred-to-caller" }),
      }),
      claims: memoryStageClaims(),
      queue: null,
    },
  );
  if (outcome.outcome !== "completed") {
    // Issue #4068 (fix): screenOptions answers "fetch errors, zero chains"
    // with an error result, not a throw — translate the engine's
    // screen-stage failure back into that shape from the persisted
    // chainFetch artifact (filter + fetchErrors + warnings as fetched).
    if (outcome.failedStage === "screen") {
      const fetched = await storage.get<{
        filter: OptionScreenerFilter;
        warnings: string[];
        symbols: string[];
        chains: unknown[];
        fetchErrors: OptionScreenFetchError[];
      }>(optionsArtifactKey(runId, "chainFetch"));
      if (fetched && fetched.fetchErrors.length > 0 && fetched.chains.length === 0) {
        const result = screener.evaluateChains([], fetched.filter, fetched.symbols.length, {
          fetchErrors: fetched.fetchErrors,
          warnings: fetched.warnings,
        });
        result.status = "error";
        return result;
      }
    }
    throw new Error(`Options screen failed at ${outcome.failedStage}: ${outcome.reason}`);
  }
  const screened = await storage.get<{ terminal: string; result: OptionScreenResult }>(
    optionsArtifactKey(runId, "screen"),
  );
  if (!screened || screened.result === undefined) {
    throw new Error(`Options screen completed without a screen artifact for run ${runId}`);
  }
  return screened.result;
}

/**
 * Issue #4068 — the opportunity scan on the engine: the shared successor
 * to the direct scan (OpportunityScanner.scan /
 * UnifiedOptionsService.scanOpportunitiesRetired4068), for callers that want the
 * scan result + save receipt. The scan computation is identical (the
 * scanner ports ARE the workflow decomposition of OpportunityScanner.scan:
 * fetchScanSnapshots → enrichScanSnapshots → screenScanCandidates →
 * assessScanRisk → collateScanResult). The persist stage attaches the
 * caller's requestRecord and saves via the scanRunStore when one is
 * bound (never failing the scan); the shapeReport stage returns the
 * result + save receipt, which is what this helper returns. The engine
 * stores are in-memory (no SQL handle on the caller).
 */
export async function runOptionsScanViaEngine(
  source: OptionChainSource | undefined,
  symbols: string[],
  template: ScanRequestTemplate,
  options: {
    scanOptions?: OpportunityScanOptions;
    requestRecord?: ScanRequestRecord;
    platformRunId?: string;
    trigger?: "manual" | "scheduled";
    scanRunStore?: ScanRunStore;
    userLogin?: string;
  } = {},
): Promise<OpportunityScanResult & { scanRunId?: string; persisted?: boolean }> {
  const runId = `options-scan:service:${new Date().toISOString()}`;
  const storage = memoryStageStorage();
  const outcome = await runOptionsScreenViaEngine(
    {
      runId,
      userLogin: options.userLogin,
      trigger: "manual",
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: {
          scan: { symbols, template, options: options.scanOptions ?? {} },
          ...(options.requestRecord ? { requestRecord: options.requestRecord } : {}),
          ...(options.platformRunId ? { platformRunId: options.platformRunId } : {}),
          ...(options.trigger ? { trigger: options.trigger } : {}),
        },
      },
    },
    {
      stages: createScannerScreenPorts({
        agents: {
          data: new OptionsDataAgent(new DynamicOptionsScreener(source)),
          risk: new StrategyRiskAgent(),
          recommender: new RecommendationAgent(),
        },
        storage,
        ...(options.scanRunStore ? { scanRunStore: options.scanRunStore } : {}),
      }),
      claims: memoryStageClaims(),
      queue: null,
    },
  );
  if (outcome.outcome !== "completed") {
    throw new Error(`Options opportunity scan failed at ${outcome.failedStage}: ${outcome.reason}`);
  }
  const shaped = await storage.get<
    OpportunityScanResult & { scanRunId?: string; persisted?: boolean }
  >(optionsArtifactKey(runId, "shapeReport"));
  if (!shaped) {
    throw new Error(`Options opportunity scan completed without a report artifact for run ${runId}`);
  }
  return shaped;
}

/** What one engine-routed options screen run needs. */
export interface OptionsScreenEngineDeps {
  stages: Record<OptionsPipelineStage, OptionsStagePort>;
  claims: OptionsScreenWorkflowDeps["claims"];
  queue?: OptionsScreenWorkflowDeps["queue"];
  warn?: OptionsScreenWorkflowDeps["warn"];
  /**
   * The engine stores to run over. Absent, in-memory stores are built
   * explicitly (the #4069 accepted-absent discipline) — a leg that has a
   * SQL handle passes optionsEngineStoresFromSql(sql) instead.
   */
  engineStores?: OptionsEngineStores | null;
}

/**
 * Route one options screen through the J engine: define the per-run job,
 * dispatch it synchronously, and map the settled run onto the outcome the
 * call sites already consume. The engine runId (generated by the engine)
 * and the options runId (the caller's, carried on the canonical row and
 * the stage artifacts) are distinct by design; the options runId is the
 * identity the outcome and the downstream records carry.
 */
export async function runOptionsScreenViaEngine(
  params: {
    runId: string;
    userLogin?: string;
    request: unknown;
    trigger?: "manual" | "scheduled";
  },
  deps: OptionsScreenEngineDeps,
): Promise<OptionsScreenWorkflowOutcome> {
  const engineStores = deps.engineStores ?? optionsEngineStoresInMemory();
  const stageRecords: OptionsStageRecord[] = [];
  const published: StageMessage[] = [];
  const stepDeps: OptionsScreenStepDeps = {
    runId: params.runId,
    userLogin: params.userLogin,
    request: params.request,
    workflow: {
      stages: deps.stages,
      claims: deps.claims,
      queue: deps.queue ?? null,
      warn: deps.warn,
    },
    stageRecords,
    published,
  };
  const registry = registerOptionsScreenStep(createBuiltinStepRegistry(), stepDeps);
  const control = new JobPipelineControl({
    stores: engineStores.stores,
    runRecorder: engineStores.runRecorder,
    publisher: null,
    steps: registry,
    invocation: "sync",
  });
  const jobId = optionsScreenJobId(params.runId);
  await control.defineJob(optionsScreenJobDefinition(jobId));
  const dispatch = await control.runJob(jobId, { trigger: params.trigger ?? "manual" });
  if (dispatch.state === "completed") {
    return { outcome: "completed", runId: params.runId, stages: stageRecords, published };
  }
  // Failed (or paused/cancelled by a control-plane action mid-run): the
  // holder carries the failed stage + reason; fall back to the engine's
  // own view when the holder has no failed record (e.g. the run stopped
  // before any stage recorded).
  const failedRecord = stageRecords.find((record) => record.status === "failed");
  if (failedRecord) {
    return {
      outcome: "failed",
      runId: params.runId,
      stages: stageRecords,
      published,
      failedStage: failedRecord.stageId,
      reason: failedRecord.reason,
    };
  }
  let reason = `options screen run ${dispatch.state}`;
  try {
    const view = await control.getJob(jobId);
    const failedUnit = view.stages
      .flatMap((stage) => stage.units.map((unit) => ({ stage, unit })))
      .find(({ unit }) => unit.status === "failed" || unit.error);
    if (failedUnit?.unit.error) {
      reason = failedUnit.unit.error;
    } else if (view.instance?.lastError) {
      reason = view.instance.lastError;
    } else if (view.latestRun?.error) {
      reason = view.latestRun.error;
    }
    const failedStage = failedUnit?.stage.kind ?? undefined;
    return {
      outcome: "failed",
      runId: params.runId,
      stages: stageRecords,
      published,
      ...(failedStage ? { failedStage } : {}),
      reason,
    };
  } catch {
    return {
      outcome: "failed",
      runId: params.runId,
      stages: stageRecords,
      published,
      reason,
    };
  }
}
