/**
 * Issue #4190 ([One engine] #3550 S1) — the screener substrate:
 * the job-definition builder, the screener step registry, and the
 * per-stage step handlers that let the one engine execute a stock
 * screen. Pure addition in this slice: nothing calls this module
 * except tests (the S2 cutover wires dispatch + residency
 * composition); the bespoke flow still runs production screens.
 *
 * Shape (design ~/workspace/.work/design-3550-onboarding.md §4,
 * Shape A): a per-run job definition (jobId = command.jobId), a
 * nested chain of six nodes, kinds feed -> enrich -> analyze ->
 * store -> serve -> deliver, each 1:1 with a catalog stage
 * (workflowCatalog.ts STOCK_SCREENER). processing.shards =
 * command shard ids; units = shards on every node; artifacts
 * hand off per (stage, shard). The goal leg rides the same six
 * nodes (goalScreen job param; handlers branch like
 * runShardFlow does — a goal run never executes as a market
 * screen, #1996).
 *
 * Step handlers resolve the live deps per invocation (agent
 * stub, quote/history deps, store/deliver doors) and delegate
 * to the ScreenerAgent stage methods, which own the per-run
 * state keyed by run id. A scheduled duplicate is passed
 * through untouched from feed to deliver (never persisted,
 * never delivered — runScreenInner's dup rule).
 */
import { actorGateway } from "../services/cloudflareActorGateway";
import { resolveScreenerAgentName } from "../agents/screenerAgentName";
import type { OrchestratorAgent } from "../agents/orchestrator";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import { screenerOutcomeFromRunResult } from "../services/screenerFollowups";
import type { Env } from "../types";
import type { JobPipelineStores, JobNodeConfig } from "../data/jobPipelinePorts";
import type { JobPipelineControl } from "./jobPipelineEngine";
import {
  createBuiltinStepRegistry,
  JobStepRegistry,
  type JobStepContext,
} from "./jobPipelineSteps";
import type {
  ScreenerAgentPort,
  ScreenerAnalysisStageOutput,
  ScreenerDeliverStageOutput,
  ScreenerFeedStageOutput,
  ScreenerGatherStageOutput,
  ScreenerGoalRunner,
  ScreenerQuoteDepsBundle,
  ScreenerRunRequest,
  ScreenerRunResult,
  ScreenerServeStageOutput,
  ScreenerStoreStageOutput,
} from "../agents/screener-agent";
import type { YahooHistoryDeps } from "../trading";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import type {
  GoalScreenCommand,
  WorkflowJobCommand,
} from "../workflows/workflowPorts";
import type { WorkflowGoalScreenEnvelope } from "../agents/orchestrator/goalScreenDispatch";

/** The step names a screener job's configuration references. */
export const SCREENER_FEED_STEP = "screener.feed";
export const SCREENER_GATHER_STEP = "screener.gather";
export const SCREENER_ANALYSIS_STEP = "screener.analysis";
export const SCREENER_STORE_STEP = "screener.store";
export const SCREENER_SERVE_STEP = "screener.serve";
export const SCREENER_DELIVER_STEP = "screener.deliver";

/** The six node kinds, in catalog order. */
export const SCREENER_NODE_KINDS = ["feed", "enrich", "analyze", "store", "serve", "deliver"] as const;

/** The step each node kind runs. */
export const SCREENER_NODE_STEPS: Record<(typeof SCREENER_NODE_KINDS)[number], string> = {
  feed: SCREENER_FEED_STEP,
  enrich: SCREENER_GATHER_STEP,
  analyze: SCREENER_ANALYSIS_STEP,
  store: SCREENER_STORE_STEP,
  serve: SCREENER_SERVE_STEP,
  deliver: SCREENER_DELIVER_STEP,
};

/**
 * The screener step deps, mirroring the family step deps
 * (FeedStepDeps et al.): the agent resolution, the bound quote /
 * history deps for one request, and the store / deliver doors.
 * The quote/history deps are resolved per request because the
 * platform binding is per-provider (and per-run in production).
 * Both are OPTIONAL: when a host omits them the agent binds
 * them itself from the platform (bindScreenerQuoteDeps /
 * bindScreenerHistoryDeps, issue #4192) — a host that cannot
 * bind them refuses by name at execution (never an unwired
 * fetch), exactly as the feed step refuses
 * FEED_JOB_NOT_CONFIGURED.
 */
export interface ScreenerStepDeps {
  /** The ScreenerAgent port for one owner login (a DO stub in production). */
  agentFor: (userLogin: string) => ScreenerAgentPort;
  /** The bound quote deps for one screen request (test override seam; omitted = agent binds them). */
  quoteDepsFor?: (req: ScreenerRunRequest) => ScreenerQuoteDepsBundle;
  /** The bound history deps for one screen request (test override seam; omitted = agent binds them). */
  historyDepsFor?: (req: ScreenerRunRequest) => YahooHistoryDeps;
  /**
   * The canonical-store door (the flow's storeReport, moved
   * here): market payloads go through recordWorkflowScreenReport,
   * goal payloads through recordWorkflowGoalScreenReport (which
   * returns the canonical report id). Returns the report id when
   * the door yields one.
   */
  storeReport: (
    payload: unknown,
    userLogin: string,
    opts?: { goalScreen?: GoalScreenCommand },
  ) => Promise<unknown>;
  /**
   * The delivery door (the flow's deliverOutcome, moved here):
   * market outcomes go through deliverWorkflowScreenOutcome
   * with the `workflow:<jobId>` delivery id (the #3943
   * suppression key), goal outcomes through the goal seam.
   */
  deliverOutcome: (
    payload: unknown,
    userLogin: string,
    opts?: { goalScreen?: GoalScreenCommand; deliveryId?: string },
  ) => Promise<void>;
  /**
   * The goal runner (defaults to the agent's runGoalScreen).
   * Tests inject a fake; production never overrides it.
   */
  goalRunner?: ScreenerGoalRunner;
}

function requireUserLogin(params: Record<string, unknown>): string {
  const login = params.userLogin;
  if (typeof login !== "string" || !login.trim()) {
    throw new Error(
      "SCREENER_STEP_NO_USER: a screener step needs a userLogin param — refusing a screen with no owner (issue #1185).",
    );
  }
  return login;
}

function goalScreenParam(params: Record<string, unknown>): GoalScreenCommand | undefined {
  const goal = params.goalScreen;
  return (goal && typeof goal === "object" ? (goal as GoalScreenCommand) : undefined);
}

/** The screen request a step's params carry (JSON only — live deps never ride params). */
function screenRequestFromParams(
  params: Record<string, unknown>,
  symbols: NasdaqStockListing[],
  shardKey: string | null,
): ScreenerRunRequest {
  const table = (params.shards ?? []) as { shardId: string; universe?: string }[];
  const row = shardKey ? table.find((entry) => entry.shardId === shardKey) : undefined;
  const universe = (row?.universe ?? table[0]?.universe) as ScreenerRunRequest["universe"];
  return {
    trigger: params.trigger === "scheduled" ? "scheduled" : "manual",
    ...(universe ? { universe } : {}),
    ...(params.provider ? { provider: params.provider as ScreenerRunRequest["provider"] } : {}),
    ...(params.filters ? { filters: params.filters as ScreenerRunRequest["filters"] } : {}),
    ...(params.sector ? { sector: params.sector as string } : {}),
    ...(params.maxItems !== undefined ? { maxItems: params.maxItems as number } : {}),
    ...(params.maxSymbols !== undefined ? { maxSymbols: params.maxSymbols as number } : {}),
    ...(params.broker ? { broker: params.broker as ScreenerRunRequest["broker"] } : {}),
    ...(params.mode ? { mode: params.mode as ScreenerRunRequest["mode"] } : {}),
    ...(params.modeSource ? { modeSource: params.modeSource as ScreenerRunRequest["modeSource"] } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
    userLogin: params.userLogin as string,
    ...(params.environment ? { environment: params.environment as ScreenerRunRequest["environment"] } : {}),
    ...(params.portfolioContext !== undefined ? { portfolioContext: params.portfolioContext as boolean } : {}),
    ...(params.traceparent ? { traceparent: params.traceparent as string } : {}),
  };
}

/**
 * This unit's symbols: the shard table's row for the unit's
 * shard key (the command's own sharding, exactly as the starter
 * computed it); the flat list under monolith; the flat list when
 * a shard row carries no explicit symbols (the agent resolves
 * the row's universe instead).
 */
function shardSymbolsFor(params: Record<string, unknown>, shardKey: string | null): NasdaqStockListing[] {
  const flat = (params.symbols ?? []) as NasdaqStockListing[];
  if (!shardKey) return flat;
  const table = (params.shards ?? []) as { shardId: string; symbols?: NasdaqStockListing[] }[];
  const row = table.find((entry) => entry.shardId === shardKey);
  if (row?.symbols?.length) return row.symbols;
  return flat;
}

/**
 * This unit's parent hand-off: the engine hands a sharded unit
 * its parent's whole per-shard map (`{shardKey: output}`), so a
 * downstream step reads its own shard's entry; a monolith unit
 * receives the single output directly. The accumulated JSON
 * state is the hand-off (the design's per-(stage, shard)
 * artifact), never re-resolved from a store.
 */
function priorFor<T>(input: unknown, shardKey: string | null): T {
  if (
    shardKey &&
    input !== null &&
    typeof input === "object" &&
    shardKey in (input as Record<string, unknown>)
  ) {
    return (input as Record<string, T>)[shardKey];
  }
  return input as T;
}

/** A scheduled duplicate passes through untouched from feed to deliver. */
function isDupOutput(value: unknown): value is { duplicate: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { duplicate?: unknown }).duplicate === true
  );
}

/**
 * Register the six screener steps on a registry. The handlers
 * are thin: resolve the live deps, delegate to the agent stage
 * methods, return the (JSON-only) stage output as the hand-off.
 */
export function registerScreenerSteps(registry: JobStepRegistry, deps: ScreenerStepDeps): JobStepRegistry {
  registry.register(SCREENER_FEED_STEP, async (ctx: JobStepContext) => {
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const symbols = shardSymbolsFor(params, ctx.shardKey);
    const req = screenRequestFromParams(params, symbols, ctx.shardKey);
    const goalScreen = goalScreenParam(params);
    const output = await agent.screenFeedStage(ctx.runId, {
      request: req,
      ...(deps.quoteDepsFor ? { quoteDeps: goalScreen ? {} : deps.quoteDepsFor(req) } : {}),
      symbols,
      timestamp: ctx.now,
      ...(goalScreen ? { goalScreen } : {}),
    });
    return { output };
  });

  registry.register(SCREENER_GATHER_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerFeedStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const req = screenRequestFromParams(params, shardSymbolsFor(params, ctx.shardKey), ctx.shardKey);
    const output = await agent.screenGatherStage(ctx.runId, {
      request: req,
      ...(deps.historyDepsFor ? { historyDeps: deps.historyDepsFor(req) } : {}),
      feedOutput: prior,
      ...(goalScreenParam(params) ? { goalScreen: goalScreenParam(params)! } : {}),
    });
    return { output };
  });

  registry.register(SCREENER_ANALYSIS_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerGatherStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const req = screenRequestFromParams(params, shardSymbolsFor(params, ctx.shardKey), ctx.shardKey);
    const goalScreen = goalScreenParam(params);
    const output = await agent.screenAnalysisStage(ctx.runId, {
      request: req,
      gatherOutput: prior,
      ...(goalScreen ? { goalScreen } : {}),
      ...(deps.goalRunner ? { goalRunner: deps.goalRunner } : {}),
    });
    return { output };
  });

  registry.register(SCREENER_STORE_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerAnalysisStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const req = screenRequestFromParams(params, shardSymbolsFor(params, ctx.shardKey), ctx.shardKey);
    const goalScreen = goalScreenParam(params);
    const output = await agent.screenStoreStage(ctx.runId, {
      request: req,
      analysisOutput: prior,
      ...(goalScreen ? { goalScreen } : {}),
      storeReport: deps.storeReport,
    });
    return { output };
  });

  registry.register(SCREENER_SERVE_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerStoreStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const output = await agent.screenServeStage(ctx.runId, { storeOutput: prior });
    return { output };
  });

  registry.register(SCREENER_DELIVER_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerServeStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) {
      return { output: { ...prior, delivered: false, deliverSkipped: true } as ScreenerDeliverStageOutput };
    }
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const goalScreen = goalScreenParam(params);
    const output = await agent.screenDeliverStage(ctx.runId, {
      serveOutput: prior,
      deliver: params.deliver === true,
      deliveryId: `workflow:${ctx.jobId}`,
      ...(goalScreen ? { goalScreen } : {}),
      deliverOutcome: deps.deliverOutcome,
    });
    return { output };
  });

  return registry;
}

/**
 * The screener step registry: the J1 built-ins plus the six
 * screener steps. Hosts compose this wherever a pipeline control
 * plane is built for screener work — one registry, every
 * residency (the same composition the workflow residency uses).
 */
export function createScreenerStepRegistry(deps: ScreenerStepDeps): JobStepRegistry {
  return registerScreenerSteps(createBuiltinStepRegistry(), deps);
}

/**
 * The raw J1 definition for one screen run: the six catalog
 * stages as a NESTED chain — feed is the root, every later stage
 * the single child of the stage before it (the chain idiom: a
 * stage's input is its parent stage's output). jobId =
 * command.jobId; processing.shards = the command's shard ids on
 * every node (units = shards on every node); the goal leg rides
 * the same six nodes with the goalScreen param.
 */
export function buildScreenerJobDefinition(command: WorkflowJobCommand): unknown {
  if (!command.jobId || !command.jobId.trim()) {
    throw new Error(
      "buildScreenerJobDefinition requires a non-empty command.jobId — refusing to invent a job id.",
    );
  }
  const shardIds = (command.shards ?? []).map((shard) => shard.shardId);
  const symbols = (command.shards ?? []).flatMap(
    (shard) => (shard.symbols ?? []) as NasdaqStockListing[],
  );
  const shardTable = (command.shards ?? []).map((shard) => ({
    shardId: shard.shardId,
    ...(shard.universe ? { universe: shard.universe } : {}),
    ...(shard.symbols ? { symbols: shard.symbols } : {}),
  }));
  const params: Record<string, unknown> = {
    userLogin: command.userLogin,
    trigger: command.trigger,
    ...(command.provider ? { provider: command.provider } : {}),
    ...(command.sector ? { sector: command.sector } : {}),
    ...(command.filters ? { filters: command.filters } : {}),
    ...(command.maxItems !== undefined ? { maxItems: command.maxItems } : {}),
    ...(command.maxSymbols !== undefined ? { maxSymbols: command.maxSymbols } : {}),
    ...(command.environment ? { environment: command.environment } : {}),
    ...(command.portfolioContext !== undefined ? { portfolioContext: command.portfolioContext } : {}),
    ...(command.broker ? { broker: command.broker } : {}),
    ...(command.mode ? { mode: command.mode } : {}),
    ...(command.modeSource ? { modeSource: command.modeSource } : {}),
    ...(command.traceparent ? { traceparent: command.traceparent } : {}),
    deliver: command.deliver === true,
    ...(command.goalScreen ? { goalScreen: command.goalScreen } : {}),
    symbols,
    shards: shardTable,
  };
  let node: JobNodeConfig | undefined;
  for (let i = SCREENER_NODE_KINDS.length - 1; i >= 0; i--) {
    const kind = SCREENER_NODE_KINDS[i];
    const next: JobNodeConfig = {
      kind,
      steps: [{ step: SCREENER_NODE_STEPS[kind], params }],
      processing: { shards: [...shardIds] },
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  const root = node!;
  root.executionMode = {
    concurrency: "sequential",
    pacing: "batch",
    delivery: "async",
    shape: shardIds.length > 1 ? "sharded" : "monolith",
  };
  return {
    jobId: command.jobId,
    name: `Screener — ${command.jobId}`,
    root,
  };
}

/**
 * Define a screener job on a control plane, skipping a stored
 * definition whose raw configuration already matches (the family
 * ensure idiom). Per-run job ids make re-definition rare (a
 * retried dispatch of the same command reuses its definition);
 * a changed command re-defines, versioned like any other job.
 */
export async function ensureScreenerJob(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  command: WorkflowJobCommand,
): Promise<string> {
  const raw = buildScreenerJobDefinition(command);
  const existing = await stores.definitions.getDefinition(command.jobId);
  if (existing && JSON.stringify(existing.rawConfig) === JSON.stringify(raw)) {
    return command.jobId;
  }
  await control.defineJob(raw);
  return command.jobId;
}

/** The orchestrator door for this residency (lazy: the binding is resolved per call, never at build). */
function orchestratorDoor(env: Env): OrchestratorAgent {
  if (!env.ORCHESTRATOR_AGENT) {
    throw new Error(
      "SCREENER_ORCHESTRATOR_UNBOUND: the screener store/deliver doors need the ORCHESTRATOR_AGENT binding — refusing an unwired door.",
    );
  }
  return actorGateway.stub<OrchestratorAgent>(
    env.ORCHESTRATOR_AGENT,
    SHARED_ORCHESTRATOR_INSTANCE,
  ) as unknown as OrchestratorAgent;
}

function screenerAgentStub(env: Env, userLogin: string): ScreenerAgentPort {
  if (!env.SCREENER_AGENT) {
    throw new Error(
      "SCREENER_AGENT_UNBOUND: the screener steps need the SCREENER_AGENT binding — refusing an unwired agent.",
    );
  }
  const id = env.SCREENER_AGENT.idFromName(resolveScreenerAgentName(env, userLogin));
  return env.SCREENER_AGENT.get(id) as unknown as ScreenerAgentPort;
}

/** The store door, mirroring screenerWorkflow.ts buildDeps (goal branch + market branch). */
function buildStoreDoor(env: Env): ScreenerStepDeps["storeReport"] {
  return async (payload, userLogin, opts) => {
    const orchestrator = orchestratorDoor(env);
    if (opts?.goalScreen) {
      return orchestrator.recordWorkflowGoalScreenReport(
        payload as WorkflowGoalScreenEnvelope,
        userLogin,
      );
    }
    await orchestrator.recordWorkflowScreenReport(payload as ScreenerRunResult);
  };
}

/** The deliver door, mirroring screenerWorkflow.ts buildDeps (goal seam + market outcome sink). */
function buildDeliverDoor(env: Env): ScreenerStepDeps["deliverOutcome"] {
  return async (payload, userLogin, opts) => {
    const orchestrator = orchestratorDoor(env);
    if (opts?.goalScreen) {
      await orchestrator.deliverWorkflowGoalScreenOutcome(
        payload as WorkflowGoalScreenEnvelope,
        userLogin,
        opts.goalScreen.deliver ?? [],
        opts.goalScreen.emailTo,
      );
      return;
    }
    const outcome = screenerOutcomeFromRunResult(
      "stock",
      payload as Record<string, unknown>,
      env.APP_BASE_URL,
    );
    await orchestrator.deliverWorkflowScreenOutcome(
      outcome,
      userLogin,
      opts?.deliveryId ?? `workflow:${(payload as { jobId?: string }).jobId ?? "unknown"}`,
    );
  };
}

/**
 * The screener-step wiring for the ScheduledAgent host — the
 * mirror of the host's feedStepDepsForScheduledAgent. The quote
 * / history deps are omitted here: the agent binds them itself
 * from the platform at stage time (bindScreenerQuoteDeps /
 * bindScreenerHistoryDeps, issue #4192). The store / deliver
 * doors are real (the orchestrator stub, lazy).
 */
export function screenerStepDepsForScheduledAgent(ctx: { env: Env }): ScreenerStepDeps {
  const env = ctx.env;
  return {
    agentFor: (userLogin) => screenerAgentStub(env, userLogin),
    storeReport: buildStoreDoor(env),
    deliverOutcome: buildDeliverDoor(env),
  };
}

/**
 * The screener-step wiring for the workflow residency — the
 * mirror of feedStepDepsForWorkflow. Same rule as the host
 * (the agent binds the quote/history deps at stage time,
 * #4192); same real doors.
 */
export function screenerStepDepsForWorkflow(env: Env): ScreenerStepDeps {
  return {
    agentFor: (userLogin) => screenerAgentStub(env, userLogin),
    storeReport: buildStoreDoor(env),
    deliverOutcome: buildDeliverDoor(env),
  };
}
