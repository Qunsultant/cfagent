import { describe, expect, it, vi } from "vitest";
import { publicSingleLegArgs } from "../src/services/publicTrading";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import type { Env } from "../src/types";

describe("Public MCP live-schema verified TIF & bracket args (#4668)", () => {
  it("publicSingleLegArgs maps timeInForce onto time_in_force (except cls, which uses on-close order_type)", () => {
    const gtc = publicSingleLegArgs({
      symbol: "AAPL",
      assetClass: "equity",
      action: "BUY",
      quantity: 2,
      orderType: "LIMIT",
      limitPrice: 190,
      timeInForce: "gtc",
    });
    expect(gtc.time_in_force).toEqual({
      names: ["time_in_force", "timeInForce"],
      value: "GTC",
    });

    const cls = publicSingleLegArgs({
      symbol: "AAPL",
      assetClass: "equity",
      action: "SELL",
      quantity: 2,
      orderType: "MARKET",
      timeInForce: "cls",
    });
    expect(cls.time_in_force).toBeUndefined();
  });

  it("PublicTradingPlatform forwards time_in_force=GTC to preflight_order and place_order", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "get_accounts",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "preflight_order",
                  inputSchema: {
                    type: "object",
                    properties: {
                      symbol: { type: "string" },
                      instrument_type: { type: "string" },
                      order_side: { type: "string" },
                      order_type: { type: "string" },
                      account_id: { type: "string" },
                      time_in_force: { type: "string" },
                      quantity: { type: "string" },
                      limit_price: { type: "string" },
                    },
                    required: ["symbol", "instrument_type", "order_side", "order_type", "account_id"],
                  },
                },
                {
                  name: "place_order",
                  inputSchema: {
                    type: "object",
                    properties: {
                      symbol: { type: "string" },
                      instrument_type: { type: "string" },
                      order_side: { type: "string" },
                      order_type: { type: "string" },
                      account_id: { type: "string" },
                      time_in_force: { type: "string" },
                      quantity: { type: "string" },
                      limit_price: { type: "string" },
                      order_class: { type: "string" },
                      take_profit_limit_price: { type: "string" },
                      stop_loss_stop_price: { type: "string" },
                      stop_loss_limit_price: { type: "string" },
                    },
                    required: ["symbol", "instrument_type", "order_side", "order_type", "account_id"],
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.method === "tools/call") {
        toolCalls.push({ name: body.params.name, args: body.params.arguments });
        if (body.params.name === "get_accounts") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify({ accounts: [{ accountId: "acct-1" }] }) }] },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify({ orderId: "pub-ord-1", estimatedTotal: 380 }) }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const platform = new PublicTradingPlatform({} as Env, undefined, "owner@example.com", "PROD", {
      accessTokenProvider: async () => "pat-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 2,
      orderType: "LIMIT",
      limitPrice: 190,
      timeInForce: "gtc",
    });

    const placed = await platform.placeOrderRemote({
      orderId: "draft-gtc-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 2,
      orderType: "LIMIT",
      limitPrice: 190,
      timeInForce: "gtc",
      userLogin: "owner@example.com",
    });

    expect(placed.success).toBe(true);
    const preflightCall = toolCalls.find((c) => c.name === "preflight_order");
    const placeCall = toolCalls.find((c) => c.name === "place_order");
    expect(preflightCall?.args.time_in_force).toBe("GTC");
    expect(placeCall?.args.time_in_force).toBe("GTC");
  });
});
