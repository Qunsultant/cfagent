/**
 * Issue #121 (audit #115 F6/F7) — MCP sandbox + quant backtest honesty.
 *
 * F6: run_sandbox_command always took the emulated path (the MCP facade
 * binds no container) and returned exitCode 0 with "Execution completed
 * cleanly" for commands that never ran.
 * F7: run_quant_backtest "backtested" over an invented sin/cos series with
 * a formula Sharpe, a Math.random() drawdown, and default-substituted
 * metrics (winRate 50.0, profitFactor 2.5, totalTrades || 8, netReturn
 * || 14.8), while describing itself as a backtest over "historical bars".
 *
 * These tests pin the honest contracts:
 * - no-backend sandbox calls return executed:false / exitCode:null with an
 *   explicit not-executed error and NO fabricated output;
 * - backtest results are labelled dataSource:"synthetic", metrics are
 *   deterministic and genuinely computed, and uncomputable metrics are null.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SandboxService } from "../src/services/sandboxAgent";
import { SandboxRunCommand, QuantBacktestCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";

const stubContext = (auditLog: any[]) =>
  ({
    env: undefined,
    orm: undefined,
    sessionId: "test-session",
    audit: (type: string, agent: any, payload: Record<string, unknown>) =>
      auditLog.push({ type, agent, payload }),
  }) as any;

describe("run_sandbox_command — no backend bound (F6)", () => {
  it("service returns a not-executed result, never a bare exitCode-0 success", async () => {
    const svc = new SandboxService(undefined, undefined);
    const result = await svc.runCommand({ command: "echo hello" });

    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error).toContain("NOT executed");
    expect(result.error).toContain("no container sandbox backend is bound");
  });

  it("every command shape gets the same honest result (no python/node/echo special cases)", async () => {
    const svc = new SandboxService(undefined, undefined);
    for (const command of ["python3 calc.py", "node app.js", "ls -la", "rm -rf /tmp/x"]) {
      const result = await svc.runCommand({ command });
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe("");
    }
  });

  it("MCP command passes the honest result through and audits executed:false", async () => {
    const auditLog: any[] = [];
    const cmd = new SandboxRunCommand();
    const result = await cmd.execute({ command: "echo hi" }, stubContext(auditLog));

    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].type).toBe("sandbox.execute");
    expect(auditLog[0].payload.executed).toBe(false);
    expect(auditLog[0].payload.exitCode).toBeNull();
  });

  it("tool description discloses the no-backend behaviour up front", () => {
    const cmd = new SandboxRunCommand();
    expect(cmd.description).toContain("executed:false");
    expect(cmd.description).toContain("never emulated");
  });

  it("source pin: the emulated shell and its fabricated output strings are gone", () => {
    const src = readFileSync("src/services/sandboxAgent.ts", "utf-8");
    expect(src).not.toContain("runEmulatedSandbox");
    expect(src).not.toContain("Execution completed cleanly");
    expect(src).not.toContain("Command simulated successfully");
    expect(src).not.toContain("Executed command:");
  });
});

describe("run_quant_backtest — synthetic, labelled, genuinely computed (F7)", () => {
  it("carries the synthetic label and a plain-language note", async () => {
    const svc = new SandboxService(undefined, undefined);
    const result = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover", startBars: 100 });

    expect(result.dataSource).toBe("synthetic");
    expect(result.note).toContain("NOT historical market data for NVDA");
    expect(result.note).toContain("Synthetic demonstration");
    expect(result.codeExecuted).toContain("none");
    expect(result.codeExecuted).not.toContain("quant_backtest.py");
  });

  it("is deterministic: identical inputs produce identical results", async () => {
    const svc = new SandboxService(undefined, undefined);
    const a = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover", startBars: 100 });
    const b = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover", startBars: 100 });
    expect(b).toEqual(a);

    const c = await svc.runQuantBacktest({ symbol: "AAPL", strategy: "mean_reversion", startBars: 100 });
    const d = await svc.runQuantBacktest({ symbol: "AAPL", strategy: "mean_reversion", startBars: 100 });
    expect(d).toEqual(c);
  });

  it("pins the genuinely computed metrics for a fixed run (all three trades lose)", async () => {
    const svc = new SandboxService(undefined, undefined);
    const result = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover", startBars: 100 });

    // Hand-verifiable from the trade log: 3 closed trades, all losses.
    expect(result.totalTrades).toBe(3);
    expect(result.winRate).toBe(0);
    expect(result.profitFactor).toBe(0); // gross profit 0 over real gross loss — computed, not the old 2.5 default
    expect(result.sharpeRatio).toBe(-3.6); // from the equity curve — the old formula reported +1.2 here
    expect(result.maxDrawdownPct).toBe(31.1); // real peak-to-trough — the old code returned 4.5 + Math.random()*2
    expect(result.netReturnPct).toBe(-31.1);
    expect(result.logs).toContain("Bar 20: BUY NVDA at $144.70");
    expect(result.logs).toContain("Bar 87: SELL NVDA at $124.39 PnL: $-11.47");
  });

  it("reports uncomputable metrics as null instead of default-filling them", async () => {
    const svc = new SandboxService(undefined, undefined);
    // 10 bars < 20-bar slow SMA warmup → the strategy can never trade.
    const result = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover", startBars: 10 });

    expect(result.totalTrades).toBe(0); // not the old `trades || 8`
    expect(result.winRate).toBeNull(); // not the old 50.0 default
    expect(result.profitFactor).toBeNull(); // not the old 2.5 default
    expect(result.sharpeRatio).toBeNull(); // flat equity curve → zero return variance
    expect(result.maxDrawdownPct).toBe(0); // computable: equity never declined
    expect(result.netReturnPct).toBe(0); // computable: no trades, no return
  });

  it("mean-reversion family runs the disclosed shared rule and ledgers the end-of-series close", async () => {
    const svc = new SandboxService(undefined, undefined);
    const result = await svc.runQuantBacktest({ symbol: "AAPL", strategy: "mean_reversion", startBars: 100 });

    expect(result.dataSource).toBe("synthetic");
    expect(result.totalTrades).toBe(3);
    expect(result.winRate).toBe(66.7);
    expect(result.profitFactor).toBe(0.77);
    expect(result.note).toContain("share one simplified mean-reversion rule");
  });

  it("MCP command returns the labelled result and audits the data source", async () => {
    const auditLog: any[] = [];
    const cmd = new QuantBacktestCommand();
    const result = await cmd.execute({ symbol: "NVDA" }, stubContext(auditLog));

    expect(result.dataSource).toBe("synthetic");
    expect(auditLog[0].type).toBe("quant.backtest");
    expect(auditLog[0].payload.dataSource).toBe("synthetic");
  });

  it("tool description + schema never claim historical data", () => {
    const cmd = new QuantBacktestCommand();
    expect(cmd.description).toContain("SYNTHETIC");
    expect(cmd.description).toContain("NOT a backtest over historical market data");
    expect(JSON.stringify(cmd.jsonSchema)).not.toContain("historical bars");
    expect(JSON.stringify(cmd.jsonSchema)).toContain("synthetic");
  });

  it("source pin: no Math.random and no default-substituted metrics remain in the backtest path", () => {
    const src = readFileSync("src/services/sandboxAgent.ts", "utf-8");
    expect(src).not.toContain("Math.random");
    expect(src).not.toContain("trades || 8");
    expect(src).not.toContain("|| 14.8");
    expect(src).not.toContain("1.2 + (winRate / 100)"); // the old formula Sharpe
  });
});
