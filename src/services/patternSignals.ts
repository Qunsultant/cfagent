/**
 * Pattern signals — the platform's sandbox strategy set as pure
 * functions over a close series (issue #3391, parent #3380).
 *
 * This module is the SINGLE implementation of the strategy rules that
 * `ETradeSandboxService.runQuantBacktest` (src/services/sandboxAgent.ts)
 * demonstrates over a synthetic series. The sandbox loop delegates its
 * per-bar decisions here, and the Stock Copilot cycle evaluates the
 * same functions over live bars — one implementation, two consumers,
 * no forked logic (the #3380 standing rule).
 *
 * The rules, reproduced exactly as the sandbox set defines them:
 *
 * - `sma_crossover` — at bar i (only once i >= slow period), compare
 *   the mean of the `fast` closes BEFORE bar i against the mean of the
 *   `slow` closes BEFORE bar i (the sandbox's slice(i-fast, i) /
 *   slice(i-slow, i) windows — bar i itself is the execution price,
 *   never part of its own signal). Fast above slow while flat →
 *   enter long; fast below slow while holding → exit.
 *
 * - The mean-reversion family — `rsi_reversal`, `mean_reversion` and
 *   `breakout` share ONE simplified rule in the sandbox set, disclosed
 *   in the sandbox result note: at bar i (only once i >= 14), a close
 *   more than 1.5% below the prior bar while flat → enter long; a
 *   close more than 3% above the entry price while holding → exit.
 *   Despite the `rsi_reversal` name, NO RSI is computed anywhere in
 *   the set — the names are the sandbox's strategy ids, kept so both
 *   consumers speak the same vocabulary, and the shared rule is named
 *   here rather than papered over.
 *
 * Long-only, one position, exactly like the sandbox simulation.
 */

export type SandboxStrategyId =
  | "sma_crossover"
  | "rsi_reversal"
  | "mean_reversion"
  | "breakout";

/** Every strategy id the sandbox set accepts. */
export const SANDBOX_STRATEGY_IDS: readonly SandboxStrategyId[] = [
  "sma_crossover",
  "rsi_reversal",
  "mean_reversion",
  "breakout",
];

export interface PatternSignalState {
  /** True while a long position is open. */
  holding: boolean;
  /** Entry price of the open position (the mean-reversion exit reads it). */
  entryPrice: number;
}

export interface PatternSignal {
  action: "enter_long" | "exit_long" | "none";
  /**
   * The sandbox log suffix for the decision, in its exact format
   * (e.g. "(Fast SMA 143.46 > Slow 136.24)"); "" when action is none.
   */
  detail: string;
  /** Populated for sma_crossover evaluations past the warm-up window. */
  fastSma?: number;
  slowSma?: number;
}

const NO_SIGNAL: PatternSignal = { action: "none", detail: "" };

const mean = (xs: readonly number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

function smaCrossoverAt(
  closes: readonly number[],
  index: number,
  state: PatternSignalState,
  fastPeriod: number,
  slowPeriod: number,
): PatternSignal {
  // Sandbox guard: the rule evaluates only once the slow window exists.
  if (index < slowPeriod || index < fastPeriod) return NO_SIGNAL;
  const fastSma = mean(closes.slice(index - fastPeriod, index));
  const slowSma = mean(closes.slice(index - slowPeriod, index));
  if (fastSma > slowSma && !state.holding) {
    return {
      action: "enter_long",
      detail: `(Fast SMA ${fastSma.toFixed(2)} > Slow ${slowSma.toFixed(2)})`,
      fastSma,
      slowSma,
    };
  }
  if (fastSma < slowSma && state.holding) {
    return {
      action: "exit_long",
      detail: `(Fast SMA ${fastSma.toFixed(2)} < Slow ${slowSma.toFixed(2)})`,
      fastSma,
      slowSma,
    };
  }
  return { action: "none", detail: "", fastSma, slowSma };
}

function meanReversionFamilyAt(
  closes: readonly number[],
  index: number,
  state: PatternSignalState,
): PatternSignal {
  // Sandbox guard: the shared rule evaluates only from bar 14.
  if (index < 14) return NO_SIGNAL;
  const current = closes[index];
  const prev = closes[index - 1];
  if (current < prev * 0.985 && !state.holding) {
    return { action: "enter_long", detail: "(dip >1.5% below prior bar)" };
  }
  if (state.holding && current > state.entryPrice * 1.03) {
    return { action: "exit_long", detail: "(+3% from entry)" };
  }
  return NO_SIGNAL;
}

/**
 * The signal the sandbox strategy set produces AT `index`, given the
 * position state the simulation holds entering that bar. Mirrors the
 * sandbox loop's branch structure: `sma_crossover` takes the SMA rule;
 * every other strategy id takes the shared mean-reversion rule (the
 * sandbox's own else-branch, which its note discloses).
 */
export function evaluatePatternSignalAt(
  strategy: SandboxStrategyId | string,
  closes: readonly number[],
  index: number,
  state: PatternSignalState,
  params?: { fast?: number; slow?: number },
): PatternSignal {
  if (index < 0 || index >= closes.length) return NO_SIGNAL;
  if (strategy === "sma_crossover") {
    return smaCrossoverAt(
      closes,
      index,
      state,
      params?.fast || 5,
      params?.slow || 20,
    );
  }
  return meanReversionFamilyAt(closes, index, state);
}

/** The signal at the latest bar of a series — the copilot cycle's view. */
export function evaluateLatestPatternSignal(
  strategy: SandboxStrategyId | string,
  closes: readonly number[],
  state: PatternSignalState,
  params?: { fast?: number; slow?: number },
): PatternSignal {
  if (closes.length === 0) return NO_SIGNAL;
  return evaluatePatternSignalAt(strategy, closes, closes.length - 1, state, params);
}
