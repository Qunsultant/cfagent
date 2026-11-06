/**
 * Issue #3186 step 3c - goal-leg caller migration: goal dispatch
 * becomes a CALLER on the one options pipeline (Venus's #2038 Q1
 * ruling), instead of executing the options leg inline through the
 * registry. The behavior pin: the same goal run through the pipeline
 * produces the SAME GoalDrivenScreenResult as through the registry
 * (same status, hits, counts, partial) - only the path changes.
 * The registry path stays intact (optionsWorkflow absent) until
 * every entry migrates.
 *
 * The leg's run id is goal-screen:<idempotencyKey>:options, so a
 * retried goal run reuses the same leg run id and the stage claims
 * make the retry skip already-claimed stages. The leg's shapeReport
 * is the leg's report section (evidence for the goal report, which
 * the goal run still generates); the leg's deliver records the
 * handoff to the goal run's delivery (email + Slack + UI in
 * executeGoalScreenRun) - the leg does not deliver itself.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { runGoalDrivenScreen, buildGoalScreenPlan } from "../src/services/goalDrivenScreen";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  ScreeningProviderRegistry,
  type ScreeningProvider,
  type ScreeningResult,
} from "../src/trading/screeningProvider";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";
import { optionsArtifactKey, type OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
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

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("goal options leg through the one pipeline (#3186 step 3c)", () => {
  it("produces the same goal result as the registry path", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    // The registry fake must screen the PLAN's filter (the pipeline
    // runs the plan's filter) - a bare filter would be a different
    // screen and the pin would compare two different runs.
    const planFilter = buildGoalScreenPlan(incomeScenario(), { symbols: ["AAPL"] }).optionsFilter;
    const direct = await screener.screenOptions(planFilter);
    const now = new Date("2026-11-04T23:30:00.000Z");

    const registryPath = new ScreeningProviderRegistry();
    registryPath.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    registryPath.register(fakeProvider("fake-options", "options", () => direct));
    const viaRegistry = await runGoalDrivenScreen({
      registry: registryPath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now,
    });

    const storage = memoryStorage();
    const pipelinePath = new ScreeningProviderRegistry();
    pipelinePath.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    pipelinePath.register(
      fakeProvider("fake-options", "options", () => {
        throw new Error("registry options screen must not be called on the pipeline path");
      }),
    );
    const viaPipeline = await runGoalDrivenScreen({
      registry: pipelinePath,
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-3c",
      optionsWorkflow: {
        screener,
        storage,
        ...createGoalOptionsLegDelivery({ goalRunId: "goal-screen:test-key-3c" }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    });

    expect(viaPipeline).toEqual(viaRegistry);
    expect(viaPipeline.status).toBe("complete");
    expect(viaPipeline.counts.optionsUnderlyingsScanned).toBe(1);
    expect(viaPipeline.counts.optionsContractsMatched).toBe(2);
    // The pipeline left its evidence: all eight stage artifacts +
    // the leg's canonical record (built in-memory, NOT written — the
    // leg writes no mas_reports row; the goal run's row is the single
    // canonical home, #783).
    expect(storage.keys()).toHaveLength(8);
    const persistArtifact = await storage.get<{
      created: boolean;
      reportId: string | null;
      record: { runId: string; summary: string };
    }>(optionsArtifactKey("goal-screen:test-key-3c:options", "persistCanonicalResults"));
    expect(persistArtifact?.created).toBe(false);
    expect(persistArtifact?.reportId).toBeNull();
    expect(persistArtifact?.record.runId).toBe("goal-screen:test-key-3c:options");
    expect(persistArtifact?.record.summary).toBeTruthy();
    const shapeArtifact = await storage.get<{
      report: { reportId: string | null; created: boolean; summary: string };
    }>(optionsArtifactKey("goal-screen:test-key-3c:options", "shapeReport"));
    expect(shapeArtifact?.report.reportId).toBeNull();
    expect(shapeArtifact?.report.created).toBe(false);
    expect(shapeArtifact?.report.summary).toBe(persistArtifact?.record.summary);
    const deliverArtifact = await storage.get<{ deliveryState: Record<string, unknown> }>(
      optionsArtifactKey("goal-screen:test-key-3c:options", "deliver"),
    );
    expect((deliverArtifact?.deliveryState as { deliveryState?: string }).deliveryState).toBe(
      "deferred-to-goal-run",
    );
  });

  it("a failing options leg is a qualified partial on both paths", async () => {
    const now = new Date("2026-11-04T23:30:00.000Z");
    const registryPath = new ScreeningProviderRegistry();
    registryPath.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    registryPath.register(
      fakeProvider("fake-options", "options", () => ({
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "error",
        validationError:
          "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains.",
      })),
    );
    const viaRegistry = await runGoalDrivenScreen({
      registry: registryPath,
      scenario: incomeScenario(),
      now,
    });
    expect(viaRegistry.status).toBe("partial");
    expect(viaRegistry.partial?.failedClasses).toEqual(["options"]);

    const pipelinePath = new ScreeningProviderRegistry();
    pipelinePath.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    pipelinePath.register(
      fakeProvider("fake-options", "options", () => {
        throw new Error("registry options screen must not be called on the pipeline path");
      }),
    );
    const viaPipeline = await runGoalDrivenScreen({
      registry: pipelinePath,
      scenario: incomeScenario(),
      now,
      userLogin: "owner@example.com",
      trigger: "manual",
      idempotencyKey: "test-key-3c-fail",
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: memoryStorage(),
        ...createGoalOptionsLegDelivery({ goalRunId: "goal-screen:test-key-3c-fail" }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    });
    expect(viaPipeline.status).toBe("partial");
    expect(viaPipeline.partial?.failedClasses).toEqual(["options"]);
    expect(viaPipeline.partial?.reasons.options).toMatch(/Specify underlying symbols/);
  });
});
