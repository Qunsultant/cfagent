/**
 * Issue #3514 / #3405 — Stock Copilot Interactive On-Demand Strategy Evaluator.
 *
 * Evaluates single-symbol equities against the sandbox strategy pattern catalog
 * over live or recent market data bars WITHOUT placing orders or modifying positions.
 * Invocable interactively via Chat, MCP tool, REST route, and Mesh Door.
 */

import {
  evaluateLatestPatternSignal,
  type PatternSignal,
  type SandboxStrategyId,
} from "./patternSignals";
import {
  DEFAULT_COPILOT_STRATEGIES,
  parseStrategiesInput,
} from "./stockCopilotConfiguration";

export interface StrategyEvaluationResultItem {
  strategy: SandboxStrategyId;
  action: PatternSignal["action"];
  signalSuffix: string;
  triggered: boolean;
}

export interface StockCopilotEvaluationResult {
  symbol: string;
  barsCount: number;
  lastPrice: number;
  evaluations: StrategyEvaluationResultItem[];
  timestamp: string;
}

export interface StockCopilotEvaluationDeps {
  loadBars: (symbol: string) => Promise<number[]>;
}

export async function evaluateStockCopilotStrategy(
  symbol: string,
  deps: StockCopilotEvaluationDeps,
  requestedStrategies?: string | readonly string[],
): Promise<StockCopilotEvaluationResult> {
  const normSymbol = symbol.trim().toUpperCase();
  const strategies = requestedStrategies
    ? parseStrategiesInput(requestedStrategies)
    : [...DEFAULT_COPILOT_STRATEGIES];

  const bars = await deps.loadBars(normSymbol);
  const lastPrice = bars.length > 0 ? bars[bars.length - 1] : 0;
  const nowIso = new Date().toISOString();

  const evaluations: StrategyEvaluationResultItem[] = strategies.map((strategy) => {
    if (bars.length < 5) {
      return {
        strategy,
        action: "none",
        signalSuffix: "Insufficient bars for evaluation (<5)",
        triggered: false,
      };
    }

    const signal = evaluateLatestPatternSignal(strategy, bars, {
      holding: false,
      entryPrice: 0,
    });

    return {
      strategy,
      action: signal.action,
      signalSuffix: signal.signalSuffix,
      triggered: signal.action !== "none",
    };
  });

  return {
    symbol: normSymbol,
    barsCount: bars.length,
    lastPrice,
    evaluations,
    timestamp: nowIso,
  };
}
