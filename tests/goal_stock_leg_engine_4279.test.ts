/**
 * Issue #4279 ([One engine] #3550 S4) — goal stock leg through the
 * one engine: goal dispatch becomes a CALLER on the S3 stock seam
 * (runStockScreenViaEngine), mirroring the options leg (#3186 step
 * 3c), instead of executing the stock leg inline through the
 * registry. The behavior pin: the same goal run through the seam
 * produces the SAME GoalDrivenScreenResult as through the registry
 * (same status, hits, counts, partial) — only the path changes.
 * The registry path stays intact (stockWorkflow absent) until
 * every entry migrates.
 *
 * The leg's run id is goal-screen:<idempotencyKey>:stocks, so a
 * retried goal run reuses the same leg run id. The leg job is a
 * market command built from the canonical goal stock spec
 * (goalStockSpecFromPlan — source "goal", universe ALL, deliver
 * false); the seam fans ALL out into the six engine shards and
 * the dispatcher maps the aggregate back onto the ScreeningResult
 * the composition already consumes. A symbol matched in two
 * shards is ONE hit (first shard wins) — the goal result's
 * contract is one hit per symbol, matching the direct leg.
 * A failed leg (no shard succeeded) throws, so the composition
 * records it as a failed class under the #462 partial contract,
 * exactly like a registry throw.
 */
import { describe, expect, it } from "vitest";
import { runGoalDrivenScreen, buildGoalScreenPlan } from "../src/services/goalDrivenScreen";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  ScreeningProviderRegistry,
  type ScreeningProvider,
  type ScreeningResult,
} from "../src/trading/screeningProvider";
import type {
  EngineScreenRunOutcome,
  RunStockScreenViaEngineInput,
} from "../src/workflows/runStockScreenViaEngine";
import {
  GOAL_SCREEN_AWAIT_DEADLINE_MS,
  runGoalScreenViaEngine,
} from "../src/workflows/runGoalScreenViaEngine";
import { MockSqlStorage } from "./mock-sql";
import { ensureScheduledReportsTable } from "../src/services/scheduledReports";
import type { ScreenerRunResult } from "../src/agents/screener-agent";
import type { StockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

function incomeScenario() {
  return buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

function stockResult(symbols: string[]): any {
  return {
    totalScanned: 500,
    matchedCount: symbols.length,
    stocks: symbols.map((symbol) => ({ symbol, lastPrice: 100 })),
    scannedAt: "2026-10-22T20:00:00.000Z",
  };
}

function fakeProvider(
  id: string,
  assetClass: "stocks" | "options",
  behavior: () => any,
): ScreeningProvider {
  return {
    id,
    assetClasses: [assetClass],
    async screen(): Promise<ScreeningResult> {
      const result = behavior();
      return { assetClass, providerId: id, result } as ScreeningResult;
    },
  };
}

function scannedStock(symbol: string, price = 100): any {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    signal: "bullish_breakout",
    momentumScore: 0.8,
    lastPrice: price,
    changePercent: 2.5,
    rsi14: 62,
    source: "etrade",
    indicators: {},
    factorGrades: {},
    technicals: {},
    sector: "technology",
  };
}

function shardResult(overrides: Partial<ScreenerRunResult> = {}): ScreenerRunResult {
  return {
    timestamp: "2026-11-12T18:00:00.000Z",
    trigger: "manual",
    provider: "etrade",
    universe: "NASDAQ100",
    sector: "ALL",
    success: true,
    totalScanned: 500,
    matchedCount: 1,
    opportunities: [],
    allStocks: [scannedStock("MSFT")],
    discoveryMessage: "",
    ...overrides,
  } as ScreenerRunResult;
}

/** A fake seam: captures its input, returns the canned outcome. */
function fakeSeam(outcome: EngineScreenRunOutcome) {
  const calls: RunStockScreenViaEngineInput[] = [];
  const fn = async (input: RunStockScreenViaEngineInput): Promise<EngineScreenRunOutcome> => {
    calls.push(input);
    return outcome;
  };
  return { fn, calls };
}

function engineOutcome(results: ScreenerRunResult[]): EngineScreenRunOutcome {
  return {
    results,
    collation: null,
    jobId: "goal-screen:test-key-4279:stocks",
    workflowId: "wf-test-4279",
  };
}

const NOW = new Date("2026-11-12T18:00:00.000Z");

describe("goal screen through the A2A seam (#4279)", () => {
  const GOAL_RESULT = {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: { momentum: "bullish_breakout" },
      optionsFilter: {},
    },
    status: "complete",
    hits: [{ assetClass: "stocks", providerId: "fake-stocks", symbol: "MSFT" }],
    counts: {
      stocksScanned: 500,
      stocksMatched: 1,
      optionsUnderlyingsScanned: 1,
      optionsContractsMatched: 2,
      hits: 2,
    },
    completedAt: "2026-11-12T18:00:00.000Z",
  };

  function seedCanonicalRow(sql: MockSqlStorage, reportId: string) {
    ensureScheduledReportsTable(sql as never);
    sql.exec(
      "INSERT INTO mas_reports (id, run_id, title, source, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      reportId,
      reportId,
      "Goal screen — income (bullish)",
      "goal_screen",
      "Goal screen (income/bullish) complete: 2 hit(s).",
      JSON.stringify({
        trigger: "manual",
        scenarioSource: "built",
        taskId: "task-1",
        result: GOAL_RESULT,
      }),
      "2026-11-12T18:00:00.000Z",
    );
  }

  function goalCollation(reportId: string): any {
    return {
      jobId: "goal-screen:a2a-k-1",
      workflowId: "wf-goal-1",
      lifecycle: "ReportGenerated",
      qualified: false,
      coverage: { evaluated: 1, considered: 1, ratio: 1 },
      shards: [
        {
          shardId: "goal",
          status: "completed",
          reportId,
          stored: true,
          delivered: false,
        },
      ],
      lifecycleTransitions: [],
      stageTransitions: [],
      reportKeys: [],
      storedShards: ["goal"],
      deliveredShards: [],
      childReportIds: [reportId],
    };
  }

  function collationRows(jobId: string, collation: unknown): any {
    return [
      {
        tenantId: "tenant-1",
        workspaceId: "ws-1",
        chainId: jobId,
        jobKey: jobId,
        version: 1,
        status: "completed",
        resultJson: JSON.stringify(collation),
      },
    ];
  }

  const TASK = {
    id: "task-1",
    idempotencyKey: "goal-screen:a2a-k-1",
    trigger: "manual",
    universe: "goal:income",
    sector: "long",
    status: "completed",
    createdAt: "2026-11-12T18:00:00.000Z",
    updatedAt: "2026-11-12T18:00:00.000Z",
    heartbeatAt: "2026-11-12T18:00:00.000Z",
    history: [],
  } as never;

  it("submits the goal command and returns the ledger task + stored result", async () => {
    const sql = new MockSqlStorage();
    seedCanonicalRow(sql, "goal-screen:task-1");
    const starts: unknown[] = [];
    const outcome = await runGoalScreenViaEngine({
      env: {} as never,
      submission: {
        jobId: "goal-screen:a2a-k-1",
        source: "a2a",
        trigger: "manual",
        userLogin: "svc-user",
        scenario: incomeScenario() as never,
        scenarioSource: "built",
        assetClasses: ["stocks", "options"],
        symbols: ["AAPL"],
        provider: "yahoo",
        baseStockFilter: { momentum: "bullish_breakout" } as never,
      },
      getSql: () => sql as never,
      readTask: async (key) => (key === "goal-screen:a2a-k-1" ? TASK : null),
      startWorkflow: async (_env, command) => {
        starts.push(command);
        return {
          workflowId: "wf-goal-1",
          jobId: command.jobId,
          status: "queued",
          existing: false,
          statusUrl: "/api/jobs/history?chainId=goal-screen%3Aa2a-k-1",
        } as never;
      },
      readWorkflowJobHistory: async () => collationRows("goal-screen:a2a-k-1", goalCollation("goal-screen:task-1")),
      sleep: async () => undefined,
      nowMs: () => Date.parse("2026-11-12T18:00:00.000Z"),
    });
    expect(outcome.executed).toBe(true);
    expect(outcome.task.id).toBe("task-1");
    expect(outcome.result?.status).toBe("complete");
    expect(outcome.result?.counts.hits).toBe(2);
    expect(starts).toHaveLength(1);
    const command = starts[0] as any;
    expect(command.jobId).toBe("goal-screen:a2a-k-1");
    expect(command.goalScreen.scenario.goalKind).toBe("income");
    expect(command.goalScreen.assetClasses).toEqual(["stocks", "options"]);
    expect(command.goalScreen.symbols).toEqual(["AAPL"]);
    expect(command.goalScreen.provider).toBe("yahoo");
    expect(command.goalScreen.baseStockFilter).toEqual({ momentum: "bullish_breakout" });
  });

  it("a duplicate submission returns executed:false with the existing outcome", async () => {
    const sql = new MockSqlStorage();
    seedCanonicalRow(sql, "goal-screen:task-1");
    const outcome = await runGoalScreenViaEngine({
      env: {} as never,
      submission: {
        jobId: "goal-screen:a2a-k-1",
        source: "a2a",
        trigger: "manual",
        userLogin: "svc-user",
        scenario: incomeScenario() as never,
        scenarioSource: "built",
      },
      getSql: () => sql as never,
      readTask: async () => TASK,
      startWorkflow: async (_env, command) => ({
        workflowId: "wf-goal-1",
        jobId: command.jobId,
        status: "queued",
        existing: true,
        statusUrl: "/api/jobs/history?chainId=goal-screen%3Aa2a-k-1",
      }) as never,
      readWorkflowJobHistory: async () => collationRows("goal-screen:a2a-k-1", goalCollation("goal-screen:task-1")),
      sleep: async () => undefined,
      nowMs: () => Date.parse("2026-11-12T18:00:00.000Z"),
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.task.id).toBe("task-1");
    expect(outcome.result?.status).toBe("complete");
  });

  it("a job that completes without a canonical row throws honestly", async () => {
    const sql = new MockSqlStorage();
    const failed = goalCollation("goal-screen:task-1");
    failed.lifecycle = "Failed";
    failed.error = "analysis stage threw";
    failed.childReportIds = [];
    failed.shards = [{ shardId: "goal", status: "failed", error: "analysis stage threw" }];
    await expect(
      runGoalScreenViaEngine({
        env: {} as never,
        submission: {
          jobId: "goal-screen:a2a-k-1",
          source: "a2a",
          trigger: "manual",
          userLogin: "svc-user",
          scenario: incomeScenario() as never,
          scenarioSource: "built",
        },
        getSql: () => sql as never,
        readTask: async () => null,
        startWorkflow: async (_env, command) => ({
          workflowId: "wf-goal-1",
          jobId: command.jobId,
          status: "queued",
          existing: false,
          statusUrl: "/api/jobs/history?chainId=goal-screen%3Aa2a-k-1",
        }) as never,
        readWorkflowJobHistory: async () => collationRows("goal-screen:a2a-k-1", failed),
        sleep: async () => undefined,
        nowMs: () => Date.parse("2026-11-12T18:00:00.000Z"),
      }),
    ).rejects.toThrow(/without storing a canonical report.*analysis stage threw/);
  });

  it("a deadline expiry throws the still-running failure with the status URL", async () => {
    const sql = new MockSqlStorage();
    const t0 = Date.parse("2026-11-12T18:00:00.000Z");
    let calls = 0;
    await expect(
      runGoalScreenViaEngine({
        env: {} as never,
        submission: {
          jobId: "goal-screen:a2a-k-1",
          source: "a2a",
          trigger: "manual",
          userLogin: "svc-user",
          scenario: incomeScenario() as never,
          scenarioSource: "built",
        },
        getSql: () => sql as never,
        readTask: async () => null,
        startWorkflow: async (_env, command) => ({
          workflowId: "wf-goal-1",
          jobId: command.jobId,
          status: "queued",
          existing: false,
          statusUrl: "/api/jobs/history?chainId=goal-screen%3Aa2a-k-1",
        }) as never,
        readWorkflowJobHistory: async () => null,
        sleep: async () => undefined,
        nowMs: () => {
          calls += 1;
          return calls === 1 ? t0 : t0 + GOAL_SCREEN_AWAIT_DEADLINE_MS + 1;
        },
        awaitDeadlineMs: GOAL_SCREEN_AWAIT_DEADLINE_MS,
      }),
    ).rejects.toThrow(/did not complete within the engine await window; it remains tracked at \/api\/jobs\/history\?chainId=goal-screen%3Aa2a-k-1/);
  });
});

describe("goal stock leg through the one engine (#4279)", () => {
  it("produces the same goal result as the registry path", async () => {
    const registryPath = new ScreeningProviderRegistry();
    registryPath.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    registryPath.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 1,
        matchedCount: 2,
        contracts: [{ underlyingSymbol: "AAPL" }, { underlyingSymbol: "AAPL" }],
        status: "complete",
      })),
    );
    const viaRegistry = await runGoalDrivenScreen({
      registry: registryPath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
    });

    const seam = fakeSeam(engineOutcome([shardResult()]));
    const enginePath = new ScreeningProviderRegistry();
    enginePath.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    enginePath.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 1,
        matchedCount: 2,
        contracts: [{ underlyingSymbol: "AAPL" }, { underlyingSymbol: "AAPL" }],
        status: "complete",
      })),
    );
    const viaEngine = await runGoalDrivenScreen({
      registry: enginePath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => {
            throw new Error("gates must not be called through the injected seam");
          },
          chargeScreenQuota: () => {
            throw new Error("gates must not be called through the injected seam");
          },
          getHistory: async () => {
            throw new Error("gates must not be called through the injected seam");
          },
        },
        runStockScreen: seam.fn,
      },
    });

    expect(viaEngine).toEqual(viaRegistry);
    expect(viaEngine.status).toBe("complete");
    expect(viaEngine.counts.stocksScanned).toBe(500);
    expect(viaEngine.counts.stocksMatched).toBe(1);
    expect(viaEngine.hits).toContainEqual(
      expect.objectContaining({ assetClass: "stocks", providerId: "fake-stocks", symbol: "MSFT" }),
    );
    // The leg dispatched the canonical goal stock spec through the seam.
    expect(seam.calls).toHaveLength(1);
    const spec = seam.calls[0].spec as StockScreenRunSpec;
    expect(spec.source).toBe("goal");
    expect(spec.universe).toBe("ALL");
    expect(spec.deliver).toBe(false);
    expect(spec.goalId).toBe("test-key-4279");
    expect(spec.userLogin).toBe("owner@example.com");
    expect(spec.filters).toEqual(buildGoalScreenPlan(incomeScenario(), { symbols: ["AAPL"] }).stockFilter);
    expect(seam.calls[0].commandOverrides?.jobId).toBe("goal-screen:test-key-4279:stocks");
    expect(seam.calls[0].commandOverrides?.provider).toBeUndefined();
    expect(seam.calls[0].userLogin).toBe("owner@example.com");
  });

  it("forwards the yahoo provider as an override, never on the spec", async () => {
    const seam = fakeSeam(engineOutcome([shardResult({ matchedCount: 0, allStocks: [] })]));
    const registry = new ScreeningProviderRegistry();
    registry.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    registry.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "complete",
      })),
    );
    const result = await runGoalDrivenScreen({
      registry,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279-yahoo",
      provider: "yahoo",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
          chargeScreenQuota: () => undefined,
          getHistory: async () => [],
        },
        runStockScreen: seam.fn,
      },
    });
    expect(result.status).toBe("complete");
    expect(seam.calls).toHaveLength(1);
    // The canonical spec keeps provider unset (goal-owned); the
    // runtime provider rides the seam override.
    expect((seam.calls[0].spec as StockScreenRunSpec).provider).toBeUndefined();
    expect(seam.calls[0].commandOverrides?.provider).toBe("yahoo");
    expect(seam.calls[0].commandOverrides?.jobId).toBe("goal-screen:test-key-4279-yahoo:stocks");
  });

  it("a symbol matched in two shards is one hit", async () => {
    const seam = fakeSeam(
      engineOutcome([
        shardResult({ universe: "NASDAQ100", totalScanned: 300, matchedCount: 1 }),
        shardResult({
          universe: "SP500",
          totalScanned: 400,
          matchedCount: 1,
          allStocks: [scannedStock("MSFT", 101)],
        }),
      ]),
    );
    const registry = new ScreeningProviderRegistry();
    registry.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    registry.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "complete",
      })),
    );
    const result = await runGoalDrivenScreen({
      registry,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279-dedupe",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
          chargeScreenQuota: () => undefined,
          getHistory: async () => [],
        },
        runStockScreen: seam.fn,
      },
    });
    expect(result.status).toBe("complete");
    // Scanned sums across shards (the overlap is not derivable from
    // the aggregates); matched dedupes to one hit per symbol.
    expect(result.counts.stocksScanned).toBe(700);
    expect(result.counts.stocksMatched).toBe(1);
    expect(result.hits.filter((h) => h.assetClass === "stocks")).toHaveLength(1);
    expect(result.hits).toContainEqual(
      expect.objectContaining({ assetClass: "stocks", symbol: "MSFT" }),
    );
  });

  it("a failing stock leg is a qualified partial on both paths", async () => {
    const registryPath = new ScreeningProviderRegistry();
    registryPath.register(fakeProvider("fake-stocks", "stocks", () => ({ status: "no_universe" })));
    registryPath.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 1,
        matchedCount: 1,
        contracts: [{ underlyingSymbol: "AAPL" }],
        status: "complete",
      })),
    );
    const viaRegistry = await runGoalDrivenScreen({
      registry: registryPath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
    });
    expect(viaRegistry.status).toBe("partial");
    expect(viaRegistry.partial?.failedClasses).toEqual(["stocks"]);

    const seam = fakeSeam(
      engineOutcome([shardResult({ success: false, totalScanned: 0, matchedCount: 0, allStocks: [], error: "shard blew up" })]),
    );
    const enginePath = new ScreeningProviderRegistry();
    enginePath.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    enginePath.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 1,
        matchedCount: 1,
        contracts: [{ underlyingSymbol: "AAPL" }],
        status: "complete",
      })),
    );
    const viaEngine = await runGoalDrivenScreen({
      registry: enginePath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279-fail",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
          chargeScreenQuota: () => undefined,
          getHistory: async () => [],
        },
        runStockScreen: seam.fn,
      },
    });
    expect(viaEngine.status).toBe("partial");
    expect(viaEngine.partial?.failedClasses).toEqual(["stocks"]);
    expect(viaEngine.partial?.reasons.stocks).toMatch(/shard blew up/);
  });

  it("a no-matches stock leg is a legitimate complete, not a partial", async () => {
    const seam = fakeSeam(engineOutcome([shardResult({ matchedCount: 0, allStocks: [] })]));
    const registry = new ScreeningProviderRegistry();
    registry.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    registry.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 1,
        matchedCount: 1,
        contracts: [{ underlyingSymbol: "AAPL" }],
        status: "complete",
      })),
    );
    const result = await runGoalDrivenScreen({
      registry,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279-empty",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
          chargeScreenQuota: () => undefined,
          getHistory: async () => [],
        },
        runStockScreen: seam.fn,
      },
    });
    expect(result.status).toBe("complete");
    expect(result.counts.stocksMatched).toBe(0);
    expect(result.partial).toBeUndefined();
  });

  it("both legs failing is a failure", async () => {
    const seam = fakeSeam(
      engineOutcome([shardResult({ success: false, totalScanned: 0, matchedCount: 0, allStocks: [], error: "leg down" })]),
    );
    const registry = new ScreeningProviderRegistry();
    registry.register(
      fakeProvider("fake-stocks", "stocks", () => {
        throw new Error("registry stocks screen must not be called on the engine path");
      }),
    );
    registry.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "error",
        validationError: "options leg down",
      })),
    );
    const result = await runGoalDrivenScreen({
      registry,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-4279-both-fail",
      stockWorkflow: {
        env: {} as never,
        agent: {
          isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
          chargeScreenQuota: () => undefined,
          getHistory: async () => [],
        },
        runStockScreen: seam.fn,
      },
    });
    expect(result.status).toBe("failed");
    expect(result.partial?.failedClasses).toEqual(["stocks", "options"]);
  });
});
