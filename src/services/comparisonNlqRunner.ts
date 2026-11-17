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
 * - userLogin + hostSeams are optional (issue #4896): with the
 *   acting login threaded and the residency bindings configured,
 *   the comparison dispatches through the workflow host and no
 *   snapshot is fetched locally; the host run writes no ledger
 *   rows (the accepted-absent discipline), so the outcome reports
 *   ledgerPersisted false. Anything else stays on the sync
 *   dispatch below, unchanged.
 */
import { DynamicOptionsScreener, OptionsDataAgent, RecommendationAgent, StrategyRiskAgent, type RiskProfile, type StrategyRequest, type StrategyScreenFilter } from "../trading";
import { mintComparisonRunId, type ComparisonLedgerSink } from "./recommendationKernel";
import { buildComparisonQuestion, comparisonEmptySnapshotError, kernelSnapshotFromDataSnapshot, runProductionComparison, type ProductionComparisonDeps, type ProductionComparisonResult } from "./comparisonRunner";
import { resolveComparisonHostDispatch, runComparisonViaHost, type ComparisonHostSeams } from "./comparisonHostDispatch";
import { runComparisonViaEngine, type OptionsEngineStores } from "../workflows/optionsScreenEngine";
import type { Env } from "../types";

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
    /** Issue #4896: the acting login — the host gate requires
     *  it (the residency's chain factory yields no source
     *  without one). Absent, the run stays on the sync dispatch. */
    userLogin?: string;
    /** Issue #4896: the host dispatch's injectable seams
     *  (tests inject fakes; production passes nothing and the
     *  dispatch derives from env). */
    hostSeams?: ComparisonHostSeams;
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
      // Issue #4896: the host dispatch, gated — when the leg's
      // (broker, mode) pair derives from the session's platform,
      // the acting login is threaded, and the residency bindings
      // are configured, the comparison runs through the workflow
      // host and no snapshot is fetched locally: the resolving
      // step fetches it, and the step's empty-snapshot failure
      // surfaces here with the shared message. The host run
      // writes no ledger rows (accepted-absent), so the outcome
      // reports the run as not persisted.
      const hostDispatch = resolveComparisonHostDispatch(
        deps.env as Env,
        "etrade",
        undefined,
        input.userLogin,
      );
      if (hostDispatch.decision.route === "host" && hostDispatch.broker) {
        try {
          const result = await runComparisonViaHost({
            env: deps.env as Env,
            request: input.request,
            riskProfile: input.riskProfile ?? "balanced",
            ...(input.strategyFilter !== undefined ? { strategyFilter: input.strategyFilter } : {}),
            runId: mintComparisonRunId(),
            // The gate's host route implies a login is present.
            userLogin: input.userLogin!,
            broker: hostDispatch.broker,
            ...(input.hostSeams ? { seams: input.hostSeams } : {}),
          });
          return { ok: true, result, ledgerPersisted: false };
        } catch (error) {
          return {
            ok: false,
            ledgerPersisted: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
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
          error: comparisonEmptySnapshotError(s.symbol).message,
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
