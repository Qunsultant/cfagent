import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import type { Env } from "../src/types";

describe("Issue #3658 — Alpaca Native Bracket Orders (alpaca_place_order)", () => {
  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    ORCHESTRATOR_AGENT: {} as any,
    ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    ALPACA_DATA_URL: "https://data.alpaca.markets",
    ALPACA_API_KEY: "PKTEST_KEY_3658",
    ALPACA_SECRET_KEY: "SKTEST_SECRET_3658",
    MARKET_DATA_PROVIDER: "hybrid",
  };

  let capturedRequests: { url: string; method: string; body: any }[] = [];

  const getContext = () => ({
    env: mockEnv,
    sessionId: "test_bracket_session",
    audit: vi.fn(),
  });

  beforeEach(() => {
    capturedRequests = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      capturedRequests.push({ url, method, body });

      if (url.includes("/v2/orders") && method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "order_bracket_abc123",
            client_order_id: "client_order_123",
            created_at: "2026-11-07T14:00:00Z",
            updated_at: "2026-11-07T14:00:00Z",
            submitted_at: "2026-11-07T14:00:00Z",
            status: "accepted",
            symbol: body?.symbol || "AAPL",
            qty: body?.qty || "10",
            side: body?.side || "buy",
            type: body?.type || "limit",
            time_in_force: body?.time_in_force || "day",
            limit_price: body?.limit_price || "220",
            order_class: body?.order_class || "bracket",
            legs: [
              {
                id: "order_leg_tp_456",
                status: "held",
                symbol: body?.symbol || "AAPL",
                type: "limit",
                side: body?.side === "buy" ? "sell" : "buy",
                limit_price: body?.take_profit?.limit_price,
                order_class: "take_profit",
              },
              {
                id: "order_leg_sl_789",
                status: "held",
                symbol: body?.symbol || "AAPL",
                type: "stop",
                side: body?.side === "buy" ? "sell" : "buy",
                stop_price: body?.stop_loss?.stop_price,
                order_class: "stop_loss",
              },
            ],
          }),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ message: "Not found" }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("places a native bracket order with order_class=bracket and both TP/SL legs via McpToolFactory", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 220,
        order_class: "bracket",
        take_profit: { limit_price: 228.8 },
        stop_loss: { stop_price: 215.6, limit_price: 214 },
        extended_hours: true,
        time_in_force: "day",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("order_bracket_abc123");
    expect(result.orderClass).toBe("bracket");
    expect(result.legs).toHaveLength(2);

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.url).toContain("/v2/orders");
    expect(req.method).toBe("POST");
    expect(req.body).toMatchObject({
      symbol: "AAPL",
      qty: 10,
      side: "buy",
      type: "limit",
      limit_price: 220,
      time_in_force: "day",
      extended_hours: true,
      order_class: "bracket",
      take_profit: { limit_price: 228.8 },
      stop_loss: { stop_price: 215.6, limit_price: 214 },
    });
  });

  it("accepts convenience aliases take_profit_limit_price and stop_loss_stop_price and auto-infers order_class=bracket", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 220,
        take_profit_limit_price: 228.8,
        stop_loss_stop_price: 215.6,
        time_in_force: "day",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.body.order_class).toBe("bracket");
    expect(req.body.take_profit).toEqual({ limit_price: 228.8 });
    expect(req.body.stop_loss).toEqual({ stop_price: 215.6 });
    expect(req.body.time_in_force).toBe("day");
  });

  it("refuses bracket order missing stop_loss leg (fails closed, zero broker contact)", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 220,
        order_class: "bracket",
        take_profit_limit_price: 228.8,
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.refusal).toBe("invalid_bracket_parameters");
    expect(result.message).toContain("Bracket orders require both take_profit");
    expect(capturedRequests).toHaveLength(0);
  });

  it("refuses bracket order with invalid prices for BUY where TP <= entry", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 220,
        take_profit_limit_price: 215, // <= 220
        stop_loss_stop_price: 210,
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.refusal).toBe("invalid_bracket_prices");
    expect(result.message).toContain("take-profit ($215) must be greater than entry ($220)");
    expect(capturedRequests).toHaveLength(0);
  });

  it("refuses bracket order with invalid prices for BUY where SL >= entry", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 220,
        take_profit_limit_price: 230,
        stop_loss_stop_price: 225, // >= 220
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.refusal).toBe("invalid_bracket_prices");
    expect(result.message).toContain("stop-loss ($225) must be less than entry ($220)");
    expect(capturedRequests).toHaveLength(0);
  });

  it("refuses bracket order with stop_limit parent type", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "stop_limit",
        limit_price: 220,
        take_profit_limit_price: 230,
        stop_loss_stop_price: 210,
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.refusal).toBe("invalid_bracket_order_type");
    expect(capturedRequests).toHaveLength(0);
  });

  it("preserves exact byte-identical behaviour for non-bracket orders", async () => {
    const ctx = getContext();
    const result = await McpToolFactory.executeTool(
      "alpaca_place_order",
      {
        symbol: "NVDA",
        qty: 5,
        side: "buy",
        type: "market",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.body.symbol).toBe("NVDA");
    expect(req.body.qty).toBe(5);
    expect(req.body.order_class).toBeUndefined();
    expect(req.body.take_profit).toBeUndefined();
    expect(req.body.stop_loss).toBeUndefined();
  });
});
