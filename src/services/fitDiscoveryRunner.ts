/**
 * Fit-discovery runner (issue #1162, Phase 6 of epic #1096).
 *
 * The production runner behind the NLQ `options_fit_discovery` action:
 * it executes Phase 2's bidirectional discovery against the live
 * research data fabric (`EtradeResearchDataProvider`, the same
 * provider the research agent uses), and — only when the
 * `screening.weightsV2Ranking` flag is explicitly on — applies
 * Phase 5's strategy weights v2 to the ranking.
 *
 * #1256 remainder — NLQ fit rewire: the name direction
 * (name_to_strategies) runs through the kernel research entry
 * (`RecommendationService.discoverForName`) and maps back to
 * `DiscoveryModeResult` via `kernelDiscoveryMapping` (nullable
 * economics carried explicitly, never dropped or fabricated). Gate
 * evidence (quote + chain) comes from the same provider session so
 * the kernel's re-gate sees the same evidence the discovery run
 * used. The strategy direction (strategy_to_names) runs through the
 * kernel research entry (`RecommendationService.discoverNamesForStrategy`)
 * and maps back via `kernelDiscoveryMapping` (#1256: the discovery
 * itself attaches genuine falsification evidence to each ranked fit
 * — gate verdict + live chain/quote session + fit components — so
 * the kernel's falsify stage keeps qualified/watchlist tiers
 * honestly; evidence-less fits still demote, per the invariant).
 *
 * Governance, stated once and pinned by tests:
 *
 *  - The flag is OFF by default (the #17 reviewed-config posture:
 *    learned weighting does not touch production ranking until a
 *    human enables it in settings). Off = the discovery result is
 *    returned with its ordering byte-identical.
 *  - When ON, weights act as bounded multipliers on the existing
 *    deterministic scores (fit score for Strategy→Names; the
 *    scenario worst/mean cells for Name→Strategies, within the same
 *    status tier — a weight never promotes a candidate across the
 *    Qualified/Watchlist/Unverified/Rejected tiers, and never lifts a
 *    negative worst-cell candidate above a positive one).
 *  - The runner refuses (explicit error, no partial answer) when the
 *    `screening.nlqFitDiscovery` off-switch is set.
 *  - Every run is recorded in the screening activity log when a store
 *    is supplied.
 */

import type { Env } from "../types";
import {
  discoverStrategiesForName,
  discoverNamesForStrategy,
  type DiscoveryModeRequest,
  type DiscoveryModeResult,
} from "./researchDiscovery";
import { RecommendationService } from "./recommendationKernel";
import { mapKernelNameDiscovery, mapKernelStrategyDiscovery } from "./kernelDiscoveryMapping";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "./researchConfig";
import { EtradeResearchDataProvider } from "./researchProviders";
import {
  resolveYahooHistoryDeps,
  nasdaqUniverseRouteBundle,
  nasdaqUniverseProviderFromRoute,
  bindNasdaqUniverseDeps,
  type NasdaqUniverseDeps,
} from "../trading";
import type { ResearchDataProvider } from "./researchPipeline";
import type { Outlook } from "./researchGates";
import {
  getStrategyWeightsV2,
  weightsV2Key,
  type WeightsV2Regime,
} from "./strategyWeightsV2";
import {
  isNlqFitDiscoveryEnabled,
  isWeightsV2RankingEnabled,
  settingReadFromSql,
  type ScreeningSettingRead,
} from "./screeningFlags";
import { recordScreeningActivity } from "./screeningActivity";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/fitDiscoveryRunner",
});


/** Outlook (a view) → Phase 5 regime class (a market state label). Directional views map to the directional regimes; the mapping is fixed and total so a weight lookup never guesses. */
export const OUTLOOK_TO_WEIGHTS_REGIME: Record<Outlook, WeightsV2Regime> = {
  bullish: "bull",
  bearish: "bear",
  range_bound: "chop",
  volatile: "high_vol",
  unknown: "unknown",
};

const STATUS_RANK: Record<string, number> = {
  qualified: 0,
  watchlist: 1,
  unverified: 2,
  rejected: 3,
};

type SqlExec = { exec: (q: string, ...a: unknown[]) => Iterable<unknown> };

/**
 * Pure re-ranking: apply v2 weights (keyed by weightsV2Key) to a
 * discovery result for one regime. Returns the (possibly reordered)
 * result plus human-readable notes for every weight that was applied.
 * Structures without a v2 row keep weight 1 (no adjustment).
 */
export function applyWeightsV2Ranking(
  result: DiscoveryModeResult,
  weights: Record<string, number>,
  regime: WeightsV2Regime
): { result: DiscoveryModeResult; notes: string[] } {
  const notes: string[] = [];
  const weightFor = (structure: string): number => {
    const w = weights[weightsV2Key(structure, regime)];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
  };
  const noteApplied = (structure: string, w: number) => {
    if (w !== 1) {
      notes.push(
        `${structure} ×${w.toFixed(2)} (strategy weights v2, regime ${regime})`
      );
    }
  };

  if (result.direction === "strategy_to_names") {
    const r = result.result;
    const adjusted = r.ranked.map((fit) => {
      const w = weightFor(fit.structure);
      noteApplied(fit.structure, w);
      return { fit, score: fit.fitScore * w };
    });
    adjusted.sort((a, b) => b.score - a.score || a.fit.symbol.localeCompare(b.fit.symbol));
    if (notes.length > 0) {
      notes.unshift("Ranking adjusted by strategy weights v2:");
    }
    return {
      result: {
        direction: "strategy_to_names",
        result: { ...r, ranked: adjusted.map((a) => a.fit) },
      },
      notes,
    };
  }

  const r = result.result;
  const adjusted = r.candidates.map((c) => {
    const w = weightFor(c.structure);
    noteApplied(c.structure, w);
    // Conservative blend: a weight scales only non-negative scenario
    // cells. A negative worst/mean cell is never improved by a weight —
    // learned weighting must not rescue a candidate the scenario grid
    // says loses money in its worst cell.
    return {
      c,
      worst: c.scenario.worstPnlTotal >= 0 ? c.scenario.worstPnlTotal * w : c.scenario.worstPnlTotal,
      mean: c.scenario.meanPnlTotal >= 0 ? c.scenario.meanPnlTotal * w : c.scenario.meanPnlTotal,
    };
  });
  adjusted.sort(
    (a, b) =>
      (STATUS_RANK[a.c.status] ?? 9) - (STATUS_RANK[b.c.status] ?? 9) ||
      b.worst - a.worst ||
      b.mean - a.mean ||
      a.c.structure.localeCompare(b.c.structure)
  );
  if (notes.length > 0) {
    notes.unshift("Ranking adjusted by strategy weights v2:");
  }
  return {
    result: {
      direction: "name_to_strategies",
      result: { ...r, candidates: adjusted.map((a) => a.c) },
    },
    notes,
  };
}

export interface FitDiscoveryRunOutcome {
  ok: boolean;
  error?: string;
  result?: DiscoveryModeResult;
  weightsApplied: boolean;
  notes: string[];
}

export interface FitDiscoveryRunner {
  run(request: DiscoveryModeRequest): Promise<FitDiscoveryRunOutcome>;
}

export function createFitDiscoveryRunner(deps: {
  env?: Env;
  userLogin: string;
  /** Store for flags, weights, and the activity log (DO SqlStorage or DatabaseORM). */
  sql?: SqlExec;
  settingRead?: ScreeningSettingRead;
  /** Test seam: supply a provider instead of the live E*TRADE-backed one. */
  provider?: ResearchDataProvider;
  config?: ResearchConfig;
  /**
   * Issue #1661: DO blob handle for full capture. When supplied, the
   * history and universe legs write capture rows; without it they keep
   * today's outcome-only contract (never a behavior change).
   */
  storage?: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> };
}): FitDiscoveryRunner {
  const settingRead =
    deps.settingRead ?? (deps.sql ? settingReadFromSql(deps.sql) : null);
  return {
    async run(request: DiscoveryModeRequest): Promise<FitDiscoveryRunOutcome> {
      if (settingRead && !isNlqFitDiscoveryEnabled(settingRead)) {
        return {
          ok: false,
          weightsApplied: false,
          notes: [],
          error:
            "Fit discovery is disabled by the screening.nlqFitDiscovery setting. Re-enable it from the screening controls to use fit phrases.",
        };
      }
      // Issue #1331: history deps when sql is present (route-
      // resolved; #1661: full capture when the caller threads a
      // blob handle, outcome-tracked otherwise). Without sql the
      // provider keeps working with honestly-null technicals — no
      // fallback to the deleted direct fetch exists.
      // Issue #1331 (fix): history resolution degrades to undefined
      // deps (honestly-null technicals) instead of failing the run
      // — the old yahooHistory contract. See
      // resolveYahooHistoryDeps.
      const historyDeps =
        deps.sql && deps.env
          ? await resolveYahooHistoryDeps({
              sql: deps.sql,
              env: deps.env,
              userLogin: deps.userLogin,
              runId: crypto.randomUUID(),
              ...(deps.storage ? { blobStorage: deps.storage as never } : {}),
            })
          : undefined;
      // Issue #1378: universe deps when sql is present (route-
      // resolved; #1661: full capture when the caller threads a
      // blob handle, outcome-tracked otherwise). Without sql — or
      // when the bundle cannot be built — the provider keeps working
      // with honestly-empty universes (listings degrade to []), never
      // a direct fetch. Decision D2: captures use a generated run id.
      let universeDeps: NasdaqUniverseDeps | undefined;
      if (deps.sql && deps.env) {
        try {
          const universeBundle = await nasdaqUniverseRouteBundle({
            sql: deps.sql,
            env: deps.env,
            userLogin: deps.userLogin,
            runId: crypto.randomUUID(),
            ...(deps.storage ? { storage: deps.storage as never } : {}),
          });
          const universeProvider = nasdaqUniverseProviderFromRoute(
            universeBundle.registry,
            universeBundle.configs,
            universeBundle.routes
          );
          universeDeps = bindNasdaqUniverseDeps(universeProvider, universeBundle.runContext);
        } catch (err) {
          structuredLog.warn("fitDiscoveryRunner.universe_deps_unavailable", {
            message: `[fit] universe deps unavailable, listings degrade to empty: ${err instanceof Error ? err.message : String(err)}`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const provider =
        deps.provider ??
        (deps.env
          ? new EtradeResearchDataProvider(deps.env, deps.userLogin, historyDeps, universeDeps)
          : null);
      if (!provider) {
        return {
          ok: false,
          weightsApplied: false,
          notes: [],
          error:
            "Fit discovery is unavailable in this context: no research data provider is configured.",
        };
      }

      const config = deps.config ?? RESEARCH_CONFIG_DEFAULTS;
      let raw: DiscoveryModeResult;
      if (request.direction === "name_to_strategies") {
        // Kernel path: run the discovery once, then re-gate + rank it
        // through the kernel facade. Gate evidence is fetched from
        // the same provider session (a second fetch — the discovery
        // does not expose its internal quote/chain); without it, the
        // kernel's missing-quote honesty would demote every
        // candidate to Unverified.
        const discovery = await discoverStrategiesForName(
          { provider },
          config,
          {
            symbol: request.symbol,
            outlook: request.outlook,
            goalKind: request.goalKind,
            scenario: request.scenario,
            now: request.now,
            repairPosition: request.repairPosition,
          },
        );
        const quote = await provider.getQuote(request.symbol);
        const chain = await provider.getChain(request.symbol);
        const kernelResult = await new RecommendationService().discoverForName({
          discoverStrategiesForName: async () => discovery,
          symbol: request.symbol,
          outlook: request.outlook,
          goalKind: request.goalKind,
          scenario: request.scenario,
          now: request.now,
          gateQuote: quote
            ? { price: quote.price, timestamp: quote.timestamp, source: quote.source }
            : undefined,
          gateChain: chain
            ? { underlyingPrice: chain.underlyingPrice, asOf: chain.asOf, provenance: chain.provenance }
            : undefined,
        });
        raw = {
          direction: "name_to_strategies",
          result: mapKernelNameDiscovery(kernelResult, discovery),
        };
      } else {
        // Strategy direction (#1256): kernel path. The discovery
        // itself attaches genuine falsification evidence to each
        // ranked fit (gate verdict + live chain/quote session + fit
        // components, recorded at discovery time), so the kernel's
        // falsify stage keeps qualified/watchlist tiers honestly —
        // no placeholder evidence, no falsify exemption. The kernel
        // order (tier, fitScore) wins where it disagrees with the
        // direct order (fitScore, symbol); see the order-divergence
        // pin in tests/fit_discovery_kernel.test.ts.
        const discovery = await discoverNamesForStrategy(
          { provider },
          config,
          {
            structure: request.structure,
            outlook: request.outlook,
            symbols: request.symbols,
            universe: request.universe,
            goalKind: request.goalKind,
            now: request.now,
          },
        );
        const kernelResult = await new RecommendationService().discoverNamesForStrategy({
          discoverNamesForStrategy: async () => discovery,
          structure: request.structure,
          outlook: request.outlook,
          symbols: request.symbols,
          universe: request.universe,
          goalKind: request.goalKind,
          now: request.now,
        });
        raw = {
          direction: "strategy_to_names",
          result: mapKernelStrategyDiscovery(kernelResult, discovery),
        };
      }

      let result = raw;
      let weightsApplied = false;
      let notes: string[] = [];
      if (deps.sql && settingRead && isWeightsV2RankingEnabled(settingRead)) {
        const regime = OUTLOOK_TO_WEIGHTS_REGIME[request.outlook];
        const weights = getStrategyWeightsV2(deps.sql);
        const blended = applyWeightsV2Ranking(raw, weights, regime);
        result = blended.result;
        notes = blended.notes;
        weightsApplied = notes.length > 0;
      }

      if (deps.sql) {
        const summary =
          result.direction === "name_to_strategies"
            ? `Fit discovery (NLQ) for ${result.result.symbol}: ${result.result.candidates.length} candidate(s), ${result.result.rejected.length} rejected${weightsApplied ? "; ranking adjusted by weights v2" : ""}.`
            : `Fit discovery (NLQ) for ${result.result.structure}: ${result.result.ranked.length} name(s) ranked, ${result.result.rejected.length} not scored${weightsApplied ? "; ranking adjusted by weights v2" : ""}.`;
        recordScreeningActivity(deps.sql, {
          userLogin: deps.userLogin,
          kind: "discovery_run",
          summary,
          detail: { direction: result.direction, weightsApplied, notes },
          actor: "nlq-fit-discovery",
        });
      }

      return { ok: true, result, weightsApplied, notes };
    },
  };
}
