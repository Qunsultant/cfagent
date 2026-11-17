import { describe, expect, it, vi, afterEach } from "vitest";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { resolveChannelBroker } from "../src/trading";
import { executeNLQQueryAsync } from "../src/agents/nlq/execution";
import type { Env } from "../src/types";

// Issue #5131: the Slack order-preview card is reached through the NLQ
// barrel. Only the preview command is stubbed — the quote/screener paths keep
// the real executor, because the voice label case below asserts against it.
vi.mock("../src/agents/nlq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/nlq")>();
  const realExecute = actual.executeNaturalLanguageQuery;
  return {
    ...actual,
    executeNaturalLanguageQuery: vi.fn((...args: unknown[]) => {
      const prompt = String(args[2] ?? "");
      if (!/preview|buy|sell/i.test(prompt)) return (realExecute as (...a: unknown[]) => unknown)(...args);
      return Promise.resolve({
        plan: { domain: "trading", tradingData: { action: "preview_order" } },
        result: {
          domain: "trading",
          targetTable: "mas_trades",
          count: 1,
          status: "ok",
          summary: "Order preview drafted.",
          rows: [
            {
              orderId: "ord_preview_1",
              action: "BUY",
              symbol: "NVDA",
              quantity: 2,
              estimatedPrice: "$120.00",
              estimatedTotal: "$240.00",
            },
          ],
          executedAt: new Date().toISOString(),
        },
      });
    }),
  };
});

function makeTradesOrm(drafts: Record<string, any> = {}) {
  const trades = {
    findById: vi.fn((id: string) => drafts[id] ?? null),
    findMany: vi.fn(() => Object.values(drafts)),
    update: vi.fn(),
  };
  return {
    trades,
    events: { create: vi.fn() },
    watchlists: {},
    getSql: () => undefined,
  } as unknown as DatabaseORM;
}

describe("Issue #4664 (Gap 10) — Voice, NLQ preview, and Slack resolve non-E*TRADE brokers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Voice approval resolves TradingPlatformRegistry for non-E*TRADE copilotBrokerId", async () => {
    const draft = {
      id: "ord_alpaca_voice_1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 2,
      price: 180,
      orderType: "LIMIT",
      totalValue: 360,
      status: "previewed",
    };
    const executeOrder = vi.fn(async () => ({
      success: true,
      executionId: "alp_exec_1",
      message: "ok",
    }));
    const getPlatformSpy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue({ executeOrder, placeOrderRemote: vi.fn() } as any);

    const orm = makeTradesOrm({ [draft.id]: draft });
    const service = new ETradeVoiceTradingService(
      { APP_BASE_URL: "https://example.com" } as unknown as Env,
      orm,
      "voice-user",
    );

    const res = await service.processVoiceTurn({
      transcript: "confirm order ord_alpaca_voice_1",
      userLogin: "voice-user",
      copilotBrokerId: "alpaca",
    });

    expect(getPlatformSpy).toHaveBeenCalledWith("alpaca", expect.anything(), orm, "voice-user");
    expect(executeOrder).toHaveBeenCalledWith("ord_alpaca_voice_1", expect.any(String), "approved");
    expect(res.success).toBe(true);
    expect(res.displayMarkdown).toContain("Alpaca");
  });

  it("Slack approval resolves TradingPlatformRegistry when TENANT_BROKER_ID is non-E*TRADE", async () => {
    const draft = {
      id: "ord_alpaca_slack_1",
      symbol: "MSFT",
      action: "BUY",
      quantity: 1,
      price: 400,
      orderType: "MARKET",
      totalValue: 400,
      status: "previewed",
    };
    const executeOrder = vi.fn(async () => ({
      success: true,
      executionId: "alp_slack_exec_1",
      message: "ok",
    }));
    const getPlatformSpy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue({ executeOrder, placeOrderRemote: vi.fn() } as any);

    const orm = makeTradesOrm({ [draft.id]: draft });
    const service = new ETradeSlackTradingService(
      { TENANT_BROKER_ID: "alpaca" } as unknown as Env,
      orm,
      "slack-user",
      undefined,
    );

    const res = await service.processSlackEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        text: "approve ord_alpaca_slack_1",
        ts: "1700000000.000100",
      },
    });

    expect(getPlatformSpy).toHaveBeenCalledWith("alpaca", expect.anything(), orm, "slack-user");
    expect(executeOrder).toHaveBeenCalledWith("ord_alpaca_slack_1", expect.any(String), "approved");
    expect(res.actionType).toBe("approval");
  });

  it("NLQ async preview_order resolves TradingPlatformRegistry for non-E*TRADE TENANT_BROKER_ID", async () => {
    const getQuote = vi.fn(async () => ({
      symbol: "NVDA",
      lastPrice: 120,
      quoteStatus: "REALTIME",
    }));
    const previewOrder = vi.fn(async () => ({
      orderId: "ord_nlq_alp_1",
      symbol: "NVDA",
      orderAction: "BUY",
      quantity: 5,
      orderType: "MARKET",
      limitPrice: undefined,
      estimatedPrice: 120,
      estimatedTotal: 600,
      estimatedCommission: 0,
      proposerDid: "did:agent:trading",
      expiresAt: "2026-11-16T21:00:00Z",
      pricingQuoteStatus: "REALTIME",
      status: "previewed",
    }));
    const getPlatformSpy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue({ getQuote, previewOrder } as any);

    const orm = makeTradesOrm();
    const res = await executeNLQQueryAsync(
      orm,
      "nlq-user",
      {
        domain: "trading",
        intent: "preview_order",
        confidence: 1,
        tradingData: {
          action: "preview_order",
          symbol: "NVDA",
          orderAction: "BUY",
          quantity: 5,
          orderType: "MARKET",
        },
      } as any,
      { TENANT_BROKER_ID: "alpaca" } as unknown as Env,
      "nlq-user",
    );

    expect(getPlatformSpy).toHaveBeenCalledWith("alpaca", expect.anything(), orm, "nlq-user", undefined, undefined);
    expect(getQuote).toHaveBeenCalledWith("NVDA");
    expect(previewOrder).toHaveBeenCalled();
    expect(res.summary).toContain("Alpaca order preview drafted");
  });
});

describe("Issue #5131 — channel labels name the broker the surface executes on", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function previewCardViaSlack(env: unknown) {
    const service = new ETradeSlackTradingService(env as unknown as Env, makeTradesOrm(), "slack-user", undefined);
    return service.processSlackEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        text: "preview buy 2 NVDA",
        ts: "1700000000.000200",
      },
    });
  }

  it("Slack order-preview card names Alpaca for an Alpaca-selected tenant", async () => {
    const res = await previewCardViaSlack({ TENANT_BROKER_ID: "alpaca" });
    const header = (res.response?.blocks ?? []).find((b: any) => b.type === "header");

    expect(res.response?.text).toContain("Alpaca Order Preview");
    expect(res.response?.text).not.toContain("E*TRADE");
    expect(header?.text?.text).toContain("Alpaca Order Preview");
    expect(header?.text?.text).not.toContain("E*TRADE");
  });

  it("Slack order-preview card names Public.com for a Public-selected tenant", async () => {
    const res = await previewCardViaSlack({ TENANT_BROKER_ID: "public" });

    expect(res.response?.text).toContain("Public.com Order Preview");
    expect(res.response?.text).not.toContain("E*TRADE");
  });

  it("a tenant with no selection keeps today's E*TRADE wording", async () => {
    const res = await previewCardViaSlack({});

    expect(res.response?.text).toContain("E*TRADE Order Preview");
  });

  it("an id outside the catalogue renders the name-free fallback, never E*TRADE", async () => {
    // The only way an unknown id reaches a channel is a per-turn override; an
    // unknown stored selection already resolves to null (no selection).
    const channelBroker = await resolveChannelBroker({}, "tradier");

    expect(channelBroker.presentation.label).toBe("Selected broker");
    expect(channelBroker.presentation.deskName).toBe("Voice Trading Desk");
  });

  it("voice welcome names the selected broker (Alpaca)", async () => {
    const service = new ETradeVoiceTradingService(
      { APP_BASE_URL: "https://example.com", TENANT_BROKER_ID: "alpaca" } as unknown as Env,
      makeTradesOrm(),
      "voice-user",
    );
    const greeting = await service.getWelcomeGreeting();

    expect(greeting.spokenText).toContain("Welcome to the Alpaca Voice Trading Desk");
    expect(greeting.spokenText).not.toContain("E*TRADE");
    expect(greeting.displayMarkdown).toContain("Alpaca Voice Trading Desk Connected");
  });

  it("voice welcome keeps the E*TRADE desk for a tenant with no selection", async () => {
    const service = new ETradeVoiceTradingService(
      { APP_BASE_URL: "https://example.com" } as unknown as Env,
      makeTradesOrm(),
      "voice-user",
    );
    const greeting = await service.getWelcomeGreeting();

    expect(greeting.spokenText).toContain("Welcome to the E*TRADE Voice Trading Desk");
  });

  it("a voice quote heading names the selected broker (Alpaca)", async () => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    DynamicMarketScreener.setTestListingsFixture(MOCK_TEST_UNIVERSE.map((stock) => ({
      symbol: stock.symbol,
      companyName: stock.companyName,
      exchange: "nasdaq" as const,
      lastPrice: stock.lastPrice,
      change: stock.change,
      changePercent: stock.changePercent,
      marketCap: (stock.marketCap || 0) * 1e9,
    })));
    try {
      const sql = new MockSqlStorage();
      const orm = new DatabaseORM(sql);
      orm.initializeSchema("voice-label-user");
      const service = new ETradeVoiceTradingService(
        {
          APP_BASE_URL: "https://example.com",
          AI_SEARCH_ENDPOINT: "https://ai-search.internal",
          ORCHESTRATOR_AGENT: {} as any,
          ETRADE_ENVIRONMENT: "sandbox",
          TENANT_BROKER_ID: "alpaca",
        } as unknown as Env,
        orm,
        "voice-label-user",
      );
      const res = await service.processVoiceTurn({ transcript: "What is nvidia trading at?" });

      expect(res.success).toBe(true);
      expect(res.displayMarkdown).toContain("Alpaca Quote");
      expect(res.displayMarkdown).not.toContain("E*TRADE");
    } finally {
      DynamicMarketScreener.setTestUniverseFixture(null);
      DynamicMarketScreener.setTestListingsFixture(null);
    }
  });
});
