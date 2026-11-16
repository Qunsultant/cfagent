import { describe, expect, it, vi } from "vitest";
import { mapAlpacaOrderHistoryRow } from "../src/trading/alpaca/platform";
import { ETradeClient } from "../src/trading/etrade/client";
import { parsePublicOrders } from "../src/services/publicTrading";

describe("Fills visibility on BrokerRemoteOrder (#4666)", () => {
  it("populates filledQty and avgFillPrice from Alpaca order rows when present", () => {
    const filled = mapAlpacaOrderHistoryRow({
      id: "ord-fill-1",
      symbol: "aapl",
      side: "buy",
      qty: "10",
      filled_qty: "10",
      filled_avg_price: "198.45",
      type: "market",
      status: "filled",
      submitted_at: "2026-11-16T14:30:00Z",
    });
    expect(filled.filledQty).toBe(10);
    expect(filled.avgFillPrice).toBe(198.45);

    const partial = mapAlpacaOrderHistoryRow({
      id: "ord-fill-2",
      symbol: "msft",
      side: "buy",
      qty: "10",
      filled_qty: "4",
      filled_avg_price: "412.50",
      type: "limit",
      limit_price: "413.00",
      status: "partially_filled",
      submitted_at: "2026-11-16T14:31:00Z",
    });
    expect(partial.status).toBe("INDIVIDUAL_FILLS");
    expect(partial.filledQty).toBe(4);
    expect(partial.avgFillPrice).toBe(412.5);

    const open = mapAlpacaOrderHistoryRow({
      id: "ord-fill-3",
      symbol: "nvda",
      side: "buy",
      qty: "5",
      filled_qty: "0",
      filled_avg_price: null,
      type: "limit",
      limit_price: "140.00",
      status: "new",
      submitted_at: "2026-11-16T14:32:00Z",
    });
    expect(open.filledQty).toBe(0);
    expect(open.avgFillPrice).toBeUndefined();
  });

  it("populates filledQty and avgFillPrice from E*TRADE fetchOrders and fetchOrderDetails", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/orders/9001")) {
        return new Response(
          JSON.stringify({
            OrdersResponse: {
              Order: [
                {
                  orderId: 9001,
                  orderType: "EQ",
                  OrderDetail: [
                    {
                      status: "EXECUTED",
                      orderType: "EQ",
                      Instrument: [
                        {
                          orderAction: "BUY",
                          orderedQuantity: 5,
                          filledQuantity: 5,
                          averageExecutionPrice: 225.75,
                          Product: { symbol: "AAPL" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          OrdersResponse: {
            Order: [
              {
                orderId: 9001,
                orderType: "EQ",
                OrderDetail: [
                  {
                    status: "INDIVIDUAL_FILLS",
                    orderType: "EQ",
                    Instrument: [
                      {
                        orderAction: "BUY",
                        orderedQuantity: 10,
                        filledQuantity: 4,
                        averageExecutionPrice: 224.5,
                        Product: { symbol: "AAPL" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const client = new ETradeClient({
        ENVIRONMENT: "sandbox",
        ETRADE_CONSUMER_KEY: "test-key",
        ETRADE_CONSUMER_SECRET: "test-secret",
        ETRADE_ACCOUNT_ID_KEY: "acct-key",
      } as any);
      vi.spyOn(client as any, "generateOAuthHeader").mockResolvedValue("OAuth test");

      const list = await client.fetchOrders("acct-key", { count: 10 });
      expect(list).toHaveLength(1);
      expect(list[0].filledQty).toBe(4);
      expect(list[0].avgFillPrice).toBe(224.5);

      const detail = await client.fetchOrderDetails("acct-key", 9001);
      expect(detail).not.toBeNull();
      expect(detail!.filledQty).toBe(5);
      expect(detail!.avgFillPrice).toBe(225.75);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("populates filledQty and avgFillPrice from Public orders when present", () => {
    const rows = parsePublicOrders({
      orders: [
        {
          orderId: "pub-1",
          symbol: "SPY",
          side: "BUY",
          quantity: 2,
          filledQuantity: 2,
          averageFillPrice: 590.12,
          orderType: "MARKET",
          status: "FILLED",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].filledQty).toBe(2);
    expect(rows[0].avgFillPrice).toBe(590.12);
  });
});
