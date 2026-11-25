/**
 * Issue 6406 — the Opportunity Hunt panel's recommendation levels.
 *
 * Every price range the report-style panel shows (entry range, stop-loss,
 * take-profit) is derived here from the latest close with per-strategy
 * percentages — never a literal in the panel or the hunt. The report
 * (issue 6403) reuses this same config so the panel and the report show
 * the same numbers.
 *
 * The values are RECOMMENDATION levels, not the evaluator's exit triggers:
 * the evaluator (`evaluateLatestPatternSignal`) decides enter/exit from the
 * bars; these levels say where a trader acting on that signal would enter,
 * stop out, and take profit.
 *
 * - sma_crossover: stop 5% / take-profit 10% — the copilot's baseline risk
 *   defaults (issue 4133), so the hunt's recommendation matches the
 *   copilot's plan step for the same signal.
 * - The mean-reversion family (rsi_reversal, mean_reversion, breakout):
 *   take-profit 3% aligns with the evaluator's own exit rule (a close
 *   more than 3% above the entry price exits); the stop is symmetric at 3%.
 * - Entry band 0.5% either way: the entry range is the latest close ± the
 *   band, the execution window for acting on the signal.
 */
import type { SandboxStrategyId } from "../services/patternSignals";

export interface OpportunityHuntLevelConfig {
  /** Half-width of the entry range around the latest close, as a fraction (0.005 = 0.5%). */
  entryBandPct: number;
  /** Stop-loss below the entry reference, as a fraction. */
  stopLossPct: number;
  /** Take-profit above the entry reference, as a fraction. */
  takeProfitPct: number;
}

/** Trailing closes carried per symbol for the panel's price chart. */
export const OPPORTUNITY_HUNT_CHART_BARS = 30;

/**
 * How many symbols the report's pattern-count chart shows (issue 6479 moved
 * this out of the renderer). The table below lists every evaluated symbol; the
 * chart is a visualization, so it shows the top N and says so — never a silent
 * cut.
 */
export const OPPORTUNITY_HUNT_PATTERN_CHART_TOP_N = 20;

export const OPPORTUNITY_HUNT_LEVELS: Record<
  SandboxStrategyId,
  OpportunityHuntLevelConfig
> = {
  sma_crossover: { entryBandPct: 0.005, stopLossPct: 0.05, takeProfitPct: 0.1 },
  rsi_reversal: { entryBandPct: 0.005, stopLossPct: 0.03, takeProfitPct: 0.03 },
  mean_reversion: { entryBandPct: 0.005, stopLossPct: 0.03, takeProfitPct: 0.03 },
  breakout: { entryBandPct: 0.005, stopLossPct: 0.03, takeProfitPct: 0.03 },
};

/** The entry recommendation's price range, derived from the latest close. */
export interface OpportunityHuntPriceLevels {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Derive an entry setup's price range from the latest close. */
export function deriveOpportunityHuntLevels(
  strategy: SandboxStrategyId,
  lastClose: number,
): OpportunityHuntPriceLevels {
  const cfg = OPPORTUNITY_HUNT_LEVELS[strategy];
  return {
    entryLow: round2(lastClose * (1 - cfg.entryBandPct)),
    entryHigh: round2(lastClose * (1 + cfg.entryBandPct)),
    stopLoss: round2(lastClose * (1 - cfg.stopLossPct)),
    takeProfit: round2(lastClose * (1 + cfg.takeProfitPct)),
  };
}
