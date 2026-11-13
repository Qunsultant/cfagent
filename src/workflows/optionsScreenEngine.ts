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
 *
 * Issue #4276: the three-way comparison ALSO dispatches through this
 * module, as a single-step engine job (`comparison:<runId>`, one
 * `comparison.run` root step, no children — the comparison core is
 * one indivisible thunk, not an eight-stage pipeline). The wrapper
 * returns the core's result verbatim and rethrows the core's error
 * verbatim, so the engine record is pure observability: the job
 * definition + run record make the comparison visible in Workflow
 * Runs and addressable by control (which refuses stage ops on it by
 * name — there are no stages to drive).
 */
import type { SqlStorage } from "../orm";
import {
  createJobPipelineStoresFromSql,
  type JobPipelineStores,
} from "../data/createJobPipelinePorts";
import type { JobArtifactStore } from "../data/jobPipelinePorts";
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
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsStageStorage,
} from "./optionsScreenPorts";
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
  type StrategyScreenAgents,
} from "./strategyScreenPorts";
import type { StageMessage } from "./stageMessage";
import { OPTIONS_PIPELINE_STAGES, type OptionsPipelineStage } from "./stageRuntimeIds";
import type { PanelDiscoveryResult } from "../services/recommendationKernel";
import type { ProductionComparisonResult } from "../services/comparisonRunner";
import type { ScanRunStore } from "../data/scanRunPorts";
import type { EtapiScreenerConfig } from "../config/etapiConfig";
import type { OptionScreenFetchError, OptionScreenResult, OptionScreenerFilter } from "../types";
// Issue #4066: these values come from the trading barrel
// (src/trading/index.ts), the sole public import surface under the
// #290 boundary — leaf imports of trading internals trip the
// boundary test. The barrel is already client-reachable on main
// (NLQ execution -> nlqOptionsStrategy imports values from it), so
// importing values from it here adds no new client-bundle surface.
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

/**
 * The step name the options job's ROOT references. The engine's
 * stage-input contract (#4066): a node's input is its parent's
 * stage-output artifact, and a parent with no step produces a null
 * hand-off — so a root with no step leaves all eight stages without
 * a persisted input, and no stage operation (run / re-run / resume)
 * can ever execute on them (stage_input_missing). The root step
 * produces the dispatch request as the run's hand-off, so every
 * stage's input is the request it was dispatched with. The child
 * step ignores ctx.input (it reads the request from its deps and
 * the earlier stages' artifacts from the stage storage); the root
 * output exists only to satisfy the contract.
 */
export const OPTIONS_SCREEN_ROOT_STEP = "options.runRoot";

/** The engine job id for one options run. */
export function optionsScreenJobId(runId: string): string {
  return `${OPTIONS_SCREEN_JOB_ID_PREFIX}:${runId}`;
}

/** The engine job id prefix: one job per strategy run (see the module doc). */
export const STRATEGY_SCREEN_JOB_ID_PREFIX = "strategy-screen";

/**
 * The strategy screen job definition, as raw configuration for
 * JobPipelineControl.defineJob: the SAME eight-node tree as the options
 * job (one child per options stage, each one `options.runStage` step
 * carrying its stageId, the root carrying the `options.runRoot` step),
 * with a strategy identity — root kind "strategy-screen", name
 * "Strategy screen <jobId>", job id `strategy-screen:<runId>`.
 *
 * Issue #4271 (#3552 S1): the strategy screen executes on the engine
 * today only by riding the options job (its dispatch defined the
 * options job with a strategyRequest shape). A dedicated definition
 * makes the strategy screener a first-class J-engine workflow with its
 * own job identity, pipeline record, and run history — visible as its
 * own job in Workflow Runs. The stages, steps, and execution mode are
 * identical to the options job by design: the strategy pipeline IS the
 * eight-stage options pipeline run over strategy ports, and the
 * dispatch request rides the raw config exactly as the options job's
 * does (so a later per-stage control action can rebuild the run's step
 * ports from it — S2's vocabulary/control work). No semantics change:
 * the same stages run over the same ports; only the job identity
 * changes.
 */
export function strategyScreenJobDefinition(jobId: string, request?: unknown, userLogin?: string): Record<string, unknown> {
  return {
    jobId,
    name: `Strategy screen ${jobId}`,
    ...(request !== undefined ? { request } : {}),
    // Issue #4289: the acting login rides the raw config beside the
    // request, so the workflow host's resolving steps can rebuild
    // owner-scoped ports per invocation. Absent, the definition is
    // byte-identical to before (the resolver ignores both fields).
    ...(userLogin !== undefined ? { userLogin } : {}),
    root: {
      kind: "strategy-screen",
      steps: [{ step: OPTIONS_SCREEN_ROOT_STEP }],
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

/** The engine job id for one strategy run. */
export function strategyScreenJobId(runId: string): string {
  return `${STRATEGY_SCREEN_JOB_ID_PREFIX}:${runId}`;
}

/**
 * The options screen job definition, as raw configuration for
 * JobPipelineControl.defineJob: a root with one child per options stage,
 * each child one `options.runStage` step carrying its stageId. Sequential
 * + batch + sync + monolith: the stages run in pipeline order, the
 * dispatch awaits the terminal state, and the run is one unit.
 *
 * Issue #4066: the dispatch request rides the raw config (`request`).
 * The resolved config ignores it (only jobId/name/root/config are
 * resolved), but defineJob persists the whole rawConfig in the
 * definitions store — so a later control action can read the run's
 * request back out of the stored definition and rebuild the step's
 * ports to run / re-run / resume one of its stages. The request is
 * plain JSON-shaped dispatch data (filter / strategyRequest / scan
 * spec); nothing non-serializable rides it. One job is one run, so
 * the definition IS the run's record — the request belongs to it.
 *
 * The root carries the `options.runRoot` step (see
 * OPTIONS_SCREEN_ROOT_STEP): without it the root produces a null
 * hand-off and no stage operation can execute on this job.
 */
export function optionsScreenJobDefinition(jobId: string, request?: unknown, userLogin?: string): Record<string, unknown> {
  return {
    jobId,
    name: `Options screen ${jobId}`,
    ...(request !== undefined ? { request } : {}),
    // Issue #4289: the acting login rides the raw config beside the
    // request, so the workflow host's resolving steps can rebuild
    // owner-scoped ports per invocation. Absent, the definition is
    // byte-identical to before (the resolver ignores both fields).
    ...(userLogin !== undefined ? { userLogin } : {}),
    root: {
      kind: "options-screen",
      steps: [{ step: OPTIONS_SCREEN_ROOT_STEP }],
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

/** The engine job id prefix: one job per comparison run (see the module doc). */
export const COMPARISON_JOB_ID_PREFIX = "comparison";

/** The step name the comparison job's root references. */
export const COMPARISON_STEP = "comparison.run";

/**
 * The comparison job definition, as raw configuration for
 * JobPipelineControl.defineJob: a root-only tree — the root carries
 * the single `comparison.run` step and there are no children. The
 * comparison core (runProductionComparison) is one indivisible thunk
 * (three arms over one snapshot, one ledger write), not a staged
 * pipeline, so there is no stage tree to define; the engine record
 * exists for observability and control addressability, and the step
 * executes the thunk verbatim. Sequential + batch + sync + monolith,
 * as the screen jobs. The dispatch request rides the raw config
 * exactly as the screen jobs' does (classInput.comparisonRequest),
 * so control can decode the run's shape from the stored definition.
 */
export function comparisonJobDefinition(jobId: string, request?: unknown): Record<string, unknown> {
  return {
    jobId,
    name: `Comparison ${jobId}`,
    ...(request !== undefined ? { request } : {}),
    root: {
      kind: "comparison",
      steps: [{ step: COMPARISON_STEP }],
      executionMode: {
        concurrency: "sequential",
        pacing: "batch",
        delivery: "sync",
        shape: "monolith",
      },
    },
  };
}

/** The engine job id for one comparison run. */
export function comparisonJobId(runId: string): string {
  return `${COMPARISON_JOB_ID_PREFIX}:${runId}`;
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
 * Issue #4289 — resolve the stage id a step invocation carries. The
 * one validation both step registrations share: the closure
 * registration (registerOptionsScreenStep) and the resolving
 * registration (registerOptionsWorkflowSteps) refuse a bad stageId
 * with the same error.
 */
export function resolveOptionsStageId(params: unknown): OptionsPipelineStage {
  const stageId = (params as { stageId?: unknown } | null)?.stageId;
  if (typeof stageId !== "string" || !(OPTIONS_PIPELINE_STAGES as readonly string[]).includes(stageId)) {
    throw new Error(
      `options.runStage: params.stageId must be one of ${OPTIONS_PIPELINE_STAGES.join(", ")}; got ${JSON.stringify(stageId)}`,
    );
  }
  return stageId as OptionsPipelineStage;
}

/**
 * Issue #4289 — the shared `options.runStage` step body: run one
 * stage through the shared per-stage body (runOptionsStageOnce — the
 * same body the thin composer calls), record the stage in the
 * holder, and throw on failure so the engine stops the run and
 * marks it failed. The hand-off to the next step is the artifact
 * keys the next stage reads. Both registrations — the closure one
 * (dispatch + control) and the resolving one (the workflow host) —
 * execute this one body; they differ only in how the deps are
 * obtained (closed over per dispatch vs rebuilt per invocation).
 */
export async function runOptionsScreenStep(
  ctx: JobStepContext,
  deps: OptionsScreenStepDeps,
): Promise<{ output: { stageId: string; artifactKeys: string[] }; descriptor: string }> {
  const stageId = resolveOptionsStageId(ctx.params);
  const input: OptionsStageInput = {
    runId: deps.runId,
    userLogin: deps.userLogin,
    stageId,
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
}

/**
 * Issue #4289 — the stage storage over the engine's artifact store:
 * the durable home for stage artifacts in the workflow residency.
 * The adapter is scoped by the ENGINE run id (the artifact store's
 * scoping — a resumed run re-uses its engine run id, so its
 * artifacts stay readable across executions); the keys are the
 * options-scoped `options:<optionsRunId>:<stageId>` keys the ports
 * already use. Values are JSON-shaped data, as the artifact store
 * requires.
 */
export function optionsStageStorageFromArtifacts(
  artifacts: JobArtifactStore,
  engineRunId: string,
): OptionsStageStorage {
  return {
    put: async (key, value) => {
      await artifacts.putArtifact(engineRunId, key, value);
    },
    get: async <T>(key: string): Promise<T | undefined> => {
      // The artifact store reports a missing key as null; the
      // stage-storage contract is undefined-for-missing, and the
      // stages branch on it — a null read crashes readers that
      // iterate the value's fields.
      const value = await artifacts.getArtifact(engineRunId, key);
      return (value ?? undefined) as T | undefined;
    },
  };
}

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
  // The root step (see OPTIONS_SCREEN_ROOT_STEP): produces the
  // dispatch request as the run's hand-off, so every stage has a
  // persisted input and is independently addressable. Registered
  // alongside the stage step so every control that rebuilds the
  // registry (dispatch and per-stage control alike) carries both.
  registry.register(OPTIONS_SCREEN_ROOT_STEP, async () => ({
    output: deps.request,
    descriptor: `options screen ${deps.runId} input`,
  }));
  registry.register(OPTIONS_SCREEN_STEP, async (ctx: JobStepContext) =>
    runOptionsScreenStep(ctx, deps),
  );
  return registry;
}

/**
 * What the `comparison.run` step closes over: the run's identity, the
 * thunk that executes the comparison core, and the per-dispatch
 * holder the wrapper reads the outcome from.
 */
export interface ComparisonStepDeps {
  runId: string;
  execute: () => Promise<ProductionComparisonResult>;
  /** The thunk's result or error, captured before the step returns /
   *  throws so the wrapper can return / rethrow it verbatim. */
  holder: { result?: ProductionComparisonResult; error?: unknown };
}

/**
 * Register the `comparison.run` step on a registry: one step, the
 * whole comparison. The step runs the thunk, captures the result in
 * the holder, and returns the run id as the hand-off; on failure it
 * captures the error and rethrows it, so the engine marks the run
 * failed and the wrapper rethrows the original error.
 */
export function registerComparisonStep(
  registry: JobStepRegistry,
  deps: ComparisonStepDeps,
): JobStepRegistry {
  registry.register(COMPARISON_STEP, async () => {
    try {
      const result = await deps.execute();
      deps.holder.result = result;
    } catch (error) {
      deps.holder.error = error;
      throw error;
    }
    return {
      output: { runId: deps.runId },
      descriptor: `comparison run ${deps.runId}`,
    };
  });
  return registry;
}

/**
 * Issue #4275 — what one caller-agents panel run needs, beyond the
 * four PipelineOptions fields (strategyFilter / riskProfile /
 * alternatives / snapshotOverride): the run's identity and trigger,
 * the engine stores it records over, and the stage-message queue.
 * Defaults preserve runOptionsPanelViaEngine's contract exactly:
 * trigger "manual", the `options-panel:service:` run id, in-memory
 * engine stores (the #4069 accepted-absent discipline), no
 * publishing.
 */
export interface PanelViaEngineOptions extends PipelineOptions {
  userLogin?: string;
  trigger?: "manual" | "scheduled";
  runId?: string;
  engineStores?: OptionsEngineStores | null;
  queue?: OptionsScreenWorkflowDeps["queue"];
}

/**
 * Issue #4275 — the engine-routed panel over CALLER-OWNED agents:
 * the shared successor to runPanelWithAgentsRetired4275 (the scheduled firer's
 * direct panel call). The #4068 deprecation ledger prescribed this
 * shape: the firer constructs shared PanelAgents once from the
 * scheduled universe deps and passes them to both the panel run and
 * agent methods, so the engine panel helper must accept pre-built
 * agents instead of constructing its own from a chain source.
 * The dispatch is runOptionsPanelViaEngine's, unchanged: the
 * strategy job (strategy-screen:<runId>) over the strategy ports,
 * the shapeReport artifact mapped back to PipelineResult. All four
 * PipelineOptions fields ride the classInput (the feed seam's
 * snapshotOverride included), so the contract is preserved for
 * callers that pass a stored snapshot.
 */
export async function runOptionsPanelViaEngineWithAgents(
  agents: StrategyScreenAgents,
  request: StrategyRequest,
  options: PanelViaEngineOptions = {},
): Promise<PipelineResult> {
  const runId = options.runId ?? `options-panel:service:${request.symbol}:${new Date().toISOString()}`;
  const trigger = options.trigger ?? "manual";
  const storage = memoryStageStorage();
  // Issue #4271: the panel is a strategy screen — it defines the
  // strategy job (strategy-screen:<runId>), not the options job.
  const outcome = await runStrategyScreenViaEngine(
    {
      runId,
      userLogin: options.userLogin,
      trigger,
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger,
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
        agents,
        storage,
      }),
      claims: memoryStageClaims(),
      queue: options.queue ?? null,
      ...(options.engineStores ? { engineStores: options.engineStores } : {}),
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
 *
 * Issue #4275: delegates to runOptionsPanelViaEngineWithAgents with
 * freshly constructed agents — one panel routing, not two.
 */
export async function runOptionsPanelViaEngine(
  source: OptionChainSource | undefined,
  request: StrategyRequest,
  options: PipelineOptions = {},
  userLogin?: string,
  universeDeps?: NasdaqUniverseDeps,
  /**
   * Issue #4066: the engine stores the panel run records over. Absent,
   * in-memory stores are built explicitly (the #4069 accepted-absent
   * discipline) — a leg that has a SQL handle passes
   * optionsEngineStoresFromSql(sql) instead, so the run is addressable
   * by a later per-stage control action from the copilot turn.
   */
  engineStores?: OptionsEngineStores | null,
): Promise<PipelineResult> {
  return runOptionsPanelViaEngineWithAgents(
    {
      data: new OptionsDataAgent(
        new DynamicOptionsScreener(source, undefined, universeDeps),
      ),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    },
    request,
    { ...options, userLogin, engineStores },
  );
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
 * stores are in-memory (no SQL handle on the caller) unless the caller
 * passes engineStores (Issue #4271: mirrors runOptionsPanelViaEngine —
 * a SQL handle records the engine run durably in the host DO, so a
 * later per-stage control action can address it).
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
    /**
     * Issue #4271: the engine stores the scan run records over. Absent,
     * in-memory stores are built explicitly (the #4069 accepted-absent
     * discipline) — a leg that has a SQL handle passes
     * optionsEngineStoresFromSql(sql) instead.
     */
    engineStores?: OptionsEngineStores | null;
  } = {},
): Promise<OpportunityScanResult & { scanRunId?: string; persisted?: boolean }> {
  const runId = `options-scan:service:${new Date().toISOString()}`;
  const storage = memoryStageStorage();
  // Issue #4271: the scan is a strategy screen — it defines the
  // strategy job (strategy-screen:<runId>), not the options job.
  const outcome = await runStrategyScreenViaEngine(
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
      ...(options.engineStores ? { engineStores: options.engineStores } : {}),
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
 * Route one screen through the J engine: define the per-run job,
 * dispatch it synchronously, and map the settled run onto the outcome the
 * call sites already consume. The engine runId (generated by the engine)
 * and the screen runId (the caller's, carried on the canonical row and
 * the stage artifacts) are distinct by design; the screen runId is the
 * identity the outcome and the downstream records carry.
 *
 * The job is the caller's: an options dispatch defines the options job
 * (runOptionsScreenViaEngine), a strategy dispatch defines the strategy
 * job (runStrategyScreenViaEngine, #4271). The dispatch body is shared —
 * the two jobs differ only in identity, never in stages, steps, or
 * execution.
 */
async function dispatchScreenViaEngine(
  params: {
    runId: string;
    userLogin?: string;
    request: unknown;
    trigger?: "manual" | "scheduled";
  },
  deps: OptionsScreenEngineDeps,
  jobId: string,
  definition: Record<string, unknown>,
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
  // Issue #4066: the dispatch request rides the job definition's
  // rawConfig (persisted by defineJob) so a later per-stage control
  // action can rebuild this run's step ports from it.
  await control.defineJob(definition);
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

/**
 * Route one options screen through the J engine: define the per-run
 * options job, dispatch it synchronously, and map the settled run onto
 * the outcome the call sites already consume.
 *
 * Issue #4289 — the durable path for an options screen is the
 * workflow host (startOptionsScreenWorkflow in optionsWorkflowHost.ts,
 * executed by JobPipelineWorkflow with the workflow step as the
 * engine's journal). This sync/in-process dispatch is KEPT, not
 * retired, for the legs that cannot move yet: the manual route (its
 * shapeReport/deliver builders need the route's getScreenerAgent) and
 * the goal leg (its host is #4290). New callers must dispatch
 * through the host; a leg moves here only when its ports are
 * rebuildable per invocation (see optionsStepPorts.ts).
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
  const jobId = optionsScreenJobId(params.runId);
  return dispatchScreenViaEngine(
    params,
    deps,
    jobId,
    optionsScreenJobDefinition(jobId, params.request),
  );
}

/**
 * Issue #4271 — route one strategy screen through the J engine: define
 * the per-run STRATEGY job (strategyScreenJobDefinition, job id
 * `strategy-screen:<runId>`), dispatch it synchronously, and map the
 * settled run onto the outcome the call sites already consume. The
 * dispatch is identical to the options dispatch — the same eight
 * stages, the same steps, the same ports — only the job identity
 * differs, so a strategy screen is visible as its own job in Workflow
 * Runs with its own pipeline record and run history.
 *
 * Issue #4291 — the durable path for a strategy screen is the
 * workflow host (startStrategyScreenWorkflow in optionsWorkflowHost.ts,
 * executed by JobPipelineWorkflow with the workflow step as the
 * engine's journal; awaitOptionsWorkflowRun awaits settlement). This
 * sync/in-process dispatch is KEPT, not retired, for the legs that
 * cannot move yet: every strategy leg is blocked by a named gap —
 * broker selection (#3960: the discovery, shard, and NLQ legs read
 * broker-aware chain sources the residency cannot rebuild), the
 * scan-run store + stage queue in the residency (#4453: the NLQ scan
 * leg, the scheduled firer, and the shard executor bind one or both),
 * and universe deps that do not travel (the firer and the evaluate
 * route). New callers must dispatch through the host; a leg moves
 * here only when its ports are rebuildable per invocation (see
 * optionsStepPorts.ts) and its gap has landed.
 */
export async function runStrategyScreenViaEngine(
  params: {
    runId: string;
    userLogin?: string;
    request: unknown;
    trigger?: "manual" | "scheduled";
  },
  deps: OptionsScreenEngineDeps,
): Promise<OptionsScreenWorkflowOutcome> {
  const jobId = strategyScreenJobId(params.runId);
  return dispatchScreenViaEngine(
    params,
    deps,
    jobId,
    strategyScreenJobDefinition(jobId, params.request),
  );
}

/**
 * Issue #4276 — route one three-way comparison through the J engine:
 * define the per-run comparison job, dispatch it synchronously, and
 * return the core's result verbatim. The engine record (definition +
 * run) is observability: the comparison is visible as its own job in
 * Workflow Runs, and control addresses it by run id (refusing stage
 * ops by name — a single-step job has no stages). A thunk failure
 * rethrows the ORIGINAL error verbatim (never a wrapped engine
 * failure), so callers see the core's failure exactly as the direct
 * path surfaces it. Without engine stores the dispatch runs over
 * explicitly constructed in-memory stores (the #4069 accepted-absent
 * discipline) — the run completes, with no durable record.
 */
export async function runComparisonViaEngine(
  params: {
    runId: string;
    request: unknown;
    engineStores?: OptionsEngineStores | null;
  },
  execute: () => Promise<ProductionComparisonResult>,
): Promise<ProductionComparisonResult> {
  const engineStores = params.engineStores ?? optionsEngineStoresInMemory();
  const holder: ComparisonStepDeps["holder"] = {};
  const registry = registerComparisonStep(createBuiltinStepRegistry(), {
    runId: params.runId,
    execute,
    holder,
  });
  const control = new JobPipelineControl({
    stores: engineStores.stores,
    runRecorder: engineStores.runRecorder,
    publisher: null,
    steps: registry,
    invocation: "sync",
  });
  const jobId = comparisonJobId(params.runId);
  // The dispatch request rides the job definition's rawConfig
  // (persisted by defineJob) so a later control action can decode
  // this run's shape from the stored definition.
  await control.defineJob(comparisonJobDefinition(jobId, params.request));
  const dispatch = await control.runJob(jobId, { trigger: "manual" });
  if (dispatch.state === "completed" && holder.result !== undefined) {
    return holder.result;
  }
  if (holder.error !== undefined) {
    throw holder.error;
  }
  throw new Error(
    `comparison run ${params.runId} ended ${dispatch.state} without a result`,
  );
}
