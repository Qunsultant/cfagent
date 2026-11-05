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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { UnifiedOptionsService } from "../src/trading";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import type { Env } from "../src/types";

const mockDeliverGatedSlack = vi.mocked(deliverGatedSlack);

// The stubbed UnifiedOptionsService returns whatever scan its static
// `scan` field holds; tests set it per case through the mocked binding
// below (factories may not reference top-level test variables).
vi.mock("../src/trading", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    UnifiedOptionsService: class FakeUnifiedOptionsService {
      static scan: any = null;
      constructor(..._args: unknown[]) {}
      async execute() {
        return FakeUnifiedOptionsService.scan;
      }
    },
  };
});

vi.mock("../src/services/gatedSlackDelivery", () => ({
  deliverGatedSlack: vi.fn(async () => ({ ok: true as const })),
}));

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

function scanResult(p: OptionsPartialQualification, evaluated: number) {
  return {
    success: true,
    summary: `Opportunity scan across 100 symbols. Partial coverage — qualified partial results: evaluated ${p.evaluatedCount} of ${p.consideredCount} underlyings (${p.coverageErrors} failures, ${p.truncatedCount} truncated).`,
    data: {
      scanned: evaluated,
      coverage: {
        evaluated,
        considered: p.consideredCount,
        errors: p.coverageErrors,
        truncated: p.truncatedCount,
      },
      partial: p,
      opportunities: [],
      withTrades: 0,
      scanRunId: "test-run-1718",
    },
    toSlack: () =>
      "✅ Screen completed\n📊 Options screen — bullish\n3 matched · 100 scanned\nOpportunity scan summary.",
    toEmailText: () => "email text",
    toEmailHtml: () => "<p>email</p>",
    toWebhook: () => ({}),
  };
}

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
    (UnifiedOptionsService as any).scan = null;
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

  // Issue #1785 routes scheduled runs with more than floor(35/12) = 2
  // symbols to the sharded branch, so these direct-Slack tests exercise
  // the monolithic branch with 2 symbols. Coverage assertions below
  // come from the stubbed partial (evaluated/considered), not from the
  // length of this list, so the floor semantics are unchanged.
  const symbolsMonolithic = ["SYM000", "SYM001"];

  async function runScheduled(p: OptionsPartialQualification, evaluated: number) {
    (UnifiedOptionsService as any).scan = scanResult(p, evaluated);
    const service = new ScheduledTasksService(env, orm, sessionId);
    return service.autonomousOptionsAnalysis({
      symbols: symbolsMonolithic,
      thesis: "bullish",
      trigger: "scheduled",
      pushToSlack: true,
      slackChannel: "stock_screener_channel",
    });
  }

  it("below floor sends the degraded notice only — no success text, no report link, no attachments", async () => {
    const res = await runScheduled(partial(), 3);
    expect(res.success).toBe(true);
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const call = mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>;
    // #3177: the tick gates on the run owner's login.
    expect(call.userLogin).toBe("coverage_floor_test_trader");
    const text = String(call.text ?? "");
    expect(text).toContain("3 of 100");
    expect(text).toContain("97");
    expect(text).toContain("OAuth Token Missing");
    expect(text).not.toContain("✅");
    expect(text).not.toContain("Screen completed");
    expect(text).not.toContain("completed");
    expect(text).not.toContain("Report:");
    expect(text).not.toContain("report.pdf");
    expect(call).not.toHaveProperty("pdf");
    expect(call).not.toHaveProperty("files");
    // Persistence is untouched: the run record + audit still exist.
    expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_completed" } })).toHaveLength(1);
  });

  it("at the floor sends today's success delivery unchanged", async () => {
    const atFloor = partial({ evaluatedCount: 50, consideredCount: 100, coverageErrors: 50, topSkipCount: 50 });
    const res = await runScheduled(atFloor, 50);
    expect(res.success).toBe(true);
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const call = mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>;
    expect(String(call.text ?? "")).toContain("✅ Screen completed");
  });

  it("above the floor a qualified partial sends today's success delivery unchanged", async () => {
    const above = partial({ evaluatedCount: 75, consideredCount: 100, coverageErrors: 25, topSkipCount: 25 });
    const res = await runScheduled(above, 75);
    expect(res.success).toBe(true);
    expect(mockDeliverGatedSlack).toHaveBeenCalledTimes(1);
    const call = mockDeliverGatedSlack.mock.calls[0][1] as Record<string, unknown>;
    expect(String(call.text ?? "")).toContain("✅ Screen completed");
  });

  it("zero evaluated still takes the FAILURE_SCREEN_NO_CONTRACTS_EVALUATED gate, not the degraded notice", async () => {
    (UnifiedOptionsService as any).scan = {
      success: true,
      summary: "scan",
      data: {
        scanned: 0,
        coverage: { evaluated: 0, considered: 100, errors: 100, truncated: 0 },
        partial: partial({ evaluatedCount: 0, consideredCount: 100, coverageErrors: 100, topSkipCount: 100 }),
        opportunities: [],
        withTrades: 0,
      },
      toSlack: () => "success text",
      toEmailText: () => "",
      toEmailHtml: () => "",
      toWebhook: () => ({}),
    };
    const service = new ScheduledTasksService(env, orm, sessionId);
    const res = await service.autonomousOptionsAnalysis({
      symbols: symbolsMonolithic,
      thesis: "bullish",
      trigger: "scheduled",
      pushToSlack: true,
      slackChannel: "stock_screener_channel",
    });
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
