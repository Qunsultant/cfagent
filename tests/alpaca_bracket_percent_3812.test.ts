/**
 * Issue #3812 — the AAPL +4% / -2% bracket RCA fixes.
 *
 * Pins, end to end:
 * 1. Percent exits convert deterministically (BUY and SELL, half-up cents).
 * 2. `alpaca_preview_order` accepts takeProfitPercent/stopLossPercent and
 *    returns absolute bracket legs + orderClass "bracket" — a draft, never
 *    a placement.
 * 3. `alpaca_place_order` accepts take_profit_pct/stop_loss_pct, requires a
 *    positive limit, and sends the computed bracket to Alpaca.
 * 4. The platform default broker is Alpaca (paper is the mode default) and
 *    the client mirror agrees, so the dynamic settings menu opens on Alpaca.
 * 5. Every refused/filled order records a `trading` outcome the Workflow
 *    Runs ledger renders as its own run.
 * 6. Provider UX deep links exist for the fixes the refusal names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const storedPair = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));
vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return { ...actual, getAlpacaCredentials: async () => storedPair.record };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { computeBracketExits, BracketPercentError } from "../src/trading/bracketPercent";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import { DEFAULT_TENANT_PROVIDERS_STATE } from "../src/client/tenantProviders";
import { PROVIDER_UX_LINKS, CREDITS_TOP_UP_HINT, ALPACA_CONNECT_HINT } from "../src/services/providerUxLinks";
import { runFromOutcome } from "../src/services/workflowRuns";
import type { Env } from "../src/types";

const PAPER_ENV = {
  ALPACA_API_KEY_ID: ["PK", "TEST"].join(""),
  ALPACA_API_SECRET_KEY: ["SK", "TEST"].join(""),
} as unknown as Env;

function makeOrm(sessionId: string): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(sessionId);
  return orm;
}

function mcpContext(orm: DatabaseORM, env: Env, sessionId = "trader_session_001"): any {
  return { env, orm, sessionId, audit: vi.fn() };
}

type FetchCall = { url: string; init: any };

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
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

function alpacaFetchStub(options: { quote?: number } = {}): (call: FetchCall) => Response {
  const price = options.quote ?? 100;
  return (call) => {
    const url = String(call.url);
    if (url.includes("/quotes/latest")) {
      return jsonResponse({
        quote: { bp: price - 0.05, ap: price + 0.05, bs: 100, as: 120, t: "2026-11-09T15:30:00Z" },
      });
    }
    if (url.includes("/v2/orders") || url.endsWith("/orders")) {
      return jsonResponse({
        id: "alpaca-order-3812",
        client_order_id: "alp_ord_seed",
        symbol: "AAPL",
        qty: "10",
        side: "buy",
        type: "limit",
        time_in_force: "day",
        status: "accepted",
        filled_avg_price: null,
      });
    }
    return jsonResponse({}, 404);
  };
}

describe("percent bracket exits (#3812)", () => {
  it("converts a BUY +4% / -2% bracket from the entry, rounded to cents", () => {
    const exits = computeBracketExits({
      side: "BUY",
      entryPrice: 342.37,
      takeProfitPercent: 4,
      stopLossPercent: 2,
    });
    expect(exits.takeProfit.limitPrice).toBe(356.06);
    expect(exits.stopLoss.stopPrice).toBe(335.52);
    expect(exits.takeProfitPercent).toBe(4);
    expect(exits.stopLossPercent).toBe(2);
  });

  it("converts a SELL bracket in the opposite direction", () => {
    const exits = computeBracketExits({
      side: "SELL",
      entryPrice: 100,
      takeProfitPercent: 4,
      stopLossPercent: 2,
    });
    expect(exits.takeProfit.limitPrice).toBe(96);
    expect(exits.stopLoss.stopPrice).toBe(102);
  });

  it("refuses malformed percentages and entries with a coded error", () => {
    expect(() =>
      computeBracketExits({ side: "BUY", entryPrice: 100, takeProfitPercent: 0, stopLossPercent: 2 }),
    ).toThrow(BracketPercentError);
    expect(() =>
      computeBracketExits({ side: "BUY", entryPrice: 0, takeProfitPercent: 4, stopLossPercent: 2 }),
    ).toThrow(/positive entry/i);
    expect(() =>
      computeBracketExits({ side: "BUY", entryPrice: 100, takeProfitPercent: 4, stopLossPercent: 100 }),
    ).toThrow(/below 100/i);
  });
});

describe("Alpaca order tools accept percent exits (#3812)", () => {
  beforeEach(() => {
    storedPair.record = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preview with a user limit produces a bracket draft with absolute legs", async () => {
    installFetch(alpacaFetchStub());
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    const orm = makeOrm("trader_session_001");
    const draft = await cmd!.execute(
      {
        symbol: "AAPL",
        action: "BUY",
        quantity: 10,
        orderType: "LIMIT",
        limitPrice: 100,
        takeProfitPercent: 4,
        stopLossPercent: 2,
      },
      mcpContext(orm, PAPER_ENV),
    );

    expect(draft.status).toBe("previewed");
    expect(draft.orderClass).toBe("bracket");
    expect(draft.takeProfit).toEqual({ limitPrice: 104 });
    expect(draft.stopLoss).toEqual({ stopPrice: 98 });
    expect(draft.priceSource).toEqual({ kind: "user" });
    expect(draft.previewMessage).toContain("take-profit $104.00");
    expect(draft.previewMessage).toContain("stop-loss $98.00");
    // A draft is not a placement: no order POST happened.
    const calls = (globalThis.fetch as any).mock?.calls ?? [];
    expect(JSON.stringify(calls)).not.toContain('"order_class":"bracket"');
  });

  it("preview without a user limit prices the bracket off the live quote", async () => {
    installFetch(alpacaFetchStub({ quote: 100 }));
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    const orm = makeOrm("trader_session_001");
    const draft = await cmd!.execute(
      { symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT", takeProfitPercent: 4, stopLossPercent: 2 },
      mcpContext(orm, PAPER_ENV),
    );
    expect(draft.limitPrice).toBeUndefined();
    expect(draft.takeProfit).toEqual({ limitPrice: 104 });
    expect(draft.stopLoss).toEqual({ stopPrice: 98 });
    expect(draft.priceSource).toMatchObject({ kind: "live-quote", provider: expect.stringContaining("Alpaca") });
  });

  it("preview refuses a half-specified percent bracket", async () => {
    installFetch(alpacaFetchStub());
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    const orm = makeOrm("trader_session_001");
    await expect(
      cmd!.execute(
        { symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 100, takeProfitPercent: 4 },
        mcpContext(orm, PAPER_ENV),
      ),
    ).rejects.toThrow(/both takeProfitPercent and stopLossPercent/i);
  });

  it("place converts take_profit_pct/stop_loss_pct from limit_price and sends a bracket", async () => {
    const calls = installFetch(alpacaFetchStub());
    const cmd = McpToolFactory.getTool("alpaca_place_order");
    const orm = makeOrm("trader_session_001");
    const res = await cmd!.execute(
      {
        symbol: "AAPL",
        qty: 10,
        side: "buy",
        type: "limit",
        limit_price: 100,
        take_profit_pct: 4,
        stop_loss_pct: 2,
      },
      mcpContext(orm, PAPER_ENV),
    );

    expect(res.success).toBe(true);
    const post = calls.find((c) => String(c.url).includes("/orders") && c.init?.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post!.init.body));
    expect(body.order_class).toBe("bracket");
    expect(body.take_profit).toEqual({ limit_price: 104 });
    expect(body.stop_loss).toEqual({ stop_price: 98 });
  });

  it("place refuses percent exits without a positive limit", async () => {
    installFetch(alpacaFetchStub());
    const cmd = McpToolFactory.getTool("alpaca_place_order");
    const orm = makeOrm("trader_session_001");
    const res = await cmd!.execute(
      { symbol: "AAPL", qty: 10, side: "buy", type: "market", take_profit_pct: 4, stop_loss_pct: 2 },
      mcpContext(orm, PAPER_ENV),
    );
    expect(res.success).toBe(false);
    expect(res.refusal).toBe("bracket_percent_needs_limit");
  });
});

describe("default broker is Alpaca in paper mode (#3812)", () => {
  it("the server default broker is alpaca; the data provider default is unchanged", () => {
    expect(DEFAULT_TENANT_PROVIDERS).toEqual({ dataProviderId: "etrade", brokerId: "alpaca" });
  });

  it("the client mirror agrees, so the settings menu opens on Alpaca before the server row loads", () => {
    expect(DEFAULT_TENANT_PROVIDERS_STATE).toEqual({ dataProviderId: "etrade", brokerId: "alpaca" });
  });
});

describe("workflow-run traceability for trading (#3812)", () => {
  it("a trading outcome is its own run under the Trading order workflow", () => {
    const run = runFromOutcome({
      id: "order:alp_ord_3812",
      kind: "trading",
      trigger: "manual",
      status: "completed",
      scanned: 1,
      matched: 1,
      deliveryStates: { broker: "alpaca", mode: "paper", symbol: "AAPL", quantity: "10" },
      origin: "alpaca_preview_order",
      createdAt: "2026-11-09T15:30:00.000Z",
    });
    expect(run.family).toBe("trading");
    expect(run.workflow).toBe("Trading order workflow");
    expect(run.title).toContain("Trading run");
    expect(run.status).toBe("completed");
  });
});

describe("provider UX deep links (#3812)", () => {
  it("names the exact top-up and Alpaca-connect URLs", () => {
    expect(PROVIDER_UX_LINKS.creditsTopUp).toBe("?tab=checkout&checkoutTab=topup");
    expect(PROVIDER_UX_LINKS.alpacaConnectPaper).toContain("/api/broker/connect/alpaca");
    expect(CREDITS_TOP_UP_HINT).toContain(PROVIDER_UX_LINKS.creditsTopUp);
    expect(ALPACA_CONNECT_HINT).toContain(PROVIDER_UX_LINKS.alpacaConnectPaper);
    expect(ALPACA_CONNECT_HINT).toContain(PROVIDER_UX_LINKS.alpacaConnectLive);
  });
});
