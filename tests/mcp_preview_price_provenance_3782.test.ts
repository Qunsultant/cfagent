/**
 * Issue #3782 (incident #3781) — Stock Copilot invented a limit price
 * ($178.00 AAPL) while quote jobs were still running. Two halves:
 *
 * (1) Guardrail: a LIMIT draft with no user-supplied limit and no live
 * authoritative quote is REFUSED (no draft, ask for the limit); every
 * draft carries priceSource; placeOrder refuses an unprovenanced limit.
 * (2) Alpaca parity: the copilot's broker is Alpaca (COPILOT_BROKER_ID),
 * so Alpaca quote + preview must exist as agent tools and the copilot
 * must route to them instead of the E*TRADE tools.
 *
 * TDD Red: these tests FAIL on the pre-fix tree (refusal absent,
 * priceSource absent, Alpaca tools unregistered, placeOrder unguarded).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const storedPair = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));
vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return { ...actual, getAlpacaCredentials: async () => storedPair.record };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { MarketDataResearchService } from "../src/services/marketDataResearch";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { DynamicMarketScreener } from "../src/trading/screener";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MCP_TOOLS_CATALOG } from "../src/client/mcpEndpointsData";
import { MESH_TOOL_FAMILIES } from "../src/agents/registry";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import type { Env } from "../src/types";

const KEY_ID = ["PK", "TEST"].join("");
const SECRET = ["SK", "TEST"].join("");

const ETRADE_ENV = {
  APP_BASE_URL: "https://agent.openaimp.com",
  AI_SEARCH_ENDPOINT: "https://ai-search.internal",
  ORCHESTRATOR_AGENT: {} as any,
  ETRADE_ENVIRONMENT: "sandbox",
} as unknown as Env;

const PAPER_ENV = {
  ALPACA_API_KEY_ID: KEY_ID,
  ALPACA_API_SECRET_KEY: SECRET,
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
type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function installFetch(handler: FetchHandler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init: any) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  );
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const ALPACA_QUOTE_OK = {
  quote: { bp: 342.3, ap: 342.45, bs: 100, as: 120, t: "2026-11-08T15:30:00Z" },
};

const ALPACA_ORDER_OK = {
  id: "alpaca-order-1",
  client_order_id: "alp_ord_seed",
  symbol: "AAPL",
  qty: "10",
  side: "buy",
  type: "limit",
  time_in_force: "day",
  status: "accepted",
  filled_avg_price: null,
};

function quoteFetchStub(price = 342.37): FetchHandler {
  return async (call) => {
    if (String(call.url).includes("/quotes/latest")) {
      return jsonResponse({ quote: { bp: price - 0.05, ap: price + 0.05, bs: 100, as: 120, t: "2026-11-08T15:30:00Z" } });
    }
    return jsonResponse({}, 404);
  };
}

describe("guardrail (1): E*TRADE MCP preview refusal (#3782a)", () => {
  let orm: DatabaseORM;
  let etrade: ETradeService;

  beforeEach(() => {
    storedPair.record = null;
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    DynamicMarketScreener.setTestListingsFixture(null);
    orm = makeOrm("trader_session_001");
    etrade = new ETradeService(orm, ETRADE_ENV, "test-user");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a LIMIT draft with no user limit and no live quote is refused and creates no draft record", () => {
    const quote = etrade.getQuote("AAPL");
    expect(quote.lastPrice).toBeGreaterThan(0);
    expect(quote.quoteStatus).not.toBe("REALTIME");

    expect(() =>
      etrade.previewOrder({
        sessionId: "trader_session_001",
        symbol: "AAPL",
        orderAction: "BUY",
        quantity: 10,
        orderType: "LIMIT",
      }),
    ).toThrow(/no limit price was supplied|ask.*limit|provide a limit price/i);
    expect(orm.trades.findMany({ where: { symbol: "AAPL" } })).toHaveLength(0);
  });

  it("a LIMIT draft with a user-supplied limit is created with user price provenance", () => {
    const draft = etrade.previewOrder({
      sessionId: "trader_session_001",
      symbol: "AAPL",
      orderAction: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 340.0,
    });
    expect(draft.status).toBe("previewed");
    expect(draft.estimatedPrice).toBe(340.0);
    expect(draft.limitPrice).toBe(340.0);
    expect(draft.priceSource).toEqual({ kind: "user" });
    const saved = orm.trades.findById(draft.orderId);
    expect(saved?.priceSourceJson).toBe(JSON.stringify({ kind: "user" }));
  });

  it("a MARKET draft carries price provenance (estimated in the sandbox test env)", () => {
    const draft = etrade.previewOrder({
      sessionId: "trader_session_001",
      symbol: "AAPL",
      orderAction: "BUY",
      quantity: 10,
      orderType: "MARKET",
    });
    expect(draft.status).toBe("previewed");
    expect(draft.priceSource).toBeDefined();
    expect(draft.priceSource?.kind).toBe("estimated");
  });

  it("the MCP preview command refuses a no-limit LIMIT draft and persists nothing", async () => {
    const ctx = mcpContext(orm, ETRADE_ENV);
    const cmd = McpToolFactory.getTool("etrade_preview_order");
    expect(cmd).toBeDefined();
    await expect(
      cmd!.execute(
        { symbol: "AAPL", orderAction: "BUY", quantity: 10, orderType: "LIMIT" },
        ctx,
      ),
    ).rejects.toThrow(/no limit price was supplied|provide a limit price/i);
    expect(orm.trades.findMany({ where: { symbol: "AAPL" } })).toHaveLength(0);
  });

  it("the MCP preview command returns priceSource on a created draft", async () => {
    const ctx = mcpContext(orm, ETRADE_ENV);
    const cmd = McpToolFactory.getTool("etrade_preview_order");
    const preview = await cmd!.execute(
      { symbol: "AAPL", orderAction: "BUY", quantity: 10, orderType: "MARKET" },
      ctx,
    );
    expect(preview.status).toBe("previewed");
    expect(preview.priceSource).toBeDefined();
    expect(preview.priceSource.kind).toBe("estimated");
  });
});

describe("guardrail (1): Alpaca preview honours provenance (#3782a/b)", () => {
  beforeEach(() => {
    storedPair.record = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an equity LIMIT draft with no user limit is priced off the live Alpaca quote, with live-quote provenance", async () => {
    installFetch(quoteFetchStub(342.37));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const draft = await alpaca.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
    });
    expect(draft.status).toBe("previewed");
    expect(draft.estimatedPrice).toBe(342.37);
    expect(draft.priceSource).toMatchObject({
      kind: "live-quote",
      provider: expect.stringContaining("Alpaca"),
      timestamp: expect.any(String),
    });
  });

  it("an equity LIMIT draft with a user limit uses the user price, not the quote", async () => {
    installFetch(quoteFetchStub(342.37));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const draft = await alpaca.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 300.0,
    });
    expect(draft.estimatedPrice).toBe(300.0);
    expect(draft.estimatedTotal).toBe(3000.0);
    expect(draft.priceSource).toEqual({ kind: "user" });
    expect(draft.previewMessage).toContain("300.00");
  });

  it("an Alpaca preview with no live quote available fails loud and creates no draft", async () => {
    installFetch(async () => jsonResponse({ message: "unauthorized" }, 401));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    await expect(
      alpaca.previewOrder({ symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT" }),
    ).rejects.toThrow(/live.*unavailable|unavailable/i);
  });

  it("an options preview carries user provenance (a limit is required for options)", async () => {
    installFetch(quoteFetchStub(342.37));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const draft = await alpaca.previewOrder({
      assetClass: "options",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 2.5,
      strategyNetDebit: 2.5,
      optionLegs: [
        { underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 350, expirationDate: "2026-12-18" },
      ],
    });
    expect(draft.status).toBe("previewed");
    expect(draft.priceSource).toEqual({ kind: "user" });
  });
});

describe("guardrail (1): placeOrder refuses an unprovenanced limit price (#3782c)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a limit order with no priceSource is refused and never POSTs to Alpaca", async () => {
    const calls = installFetch(async () => jsonResponse(ALPACA_ORDER_OK));
    const service = new MarketDataResearchService(PAPER_ENV);
    const result = await service.placeAlpacaOrder({
      symbol: "AAPL",
      qty: 10,
      side: "buy",
      type: "limit",
      limit_price: 178.0,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unprovenanced|provenance/i);
    expect(calls.filter((c) => String(c.url).includes("/v2/orders"))).toHaveLength(0);
  });

  it("a limit order with estimated provenance is refused and never POSTs to Alpaca", async () => {
    const calls = installFetch(async () => jsonResponse(ALPACA_ORDER_OK));
    const service = new MarketDataResearchService(PAPER_ENV);
    const result = await service.placeAlpacaOrder({
      symbol: "AAPL",
      qty: 10,
      side: "buy",
      type: "limit",
      limit_price: 178.0,
      priceSource: { kind: "estimated", provider: "static fallback" },
    } as any);
    expect(result.success).toBe(false);
    expect(calls.filter((c) => String(c.url).includes("/v2/orders"))).toHaveLength(0);
  });

  it("a limit order with user provenance reaches Alpaca", async () => {
    const calls = installFetch(async (call) => {
      expect(call.url).toBe("https://paper-api.alpaca.markets/v2/orders");
      return jsonResponse(ALPACA_ORDER_OK);
    });
    const service = new MarketDataResearchService(PAPER_ENV);
    const result = await service.placeAlpacaOrder({
      symbol: "AAPL",
      qty: 10,
      side: "buy",
      type: "limit",
      limit_price: 340.0,
      priceSource: { kind: "user" },
    } as any);
    expect(result.success).toBe(true);
    expect(result.orderId).toBe("alpaca-order-1");
    expect(calls).toHaveLength(1);
  });

  it("a market order without a limit price is unaffected by the guard", async () => {
    installFetch(async () => jsonResponse({ ...ALPACA_ORDER_OK, type: "market" }));
    const service = new MarketDataResearchService(PAPER_ENV);
    const result = await service.placeAlpacaOrder({ symbol: "AAPL", qty: 10, side: "buy", type: "market" });
    expect(result.success).toBe(true);
  });

  it("placeOrderRemote forwards the stored draft's provenance, so an approved draft executes", async () => {
    const orm = makeOrm("sess_3782");
    orm.trades.create({
      id: "alp_ord_seed",
      sessionId: "sess_3782",
      symbol: "AAPL",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 10,
      price: 340.0,
      totalValue: 3400.0,
      status: "previewed",
      orderRef: undefined,
      proposerDid: "did:agent:openaimp:trading",
      authorizerDid: "did:user:github:boss",
      proofSignature: "sig_3782_seed",
      previewNotes: "Alpaca Order Preview: BUY 10 AAPL.",
      priceSourceJson: JSON.stringify({ kind: "user" }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
    const calls = installFetch(async (call) => {
      expect(call.url).toBe("https://paper-api.alpaca.markets/v2/orders");
      return jsonResponse(ALPACA_ORDER_OK);
    });
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, orm, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "alp_ord_seed",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 340.0,
      userLogin: "boss",
    });
    expect(res.success).toBe(true);
    expect(calls.filter((c) => String(c.url).includes("/v2/orders"))).toHaveLength(1);
  });

  it("placeOrderRemote with explicit market-data provenance (copilot exit shape) reaches Alpaca", async () => {
    installFetch(async () => jsonResponse(ALPACA_ORDER_OK));
    const alpaca = new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
    const res = await alpaca.placeOrderRemote({
      orderId: "copilot-exit-1",
      symbol: "AAPL",
      action: "SELL",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 350.0,
      userLogin: "boss",
      priceSource: { kind: "market-data", provider: "Stock Copilot exit bars", timestamp: "2026-11-08T15:30:00Z" },
    } as any);
    expect(res.success).toBe(true);
  });
});

describe("Alpaca parity (2): quote + preview as agent tools (#3782)", () => {
  beforeEach(() => {
    storedPair.record = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("alpaca_get_quote is a registered tool returning a live Alpaca quote with provenance", async () => {
    installFetch(quoteFetchStub(342.37));
    const cmd = McpToolFactory.getTool("alpaca_get_quote");
    expect(cmd).toBeDefined();
    const orm = makeOrm("trader_session_001");
    const quote = await cmd!.execute({ symbol: "AAPL" }, mcpContext(orm, PAPER_ENV));
    expect(quote.symbol).toBe("AAPL");
    expect(quote.provider).toBe("alpaca");
    expect(quote.provenance).toBe("live");
    expect(quote.price).toBe(342.37);
    expect(quote.timestamp).toBeTruthy();
  });

  it("alpaca_get_quote fails loud when Alpaca is unconfigured — no substitute quote", async () => {
    const cmd = McpToolFactory.getTool("alpaca_get_quote");
    expect(cmd).toBeDefined();
    const orm = makeOrm("trader_session_001");
    await expect(
      cmd!.execute({ symbol: "AAPL" }, mcpContext(orm, {} as Env)),
    ).rejects.toThrow(/live.*unavailable|unavailable/i);
  });

  it("alpaca_preview_order is a registered tool creating a draft with a provenanced price", async () => {
    installFetch(quoteFetchStub(342.37));
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    expect(cmd).toBeDefined();
    const orm = makeOrm("trader_session_001");
    const draft = await cmd!.execute(
      { symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT" },
      mcpContext(orm, PAPER_ENV),
    );
    expect(draft.status).toBe("previewed");
    expect(draft.orderId).toMatch(/^alp_ord_/);
    expect(draft.broker).toBe("alpaca");
    expect(draft.estimatedPrice).toBe(342.37);
    expect(draft.priceSource).toMatchObject({ kind: "live-quote", provider: expect.stringContaining("Alpaca") });
  });

  it("alpaca_preview_order with a user limit uses it, and refuses nothing when the quote is live", async () => {
    installFetch(quoteFetchStub(342.37));
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    const orm = makeOrm("trader_session_001");
    const draft = await cmd!.execute(
      { symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 300.0 },
      mcpContext(orm, PAPER_ENV),
    );
    expect(draft.estimatedPrice).toBe(300.0);
    expect(draft.priceSource).toEqual({ kind: "user" });
  });

  it("alpaca_preview_order fails loud when no live Alpaca quote is available", async () => {
    installFetch(async () => jsonResponse({ message: "unauthorized" }, 401));
    const cmd = McpToolFactory.getTool("alpaca_preview_order");
    const orm = makeOrm("trader_session_001");
    await expect(
      cmd!.execute({ symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT" }, mcpContext(orm, PAPER_ENV)),
    ).rejects.toThrow(/live.*unavailable|unavailable/i);
  });

  it("both new tools are registered, permission-scoped, catalogued, and in the tool registry", () => {
    expect(McpToolFactory.getTool("alpaca_get_quote")).toBeDefined();
    expect(McpToolFactory.getTool("alpaca_preview_order")).toBeDefined();
    expect(MCP_TOOL_SCOPES["alpaca_get_quote"]).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES["alpaca_preview_order"]).toBe("mcp:trade");
    const catalogNames = MCP_TOOLS_CATALOG.map((t) => t.name);
    expect(catalogNames).toContain("alpaca_get_quote");
    expect(catalogNames).toContain("alpaca_preview_order");
    const marketDataFamily = MESH_TOOL_FAMILIES.find((f) => f.id === "market-data-mcp-commands");
    expect(marketDataFamily?.commands).toContain("alpaca_get_quote");
    expect(marketDataFamily?.commands).toContain("alpaca_preview_order");
  });
});

describe("agent routing (2): the copilot routes quote/preview to Alpaca (#3782)", () => {
  it("the Stock Copilot steering names the Alpaca quote/preview tools and the price-source rule", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "trading", confidence: 1, reason: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
      stockCopilotMcpActive: true,
    });
    expect(prompt).toContain("tool_openaimp_alpaca_get_quote");
    expect(prompt).toContain("tool_openaimp_alpaca_preview_order");
    expect(prompt).toMatch(/never present a price without .* source/i);
    expect(prompt).toMatch(/do not use.*etrade.*(quote|preview)|not the E\*TRADE/i);
  });

  it("rule 6 carries the price-provenance rule for every trading turn", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "trading", confidence: 1, reason: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
    expect(prompt).toMatch(/never state .* price without .* source/i);
    expect(prompt).toMatch(/ask for the limit, never guess/i);
  });
});
