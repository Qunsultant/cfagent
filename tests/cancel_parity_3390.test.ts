/**
 * Issue #3390 — cancel parity, one neutral seam for both brokers.
 *
 * What these tests defend:
 *   1. Both brokers declare `orderCancel`, so the neutral route can say "this
 *      broker cannot cancel" instead of rendering a control that does nothing.
 *   2. Alpaca's cancel is a `DELETE /v2/orders/{id}`: 204 is a cancelled order,
 *      404/422 are failures carrying the broker's status — never an invented
 *      success.
 *   3. The neutral route exists and the client uses it for everyone (E*TRADE
 *      included), so there is one cancel path, not two.
 *   4. The Alpaca order-history control renders only for an OPEN order and
 *      posts to the neutral route.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";

const CREDS = {
  ALPACA_API_KEY: "key",
  ALPACA_SECRET_KEY: "secret",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as any;

function provider() {
  return new AlpacaMarketDataProvider(CREDS);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the cancel capability is declared for both brokers (#3390)", () => {
  it("E*TRADE and Alpaca both cancel", () => {
    expect(brokerSupports("etrade", "orderCancel")).toBe(true);
    expect(brokerSupports("alpaca", "orderCancel")).toBe(true);
  });
});

describe("Alpaca cancel is a DELETE with the broker's own answer (#3390)", () => {
  it("sends DELETE /v2/orders/{id} and treats 204 as cancelled", async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        return { ok: true, status: 204, json: async () => ({}) } as any;
      }),
    );

    const result = await provider().cancelOrder("ord-123");

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("ord-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://paper-api.alpaca.markets/v2/orders/ord-123");
    expect(calls[0].method).toBe("DELETE");
  });

  it("reports a 404 as a failure carrying the broker's status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ message: "order not found" }),
      }) as any),
    );

    const result = await provider().cancelOrder("missing");

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(result.message).toContain("not found");
  });

  it("refuses an empty id without calling the broker", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await provider().cancelOrder("  ");
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("there is one cancel path (#3390)", () => {
  it("the neutral route exists and refuses a broker without the capability", () => {
    const source = readFileSync("src/agents/routes/brokerOrders.ts", "utf8");
    expect(source).toContain('path.endsWith("/broker/order/cancel")');
    expect(source).toContain('brokerSupports(broker, "orderCancel")');
    expect(source).toContain("platform.cancelOrderRemote(cancelOrderId)");
    expect(source).toContain("provider_unsupported");
  });

  it("the E*TRADE account panel uses the neutral route, not its legacy one", () => {
    const source = readFileSync("src/client/accountApi.ts", "utf8");
    expect(source).toContain('"/api/broker/order/cancel"');
    expect(source).not.toContain('"/api/etrade/orders/cancel"');
  });

  it("the Alpaca order history offers cancel only for an OPEN order", () => {
    const source = readFileSync("src/client/AlpacaBrokerPanel.tsx", "utf8");
    expect(source).toContain('row.status === "OPEN"');
    expect(source).toContain('fetch("/api/broker/order/cancel"');
    expect(source).toContain("Cancel");
  });
});
