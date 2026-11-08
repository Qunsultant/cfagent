/**
 * Issue #3508 — Alpaca platform: carry session order terms on the wire
 * (extended_hours, overnight) + truthful supportsSessionOrders.
 *
 * Requirements:
 * 1. `AlpacaTradingPlatform` implements `supportsSessionOrders(session)`:
 *    truthful for all four supported sessions: "pre_market", "regular",
 *    "after_hours", and "exto" (24/5 overnight via BOATS ATS).
 * 2. `PlaceOrderParams` carries optional `session`, `extendedHours`, and `timeInForce`.
 * 3. `AlpacaTradingPlatform.placeOrderRemote` and `AlpacaMarketDataProvider.placeOrder`
 *    carry `extended_hours: true` on the wire to `/v2/orders` when the order
 *    targets an extended session or requests extended hours.
 * 4. Venue policy guard: extended-hours and overnight sessions are limit-only.
 *    A market order targeting an extended session is refused by name,
 *    preventing broker API rejections.
 * 5. Stock Copilot integration: the copilot passes session terms to
 *    `deps.platform.placeOrderRemote`, and the named refusal
 *    (`stock_copilot_session_wire_unsupported`) lifts on capable platforms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import type { Env } from "../src/types";
import type { PlaceOrderParams } from "../src/trading/interfaces";
import {
  runStockCopilotCycle,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import { StockCopilotPositionStore } from "../src/services/stockCopilotStore";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  COPILOT_SESSIONS,
  STOCK_COPILOT_SESSION_WIRE_UNSUPPORTED,
} from "../src/services/stockCopilotSessions";

const KEY_ID = ["PK", "TEST"].join("");
const SECRET = ["SK", "TEST"].join("");

const PAPER_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as unknown as Env;

const ORDER_OK = {
  id: "alpaca-order-3508",
  client_order_id: "client-ord-3508",
  symbol: "NVDA",
  qty: "10",
  side: "buy",
  type: "limit",
  time_in_force: "day",
  status: "accepted",
  filled_avg_price: null,
};

type FetchCall = { url: string; init: any };
type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function installFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("Issue #3508 — Alpaca supportsSessionOrders & wire terms", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("1. Platform Capability Verification", () => {
    it("truthfully reports supportsSessionOrders for all four canonical sessions", () => {
      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");
      expect(typeof alpaca.supportsSessionOrders).toBe("function");

      for (const session of COPILOT_SESSIONS) {
        expect(alpaca.supportsSessionOrders!(session)).toBe(true);
      }

      expect(alpaca.supportsSessionOrders!("unknown_session")).toBe(false);
      expect(alpaca.supportsSessionOrders!("weekend")).toBe(false);
      expect(alpaca.supportsSessionOrders!("")).toBe(false);
    });
  });

  describe("2. AlpacaMarketDataProvider Wire Payload", () => {
    it("sends extended_hours: true to POST /v2/orders when specified", async () => {
      const calls = installFetch(async (call) => {
        expect(call.url).toBe("https://paper-api.alpaca.markets/v2/orders");
        const body = JSON.parse(call.init.body);
        expect(body).toMatchObject({
          symbol: "AAPL",
          qty: 5,
          side: "buy",
          type: "limit",
          limit_price: 150,
          time_in_force: "day",
          extended_hours: true,
        });
        return jsonResponse(ORDER_OK);
      });

      const provider = new AlpacaMarketDataProvider(PAPER_ENV);
      const res = await provider.placeOrder({
        symbol: "AAPL",
        qty: 5,
        side: "buy",
        type: "limit",
        limit_price: 150,
        extended_hours: true,
        // Issue #3782: the caller-supplied limit price declares user provenance for the placeOrder guard.
        priceSource: { kind: "user" },
      });

      expect(res.success).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("omits extended_hours or sets false for regular hours", async () => {
      const calls = installFetch(async (call) => {
        const body = JSON.parse(call.init.body);
        expect(body.extended_hours).toBeUndefined();
        return jsonResponse(ORDER_OK);
      });

      const provider = new AlpacaMarketDataProvider(PAPER_ENV);
      const res = await provider.placeOrder({
        symbol: "AAPL",
        qty: 5,
        side: "buy",
        type: "market",
      });

      expect(res.success).toBe(true);
      expect(calls).toHaveLength(1);
    });
  });

  describe("3. AlpacaTradingPlatform placeOrderRemote Session Wire Terms", () => {
    it("carries extended_hours: true on the wire for pre_market session orders", async () => {
      const calls = installFetch(async (call) => {
        const body = JSON.parse(call.init.body);
        expect(body).toMatchObject({
          symbol: "NVDA",
          qty: 10,
          side: "buy",
          type: "limit",
          limit_price: 125.5,
          time_in_force: "day",
          extended_hours: true,
        });
        return jsonResponse(ORDER_OK);
      });

      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");
      const res = await alpaca.placeOrderRemote({
        orderId: "ord-pre-1",
        symbol: "NVDA",
        action: "BUY",
        quantity: 10,
        orderType: "LIMIT",
        limitPrice: 125.5,
        // Issue #3782: the caller-supplied limit price declares user provenance for the placeOrder guard.
        priceSource: { kind: "user" },
        userLogin: "trader",
        session: "pre_market",
      });

      expect(calls).toHaveLength(1);
      expect(res.success).toBe(true);
      expect(res.status).toBe("submitted");
    });

    it("carries extended_hours: true on the wire for after_hours session orders", async () => {
      const calls = installFetch(async (call) => {
        const body = JSON.parse(call.init.body);
        expect(body).toMatchObject({
          symbol: "NVDA",
          qty: 10,
          side: "sell",
          type: "limit",
          limit_price: 130.0,
          time_in_force: "day",
          extended_hours: true,
        });
        return jsonResponse({ ...ORDER_OK, side: "sell" });
      });

      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");
      const res = await alpaca.placeOrderRemote({
        orderId: "ord-ah-1",
        symbol: "NVDA",
        action: "SELL",
        quantity: 10,
        orderType: "LIMIT",
        limitPrice: 130.0,
        // Issue #3782: the caller-supplied limit price declares user provenance for the placeOrder guard.
        priceSource: { kind: "user" },
        userLogin: "trader",
        session: "after_hours",
      });

      expect(calls).toHaveLength(1);
      expect(res.success).toBe(true);
    });

    it("carries extended_hours: true on the wire for exto overnight session orders", async () => {
      const calls = installFetch(async (call) => {
        const body = JSON.parse(call.init.body);
        expect(body).toMatchObject({
          symbol: "TSLA",
          qty: 8,
          side: "buy",
          type: "limit",
          limit_price: 215.0,
          time_in_force: "day",
          extended_hours: true,
        });
        return jsonResponse({ ...ORDER_OK, symbol: "TSLA" });
      });

      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");
      const res = await alpaca.placeOrderRemote({
        orderId: "ord-exto-1",
        symbol: "TSLA",
        action: "BUY",
        quantity: 8,
        orderType: "LIMIT",
        limitPrice: 215.0,
        // Issue #3782: the caller-supplied limit price declares user provenance for the placeOrder guard.
        priceSource: { kind: "user" },
        userLogin: "trader",
        session: "exto",
      });

      expect(calls).toHaveLength(1);
      expect(res.success).toBe(true);
    });

    it("refuses MARKET orders in extended sessions by name before hitting network", async () => {
      const calls = installFetch(async () => jsonResponse(ORDER_OK));
      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");

      const res = await alpaca.placeOrderRemote({
        orderId: "ord-err-1",
        symbol: "NVDA",
        action: "BUY",
        quantity: 10,
        orderType: "MARKET",
        userLogin: "trader",
        session: "pre_market",
      });

      expect(calls).toHaveLength(0);
      expect(res.success).toBe(false);
      expect(res.status).toBe("failed");
      expect(res.message).toMatch(/limit/i);
    });
  });

  describe("4. End-to-End Stock Copilot Cycle with Real Alpaca Adapter", () => {
    it("copilot cycle successfully places extended-hours limit order through AlpacaTradingPlatform", async () => {
      const calls = installFetch(async (call) => {
        if (call.url.includes("/v2/account")) {
          return jsonResponse({
            id: "act-1",
            account_number: "PA12345",
            status: "ACTIVE",
            currency: "USD",
            buying_power: "100000.00",
            cash: "100000.00",
            portfolio_value: "100000.00",
            multiplier: "2",
          });
        }
        if (call.url.includes("/v2/positions")) {
          return jsonResponse([]);
        }
        if (call.url.includes("/v2/orders")) {
          const body = JSON.parse(call.init.body);
          expect(body).toMatchObject({
            symbol: "TEST",
            side: "buy",
            type: "limit",
            extended_hours: true,
          });
          return jsonResponse({
            id: "alpaca-ord-session-123",
            symbol: "TEST",
            status: "accepted",
          });
        }
        return jsonResponse({});
      });

      const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "trader");
      const positions = createInMemoryStockCopilotPositionPort();
      const activity = createInMemoryStockCopilotActivityPort();

      // Sawtooth closes that trigger a mean_reversion BUY signal
      const closes: number[] = [];
      for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
      closes.push(100, 98);

      const result = await runStockCopilotCycle({
        env: { STOCK_COPILOT_PAPER_ENABLED: "1", ...PAPER_ENV } as any,
        selection: {
          resolved: true,
          selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
        },
        userLogin: "trader",
        platform: alpaca,
        positions,
        activity,
        enabledSessions: ["pre_market", "regular", "after_hours", "exto"],
        now: () => new Date("2026-11-04T10:00:00Z"), // Wed 05:00 ET = pre_market
        universe: ["TEST"],
        strategies: ["mean_reversion"],
        loadBars: async () => closes,
      });

      expect(result.status).toBe("ok");
      expect(result.session).toBe("pre_market");
      expect(result.entriesPlaced).toBe(1);
      expect(result.errors).toHaveLength(0);

      const orderCalls = calls.filter((c) => c.url.includes("/v2/orders"));
      expect(orderCalls).toHaveLength(1);

      const storedPositions = positions.listOpenPositions("trader");
      expect(storedPositions).toHaveLength(1);
      expect(storedPositions[0]).toMatchObject({
        symbol: "TEST",
        entrySession: "pre_market",
        entryOrderType: "LIMIT",
        brokerOrderRef: "alpaca-ord-session-123",
      });
    });
  });
});
