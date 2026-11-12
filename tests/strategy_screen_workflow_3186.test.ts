/**
 * Issue #3186 (step 3e) - the strategy leg's behavior pin: the panel
 * path through the one pipeline reproduces runPanelPipelineRetired4068 EXACTLY.
 * Same fake agents + same request on both paths; the pipeline's
 * shapeReport artifact, mapped through runPanelWithAgents' own
 * mapping, deep-equals the direct PipelineResult.
 *
 * The fakes replace ONLY the three agents (data / risk /
 * recommender). The kernel, the gates, and the stage wiring are real
 * on both paths - so a wiring mistake (wrong artifact, wrong order,
 * dropped field) fails here, not in production.
 */
import { describe, expect, it } from "vitest";
import { runPanelWithAgents } from "../src/trading/options/panelPipeline";
import { createStrategyScreenPorts } from "../src/workflows/strategyScreenPorts";
import { runOptionsScreenWorkflow } from "../src/workflows/optionsScreenWorkflow";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async <T>(key: string) => map.get(key) as T | undefined,
    keys: () => [...map.keys()],
  };
}

const EXPIRY = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

function fakeAgents() {
  const candidate = {
    id: "bull-call-spread",
    type: "bull_call_spread",
    label: "Bull call spread",
    symbol: "AAPL",
    score: 0.8,
    legs: [
      {
        optionType: "CALL",
        side: "BUY",
        strike: 100,
        expirationDate: EXPIRY,
        daysToExpiration: 30,
        bid: 1.05,
        ask: 1.1,
        impliedVolatility: 0.25,
        volume: 100,
        openInterest: 500,
        quantity: 1,
        quoteTimestamp: new Date().toISOString(),
      },
    ],
  };
  return {
    data: {
      loadSnapshot: async () => ({
        symbol: "AAPL",
        contracts: [
          {
            underlyingSymbol: "AAPL",
            optionType: "CALL",
            strike: 100,
            expirationDate: EXPIRY,
            bid: 1.05,
            ask: 1.1,
            openInterest: 500,
            volume: 100,
            underlyingPrice: 100,
          },
        ],
        dataSource: "live" as const,
        screen: { contractsEvaluated: 1, contractsMatched: 1 },
        rejections: [],
      }),
    },
    risk: {
      buildStrategies: () => ({ candidates: [candidate] }),
      screenStrategies: (candidates: unknown[]) => ({ matched: candidates, rejected: [] }),
      riskReport: (c: unknown) => ({ candidate: c, violation: false }),
    },
    recommender: {
      rank: (candidates: unknown[]) =>
        (candidates as unknown[]).map((c, i) => ({ candidate: c, rank: i + 1 })),
      pickBestTrade: (candidates: unknown[]) => ({ pick: (candidates as unknown[])[0] ?? null }),
    },
  };
}

function toPipelineResult(panel: Record<string, any>): Record<string, unknown> {
  const snapshot = panel.snapshot as Record<string, any>;
  return {
    snapshot: {
      symbol: snapshot.symbol,
      contracts: snapshot.contracts ?? [],
      dataSource: snapshot.dataSource,
      screen: snapshot.screen,
      rejections: snapshot.rejections,
      validationError: snapshot.validationError,
    },
    // The direct PipelineResult carries strategies directly; the panel
    // result carries it under legacy.buildResult. Same object either way.
    strategies: panel.strategies ?? panel.legacy?.buildResult,
    screenedOut: panel.screenedOut,
    ranked: panel.ranked,
    riskReports: panel.riskReports,
    bestTrade: panel.bestTrade,
  };
}

describe("strategy leg through the one pipeline (#3186 step 3e)", () => {
  it("reproduces runPanelPipelineRetired4068 exactly", async () => {
    const agents = fakeAgents();
    const request = {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      minDte: 21,
      maxDte: 60,
    };
    const direct = await runPanelWithAgents(agents as never, request as never, {
      riskProfile: "balanced",
      alternatives: 3,
    });

    const storage = memoryStorage();
    const sent: Array<{ stageId: string; family: string }> = [];
    const outcome = await runOptionsScreenWorkflow(
      {
        runId: "strategy-panel-1",
        userLogin: "owner@example.com",
        request: {
          assetClass: "options",
          runIdentity: { runId: "strategy-panel-1" },
          trigger: "manual",
          classInput: {
            strategyRequest: request,
            riskProfile: "balanced",
            alternatives: 3,
          },
        },
      },
      {
        stages: createStrategyScreenPorts({ agents: agents as never, storage }),
        claims: { has: () => false, add: () => undefined },
        queue: { send: async (body: unknown) => {
          const message = body as { stageId: string; family: string };
          sent.push({ stageId: message.stageId, family: message.family });
        } },
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(sent.map((m) => m.stageId)).toEqual([
      "plan",
      "chainFetch",
      "enrich",
      "screen",
      "risk",
      "persistCanonicalResults",
      "shapeReport",
      "deliver",
    ]);
    expect(sent.every((m) => m.family === "options")).toBe(true);
    expect(storage.keys()).toHaveLength(8);

    const shapeReport = await storage.get<{ snapshot: Record<string, any>; ranked: unknown; riskReports: unknown; bestTrade: unknown; screenedOut: unknown; legacy: unknown }>(
      "options:strategy-panel-1:shapeReport",
    );
    expect(shapeReport).toBeDefined();
    // The shapeReport artifact IS the panel result (the kernel result
    // spread at top level); map it through runPanelWithAgents' own
    // mapping and compare with the direct run.
    const viaPipeline = toPipelineResult({
      snapshot: shapeReport!.snapshot,
      legacy: shapeReport!.legacy,
      screenedOut: shapeReport!.screenedOut,
      ranked: shapeReport!.ranked,
      riskReports: shapeReport!.riskReports,
      bestTrade: shapeReport!.bestTrade,
    });
    expect(viaPipeline).toEqual(toPipelineResult(direct as unknown as Record<string, any>));
  });

  it("fails closed on a panel request without a symbol", async () => {
    const storage = memoryStorage();
    const outcome = await runOptionsScreenWorkflow(
      {
        runId: "strategy-panel-no-symbol",
        userLogin: "owner@example.com",
        request: {
          assetClass: "options",
          runIdentity: { runId: "strategy-panel-no-symbol" },
          trigger: "manual",
          classInput: { strategyRequest: { thesis: "bullish" } },
        },
      },
      {
        stages: createStrategyScreenPorts({ agents: fakeAgents() as never, storage }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.failedStage).toBe("plan");
    expect(outcome.reason).toMatch(/missing symbol/);
  });
});
