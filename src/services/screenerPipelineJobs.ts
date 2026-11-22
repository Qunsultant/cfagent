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
 * nested chain of five generic nodes for a market run — kinds
 * feed -> enrich -> analyze -> generate -> deliver, each 1:1
 * with a v2 catalog stage (#5884 6b3: the generic steps run
 * the chain; #5885 6c: the deliver node runs generic
 * deliver.apply with the screener marker). The goal leg rides its own
 * definition (#5873): the "goalScreen" spec, same six kinds,
 * the analyze node the goal dispatch (screener.goal) — a goal
 * run never executes as a market screen, #1996).
 * processing.shards = command shard ids; units = shards on
 * every node; artifacts hand off per (stage, shard).
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
import type { ScreenerRunOutcome } from "../services/screenerFollowups";
import type { AsyncJobChannel, Env, ScreenedStockItem, StageChainConfig, StockScreenResult } from "../types";
import type { JobPipelineStores, JobNodeConfig } from "../data/jobPipelinePorts";
import { normalizeJobRunTrigger } from "../data/jobRunRecordPorts";
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
import type { ScreeningResult, YahooHistoryDeps, DataProvider } from "../trading";
import {
  bindAlpacaQuoteDeps,
  bindEtradeQuoteDeps,
  bindPublicQuoteDeps,
  bindYahooScreenerDeps,
  bindYahooHistoryDeps,
} from "../trading";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import type { CircuitBreaker } from "../breakers/breakerPorts";
import type { FeedJobDefinition } from "./feedJobs";
import type { FeedStepDeps } from "./feedPipelineJobs";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import type {
  GoalScreenCommand,
  WorkflowJobCommand,
} from "../workflows/workflowPorts";
import type { StockScreenDelivery } from "../workflows/stockScreenRunSpec";
import type { WorkflowGoalScreenEnvelope } from "../agents/orchestrator/goalScreenDispatch";
import { SCREENER_DEFAULT_EXECUTION_MODE } from "../config/screenerExecutionMode";
import { jobDefinitionSpec } from "../config/jobDefinitionCatalog";
import { FEED_PIPELINE_CATALOG } from "./feedPipelineJobs";
import { DEFAULT_TENANT_PROVIDERS } from "../data/commercialPorts";
import {
  assembleGoalScreenResult,
  buildGoalScreenPlan,
  goalUniverseLabel,
  TERMINAL_TASK_STATUSES,
  type GoalDrivenScreenResult,
  type GoalLegOutcome,
  type GoalOptionsLegInput,
  type GoalScreenPlan,
  type GoalStockLegInput,
} from "./goalDrivenScreen";
import {
  evaluateScreenerOutcome,
  ScreenerTaskLedger,
  type ScreenerTask,
} from "./screenerTaskLedger";
import { createD1ScreenerTaskStore } from "../data/d1ScreenerTaskStoreAdapter";
import type { AnalyzedDatasetArtifact } from "../data/analyzedDatasetPorts";
import { createAnalyzedDatasetPorts } from "../data/createAnalyzedDatasetPorts";
import { defaultUniverseId } from "../config/defaultUniverse";
import type { GoalScreenArtifactOutcome } from "./goalScreenReports";

/** The step names a screener job's configuration references. */
export const SCREENER_FEED_STEP = "screener.feed";
export const SCREENER_GATHER_STEP = "screener.gather";
export const SCREENER_ANALYSIS_STEP = "screener.analysis";
/** The goal dispatch step: the analyze node of the "goalScreen" definition (#5873). */
export const SCREENER_GOAL_STEP = "screener.goal";
export const SCREENER_STORE_STEP = "screener.store";
export const SCREENER_SERVE_STEP = "screener.serve";
export const SCREENER_DELIVER_STEP = "screener.deliver";

/**
 * The goal composition's step names (#6072): the analyze node of the
 * "goalScreen" definition runs these eight steps in order, replacing
 * the single `screener.goal` dispatch (which stays registered for
 * old stored definitions — see SCREENER_GOAL_STEP above).
 */
export const GOAL_QUOTA_STEP = "goal.quota";
export const GOAL_PLAN_STEP = "goal.plan";
export const GOAL_LEDGER_CLAIM_STEP = "goal.ledgerClaim";
export const GOAL_STOCK_LEG_STEP = "goal.stockLeg";
export const GOAL_OPTIONS_LEG_STEP = "goal.optionsLeg";
export const GOAL_ASSEMBLE_STEP = "goal.assemble";
export const GOAL_LEDGER_COMPLETE_STEP = "goal.ledgerComplete";
export const GOAL_ARTIFACTS_STEP = "goal.artifacts";

/**
 * The goal-run composition, in run order (#6072): quota (the
 * submission gate, before any work) → plan (the pure scenario→plan
 * derivation) → ledger claim (the D1-resident ledger: terminal
 * record = duplicate, active record = adopt, fresh = create +
 * claim + start + heartbeat) → the two leg dispatches (each a
 * failed class on error, never a failed run) → assembly (the
 * #1963 / #462 contract) → ledger complete (complete, or
 * fail + escalate when every leg failed) → artifacts (the report
 * tail + the analysis output the store stage consumes).
 */
export const GOAL_COMPOSITION_STEPS = [
  GOAL_QUOTA_STEP,
  GOAL_PLAN_STEP,
  GOAL_LEDGER_CLAIM_STEP,
  GOAL_STOCK_LEG_STEP,
  GOAL_OPTIONS_LEG_STEP,
  GOAL_ASSEMBLE_STEP,
  GOAL_LEDGER_COMPLETE_STEP,
  GOAL_ARTIFACTS_STEP,
] as const;

/** The five generic node kinds, in catalog order (#5884 6b3 — the market spec's v2 stages). The "goalScreen" spec keeps its own six bespoke stages (feed/enrich/analyze/store/serve/deliver); these constants project the market spec only. */
export const SCREENER_NODE_KINDS = ["feed", "enrich", "analyze", "generate", "deliver"] as const;

/**
 * The step each node kind runs. Spelled as literals: the
 * canonical constants live in the family modules, and
 * importing them here would cycle (enrichPipelineJobs imports
 * registerScreenerSteps from this module). Drift fails loudly:
 * the #4365-P04 pin holds these equal to the catalog, and the
 * #5884 definition test holds the built nodes' steps equal to
 * the family constants (FEED_PULL_STEP, ENRICH_SCREENER_STEP,
 * ANALYZE_SCREENER_STEP, GENERATE_APPLY_STEP, DELIVER_APPLY_STEP).
 * Issue #5885 (6c): the deliver node runs generic deliver.apply,
 * not the bespoke screener.deliver step (which the goalScreen
 * spec still uses).
 */
export const SCREENER_NODE_STEPS: Record<(typeof SCREENER_NODE_KINDS)[number], string> = {
  feed: "feed.pull",
  enrich: "enrich.screener",
  analyze: "analyze.screener",
  generate: "generate.apply",
  deliver: "deliver.apply",
};

/**
 * The screener step deps, mirroring the family step deps
 * (FeedStepDeps et al.): the agent resolution, the bound quote /
 * history deps for one request, and the store / deliver doors.
 * The quote/history deps are resolved per request because the
 * provider is per-request (and the run context per-run).
 * Both are OPTIONAL in the interface so stage-scoped test
 * registries may omit them — but a host that omits them gets a
 * named refusal at execution, never an unwired fetch: the feed
 * stage refuses SCREENER_QUOTE_DEPS_MISSING and the gather stage
 * SCREENER_HISTORY_DEPS_MISSING (issue #5823 — the agent no
 * longer binds them itself from the platform at stage time;
 * #4192's fallback is gone on the engine path, and the bespoke
 * flow keeps its own bind until slice 7 retires it).
 */
export interface ScreenerStepDeps {
  /** The ScreenerAgent port for one owner login (a DO stub in production). */
  agentFor: (userLogin: string) => ScreenerAgentPort;
  /**
   * Issue #5823 — the bound quote deps for one screen request,
   * over the #3941 capture-wired provider (built by
   * createScreenerFeedDepsFactories from the feed deps). The run
   * id rides the capture context. Omitted = the feed stage
   * refuses SCREENER_QUOTE_DEPS_MISSING by name.
   */
  quoteDepsFor?: (req: ScreenerRunRequest, runId: string) => ScreenerQuoteDepsBundle;
  /**
   * Issue #5823 — the bound history deps for one screen request,
   * over the #3941 Yahoo provider (same factories). Omitted = the
   * gather stage refuses SCREENER_HISTORY_DEPS_MISSING by name.
   * The factory itself degrades an unwired history provider to
   * null-fetching deps (#1331's contract, preserved).
   */
  historyDepsFor?: (
    req: ScreenerRunRequest,
    runId: string,
  ) => YahooHistoryDeps | Promise<YahooHistoryDeps>;
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
    opts?: {
      goalScreen?: GoalScreenCommand;
      deliveryId?: string;
      /**
       * Issue #4280 ([One engine] #3550 S5): the per-request delivery
       * envelope + stage-chain config the deliver step carries from
       * the command params (market runs), the engine job id (the
       * chain id for chained runs), and the canonical report id the
       * serve stage verified (goal runs). The door overlays the
       * envelope + stageChain onto the run outcome and bridges
       * through it.
       */
      delivery?: StockScreenDelivery;
      stageChain?: StageChainConfig;
      chainId?: string;
      canonicalReportId?: string;
    },
  ) => Promise<void>;
  /**
   * The goal runner for the goal step (defaults to the agent's
   * engine method, runGoalScreenOnEngine, inside screenGoalStage).
   * Tests inject a fake; production never overrides it.
   */
  goalRunner?: ScreenerGoalRunner;
  /**
   * Issue #6072 — the goal composition's injected deps. Each is
   * optional; when absent the step resolves its production default
   * from the agent (quota / legs / artifacts) or refuses by name
   * (the D1 ledger — a goal run without a D1-resident ledger cannot
   * satisfy the eviction requirement, so there is no silent fallback
   * to the DO-storage ledger runGoalScreenOnEngine used).
   */
  goalTaskLedgerFor?: () => ScreenerTaskLedger;
  goalQuotaCharge?: (input: { userLogin: string; runId: string }) => Promise<void>;
  goalStockLeg?: (input: GoalStockLegInput) => Promise<ScreeningResult>;
  /**
   * Issue #6073 — the goal stock leg's analyzed-artifact reader:
   * the analyzed dataset the generic chain persisted for the
   * leg's analyze job. Absent = the leg refuses by name
   * (GOAL_STOCK_LEG_NO_ANALYZED_STORE), never a silent
   * fallthrough to the nested dispatch. Bound in the host
   * factories from createAnalyzedDatasetPorts(env).
   */
  goalStockLegAnalyzedFor?: (
    analyzeJobId: string,
  ) => Promise<AnalyzedDatasetArtifact | undefined>;
  goalOptionsLeg?: (input: GoalOptionsLegInput) => Promise<ScreeningResult>;
  goalArtifacts?: (result: GoalDrivenScreenResult) => Promise<GoalScreenArtifactOutcome>;
}

/**
 * Issue #5823 (#4437 slice 2) — the screener's feed-stage deps over
 * the #3941 capture-wired provider: the quote/history deps the step
 * handler binds per request, from the feed deps' registry +
 * providerFor (the SAME construction feed jobs run through —
 * `createCaptureWiredFeedProvider`, not a second fetch path).
 *
 * - The quotes job is resolved per request source from the feed
 *   registry (dataset "quotes"). Only its sourceId is consumed by
 *   the factory, so the job's universe is not load-bearing here —
 *   the provider fetches the request's own symbols either way;
 *   a source with no quotes job refuses by name, never another
 *   source's job (the #2144 no-silent-substitution rule).
 * - The provider is built per request with the RUN's login (the
 *   per-login providers fetch as the run's user, never the host's
 *   wiring login) and the Yahoo breaker (#1745) when supplied —
 *   the slice-1 gated binds (`bindYahooScreenerDeps` et al.) sit
 *   on top, so fresh capture serves with zero live calls and a
 *   miss fetches live once and writes through.
 * - History rides the same Yahoo provider through
 *   `bindYahooHistoryDeps` (the factory's Yahoo adapter exposes
 *   getHistoricalBars); an unwired history provider degrades to
 *   null-fetching deps, exactly as the agent's bind did (#1331).
 * - A missing leg for the planned provider is a named refusal
 *   (SCREENER_QUOTE_DEPS_MISSING), never a fallback.
 */
export function createScreenerFeedDepsFactories(
  feedDeps: FeedStepDeps,
  yahooBreaker?: CircuitBreaker,
): Pick<ScreenerStepDeps, "quoteDepsFor" | "historyDepsFor"> {
  /** The registered quotes job for a source — the factory's key. */
  function quotesJobForSource(sourceId: string): FeedJobDefinition {
    if (!feedDeps?.registry) {
      throw new Error(
        "SCREENER_QUOTE_DEPS_MISSING: the screener step deps were wired without feed deps — the feed stage reads through the #3941 capture-wired provider, so a host that cannot supply feed deps cannot serve a screen (#5823).",
      );
    }
    const def = feedDeps.registry
      .list()
      .find((job) => job.sourceId === sourceId && job.dataset === "quotes");
    if (!def) {
      throw new Error(
        `SCREENER_QUOTE_DEPS_MISSING: no quotes feed job is registered for source "${sourceId}" — the screener's feed stage reads through the #3941 capture-wired provider, so a source with no quotes job cannot serve a screen (#5823).`,
      );
    }
    return def;
  }

  /** The #3941 provider for a source, built for this run's login. */
  function providerForSource(sourceId: string, req: ScreenerRunRequest): DataProvider {
    // The job lookup runs first (and carries the no-feed-deps guard):
    // a callee-side `feedDeps.providerFor(...)` read would throw a
    // TypeError before the arguments — and the guard — are evaluated.
    const def = quotesJobForSource(sourceId);
    const provider = feedDeps.providerFor(def, {
      userLogin: req.userLogin,
      ...(yahooBreaker ? { yahooBreaker } : {}),
    });
    if (!provider) {
      throw new Error(
        `SCREENER_QUOTE_DEPS_MISSING: no capture-wired provider for source "${sourceId}" — the feed host cannot wire it for this run (#5823).`,
      );
    }
    return provider;
  }

  return {
    quoteDepsFor: (req, runId) => {
      const provider = req.provider;
      if (!provider) {
        throw new Error(
          "SCREENER_QUOTE_DEPS_MISSING: the screen request names no provider — the feed stage reads through the #3941 capture-wired provider, so a provider-less request cannot serve a screen (#5823).",
        );
      }
      const runContext = { runId, userLogin: req.userLogin };
      const source = providerForSource(provider, req);
      switch (provider) {
        case "yahoo":
          return { yahoo: bindYahooScreenerDeps(source, runContext) };
        case "etrade":
          return { etrade: bindEtradeQuoteDeps(source, runContext) };
        case "alpaca":
          return { alpaca: bindAlpacaQuoteDeps(source, runContext) };
        case "public":
          return { public: bindPublicQuoteDeps(source, runContext) };
        default:
          throw new Error(
            `SCREENER_QUOTE_DEPS_MISSING: provider "${provider}" has no screener quote bind — the feed stage reads through the #3941 capture-wired provider for yahoo / etrade / alpaca / public only (#5823).`,
          );
      }
    },
    historyDepsFor: async (req, runId) => {
      try {
        const source = providerForSource("yahoo", req);
        return bindYahooHistoryDeps(source, { runId, userLogin: req.userLogin });
      } catch {
        // Issue #1331: history resolution degrades to null-fetching
        // deps, so the batch still runs and every symbol gets honest
        // null technicals — the screen itself never fails on history
        // resolution. The persisted-first wrap below still applies.
        return { fetchBars: async () => null };
      }
    },
  };
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
    // Issue #5052: the dispatch trigger passes through the five modes
    // — a scheduler Run-now ("triggered") is never collapsed to
    // "manual"; anything unrecognized still reads as "manual".
    trigger: normalizeJobRunTrigger(params.trigger),
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
 * Issue #6072 — the goal composition's accumulated state: each step's
 * output is the next step's input, so the state threads the gather
 * output (the analyze node's input), the plan, the ledger task, the
 * leg outcomes, and the assembled result through to the artifacts
 * step, which builds the analysis output the store stage consumes.
 * Every field is JSON (the plan, the task record, the leg results),
 * so the state survives as per-step persisted artifacts — a resume
 * re-derives from them instead of re-executing.
 */
interface GoalCompositionState {
  gather: ScreenerGatherStageOutput;
  plan?: GoalScreenPlan;
  requested?: ("stocks" | "options")[];
  task?: ScreenerTask;
  executed?: boolean;
  stockLeg?: GoalLegStepOutput;
  optionsLeg?: GoalLegStepOutput;
  result?: GoalDrivenScreenResult;
}

/** One leg step's output: its ScreeningResult, its error, or skipped (class not requested). */
type GoalLegStepOutput = GoalLegOutcome | { legSkipped: true };

/**
 * The composition state a step's input carries: the accumulated state
 * (steps after the first), or the analyze node's raw gather output
 * (the first step wraps it). A scheduled duplicate passes through
 * unwrapped — the caller checks isDupOutput first.
 */
function goalCompositionState(
  input: unknown,
  shardKey: string | null,
): GoalCompositionState {
  const prior = priorFor<GoalCompositionState | ScreenerGatherStageOutput>(
    input,
    shardKey,
  );
  if (
    prior &&
    typeof prior === "object" &&
    "gather" in (prior as unknown as Record<string, unknown>)
  ) {
    return prior as GoalCompositionState;
  }
  return { gather: prior as ScreenerGatherStageOutput };
}

/** The goal command a composition step's params carry (refuses by name without one). */
function requireGoalScreen(params: Record<string, unknown>): GoalScreenCommand {
  const goalScreen = goalScreenParam(params);
  if (!goalScreen) {
    throw new Error(
      "GOAL_STEP_NO_GOAL: a goal composition step ran without a goalScreen param — refusing to run a goal dispatch with no goal command.",
    );
  }
  return goalScreen;
}

/** The D1-resident task ledger a composition step writes to (refuses by name without one). */
function requireGoalTaskLedger(deps: ScreenerStepDeps): ScreenerTaskLedger {
  if (!deps.goalTaskLedgerFor) {
    throw new Error(
      "GOAL_TASK_LEDGER_MISSING: the goal composition steps need a D1-resident task ledger (goalTaskLedgerFor) — a goal run without one cannot survive a workflow eviction, so there is no fallback to the DO-storage ledger (#6072).",
    );
  }
  return deps.goalTaskLedgerFor();
}

/** The hand-off quote fields the goal stock leg maps from (the enrich output's acquired.quotes). */
interface GoalStockLegQuote {
  symbol: string;
  lastPrice?: number;
  changePercent?: number;
  peRatio?: number;
  volume?: number;
  averageVolume?: number;
  open?: number;
  high?: number;
  low?: number;
  week52High?: number;
  week52Low?: number;
}

/**
 * Issue #6073 — the goal stock leg on the generic chain: the four
 * generic steps run in-process inside goal.stockLeg (function
 * calls on the captured registry, not nodes of the goal
 * definition — the composition state threads through the leg,
 * not through them, and the builder gives every step on a node
 * the same params, so per-step params cannot ride the analyze
 * node). The synthesized contexts carry the leg's own run
 * identity (same jobId/runId/trigger/runKind/now, the goal
 * run's shardKey — null, monolith) with the leg's kit from the
 * analyze node's params, WITHOUT `goalScreen` — the 6d refusal
 * guards the market chain, and these calls are the leg's own,
 * not a market run; the refusal is not triggered and not
 * weakened. The step names are literals, as in the externalized
 * catalog: their canonical constants are FEED_PULL_STEP
 * (feedPipelineJobs), ENRICH_SCREENER_STEP (enrichPipelineJobs),
 * ANALYZE_SCREENER_STEP (analyzePipelineJobs) and
 * GENERATE_APPLY_STEP (generatePipelineJobs) — imported
 * constants would cycle through enrichPipelineJobs, which
 * imports this module for registerScreenerSteps. The chain is
 * store-mediated (each step reads the previous step's persisted
 * dataset via latestUsable), so no input threading is needed
 * beyond the analyze hand-off, which consumes the enrich output
 * explicitly (its handOff branch).
 */
async function runGoalStockLegOnGenericNodes(args: {
  registry: JobStepRegistry;
  deps: ScreenerStepDeps;
  ctx: JobStepContext;
  params: Record<string, unknown>;
  plan: GoalScreenPlan;
}): Promise<ScreeningResult> {
  const { registry, deps, ctx, params, plan } = args;
  const readId = (key: string): string => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "" ? value : "";
  };
  const feedJobId = readId("feedJobId");
  const enrichJobId = readId("enrichJobId");
  const analyzeJobId = readId("analyzeJobId");
  const generateJobId = readId("generateJobId");
  if (!feedJobId || !enrichJobId || !analyzeJobId || !generateJobId) {
    throw new Error(
      "GOAL_STOCK_LEG_NO_FAMILY_IDS: the goal stock leg needs the family job ids the #6073 builder writes onto the analyze node — this definition predates them; re-define the job.",
    );
  }
  const stockLegAnalyzeParams = (params.stockLegAnalyzeParams ?? {}) as Record<
    string,
    unknown
  >;
  const stockLegGenerateParams = (params.stockLegGenerateParams ?? {}) as Record<
    string,
    unknown
  >;
  const stockLegUniverse =
    typeof params.stockLegUniverse === "string" &&
    params.stockLegUniverse.trim() !== ""
      ? params.stockLegUniverse.trim().toLowerCase()
      : undefined;
  // The 6d refusal reads goalScreen off the params; the leg's own
  // calls carry none (see above).
  const legParams = { ...params };
  delete legParams.goalScreen;
  const base = {
    jobId: ctx.jobId,
    runId: ctx.runId,
    nodePath: ctx.nodePath,
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [] as readonly unknown[],
    shardKey: ctx.shardKey,
    now: ctx.now,
    trigger: ctx.trigger,
    runKind: ctx.runKind,
  };
  const feed = await registry.resolve("feed.pull")({
    ...base,
    kind: "feed",
    params: {
      ...legParams,
      feedJobId,
      ...(stockLegUniverse ? { universe: stockLegUniverse } : {}),
    },
    input: undefined,
  });
  const enrich = await registry.resolve("enrich.screener")({
    ...base,
    kind: "enrich",
    params: { ...legParams, enrichJobId },
    input: feed.output,
  });
  const analyze = await registry.resolve("analyze.screener")({
    ...base,
    kind: "analyze",
    params: { ...legParams, analyzeJobId, ...stockLegAnalyzeParams },
    input: enrich.output,
  });
  await registry.resolve("generate.apply")({
    ...base,
    kind: "generate",
    params: {
      ...legParams,
      generateJobId,
      ...stockLegGenerateParams,
      filters: plan.stockFilter,
    },
    input: analyze.output,
  });
  if (!deps.goalStockLegAnalyzedFor) {
    throw new Error(
      "GOAL_STOCK_LEG_NO_ANALYZED_STORE: the goal stock leg needs the analyzed-dataset reader (goalStockLegAnalyzedFor) to map the generic chain's output — refusing a goal stock leg with nowhere to read the analyzed artifact (#6073).",
    );
  }
  const artifact = await deps.goalStockLegAnalyzedFor(analyzeJobId);
  if (!artifact) {
    throw new Error(
      `GOAL_STOCK_LEG_NO_ANALYZED_ARTIFACT: the generic chain ran but no usable analyzed artifact exists for analyze job "${analyzeJobId}" — refusing to map a leg result from nothing (#6073).`,
    );
  }
  const quotes = (enrich.output as { acquired?: { quotes?: unknown } } | undefined)
    ?.acquired?.quotes;
  return goalStockLegResultFromAnalyzed({
    artifact,
    quotes: Array.isArray(quotes) ? (quotes as GoalStockLegQuote[]) : [],
    plan,
    timestamp: ctx.now,
  });
}

/**
 * Issue #6073 — the goal stock leg's result, mapped from the
 * generic chain's analyzed artifact (pure: no stores, no
 * registry). Matched = the artifact's own standouts — the
 * family's list ("the generate stage reads this list rather
 * than re-deriving it", ≤ standoutMaxItems, default 5). Each
 * standout joins its analyzed row (lastPrice, `signals.screen`
 * → signal, `compositeScore` → momentumScore — the same
 * fallbacks `buildScreenerDeliveryPayload` uses) with its
 * hand-off quote (changePercent, peRatio?, volume?) into a
 * ScreenedStockItem with the same field semantics as
 * `scannedStockToScreenedItem` (price/open/high/low/
 * previousClose derived from lastPrice + changePercent;
 * companyName falls back to the symbol — the bespoke path's own
 * last resort; sector/rsi14 omitted — the chain computes
 * neither). The plan's stockFilter is NOT applied as a row
 * filter (verified: the nested leg doesn't apply it either —
 * analyze runs static thresholds, nothing consumes
 * `params.filters` in analyze; the filter rides as generate
 * criteria, as today). The #1963 status checks still apply
 * downstream in the assembly.
 */
export function goalStockLegResultFromAnalyzed(args: {
  artifact: AnalyzedDatasetArtifact;
  quotes: readonly GoalStockLegQuote[];
  plan: GoalScreenPlan;
  timestamp: string;
  providerId?: string;
}): ScreeningResult {
  const { artifact, quotes, plan, timestamp } = args;
  // The nested leg's provenance marker (runGoalStockLegViaWorkflow
  // falls back to it when no stocks provider is registered): the
  // goal result's hits carry it, so the engine leg keeps the same
  // provenance rather than inventing a new one.
  const providerId = args.providerId ?? "stock-screen-workflow";
  const quotesBySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));
  const rowsBySymbol = new Map(
    artifact.rows.map((r) => [r.symbol.toUpperCase(), r]),
  );
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const stocks: ScreenedStockItem[] = artifact.summary.standouts.map((standout) => {
    const row = rowsBySymbol.get(standout.symbol.toUpperCase());
    const quote = quotesBySymbol.get(standout.symbol.toUpperCase());
    const price = row?.lastPrice ?? num(quote?.lastPrice) ?? 0;
    const changePercent = num(quote?.changePercent) ?? 0;
    const previousClose =
      changePercent === -100 ? price : price / (1 + changePercent / 100);
    const rawSignal = row?.signals["screen"] ?? standout.signal;
    const signal =
      rawSignal === "BULLISH_MOMENTUM" ||
      rawSignal === "OVERSOLD_BOUNCE" ||
      rawSignal === "RANGE_BOUND" ||
      rawSignal === "OVERBOUGHT"
        ? rawSignal
        : "RANGE_BOUND";
    return {
      symbol: standout.symbol,
      companyName: standout.symbol,
      lastPrice: price,
      price,
      change: price - previousClose,
      changePercent,
      bid: price,
      ask: price,
      volume: num(quote?.volume) ?? 0,
      open: num(quote?.open) ?? price,
      high: num(quote?.high) ?? price,
      low: num(quote?.low) ?? price,
      previousClose,
      timestamp,
      ...(num(quote?.peRatio) != null ? { peRatio: num(quote?.peRatio) } : {}),
      ...(num(quote?.averageVolume) != null
        ? { averageVolume: num(quote?.averageVolume) }
        : {}),
      ...(num(quote?.week52High) != null
        ? { week52High: num(quote?.week52High) }
        : {}),
      ...(num(quote?.week52Low) != null
        ? { week52Low: num(quote?.week52Low) }
        : {}),
      macdSignal: "",
      signal,
      technicalSignal: "",
      momentumScore: row?.compositeScore ?? standout.momentumScore,
      highlightReason: "",
    };
  });
  const result: StockScreenResult = {
    totalScanned: artifact.summary.symbols,
    totalScreened: artifact.summary.symbols,
    matchedCount: stocks.length,
    filterApplied: plan.stockFilter,
    filterSummary: "",
    stocks,
    scannedAt: timestamp,
    status: stocks.length > 0 ? "matches_found" : "no_matches",
  };
  return { assetClass: "stocks", providerId, result };
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
      // Issue #5823: the quote deps arrive bound over the #3941
      // capture-wired provider (createScreenerFeedDepsFactories);
      // a goal run needs none (its quotes are the goal runner's
      // stock leg). Omitted = the stage refuses by name.
      ...(deps.quoteDepsFor ? { quoteDeps: goalScreen ? {} : deps.quoteDepsFor(req, ctx.runId) } : {}),
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
      // Issue #5823: the history deps arrive bound over the #3941
      // Yahoo provider (createScreenerFeedDepsFactories). Omitted
      // = the stage refuses by name.
      ...(deps.historyDepsFor ? { historyDeps: await deps.historyDepsFor(req, ctx.runId) } : {}),
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
    const output = await agent.screenAnalysisStage(ctx.runId, {
      request: req,
      gatherOutput: prior,
    });
    return { output };
  });

  registry.register(SCREENER_GOAL_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<ScreenerGatherStageOutput>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const agent = deps.agentFor(userLogin);
    const req = screenRequestFromParams(params, shardSymbolsFor(params, ctx.shardKey), ctx.shardKey);
    const goalScreen = goalScreenParam(params);
    if (!goalScreen) {
      throw new Error(
        "SCREENER_GOAL_STEP_NO_GOAL: the goal step ran without a goalScreen param — refusing to run a goal dispatch with no goal command.",
      );
    }
    const output = await agent.screenGoalStage(ctx.runId, {
      request: req,
      gatherOutput: prior,
      goalScreen,
      ...(deps.goalRunner ? { goalRunner: deps.goalRunner } : {}),
    });
    return { output };
  });

  /**
   * Issue #6072 — the goal composition: the eight steps that replace
   * the `screener.goal` dispatch on the goal definition's analyze
   * node. Each step threads the accumulated GoalCompositionState
   * (the first wraps the node's gather output); a scheduled
   * duplicate passes through every step untouched, exactly as
   * through the bespoke steps above.
   */
  registry.register(GOAL_QUOTA_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    requireGoalScreen(params);
    const agent = deps.agentFor(userLogin);
    // The quota run id is the engine run id, exactly as
    // runGoalScreenOnEngine charged it (`goalScreen:<runId>`) — a
    // duplicate delivery re-charges the same id, and the port
    // counts it once (#2842).
    const charge =
      deps.goalQuotaCharge ??
      ((input: { userLogin: string; runId: string }) =>
        agent.chargeGoalScreenQuota(input));
    await charge({ userLogin, runId: `goalScreen:${ctx.runId}` });
    return { output: goalCompositionState(ctx.input, ctx.shardKey) };
  });

  registry.register(GOAL_PLAN_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const goalScreen = requireGoalScreen(ctx.params);
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    // The symbols are the gather stage's goal symbols (resolved
    // from the goal command's explicit symbols, or the universe
    // path); the command's own symbols are the fallback for a
    // gather output that did not set them.
    const symbols = state.gather.goalSymbols?.length
      ? state.gather.goalSymbols
      : goalScreen.symbols;
    const plan = buildGoalScreenPlan(goalScreen.scenario, {
      ...(symbols?.length ? { symbols } : {}),
      ...(goalScreen.baseStockFilter
        ? { baseStockFilter: goalScreen.baseStockFilter }
        : {}),
      ...(goalScreen.baseOptionsFilter
        ? { baseOptionsFilter: goalScreen.baseOptionsFilter }
        : {}),
    });
    const requested = goalScreen.assetClasses ?? ["stocks", "options"];
    return { output: { ...state, plan, requested } };
  });

  registry.register(GOAL_LEDGER_CLAIM_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const goalScreen = requireGoalScreen(params);
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    const ledger = requireGoalTaskLedger(deps);
    // The run id IS the idempotency key, exactly as
    // runGoalDrivenScreenWithLedger keyed it — a re-entry of the
    // same run (pause + resume, workflow eviction replay, step
    // retry) finds its own record. The adoption is #5269 verbatim:
    // a TERMINAL record is a duplicate delivery (executed:false,
    // providers never re-invoked); an ACTIVE record is adopted
    // through the legal transitions; a fresh run is created,
    // claimed, started, and heartbeated.
    const idempotencyKey = ctx.runId;
    const existing = (await ledger.list(200)).find(
      (t) => t.idempotencyKey === idempotencyKey,
    );
    if (existing && TERMINAL_TASK_STATUSES.has(existing.status)) {
      return { output: { ...state, task: existing, executed: false } };
    }
    let task: ScreenerTask;
    if (existing) {
      task = existing;
      if (task.status === "queued") task = await ledger.claim(task.id);
      if (task.status === "claimed") task = await ledger.start(task.id);
      await ledger.heartbeat(task.id);
    } else {
      const created = await ledger.create({
        trigger: ctx.trigger,
        universe: goalUniverseLabel(goalScreen.scenario),
        sector: goalScreen.scenario.direction,
        userLogin,
        idempotencyKey,
      });
      if (!created.created) {
        return { output: { ...state, task: created.task, executed: false } };
      }
      task = created.task;
      await ledger.claim(task.id);
      await ledger.start(task.id);
      await ledger.heartbeat(task.id);
    }
    return { output: { ...state, task, executed: true } };
  });

  registry.register(GOAL_STOCK_LEG_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const goalScreen = requireGoalScreen(params);
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    if (state.executed === false) return { output: state };
    if (!state.plan) {
      throw new Error(
        "GOAL_LEG_NO_PLAN: the stock leg ran without a plan — the goal.plan step must run first.",
      );
    }
    if (!state.requested?.includes("stocks")) {
      return { output: { ...state, stockLeg: { legSkipped: true } } };
    }
    // Issue #6073 — the leg runs the generic chain in-process
    // (runGoalStockLegOnGenericNodes, above) and maps the
    // analyzed artifact's standouts. A test-injected
    // deps.goalStockLeg still wins (the 6072/5873 suites keep
    // injecting fakes, with the same input shape as before);
    // production never overrides it, so the nested dispatch
    // (runGoalStockLegViaWorkflow) never runs on the engine path.
    // A chain failure is a failed class (#462), never a failed run.
    let stockLeg: GoalLegStepOutput;
    try {
      const result = deps.goalStockLeg
        ? await deps.goalStockLeg({
            plan: state.plan,
            userLogin,
            trigger: ctx.trigger,
            idempotencyKey: ctx.runId,
            ...(params.environment
              ? { environment: params.environment as "TEST" | "PROD" }
              : {}),
            ...(goalScreen.provider ? { provider: goalScreen.provider } : {}),
          })
        : await runGoalStockLegOnGenericNodes({
            registry,
            deps,
            ctx,
            params,
            plan: state.plan,
          });
      stockLeg = { result };
    } catch (err) {
      // Issue #462: a failed leg is a failed class, never a failed
      // run — the throw is recorded as the leg's error outcome and
      // the assembly turns it into a partial result.
      stockLeg = { error: err instanceof Error ? err.message : String(err) };
    }
    return { output: { ...state, stockLeg } };
  });

  registry.register(GOAL_OPTIONS_LEG_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    requireGoalScreen(params);
    const agent = deps.agentFor(userLogin);
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    if (state.executed === false) return { output: state };
    if (!state.plan) {
      throw new Error(
        "GOAL_LEG_NO_PLAN: the options leg ran without a plan — the goal.plan step must run first.",
      );
    }
    if (!state.requested?.includes("options")) {
      return { output: { ...state, optionsLeg: { legSkipped: true } } };
    }
    const dispatch =
      deps.goalOptionsLeg ??
      ((input: GoalOptionsLegInput) => agent.runGoalOptionsLeg(input));
    let optionsLeg: GoalLegStepOutput;
    try {
      const result = await dispatch({
        plan: state.plan,
        userLogin,
        trigger: ctx.trigger,
        idempotencyKey: ctx.runId,
        ...(params.environment
          ? { environment: params.environment as "TEST" | "PROD" }
          : {}),
      });
      optionsLeg = { result };
    } catch (err) {
      // Issue #462: a failed leg is a failed class, never a failed run.
      optionsLeg = { error: err instanceof Error ? err.message : String(err) };
    }
    return { output: { ...state, optionsLeg } };
  });

  registry.register(GOAL_ASSEMBLE_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    if (state.executed === false) return { output: state };
    if (!state.plan || !state.requested) {
      throw new Error(
        "GOAL_ASSEMBLE_NO_PLAN: the assembly ran without a plan — the goal.plan step must run first.",
      );
    }
    const outcomes: Partial<Record<"stocks" | "options", GoalLegOutcome>> = {};
    for (const klass of state.requested) {
      const leg = klass === "stocks" ? state.stockLeg : state.optionsLeg;
      if (!leg || "legSkipped" in leg) {
        throw new Error(
          `GOAL_ASSEMBLE_NO_LEG: the assembly ran without the ${klass} leg's outcome — the goal.${klass}Leg step must run first.`,
        );
      }
      outcomes[klass] = leg;
    }
    const result = assembleGoalScreenResult({
      plan: state.plan,
      requested: state.requested,
      outcomes,
      now: new Date(ctx.now),
    });
    return { output: { ...state, result } };
  });

  registry.register(GOAL_LEDGER_COMPLETE_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    if (state.executed === false) return { output: state };
    if (!state.task || !state.result) {
      throw new Error(
        "GOAL_LEDGER_COMPLETE_NO_TASK: the ledger completion ran without a claimed task and an assembled result — the goal.ledgerClaim and goal.assemble steps must run first.",
      );
    }
    const ledger = requireGoalTaskLedger(deps);
    const result = state.result;
    let task: ScreenerTask;
    if (result.status === "failed") {
      // Issue #5269 verbatim: total failure is failed-then-escalated
      // (the ledger's human-visible terminal state).
      const reasons = result.partial
        ? Object.entries(result.partial.reasons)
            .map(([klass, reason]) => `${klass}: ${reason}`)
            .join("; ")
        : "all requested asset classes failed";
      await ledger.fail(state.task.id, reasons);
      task = await ledger.escalate(
        state.task.id,
        "goal-driven screen failed on every requested asset class; awaiting human review",
      );
    } else {
      const partial = result.status === "partial";
      const evaluation = evaluateScreenerOutcome(
        {
          success: true,
          runTimestamp: result.completedAt,
          totalScanned:
            result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
          matchedCount: result.counts.hits,
          opportunities: result.counts.hits,
          partial,
          qualificationPresent: partial ? result.partial !== undefined : false,
          error: null,
        },
        result.completedAt,
      );
      task = await ledger.complete(state.task.id, {
        runTimestamp: result.completedAt,
        totalScanned:
          result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
        matchedCount: result.counts.hits,
        opportunitiesCount: result.counts.hits,
        partial,
        evaluation,
      });
    }
    return { output: { ...state, task, executed: true } };
  });

  registry.register(GOAL_ARTIFACTS_STEP, async (ctx: JobStepContext) => {
    const prior = priorFor<unknown>(ctx.input, ctx.shardKey);
    if (isDupOutput(prior)) return { output: prior };
    const params = ctx.params;
    const userLogin = requireUserLogin(params);
    const goalScreen = requireGoalScreen(params);
    const agent = deps.agentFor(userLogin);
    const state = goalCompositionState(ctx.input, ctx.shardKey);
    const result = state.result ? { ...state.result } : undefined;
    if (result) {
      // The run's explicit data mode + provider ride the result
      // before artifact generation, exactly as runGoalScreenOnEngine
      // stamped them (the PDF provenance names the mode).
      if (goalScreen.yahooDataMode && !result.yahooDataMode) {
        result.yahooDataMode = goalScreen.yahooDataMode;
      }
      if (goalScreen.provider && !result.provider) {
        result.provider = goalScreen.provider;
      }
      const generate =
        deps.goalArtifacts ??
        ((r: GoalDrivenScreenResult) => agent.generateGoalScreenArtifacts(r));
      const artifacts = await generate(result);
      Object.assign(result, artifacts);
    }
    const gatherOutput = state.gather;
    // The analysis output the store stage consumes — the shape
    // screenGoalStage returned, verbatim (a duplicate delivery
    // carries no result, so the store stage records its refusal
    // by name, as the direct path did).
    return {
      output: {
        ...gatherOutput,
        screenResult: {
          totalScanned: result?.counts?.stocksScanned ?? 0,
          matchedCount: result?.counts?.stocksMatched ?? 0,
          filterSummary: undefined,
        },
        allStocks: [],
        opportunities: [],
        sentimentCoverage: { symbols: 0, withSentiment: 0 },
        goalTask: state.task,
        goalExecuted: state.executed ?? false,
        ...(result ? { goalResult: result } : {}),
      } as ScreenerAnalysisStageOutput,
    };
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
      ...(params.delivery && typeof params.delivery === "object"
        ? { delivery: params.delivery as StockScreenDelivery }
        : {}),
      ...(params.stageChain && typeof params.stageChain === "object"
        ? { stageChain: params.stageChain as StageChainConfig }
        : {}),
      chainId: ctx.jobId,
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
 * Issue #6073 — the goal stock leg's symbol resolution (owner
 * rule 2026-11-22: there is NEVER a symbol-less run, for ANY
 * run). Explicit `goalScreen.symbols` (normalized: uppercase /
 * trim / dedupe, mirroring `explicitSymbolsFor`) win; else the
 * ONE shared externalized default (the #5515 default universe,
 * read through its one reader `defaultUniverseId` — never a
 * leg-local literal) as a universe; else a named refusal
 * (`GOAL_STOCK_LEG_NO_SYMBOLS`) at definition-build time, before
 * any work — never silent nothing, never a silent fallthrough
 * to ALL. The fallback is injectable so the refusal is testable
 * without touching the shared config.
 */
export function resolveGoalStockLegSymbols(
  command: WorkflowJobCommand,
  fallbackUniverse?: string,
): { symbols: string[] } | { universe: string } {
  const explicit = (command.goalScreen?.symbols ?? [])
    .map((s) => (typeof s === "string" ? s.toUpperCase().trim() : ""))
    .filter((s) => s.length > 0)
    .filter((s, i, arr) => arr.indexOf(s) === i);
  if (explicit.length > 0) return { symbols: explicit };
  let fallback = "";
  try {
    fallback = (fallbackUniverse ?? defaultUniverseId()).trim().toLowerCase();
  } catch {
    fallback = "";
  }
  if (fallback.length > 0) return { universe: fallback };
  throw new Error(
    "GOAL_STOCK_LEG_NO_SYMBOLS: the goal stock leg has no explicit symbols and the shared default universe did not resolve — refusing a symbol-less run (#6073; owner rule 2026-11-22: never a symbol-less run, for ANY run).",
  );
}

/**
 * Issue #5884 (#4437 slice 6b3 — the flip): the family job ids
 * for one market run, computed per command. The generic steps
 * are job-driven and the job id depends on the run's provider —
 * a static spec literal would pin one provider for every run
 * (a broker substitution, forbidden by #5517). Provider =
 * `command.provider ?? DEFAULT_TENANT_PROVIDERS.dataProviderId`
 * (the #5517 default — since #5516 it reads through to the
 * one externalized vocabulary block, not a second default
 * table); the feed job is the provider's
 * canonical quotes job, validated against FEED_PIPELINE_CATALOG
 * (acyclic: feedPipelineJobs imports no screener module); the
 * chain derives by the family lineage (`<feed>-enrich` →
 * `<feed>-enrich-analyze` → `<feed>-enrich-analyze-generate`),
 * the same derivation the enrich/analyze/generate catalogs
 * use. An unknown provider refuses by name — a job id is never
 * invented.
 */
export function screenerFamilyJobIds(command: WorkflowJobCommand): {
  feedJobId: string;
  enrichJobId: string;
  analyzeJobId: string;
  generateJobId: string;
} {
  // Issue #6073 — a goal command's provider lives at
  // goalScreen.provider (what the nested leg passed through as
  // the leg provider; typed to the single provider id the goal
  // command allows, #4436); the top-level provider, when a caller
  // set one, wins, as on the market path; else the tenant default.
  // Market commands carry no goalScreen, so this changes nothing
  // for them.
  const provider =
    command.provider ??
    command.goalScreen?.provider ??
    DEFAULT_TENANT_PROVIDERS.dataProviderId;
  const feedJobId = `${provider}-nasdaq100-quotes`;
  const entry = FEED_PIPELINE_CATALOG.find(
    (e) => e.jobId === feedJobId && e.dataset === "quotes",
  );
  if (!entry) {
    throw new Error(
      `SCREENER_FEED_JOB_UNKNOWN: no quotes feed job "${feedJobId}" for provider "${provider}" — refusing to invent a feed job id.`,
    );
  }
  return {
    feedJobId,
    enrichJobId: `${feedJobId}-enrich`,
    analyzeJobId: `${feedJobId}-enrich-analyze`,
    generateJobId: `${feedJobId}-enrich-analyze-generate`,
  };
}

/**
 * Issue #5884 — the feed node's universe param: the run's
 * single universe when every shard that names one agrees on
 * it; absent otherwise, so per-shard universes govern per unit
 * (6b1) and no node-level universe can override them.
 * Explicit-symbols shards name no universe.
 */
function screenerFeedNodeUniverse(command: WorkflowJobCommand): string | undefined {
  const universes = new Set(
    (command.shards ?? [])
      .map((shard) => shard.universe)
      .filter((u): u is string => typeof u === "string" && u.trim() !== ""),
  );
  return universes.size === 1 ? [...universes][0] : undefined;
}

/**
 * The raw J1 definition for one screen run: the five generic
 * nodes as a NESTED chain — feed is the root, every later stage
 * the single child of the stage before it (the chain idiom: a
 * stage's input is its parent stage's output). jobId =
 * command.jobId; processing.shards = the command's shard ids on
 * every node (units = shards on every node); a goal command
 * builds the "goalScreen" spec — the goal leg's own definition
 * (#5873), same six kinds, the analyze node the goal dispatch.
 */
export function buildScreenerJobDefinition(command: WorkflowJobCommand): unknown {
  if (!command.jobId || !command.jobId.trim()) {
    throw new Error(
      "buildScreenerJobDefinition requires a non-empty command.jobId — refusing to invent a job id.",
    );
  }
  const shardIds = (command.shards ?? []).map((shard) => shard.shardId);
  // Issue #6073 — the goal stock leg resolves its symbols at build
  // time (explicit → the ONE shared externalized default → named
  // refusal); only when stocks are requested — an options-only goal
  // run has no stock leg to resolve for. The resolved explicit
  // symbols ride the goal shard's row and the flat list (the goal
  // run is monolith, so feed.pull reads the flat list); the row is
  // the honest record, the flat list the fetch set. Production
  // goal commands carry no shard-row symbols
  // (buildGoalScreenCommand puts them only on goalScreen.symbols),
  // so the builder is the place that puts them on the row — as
  // the resolved bare strings, never invented listing objects
  // (no company name or exchange is known for them; the only
  // reader that matters, explicitSymbolsFor, accepts both shapes,
  // and the bespoke feed/gather stages ignore the flat list on
  // goal runs — they read goalScreen.symbols). A row that already
  // carries a symbol (as a listing, as tests build it) is not
  // duplicated.
  const goalStocksRequested =
    !command.goalScreen ||
    (command.goalScreen.assetClasses ?? ["stocks", "options"]).includes("stocks");
  const goalSymbols =
    command.goalScreen && goalStocksRequested
      ? resolveGoalStockLegSymbols(command)
      : null;
  const shardTable = (command.shards ?? []).map((shard) => {
    const row: {
      shardId: string;
      universe?: string;
      symbols?: unknown[];
    } = {
      shardId: shard.shardId,
      ...(shard.universe ? { universe: shard.universe } : {}),
      ...(shard.symbols ? { symbols: [...shard.symbols] } : {}),
    };
    if (goalSymbols && "symbols" in goalSymbols && shard.shardId === "goal") {
      const have = new Set(
        ((shard.symbols ?? []) as unknown[])
          .map((s) =>
            typeof s === "string"
              ? s.toUpperCase().trim()
              : s !== null &&
                  typeof s === "object" &&
                  typeof (s as { symbol?: unknown }).symbol === "string"
                ? String((s as { symbol: unknown }).symbol)
                    .toUpperCase()
                    .trim()
                : "",
          )
          .filter((s) => s.length > 0),
      );
      const missing = goalSymbols.symbols.filter((s) => !have.has(s));
      if (missing.length > 0) row.symbols = [...(row.symbols ?? []), ...missing];
    }
    return row;
  });
  const symbols = shardTable.flatMap(
    (row) => (row.symbols ?? []) as NasdaqStockListing[],
  );
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
    ...(command.delivery && Object.keys(command.delivery).length > 0
      ? { delivery: command.delivery }
      : {}),
    ...(command.stageChain !== undefined ? { stageChain: command.stageChain } : {}),
    ...(command.goalScreen ? { goalScreen: command.goalScreen } : {}),
    symbols,
    shards: shardTable,
  };
  // Issue #4365 — the stage list comes from the externalized definition
  // spec, not from a literal in this builder. The typed constants below
  // are its projection (a parity pin holds them equal). Issue #5873 —
  // a goal command builds the "goalScreen" spec (analyze node
  // screener.goal); a market command builds the "screener" spec.
  // Issue #5884 — the generic steps are job-driven: the definition's
  // nodes carry their family job id (computed per command above);
  // the market feed node also carries the run's single universe
  // when the shards agree on one. Issue #6073 — the goal
  // definition's nodes carry the family ids too (the goal stock
  // leg runs the generic chain): the feed node carries the
  // resolved default universe when the leg runs universe-fed,
  // and the analyze node carries the leg's whole kit (the four
  // family ids + the market spec's analyze/generate stage params,
  // read at build time — single home, no duplicated literal).
  const spec = jobDefinitionSpec(command.goalScreen ? "goalScreen" : "screener");
  const familyIds = screenerFamilyJobIds(command);
  const feedUniverse = command.goalScreen
    ? goalSymbols && "universe" in goalSymbols
      ? goalSymbols.universe
      : undefined
    : screenerFeedNodeUniverse(command);
  const marketSpec = command.goalScreen ? jobDefinitionSpec("screener") : undefined;
  const stockLegAnalyzeParams =
    marketSpec?.stages.find((s) => s.kind === "analyze")?.params ?? {};
  const stockLegGenerateParams =
    marketSpec?.stages.find((s) => s.kind === "generate")?.params ?? {};
  const jobIdParams: Record<string, Record<string, unknown>> = {
    feed: {
      feedJobId: familyIds.feedJobId,
      ...(feedUniverse ? { universe: feedUniverse } : {}),
    },
    enrich: { enrichJobId: familyIds.enrichJobId },
    analyze: {
      analyzeJobId: familyIds.analyzeJobId,
      ...(command.goalScreen
        ? {
            feedJobId: familyIds.feedJobId,
            enrichJobId: familyIds.enrichJobId,
            generateJobId: familyIds.generateJobId,
            stockLegAnalyzeParams,
            stockLegGenerateParams,
            // Issue #6073 — the leg's working copy of the resolved
            // universe: the leg runs on the analyze node, so the
            // feed node's universe param (above) is not in its
            // params — the kit carries it, frozen at build time
            // exactly as the market feed node's universe is.
            ...(goalSymbols && "universe" in goalSymbols
              ? { stockLegUniverse: goalSymbols.universe }
              : {}),
          }
        : {}),
    },
    generate: { generateJobId: familyIds.generateJobId },
  };
  let node: JobNodeConfig | undefined;
  for (let i = spec.stages.length - 1; i >= 0; i--) {
    const stageSpec = spec.stages[i];
    const kind = stageSpec.kind;
    // Issue #6072 — a stage may declare several steps (the
    // goalScreen analyze stage's composition); a single-step stage
    // keeps its `step`. Every step on the node carries the same params.
    const stepNames = stageSpec.steps ?? [stageSpec.step];
    const next: JobNodeConfig = {
      kind,
      steps: stepNames.map((name) => ({
        step: name,
        params: { ...params, ...(jobIdParams[kind] ?? {}), ...(stageSpec.params ?? {}) },
      })),
      processing: { shards: [...shardIds] },
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  const root = node!;
  // Issue #4363 — the execution mode is a run parameter: the caller's
  // choice when one was made, else the family default from configuration
  // (never a second hard-coded literal). `shape` follows the shard count
  // unless the caller chose one.
  const requestedMode = command.executionMode;
  root.executionMode = {
    concurrency: requestedMode?.concurrency ?? SCREENER_DEFAULT_EXECUTION_MODE.concurrency,
    pacing: requestedMode?.pacing ?? SCREENER_DEFAULT_EXECUTION_MODE.pacing,
    delivery: requestedMode?.delivery ?? SCREENER_DEFAULT_EXECUTION_MODE.delivery,
    shape: requestedMode?.shape ?? (shardIds.length > 1 ? "sharded" : "monolith"),
  };
  return {
    jobId: command.jobId,
    name: `${command.goalScreen ? "Goal screen" : "Screener"} — ${command.jobId}`,
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

/**
 * Issue #4280 ([One engine] #3550 S5) — overlay the per-request delivery
 * envelope + stage-chain config onto a run outcome. Pure: the envelope
 * lands only where the outcome lacks the field (a payload-stamped value
 * wins — it reflects a stored explicit selection). The channel allowlist
 * is explicit-only: slack rides when the caller asked for it
 * (`pushToSlack === true` or a named `slackChannel`) — the door never
 * invents a Slack delivery. The scheduled caller applies the chain's
 * default-on (`pushToSlack !== false`) when it builds the envelope, so
 * scheduled runs keep the chain's Slack-by-default. Exported for tests.
 */
export function overlayEngineDelivery(
  outcome: ScreenerRunOutcome,
  delivery: StockScreenDelivery | undefined,
  stageChain: StageChainConfig | undefined,
): ScreenerRunOutcome {
  if (!delivery && !stageChain) return outcome;
  const channels: AsyncJobChannel[] = [];
  if (delivery?.emailTo) channels.push("email");
  if (delivery && (delivery.pushToSlack === true || delivery.slackChannel !== undefined)) {
    channels.push("slack");
  }
  if (delivery?.webhookUrl) channels.push("webhook");
  return {
    ...outcome,
    ...(delivery?.emailTo && !outcome.emailTo ? { emailTo: delivery.emailTo } : {}),
    ...(delivery?.slackChannel && !outcome.slackChannel
      ? { slackChannel: delivery.slackChannel }
      : {}),
    ...(delivery?.webhookUrl && !outcome.webhookUrl ? { webhookUrl: delivery.webhookUrl } : {}),
    ...(channels.length > 0 && !outcome.deliveryChannels
      ? { deliveryChannels: channels }
      : {}),
    ...(stageChain ? { stageChain } : {}),
  };
}

/**
 * Issue #5885 (#4437 slice 6c) — the market-outcome
 * construction, extracted pure so it is unit-testable without
 * the orchestrator door: the payload → outcome conversion
 * (screenerOutcomeFromRunResult, unchanged) plus the canonical
 * report id stamp. The stamp fires ONLY for payloads that
 * carry the field — the generic generate output (the converter
 * builds it in) — never for a bespoke ScreenerRunResult, which
 * has no such field, so the bespoke path is unchanged and a
 * bespoke market run with PDFs still takes the PDF-adoption
 * branch downstream (the C4 canonical branch sits after the
 * pdf-failed branch and before the no-keys branch in
 * asyncJobs.ts; stamping from opts.canonicalReportId instead
 * would have diverted those runs). Without the stamp a generic
 * delivery is dead on arrival: no pdfKeys and no canonical id
 * hits "no artifact" → FAILURE_REPORT_ARTIFACT_MISSING.
 */
export function buildScreenerMarketOutcome(
  payload: Record<string, unknown>,
  appBaseUrl: string | undefined,
): ScreenerRunOutcome {
  const outcome = screenerOutcomeFromRunResult("stock", payload, appBaseUrl);
  return typeof payload.canonicalReportId === "string" && payload.canonicalReportId
    ? { ...outcome, canonicalReportId: payload.canonicalReportId }
    : outcome;
}

/** The deliver door, mirroring screenerWorkflow.ts buildDeps (goal seam + market outcome sink). */
export function buildDeliverDoor(env: Env): ScreenerStepDeps["deliverOutcome"] {
  return async (payload, userLogin, opts) => {
    const orchestrator = orchestratorDoor(env);
    if (opts?.goalScreen) {
      // Issue #4280 ([One engine] #3550 S5): a chain-mode goal run
      // bridges generate + serve through the follow-up bridge (the
      // direct bridge's semantics, carried into the workflow's
      // deliver stage) instead of delivering directly: the outcome
      // carries the stage chain, the per-task recipients, and the
      // delivery-channel allowlist, so the bridge serves with
      // serveDelaySeconds and delivers with deliverDelaySeconds,
      // exactly once. Unchained goal runs deliver directly, as before.
      if (opts.goalScreen.stageChain) {
        const envelope = payload as WorkflowGoalScreenEnvelope;
        const result = envelope.result;
        const goalOutcome: ScreenerRunOutcome = {
          kind: "goal",
          trigger: envelope.trigger === "scheduled" ? "scheduled" : "manual",
          success: true,
          pdfKeys: [],
          thesis: `Goal screen — ${result.goalKind}`,
          matchedCount: result.counts.hits,
          totalScanned:
            (result.counts.stocksScanned ?? 0) + (result.counts.optionsUnderlyingsScanned ?? 0),
          deliverViaChain: true,
          ...(opts.canonicalReportId ? { canonicalReportId: opts.canonicalReportId } : {}),
          ...(opts.goalScreen.emailTo ? { emailTo: opts.goalScreen.emailTo } : {}),
          ...(opts.goalScreen.slackChannel ? { slackChannel: opts.goalScreen.slackChannel } : {}),
          ...(opts.goalScreen.deliver && opts.goalScreen.deliver.length > 0
            ? {
                deliveryChannels: opts.goalScreen.deliver.filter(
                  (c): c is AsyncJobChannel => c === "slack" || c === "email" || c === "webhook",
                ),
              }
            : {}),
          stageChain: opts.goalScreen.stageChain,
          ...(opts.goalScreen.yahooDataMode
            ? { yahooDataMode: opts.goalScreen.yahooDataMode }
            : {}),
        };
        await orchestrator.deliverWorkflowScreenOutcome(
          goalOutcome,
          userLogin,
          opts?.deliveryId ?? `workflow:${(payload as { jobId?: string }).jobId ?? "unknown"}`,
          opts?.chainId,
        );
        return;
      }
      await orchestrator.deliverWorkflowGoalScreenOutcome(
        payload as WorkflowGoalScreenEnvelope,
        userLogin,
        opts.goalScreen.deliver ?? [],
        opts.goalScreen.emailTo,
      );
      return;
    }
    const outcome = overlayEngineDelivery(
      buildScreenerMarketOutcome(payload as Record<string, unknown>, env.APP_BASE_URL),
      opts?.delivery,
      opts?.stageChain,
    );
    await orchestrator.deliverWorkflowScreenOutcome(
      outcome,
      userLogin,
      opts?.deliveryId ?? `workflow:${(payload as { jobId?: string }).jobId ?? "unknown"}`,
      opts?.chainId,
    );
  };
}

/**
 * The screener-step wiring for the ScheduledAgent host — the
 * mirror of the host's feedStepDepsForScheduledAgent. Issue
 * #5823: the quote / history deps are bound here, over the
 * #3941 capture-wired provider from the feed deps
 * (createScreenerFeedDepsFactories, with the Yahoo breaker
 * #1745) — the agent no longer binds them at stage time. The
 * store / deliver doors are real (the orchestrator stub, lazy).
 */
export function screenerStepDepsForScheduledAgent(
  ctx: { env: Env },
  feedDeps: FeedStepDeps,
): ScreenerStepDeps {
  const env = ctx.env;
  return {
    agentFor: (userLogin) => screenerAgentStub(env, userLogin),
    ...createScreenerFeedDepsFactories(
      feedDeps,
      defaultBreakerRegistry().breakerFor("yahoo"),
    ),
    storeReport: buildStoreDoor(env),
    deliverOutcome: buildDeliverDoor(env),
    // Issue #6072 — the goal composition's ledger is D1-resident
    // (env.AGENT_DB, the same binding the run ledger reads), so a
    // goal run's ledger survives a workflow eviction. Unbound in
    // this residency = a named refusal at claim time, never a
    // silent fallback to the DO-storage ledger.
    goalTaskLedgerFor: () => {
      if (!env.AGENT_DB) {
        throw new Error(
          "GOAL_TASK_LEDGER_NO_D1: the goal composition steps need the AGENT_DB binding for the D1-resident task ledger — refusing a goal run with no D1 ledger (#6072).",
        );
      }
      return new ScreenerTaskLedger(createD1ScreenerTaskStore(env.AGENT_DB));
    },
    // Issue #6073 — the goal stock leg's analyzed-artifact
    // reader: the analyzed-dataset store for this residency (the
    // same construction the analyze deps use). No AGENT_DB binding
    // = the leg's named refusal (GOAL_STOCK_LEG_NO_ANALYZED_STORE)
    // at leg time, never a silent fallback to the nested dispatch.
    goalStockLegAnalyzedFor: async (analyzeJobId: string) => {
      const store = createAnalyzedDatasetPorts(env);
      if (!store) {
        throw new Error(
          "GOAL_STOCK_LEG_NO_ANALYZED_STORE: the goal stock leg needs the analyzed-dataset store (env.AGENT_DB) to map the generic chain's output — refusing a goal stock leg with nowhere to read the analyzed artifact (#6073).",
        );
      }
      return store.latestUsable(analyzeJobId);
    },
  };
}

/**
 * The screener-step wiring for the workflow residency — the
 * mirror of feedStepDepsForWorkflow. Same rule as the host
 * (#5823): the quote / history deps are bound over the #3941
 * provider from the feed deps; same real doors.
 */
export function screenerStepDepsForWorkflow(env: Env, feedDeps: FeedStepDeps): ScreenerStepDeps {
  return {
    agentFor: (userLogin) => screenerAgentStub(env, userLogin),
    ...createScreenerFeedDepsFactories(
      feedDeps,
      defaultBreakerRegistry().breakerFor("yahoo"),
    ),
    storeReport: buildStoreDoor(env),
    deliverOutcome: buildDeliverDoor(env),
    // Issue #6072 — the goal composition's ledger is D1-resident
    // (env.AGENT_DB, the same binding the run ledger reads); unbound
    // = a named refusal at claim time, never a silent fallback.
    goalTaskLedgerFor: () => {
      if (!env.AGENT_DB) {
        throw new Error(
          "GOAL_TASK_LEDGER_NO_D1: the goal composition steps need the AGENT_DB binding for the D1-resident task ledger — refusing a goal run with no D1 ledger (#6072).",
        );
      }
      return new ScreenerTaskLedger(createD1ScreenerTaskStore(env.AGENT_DB));
    },
    // Issue #6073 — the goal stock leg's analyzed-artifact
    // reader: the analyzed-dataset store for this residency (the
    // same construction the analyze deps use). No AGENT_DB binding
    // = the leg's named refusal (GOAL_STOCK_LEG_NO_ANALYZED_STORE)
    // at leg time, never a silent fallback to the nested dispatch.
    goalStockLegAnalyzedFor: async (analyzeJobId: string) => {
      const store = createAnalyzedDatasetPorts(env);
      if (!store) {
        throw new Error(
          "GOAL_STOCK_LEG_NO_ANALYZED_STORE: the goal stock leg needs the analyzed-dataset store (env.AGENT_DB) to map the generic chain's output — refusing a goal stock leg with nowhere to read the analyzed artifact (#6073).",
        );
      }
      return store.latestUsable(analyzeJobId);
    },
  };
}
