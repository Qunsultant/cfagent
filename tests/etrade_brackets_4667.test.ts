import { describe, expect, it, vi } from "vitest";
import { advancedOrderType } from "../src/trading/advancedOrders";
import { ETradeClient } from "../src/trading/etrade/client";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

describe("E*TRADE brackets / OCO / OTO honesty & placeBracketExits (#4667)", () => {
  it("marks bracket as emulated and OTO as none on E*TRADE in advancedOrders registry", () => {
    expect(advancedOrderType("bracket")?.broker.etrade).toBe("emulated");
    expect(advancedOrderType("oco")?.broker.etrade).toBe("emulated");
    expect(advancedOrderType("oto")?.broker.etrade).toBe("none");
  });

  it("placeBracketExits submits separate SELL LIMIT and SELL STOP orders for a BUY entry", async () => {
    const client = new ETradeClient({ ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env);
    const placeOrderSpy = vi.spyOn(client, "placeOrder").mockImplementation(async (params) => ({
      success: true,
      orderId: params.orderId,
      executionId: `exec-${params.orderType}`,
      brokerOrderRef: `ref-${params.orderType}`,
      authorizerDid: params.userLogin,
      status: "executed",
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: params.limitPrice ?? params.stopPrice ?? 0,
      totalSettled: 0,
      didAttestation: { proposerDid: "did:agent:trading", authorizerDid: params.userLogin, signature: "sig" },
      message: "ok",
      timestamp: new Date().toISOString(),
    }));

    const res = await client.placeBracketExits({
      orderId: "ord-123",
      symbol: "AAPL",
      entryAction: "BUY",
      quantity: 10,
      takeProfitLimitPrice: 210,
      stopLossStopPrice: 190,
      userLogin: "did:user:github:tester",
    });

    expect(placeOrderSpy).toHaveBeenCalledTimes(2);
    expect(placeOrderSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderId: "ord-123-tp",
        symbol: "AAPL",
        action: "SELL",
        quantity: 10,
        orderType: "LIMIT",
        limitPrice: 210,
      }),
    );
    expect(placeOrderSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderId: "ord-123-sl",
        symbol: "AAPL",
        action: "SELL",
        quantity: 10,
        orderType: "STOP",
        stopPrice: 190,
      }),
    );
    expect(res.takeProfitResult?.brokerOrderRef).toBe("ref-LIMIT");
    expect(res.stopLossResult?.brokerOrderRef).toBe("ref-STOP");
  });

  it("discloses exit failure clearly in executeOrder message if an exit fails after entry succeeds", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const platform = new ETradeTradingPlatform(
      { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env,
      orm,
      "tester_4667",
    );
    const draft = await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 5,
      orderType: "LIMIT",
      limitPrice: 100,
      takeProfitPercent: 5,
      stopLossPercent: 2,
    });

    const client = (platform as any).client;
    vi.spyOn(client, "placeOrder").mockResolvedValue({
      success: true,
      orderId: draft.orderId,
      executionId: "entry-1",
      brokerOrderRef: "entry-1",
      authorizerDid: "did:user:github:tester_4667",
      status: "executed",
      symbol: "AAPL",
      action: "BUY",
      quantity: 5,
      executionPrice: 100,
      totalSettled: 500,
      didAttestation: { proposerDid: "did:agent:trading", authorizerDid: "did:user:github:tester_4667", signature: "sig" },
      message: "Entry executed.",
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(client, "placeBracketExits").mockResolvedValue({
      takeProfitResult: {
        success: true,
        orderId: `${draft.orderId}-tp`,
        executionId: "tp-1",
        brokerOrderRef: "tp-1",
        authorizerDid: "did:user:github:tester_4667",
        status: "executed",
        symbol: "AAPL",
        action: "SELL",
        quantity: 5,
        executionPrice: 105,
        totalSettled: 525,
        didAttestation: { proposerDid: "did:agent:trading", authorizerDid: "did:user:github:tester_4667", signature: "sig" },
        message: "ok",
        timestamp: new Date().toISOString(),
      },
      stopLossResult: {
        success: false,
        orderId: `${draft.orderId}-sl`,
        executionId: "",
        brokerOrderRef: "",
        authorizerDid: "did:user:github:tester_4667",
        status: "failed",
        symbol: "AAPL",
        action: "SELL",
        quantity: 5,
        executionPrice: 0,
        totalSettled: 0,
        didAttestation: { proposerDid: "did:agent:trading", authorizerDid: "did:user:github:tester_4667", signature: "sig" },
        message: "Insufficient margin",
        timestamp: new Date().toISOString(),
      },
    });

    const res = await platform.executeOrder(draft.orderId, "did:user:github:tester_4667", "approved");
    expect(res.success).toBe(true);
    expect(res.message).toContain("TP exit placed (tp-1)");
    expect(res.message).toContain("SL exit failed (Insufficient margin)");
  });
});
