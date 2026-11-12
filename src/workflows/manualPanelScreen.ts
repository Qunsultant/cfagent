/**
 * Issue #3186 step 3e - the manual panel route's pipeline call.
 *
 * POST /trading/options/strategies + /best-trade run through the one
 * panel pipeline (createStrategyScreenPorts over the same three
 * agents the direct discoverPanel call used) instead of calling
 * RecommendationService.discoverPanel. The pipeline's shapeReport
 * stage IS assemblePanelResult, so the returned PanelDiscoveryResult
 * is the discoverPanel result and the route reads it unchanged.
 *
 * Lives here, not in the route, because etradeOptions.ts sits under
 * the #359 50 KB ratchet (tests/etrade_routes_resplit_995.test.ts)
 * and the pipeline construction does not fit in it.
 *
 * Storage/claims are the DO handles when the caller passes them,
 * in-memory otherwise; the identity is the caller's (already
 * fail-closed at the route), never invented here.
 */
import { createSqlStageClaimStore } from "../data/stageClaimsStore";
import type { SqlStorage } from "../orm";
import { optionsArtifactKey, type OptionsStageStorage } from "./optionsScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "./optionsScreenWorkflow";
import { optionsEngineStoresFromSql, runStrategyScreenViaEngine } from "./optionsScreenEngine";
import {
  createStrategyScreenPorts,
  panelResultToPipelineResult,
} from "./strategyScreenPorts";
import type { StageQueueSend } from "./stageQueueTransport";
import type {
  PanelDiscoveryInput,
  PanelDiscoveryResult,
} from "../services/recommendationKernel";
import {
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type PipelineResult,
  type StrategyRequest,
} from "../trading";

export interface ManualPanelScreenInput {
  userLogin: string;
  /** The banded request (resolvePanelFetchBands output) - the same request discoverPanel received. */
  strategyRequest: StrategyRequest;
  strategyFilter?: PanelDiscoveryInput["strategyFilter"];
  riskProfile?: PanelDiscoveryInput["riskProfile"];
  alternatives?: number;
  /** The route's data agent; the loadSnapshot adapter is the one the route built inline before. */
  dataAgent: OptionsDataAgent;
  storage?: OptionsStageStorage | null;
  getSql?: (() => SqlStorage) | null;
  queue?: StageQueueSend | null;
}

export async function runManualPanelViaPipeline(
  input: ManualPanelScreenInput,
): Promise<PanelDiscoveryResult> {
  const runId = `options-panel:route:${input.strategyRequest.symbol}:${new Date().toISOString()}`;
  const storage = input.storage ?? memoryStageStorage();
  const claims = input.getSql
    ? createSqlStageClaimStore(input.getSql)
    : memoryStageClaims();
  // Issue #4271: the manual panel is a strategy screen — it defines
  // the strategy job (strategy-screen:<runId>), not the options job.
  const outcome = await runStrategyScreenViaEngine(
    {
      runId,
      userLogin: input.userLogin,
      trigger: "manual",
      request: {
        assetClass: "options",
        runIdentity: { runId },
        trigger: "manual",
        classInput: {
          strategyRequest: input.strategyRequest,
          strategyFilter: input.strategyFilter,
          riskProfile: input.riskProfile,
          alternatives: input.alternatives,
        },
      },
    },
    {
      stages: createStrategyScreenPorts({
        agents: {
          data: {
            loadSnapshot: async (params: unknown) => {
              const s = await input.dataAgent.loadSnapshot(params as StrategyRequest);
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
          risk: new StrategyRiskAgent(),
          recommender: new RecommendationAgent(),
        },
        storage,
      }),
      claims,
      queue: input.queue ?? null,
      // Issue #4068: the engine run record is durable in the route's
      // SQLite when it passes getSql; in-memory otherwise (the leg's
      // own stage storage is in-memory in that case too).
      engineStores: input.getSql ? optionsEngineStoresFromSql(input.getSql()) : null,
    },
  );
  if (outcome.outcome !== "completed") {
    throw new Error(
      `Options panel screen failed at ${outcome.failedStage}: ${outcome.reason}`,
    );
  }
  const result = await storage.get<PanelDiscoveryResult>(
    optionsArtifactKey(runId, "shapeReport"),
  );
  if (!result) {
    throw new Error(
      "Options panel screen completed without a report artifact; refusing to answer from nothing.",
    );
  }
  return result;
}

/**
 * The compare route's form of the same run: the panel result mapped
 * back to the PipelineResult shape runPanelWithAgents returned, via
 * its own mapping (panelResultToPipelineResult) - the ranking code
 * reads strategies/snapshot/ranked off it unchanged.
 */
export async function runComparePanelViaPipeline(
  input: ManualPanelScreenInput,
): Promise<PipelineResult> {
  return panelResultToPipelineResult(await runManualPanelViaPipeline(input));
}
