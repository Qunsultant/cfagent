import { describe, expect, it, vi, afterEach } from "vitest";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import { ETradeSlackTradingService } from "../src/trading/slack/agent";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { DatabaseORM } from "../src/orm";
import { executeNLQQueryAsync } from "../src/agents/nlq/execution";
import type { Env } from "../src/types";

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
