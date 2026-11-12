/**
 * Panel pipeline (#1151 / #1256 remainder) — the ONE server pipeline
 * behind the options discovery panel, NLQ, and scheduled discovery.
 *
 * History: C4 (#1329) turned the OptionsAgentPipeline class into a
 * thin delegating adapter over the Recommendation Kernel facade
 * (RecommendationService.discoverPanel) and proved probe parity. The
 * #1256 remainder retires the class itself: its constructor + run()
 * move here VERBATIM as runPanelPipeline / runPanelWithAgents —
 * (the former was retired by rename to runPanelPipelineRetired4068
 * under #4068; its successor is runOptionsPanelViaEngine, the
 * engine-routed panel).
 * same kernel call, same mapping back to PipelineResult (snapshot
 * reconstructed from the kernel snapshot; strategies IS the engine
 * build result the kernel wrapped, full built set with scoreWeights
 * included — the /compare pool counts generated, not gate-survived;
 * ranked / riskReports / bestTrade computed via the same agents over
 * the kernel-passed candidates). No behavior change, so C4 probe
 * parity still holds — see tests/consolidation_c4_kernel_parity.test.ts.
 *
 * Sites that need direct agent access (the no-view scheduled path,
 * which loads a snapshot and builds no-view strategies without a
 * panel run) construct the agents struct once and pass it to both
 * runPanelWithAgents and the agent methods — exactly the fields the
 * retired class exposed as public readonly members.
 */
import type { DynamicOptionsScreener } from "../optionsScreener";
import { OptionsDataAgent, type OptionsDataSnapshot } from "./optionsDataAgent";
import { StrategyRiskAgent, type StrategyScreenFilter, type StrategyRiskReport } from "./strategyRiskAgent";
import { RecommendationAgent, type BestTradePick, type RankedStrategy, type RiskProfile } from "./recommendationAgent";
import type { StrategyRecommendationResult, StrategyRequest } from "./strategyEngine";
import { RecommendationService } from "../../services/recommendationKernel";

/**
 * Options for a panel pipeline run: strategy filtering, risk
 * profile, and how many best-trade alternatives to return. The
 * panel route defaults (balanced profile, 3 alternatives) live here
 * so every surface shares them; callers that pass nothing get the
 * same defaults the interactive route has always used.
 */
export interface PipelineOptions {
  strategyFilter?: StrategyScreenFilter;
  riskProfile?: RiskProfile;
  alternatives?: number;
  /** Consolidation #1236 (feed seam): a stored snapshot to run on
   *  instead of live-loading. The pipeline downstream (gates,
   *  pricing, ranking, falsification) is unchanged — only the
   *  snapshot's source differs, so a snapshot-fed run is judged
   *  exactly like a live run on the same bytes. */
  snapshotOverride?: OptionsDataSnapshot;
}

export interface PipelineResult {
  snapshot: OptionsDataSnapshot;
  strategies: StrategyRecommendationResult;
  screenedOut: Array<{ id: string; reason: string }>;
  ranked: RankedStrategy[];
  riskReports: StrategyRiskReport[];
  bestTrade: BestTradePick;
}

/** The three agents a panel run is composed of (formerly the retired class's public fields). */
export interface PanelAgents {
  data: OptionsDataAgent;
  risk: StrategyRiskAgent;
  recommender: RecommendationAgent;
}

/**
 * Run the panel pipeline with caller-owned agents. This IS the
 * retired adapter's run() body, moved verbatim.
 */
export async function runPanelWithAgents(
  agents: PanelAgents,
  request: StrategyRequest,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const panel = await new RecommendationService().discoverPanel({
    dataAgent: {
      loadSnapshot: async (params: unknown) => {
        const s = options.snapshotOverride ?? await agents.data.loadSnapshot(params as StrategyRequest);
        return {
          symbol: s.symbol,
          contracts: s.contracts,
          dataSource: s.dataSource,
          screen: s.screen,
          rejections: s.rejections,
          validationError: s.validationError,
        };
      },
    },
    riskAgent: agents.risk,
    recommender: agents.recommender,
    request,
    strategyFilter: options.strategyFilter,
    riskProfile: options.riskProfile,
    alternatives: options.alternatives,
  });
  const buildResult = panel.legacy?.buildResult;
  if (!buildResult) {
    throw new Error("Panel pipeline produced no engine build result.");
  }
  const snapshot: OptionsDataSnapshot = {
    symbol: panel.snapshot.symbol,
    contracts: panel.snapshot.contracts ?? [],
    dataSource: panel.snapshot.dataSource,
    screen: panel.snapshot.screen as OptionsDataSnapshot["screen"],
    rejections: panel.snapshot.rejections as OptionsDataSnapshot["rejections"],
    validationError: panel.snapshot.validationError,
  };
  return {
    snapshot,
    strategies: buildResult as unknown as StrategyRecommendationResult,
    screenedOut: panel.screenedOut,
    ranked: panel.ranked,
    riskReports: panel.riskReports as StrategyRiskReport[],
    bestTrade: panel.bestTrade as BestTradePick,
  };
}

/**
 * Run the panel pipeline, constructing the agents exactly as the
 * retired class's constructor did (data agent over the given
 * screener, fresh risk + recommender agents).
 *
 * @deprecated Issue #4068 — retired by rename: the direct panel bypass.
 * Successor: runOptionsPanelViaEngine (src/workflows/optionsScreenEngine.ts),
 * which runs the same panel through the one engine-routed workflow.
 * This function is frozen: no production caller remains; tests that pin the
 * panel decomposition keep calling it. Recorded in
 * docs/architecture/transition/deprecations.md.
 */
export async function runPanelPipelineRetired4068(
  screener: DynamicOptionsScreener,
  request: StrategyRequest,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  return runPanelWithAgents(
    {
      data: new OptionsDataAgent(screener),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    },
    request,
    options,
  );
}
