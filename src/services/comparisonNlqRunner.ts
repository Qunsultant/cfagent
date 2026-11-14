/**
 * #1257 comparison surfacing — the NLQ comparison runner.
 *
 * Mirrors the POST /trading/options/comparison route exactly (same
 * snapshot mapping, same agents, same question construction, same
 * runProductionComparison call) so a chat comparison and a panel
 * comparison over the same request are the same run, differing only
 * in surface. Follows the fitDiscoveryRunner discipline: when a
 * required dependency is absent, the run fails with an availability
 * error rather than silently answering a different question.
 *
 * - env is REQUIRED: without it the llm arm cannot generate and the
 *   hybrid arm cannot rank; a quant-only "comparison" would silently
 *   equal the quant order and misrepresent itself as three arms.
 * - ledgerSql is optional: without it the run still compares, but
 *   the outcome reports that it was not persisted to the ledger.
 * - An empty snapshot is a failure, not a no_candidates envelope:
 *   the NLQ action has no separate no-candidates rendering, and a
 *   silent empty answer would hide a data problem.
 * - engineStores is optional (issue #4276): with it, the comparison
 *   dispatches as a single-step engine job over the caller's stores
 *   (the #4066 pattern), so the run has a durable pipeline record;
 *   without it, the core executes directly (the #4069 accepted-absent
 *   discipline). The engine path changes nothing about the
 *   comparison itself — same snapshot, same core inputs, same
 *   artifact modulo the run id, which the runner mints so the
 *   engine job and the artifact carry one id.
 */
import { DynamicOptionsScreener, OptionsDataAgent, RecommendationAgent, StrategyRiskAgent, type RiskProfile, type StrategyRequest, type StrategyScreenFilter } from "../trading";
import { mintComparisonRunId, type ComparisonLedgerSink } from "./recommendationKernel";
import { buildComparisonQuestion, kernelSnapshotFromDataSnapshot, runProductionComparison, type ProductionComparisonDeps, type ProductionComparisonResult } from "./comparisonRunner";
import { runComparisonViaEngine, type OptionsEngineStores } from "../workflows/optionsScreenEngine";

export interface ComparisonNlqOutcome {
  ok: boolean;
  error?: string;
  result?: ProductionComparisonResult;
  ledgerPersisted: boolean;
}

export interface ComparisonNlqRunner {
  run(input: {
    request: StrategyRequest;
    riskProfile?: RiskProfile;
    strategyFilter?: StrategyScreenFilter;
    /** Issue #4276: the engine stores the run records over (the
     *  #4066 pattern — threaded by the NLQ leg from engineSql).
     *  Absent, the core executes directly and leaves no durable
     *  pipeline record (the #4069 accepted-absent discipline). */
    engineStores?: OptionsEngineStores | null;
  }): Promise<ComparisonNlqOutcome>;
}

export function createComparisonRunner(deps: {
  client: ConstructorParameters<typeof DynamicOptionsScreener>[0];
  env?: unknown;
  ledgerSql?: ComparisonLedgerSink | null;
}): ComparisonNlqRunner {
  return {
    async run(input): Promise<ComparisonNlqOutcome> {
      if (!deps.env) {
        return {
          ok: false,
          ledgerPersisted: false,
          error: "Three-way comparison is unavailable in this context: no environment is configured for LLM generation, so the llm and hybrid arms cannot run.",
        };
      }
      const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(deps.client));
      const s = await dataAgent.loadSnapshot(input.request);
      // The shared snapshot mapping (comparisonRunner.ts) — the
      // same mapping the panel route builds, without calling
      // discoverPanel, which would waste a full kernel run just
      // for the snapshot.
      const snapshot = kernelSnapshotFromDataSnapshot(s);
      if ((snapshot.contracts ?? []).length === 0) {
        return {
          ok: false,
          ledgerPersisted: false,
          error: `Comparison snapshot for ${s.symbol} has no screened contracts.`,
        };
      }
      const riskAgent = new StrategyRiskAgent();
      const recommender = new RecommendationAgent();
      const req = input.request;
      const question = buildComparisonQuestion(req);
      const coreArgs: ProductionComparisonDeps = {
        snapshot,
        request: req,
        question,
        riskProfile: input.riskProfile ?? "balanced",
        strategyFilter: input.strategyFilter,
        buildFn: (contracts, request) => riskAgent.buildStrategies(contracts, request as StrategyRequest),
        rankFn: (candidates, request, profile) => recommender.rank(candidates, request as unknown as StrategyRequest, profile),
        screenFn: (candidates, filter) => riskAgent.screenStrategies(candidates, filter),
        env: deps.env,
        ledgerSql: deps.ledgerSql ?? null,
      };
      if (input.engineStores) {
        // Issue #4276: the comparison dispatches as a single-step
        // engine job over the caller's stores, so the run has a
        // durable pipeline record. The minted id is the engine
        // job's run id AND the artifact's run id — one id for
        // the run, so control addresses the run the turn reports.
        const runId = mintComparisonRunId();
        const result = await runComparisonViaEngine(
          {
            runId,
            request: {
              assetClass: "options",
              runIdentity: { runId },
              trigger: "manual",
              classInput: {
                comparisonRequest: {
                  request: req,
                  riskProfile: input.riskProfile ?? "balanced",
                  strategyFilter: input.strategyFilter,
                },
              },
            },
            engineStores: input.engineStores,
          },
          () => runProductionComparison({ ...coreArgs, runId }),
        );
        return { ok: true, result, ledgerPersisted: Boolean(deps.ledgerSql) };
      }
      const result = await runProductionComparison(coreArgs);
      return { ok: true, result, ledgerPersisted: Boolean(deps.ledgerSql) };
    },
  };
}
