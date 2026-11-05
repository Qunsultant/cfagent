/**
 * Cloudflare Agents Container Sandbox for Financial Quantitative Code Execution
 * Repurposed from Cloudflare Agents Sandbox standard:
 * https://developers.cloudflare.com/agents/tools/sandbox/
 *
 * Implements:
 * - Isolated container command runner via this.ctx.container
 * - Quantitative strategy calculation demos (SMA Crossover, RSI Reversal, Mean Reversion, Breakout)
 * - Deterministic Sharpe Ratio, Max Drawdown, and Win Rate calculations
 * - Timeout enforcement and output character truncation (10,000 chars)
 *
 * Honesty contract (issue #121, audit #115 F6/F7):
 * - runCommand executes ONLY through a real bound container. When no
 *   container is bound it returns executed:false with exitCode:null and an
 *   explicit error — shell execution is never emulated and output is never
 *   fabricated.
 * - runQuantBacktest runs over a SYNTHETIC generated price series, labelled
 *   dataSource:"synthetic" in every result. Its metrics are genuinely and
 *   deterministically computed from that series; a metric that cannot be
 *   computed is null, never default-filled or randomised.
 */

import type {
  Env,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  QuantBacktestRequest,
  QuantBacktestResult,
} from "../types";
import { AGENT_DIDS } from "../agents/did";
import { evaluatePatternSignalAt } from "./patternSignals";

const MAX_OUTPUT_CHARS = 10_000;
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class ETradeSandboxService {
  constructor(private container?: any, private env?: Env) {}

  /**
   * Run a shell command in the agent's Linux container sandbox
   */
  async runCommand(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const cmd = request.command;

    // 1. If container is available (Cloudflare Containers runtime)
    if (this.container) {
      try {
        if (!this.container.running) {
          await this.container.start({
            image: "cloudflare/debian-trixie",
            entrypoint: ["sleep", "infinity"],
            enableInternet: false, // Network isolation by default
          });
          if (typeof this.container.setInactivityTimeout === "function") {
            await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
          }
        }

        const timeoutSec = Math.min(Math.round((request.timeoutMs || 30_000) / 1000), 60);
        const process = await this.container.exec([
          "timeout",
          "--kill-after=5",
          String(timeoutSec),
          "bash",
          "-lc",
          cmd,
        ]);

        const output = await process.output();
        const decoder = new TextDecoder();
        const stdout = decoder.decode(output.stdout).slice(-MAX_OUTPUT_CHARS);
        const stderr = decoder.decode(output.stderr).slice(-MAX_OUTPUT_CHARS);

        return {
          executed: true,
          exitCode: output.exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        return {
          executed: true,
          exitCode: 1,
          stdout: "",
          stderr: err.message || "Container execution failed",
          durationMs: Date.now() - startTime,
          error: err.message,
        };
      }
    }

    // 2. No container backend is bound: the command is NOT executed.
    // Issue #121 (audit F6): this path previously emulated a shell and
    // returned exitCode 0 with a clean-execution message for commands that
    // never ran. There is no honest success shape for a non-execution,
    // so the result states plainly that nothing ran.
    return {
      executed: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startTime,
      error:
        "Command NOT executed: no container sandbox backend is bound in this environment, so there is nothing to run the command in. Shell execution is not emulated and no output was produced.",
    };
  }

  /**
   * Run the strategy calculation over a SYNTHETIC generated price series.
   *
   * Issue #121 (audit F7): this is a calculation demonstration, not a
   * backtest of the real security — the series is generated in code
   * (deterministic sin/cos), never historical market data. Every metric
   * below is genuinely computed from that series and the simulated trades
   * (Sharpe from the equity curve's per-bar returns, max drawdown from the
   * equity curve's peak-to-trough decline). Nothing is randomised and no
   * metric is default-filled: a metric that cannot be computed from the
   * run (e.g. win rate with no closed trades) is returned as null.
   */
  async runQuantBacktest(request: QuantBacktestRequest): Promise<QuantBacktestResult> {
    const sym = (request.symbol || "NVDA").toUpperCase();
    const strat = request.strategy || "sma_crossover";
    const numBars = request.startBars || 100;

    // Generate the deterministic synthetic price series (demo data only).
    const bars: number[] = [];
    let price = sym === "NVDA" ? 120 : sym === "AAPL" ? 220 : 100;
    for (let i = 0; i < numBars; i++) {
      const changePct = (Math.sin(i / 5) * 0.02) + (Math.cos(i / 3) * 0.015);
      price = price * (1 + changePct);
      bars.push(parseFloat(price.toFixed(2)));
    }

    // One-share long-only simulation with a full trade ledger and an
    // equity curve, so every metric derives from the simulated run.
    const capital = bars.length > 0 ? bars[0] : 0;
    let cash = capital;
    let position = 0;
    let entryPrice = 0;
    const tradePnls: number[] = [];
    const equityCurve: number[] = [];
    const logs: string[] = [];

    const openPosition = (atPrice: number, barIdx: number, why: string) => {
      position = 1;
      entryPrice = atPrice;
      cash -= atPrice;
      logs.push(`Bar ${barIdx}: BUY ${sym} at $${atPrice.toFixed(2)}${why}`);
    };
    const closePosition = (exitPrice: number, barIdx: number, why: string) => {
      const pnl = exitPrice - entryPrice;
      tradePnls.push(pnl);
      cash += exitPrice;
      position = 0;
      logs.push(`Bar ${barIdx}: SELL ${sym} at $${exitPrice.toFixed(2)} PnL: $${pnl.toFixed(2)}${why}`);
    };

    const fastPeriod = request.params?.fast || 5;
    const slowPeriod = request.params?.slow || 20;

    for (let i = 0; i < bars.length; i++) {
      // Issue #3391: the per-bar decision comes from the shared
      // pattern-signals module (src/services/patternSignals.ts) — the
      // single implementation of this strategy set, which the Stock
      // Copilot cycle also evaluates over live bars. The rules are
      // unchanged, including the disclosed simplification that
      // rsi_reversal, mean_reversion and breakout share one
      // mean-reversion rule in this set.
      const signal = evaluatePatternSignalAt(
        strat,
        bars,
        i,
        { holding: position === 1, entryPrice },
        { fast: fastPeriod, slow: slowPeriod },
      );
      if (signal.action === "enter_long") {
        openPosition(bars[i], i, signal.detail ? ` ${signal.detail}` : "");
      } else if (signal.action === "exit_long") {
        closePosition(bars[i], i, signal.detail ? ` ${signal.detail}` : "");
      }
      equityCurve.push(cash + (position === 1 ? bars[i] : 0));
    }

    // An open position at the end of the series is closed at the final bar
    // so its real gain/loss is part of the ledger — never silently dropped.
    if (position === 1 && bars.length > 0) {
      closePosition(bars[bars.length - 1], bars.length - 1, " (end of series — closed at final bar)");
    }

    const round = (v: number, dp: number) => parseFloat(v.toFixed(dp));

    const totalTrades = tradePnls.length;
    const wins = tradePnls.filter((p) => p > 0).length;
    const grossProfit = tradePnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(tradePnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));

    const winRate = totalTrades > 0 ? round((wins / totalTrades) * 100, 1) : null;
    const profitFactor = grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null;

    // Per-bar returns of the equity curve → annualised Sharpe (rf = 0).
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      if (equityCurve[i - 1] > 0) returns.push(equityCurve[i] / equityCurve[i - 1] - 1);
    }
    let sharpeRatio: number | null = null;
    if (returns.length >= 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) sharpeRatio = round((mean / std) * Math.sqrt(252), 2);
    }

    let maxDrawdownPct: number | null = null;
    if (equityCurve.length >= 2) {
      let peak = equityCurve[0];
      let maxDd = 0;
      for (const e of equityCurve) {
        peak = Math.max(peak, e);
        if (peak > 0) maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
      }
      maxDrawdownPct = round(maxDd, 1);
    }

    const netReturnPct =
      capital > 0 && equityCurve.length > 0
        ? round((equityCurve[equityCurve.length - 1] / capital - 1) * 100, 1)
        : null;

    return {
      symbol: sym,
      strategy: strat,
      dataSource: "synthetic",
      totalTrades,
      winRate,
      profitFactor,
      sharpeRatio,
      maxDrawdownPct,
      netReturnPct,
      codeExecuted:
        "none — the metrics were calculated in-process (TypeScript) over a generated series; no code was executed in a sandbox",
      logs: logs.slice(0, 10).join("\n"),
      note:
        `Synthetic demonstration: the price series is generated in code (deterministic sin/cos), NOT historical market data for ${sym}. ` +
        "Metrics are genuinely computed from that series and the simulated trades; they demonstrate the calculation only and say nothing about the real security. " +
        "A metric reported as null could not be computed from this run (e.g. no closed trades). " +
        "rsi_reversal, mean_reversion and breakout share one simplified mean-reversion rule in this demonstration.",
    };
  }
}
