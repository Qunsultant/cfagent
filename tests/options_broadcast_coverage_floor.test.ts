/**
 * Issue #1718: coverage floor for scheduled options BROADCAST.
 *
 * A partial options run below the floor (evaluated/considered < 0.5)
 * must NOT be broadcast as "✅ Screen completed" with a success report
 * link on any notification surface. Instead its notification is a
 * degraded notice naming coverage and the top skip reason. At or above
 * the floor behavior is exactly today's, and zero evaluated still takes
 * the FAILURE_SCREEN_NO_CONTRACTS_EVALUATED gate (unchanged).
 *
 * RED first: the floor helpers, the lifecycle gate, the outcome
 * plumbing, and the direct-Slack branch do not exist yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import {
  OPTIONS_BROADCAST_COVERAGE_FLOOR,
  optionsCoverageBelowBroadcastFloor,
  formatDegradedCoverageNotice,
  formatLifecycleNotification,
  formatUndeliverableNotification,
  screenerOutcomeFromEvent,
  screenerOutcomeFromRunResult,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import type { OptionsPartialQualification } from "../src/trading/options/opportunityScanner";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import type { Env } from "../src/types";
import { ETradeRestClient } from "../src/trading/etrade/client";
import type { ETradeOptionChain } from "../src/trading/etrade/client";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { StrategyRiskAgent } from "../src/trading/options/strategyRiskAgent";
import { RecommendationAgent } from "../src/trading/options/recommendationAgent";
import {
  runOptionsScreenWorkflow,
  memoryStageStorage,
  memoryStageClaims,
} from "../src/workflows/optionsScreenWorkflow";
import { createScannerScreenPorts } from "../src/workflows/strategyScreenPorts";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";

const mockDeliverGatedSlack = vi.mocked(deliverGatedSlack);

// #3186 step 3e: the scheduled monolithic scan runs the one scanner
// pipeline over the real UnifiedOptionsService — the old
// FakeUnifiedOptionsService (execute()-only) is deleted, and chain
// data is stubbed at the ETradeRestClient prototype instead (the
// tests/scheduled_options_pipeline_3186.test.ts pattern). Chain
// fixtures are the pin test's chainFor shape, which the scanner
// pipeline parses (selectedExpiry as a string, legs with `strike`).

vi.mock("../src/services/gatedSlackDelivery", () => ({
  deliverGatedSlack: vi.fn(async () => ({ ok: true as const })),
}));

const NOW = Date.now();
const expiryDateObj = new Date(NOW + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

function chainFor(symbol: string, spot: number) {
  const expiry = `${expiryObj.year}-${String(expiryObj.month).padStart(2, "0")}-${String(expiryObj.day).padStart(2, "0")}`;
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const deltaMag = 0.5;
    const mid = 5;
    return {
      symbol,
      optionType: type,
      strike,
      expirationDate: expiry,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

class MockKVNamespace {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const partial = (
  over: Partial<OptionsPartialQualification> = {},
): OptionsPartialQualification => ({
  evaluatedCount: 3,
  consideredCount: 100,
  coverageErrors: 97,
  truncatedCount: 0,
  topSkipReason: "OAuth Token Missing",
  topSkipCount: 97,
  ...over,
});

const optionsOutcome = (
  over: Partial<ScreenerRunOutcome> = {},
): ScreenerRunOutcome => ({
  kind: "options",
  trigger: "scheduled",
  success: true,
  pdfKeys: ["options-report.pdf"],
  pdfStatus: "generated",
  reportUrl: "https://agent.openaimp.com/api/options/report.pdf?key=options-report.pdf",
  thesis: "bullish",
  totalScanned: 100,
  summary: "Opportunity scan across 100 symbols: found 3 actionable trade setups. Partial coverage — qualified partial results: evaluated 3 of 100 underlyings (97 failures, 0 truncated).",
  ...over,
});

describe("broadcast coverage floor", () => {
  it("is a single named constant at 0.5", () => {
    expect(OPTIONS_BROADCAST_COVERAGE_FLOOR).toBe(0.5);
  });

  it("flags below-floor partials and only those", () => {
    expect(optionsCoverageBelowBroadcastFloor(undefined)).toBe(false);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 100, consideredCount: 100 }))).toBe(false);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 50, consideredCount: 100 }))).toBe(false);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 75, consideredCount: 100 }))).toBe(false);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 3, consideredCount: 100 }))).toBe(true);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 0, consideredCount: 100 }))).toBe(true);
    expect(optionsCoverageBelowBroadcastFloor(partial({ evaluatedCount: 0, consideredCount: 0 }))).toBe(false);
  });

  it("degraded notice names coverage, failures, and the top skip reason — with no success text or report link", () => {
    const notice = formatDegradedCoverageNotice(partial(), "Options screen", "bullish");
    expect(notice).toContain("3 of 100");
    expect(notice).toContain("97");
    expect(notice).toContain("OAuth Token Missing");
    expect(notice).not.toContain("✅");
    expect(notice).not.toContain("Screen completed");
    expect(notice).not.toContain("completed");
    expect(notice).not.toContain("Report:");
    expect(notice).not.toContain("http");
  });

  it("degraded notice omits the reason line when no top skip reason is stamped", () => {
    const { topSkipReason: _r, topSkipCount: _c, ...noReason } = partial();
    const notice = formatDegradedCoverageNotice(noReason, "Options screen", "bullish");
    expect(notice).toContain("3 of 100");
    expect(notice).not.toContain("Top skip reason");
    expect(notice).not.toContain("completed");
  });
});

describe("lifecycle completed notification under the floor", () => {
  it("below floor renders the degraded notice, not success, and no report link", () => {
    const text = formatLifecycleNotification("completed", optionsOutcome({ partial: partial() }));
    expect(text).toContain("3 of 100");
    expect(text).toContain("97");
    expect(text).toContain("OAuth Token Missing");
    expect(text).not.toContain("✅");
    expect(text).not.toContain("Screen completed");
    expect(text).not.toContain("completed");
    expect(text).not.toContain("report.pdf");
  });

  it("at the floor renders exactly today's completed delivery", () => {
    const text = formatLifecycleNotification(
      "completed",
      optionsOutcome({ partial: partial({ evaluatedCount: 50, consideredCount: 100, coverageErrors: 50, topSkipCount: 50 }) }),
    );
    expect(text).toContain("✅ Screen completed");
    expect(text).toContain("📄 Report: https://agent.openaimp.com/api/options/report.pdf?key=options-report.pdf");
  });

  it("above the floor a qualified partial still renders today's completed delivery", () => {
    const text = formatLifecycleNotification(
      "completed",
      optionsOutcome({ partial: partial({ evaluatedCount: 75, consideredCount: 100, coverageErrors: 25, topSkipCount: 25 }) }),
    );
    expect(text).toContain("✅ Screen completed");
    expect(text).toContain("📄 Report:");
  });

  it("stock outcomes are unchanged even if a partial were ever attached", () => {
    const stock: ScreenerRunOutcome = {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["k1"],
      pdfStatus: "generated",
      matchedCount: 2,
      totalScanned: 50,
      universe: "NASDAQ100",
      reportUrl: "/api/screener/report.pdf?key=k1",
      partial: partial(),
    };
    const text = formatLifecycleNotification("completed", stock);
    expect(text).toContain("✅ Screen completed");
    expect(text).toContain("2 matched");
  });

  it("failed notifications are untouched by the floor", () => {
    const text = formatLifecycleNotification("failed", {
      ...optionsOutcome({ partial: partial() }),
      success: false,
      error: "E*TRADE unavailable",
    });
    expect(text).toContain("failed");
    expect(text).toContain("E*TRADE unavailable");
    expect(text).not.toContain("degraded");
  });

  it("undeliverable notices degrade below the floor too", () => {
    const text = formatUndeliverableNotification(optionsOutcome({ partial: partial() }), "PDF missing");
    expect(text).not.toContain("✅");
    expect(text).not.toContain("completed");
    expect(text).toContain("3 of 100");
    const atFloor = formatUndeliverableNotification(
      optionsOutcome({ partial: partial({ evaluatedCount: 50, consideredCount: 100, coverageErrors: 50, topSkipCount: 50 }) }),
      "PDF missing",
    );
    expect(atFloor).toContain("✅ Screen completed");
    expect(atFloor).toContain("No report is attached: PDF missing");
  });
});

describe("outcome plumbing carries the qualification", () => {
  it("options.completed bus events carry partial into the outcome", () => {
    const outcome = screenerOutcomeFromEvent({
      type: "options.completed",
      timestamp: new Date().toISOString(),
      trigger: "scheduled",
      thesis: "bullish",
      totalScanned: 100,
      withTrades: 3,
      symbols: ["AAPL"],
      summary: "summary",
      reportUrl: "https://agent.openaimp.com/api/options/report.pdf?key=k",
      opportunities: [],
      partial: partial(),
    } as any);
    expect(outcome.kind).toBe("options");
    expect(outcome.partial).toEqual(partial());
  });

  it("run-result outcomes carry a well-shaped partial and drop a malformed one", () => {
    const carried = screenerOutcomeFromRunResult("options", {
      success: true,
      trigger: "scheduled",
      thesis: "bullish",
      partial: partial(),
    });
    expect(carried.partial).toEqual(partial());
    const dropped = screenerOutcomeFromRunResult("options", {
      success: true,
      trigger: "scheduled",
      thesis: "bullish",
      partial: { evaluatedCount: "three" },
    });
    expect(dropped.partial).toBeUndefined();
  });
});

describe("direct Slack delivery in autonomousOptionsAnalysis", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let env: Env;
  const sessionId = "coverage_floor_test_trader";

  beforeEach(() => {
    mockDeliverGatedSlack.mockClear();
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    const mockKv = new MockKVNamespace();
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: mockKv as any,
      SESSION_STORE: sessionStoreNs,
      SEARCH_AGENT: {} as any,
      SCREENER_AGENT: {
        idFromName: () => "mock-screener-id",
        get: () => ({
          runScreen: async () => ({ success: true }),
          claimScheduledExecution: async () => true,
        }),
      },
    } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Issue #1785 routes scheduled runs with more than floor(35/12) = 2
  // symbols to the sharded branch, so these direct-Slack tests exercise
  // the monolithic branch with 2 symbols.
  //
  // #3186 re-pin: the old tests injected arbitrary partials (3/100,
  // 50/100, 75/100) through a fake execute() seam. Through the real
  // pipeline only three coverage shapes are reachable with 2 symbols —
  // 0/2 (takes the FAILURE gate before any delivery), 1/2 (exactly at
  // the 0.5 floor), 2/2 (above it) — and the success delivery text is
  // the real shared summary ("Opportunity scan across 2 symbols..."),
  // not the fake's "✅ Screen completed" string. A below-floor partial
  // is unreachable through this entry point (the sharded branch returns
  // before delivery), so the below-floor shape is pinned at the
  // pipeline level in the next describe, and the degraded-notice
  // rendering stays pinned at the formatter level above.
  const symbolsMonolithic = ["SYM000", "SYM001"];

  async function runScheduled(spots: Record<string, number>) {
    vi.spyOn(ETradeRestClient.prototype, "getOptionExpireDates").mockImplementation(async () => [expiryObj] as never);
    vi.spyOn(ETradeRestClient.prototype, "getOptionChains").mockImplementation(async (args: { symbol: string }) =>
      spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol]) : null,
    );
    const service = new ScheduledTasksService(env, orm, sessionId);
    return service.autonomousOptionsAnalysis({
      symbols: symbolsMonolithic,
      thesis: "bullish",
      trigger: "scheduled",
      pushToSlack: true,
      slackChannel: "stock_screener_channel",
    });
  }

  it("at the floor (1 of 2 evaluated) sends today's success delivery unchanged", async () => {
    // Old pin asserted a hand-built 50/100 partial via the fake
    // execute() seam; the reachable at-floor shape through the real
    // pipeline is 1-of-2 evaluated (1/2 = the 0.5 floor exactly).
    // This pin proves the at-floor run takes the success delivery
    // (the shared summary text), not the degraded notice.
    const res = await runScheduled({ SYM000: 150 });
    expect(res.success).toBe(true);
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const call = mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>;
    // #3177: the tick gates on the run owner's login.
    expect(call.userLogin).toBe("coverage_floor_test_trader");
    const text = String(call.text ?? "");
    expect(text).toContain("Opportunity scan across 2 symbols");
    expect(text).not.toContain("degraded coverage");
    expect(text).not.toContain("No report broadcast");
    expect(call).not.toHaveProperty("pdf");
    expect(call).not.toHaveProperty("files");
    // Persistence is untouched: the run record + audit still exist.
    expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_completed" } })).toHaveLength(1);
  });

  it("above the floor (2 of 2 evaluated) sends today's success delivery unchanged", async () => {
    // Old pin asserted a hand-built 75/100 partial via the fake
    // execute() seam; the reachable above-floor shape is 2/2
    // evaluated (complete coverage, no partial stamped).
    const res = await runScheduled({ SYM000: 150, SYM001: 250 });
    expect(res.success).toBe(true);
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const call = mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>;
    const text = String(call.text ?? "");
    expect(text).toContain("Opportunity scan across 2 symbols");
    expect(text).not.toContain("degraded coverage");
    expect(text).not.toContain("No report broadcast");
  });

  it("zero evaluated still takes the FAILURE_SCREEN_NO_CONTRACTS_EVALUATED gate, not the degraded notice", async () => {
    // Old pin injected a hand-built 0/100 scan via the fake; the
    // reachable shape is both chains failing, so the pipeline yields
    // evaluated 0 and the :2777 gate fires with the coded message.
    const res = await runScheduled({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED");
    // The only Slack send is the failure notice, never a degraded or success notice.
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const text = String((mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>).text ?? "");
    expect(text).toContain("FAILED");
    expect(text).toContain("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED");
    expect(text).not.toContain("degraded");
  });
});

describe("below-floor partial through the pipeline (#3186)", () => {
  let env: Env;
  const sessionId = "coverage_floor_test_trader";

  beforeEach(() => {
    const mockKv = new MockKVNamespace();
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: mockKv as any,
      SESSION_STORE: sessionStoreNs,
    } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a 1-of-4 run stamps a below-floor partial and the degraded notice is what would be sent", async () => {
    // Old pin asserted the degraded notice was sent by
    // autonomousOptionsAnalysis for a hand-built 3/100 partial; that
    // shape is unreachable through the scheduled entry (2-symbol
    // monolithic cap, sharded returns before delivery). This pin
    // proves the same behavior at the deepest reachable level: the
    // real pipeline stamps a below-floor partial from real chains,
    // and the degraded notice renders from it with no success text
    // or report link.
    const symbols = ["SYM000", "SYM001", "SYM002", "SYM003"];
    vi.spyOn(ETradeRestClient.prototype, "getOptionExpireDates").mockImplementation(async () => [expiryObj] as never);
    vi.spyOn(ETradeRestClient.prototype, "getOptionChains").mockImplementation(async (args: { symbol: string }) =>
      args.symbol === "SYM000" ? chainFor("SYM000", 150) : null,
    );

    const storage = memoryStageStorage();
    const runId = "coverage-floor-below-1-of-4";
    const outcome = await runOptionsScreenWorkflow(
      {
        runId,
        userLogin: sessionId,
        request: {
          assetClass: "options",
          trigger: "scheduled",
          classInput: {
            scan: {
              symbols,
              template: {
                thesis: "bullish",
                targetDate: new Date(NOW + 30 * 86_400_000).toISOString().slice(0, 10),
                expectedIvDirection: "unchanged",
                maxPlannedLoss: 5000,
                minRewardRisk: 0.1,
                allowedStrategies: ["long_call"],
                minDte: 14,
                maxDte: 60,
              },
              options: { riskProfile: "balanced", maxSymbols: 4, eventCalendarBySymbol: {} },
            },
          },
        } as never,
      },
      {
        stages: createScannerScreenPorts({
          agents: {
            data: new OptionsDataAgent(new DynamicOptionsScreener(new ETradeRestClient(env, sessionId))),
            risk: new StrategyRiskAgent(),
            recommender: new RecommendationAgent(),
          },
          storage,
        }),
        claims: memoryStageClaims(),
        queue: null,
      },
    );
    expect(outcome.outcome).toBe("completed");
    const shaped = await storage.get(optionsArtifactKey(runId, "shapeReport")) as any;
    expect(shaped.partial).toMatchObject({ evaluatedCount: 1, consideredCount: 4 });
    expect(optionsCoverageBelowBroadcastFloor(shaped.partial)).toBe(true);
    const notice = formatDegradedCoverageNotice(shaped.partial, "Options screen", "bullish");
    expect(notice).toContain("1 of 4");
    expect(notice).toContain("Top skip reason");
    expect(notice).not.toContain("✅");
    expect(notice).not.toContain("Screen completed");
    expect(notice).not.toContain("completed");
    expect(notice).not.toContain("Report:");
    expect(notice).not.toContain("http");
  });
});
