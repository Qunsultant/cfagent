/**
 * Issue #3990 Slice C — Public.com as a live broker.
 *
 * TDD Red: these FAIL on the pre-#3990 tree —
 *  - Public has no trading client (the data client's allow-list
 *    refuses order tools by construction) and no trading platform;
 *  - BROKER_IDS is ["etrade", "alpaca"]; the catalog has no public
 *    entry; the registry registers no public platform;
 *  - the outcome catalog has no code for "Public has no paper mode";
 *  - the OAuth scopes carry no trading.write;
 *  - Settings has no personal-token connect surface.
 *
 * Green when: the trading client (second allow-list over the same
 * MCP transport) places/previews/cancels through fakes; the
 * platform maps the neutral shapes; TEST-mode placement is refused
 * with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP call; the
 * catalog + registry + presentation + identities carry public; the
 * scopes carry trading.write; the neutral connect read answers.
 *
 * No live network, no live orders: every MCP call goes through an
 * injected fake fetch; PROD-mode tests assert the call that WOULD
 * be made, never a real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  PUBLIC_DATA_TOOL_ALLOWLIST,
  PublicMcpClient,
} from "../src/mcps/public/publicMcp";
import { PublicTradingMcpClient, PUBLIC_TRADING_TOOL_ALLOWLIST } from "../src/mcps/public/publicTradingMcp";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import {
  BROKER_CATALOG,
  ROUTED_BROKER_IDS,
  TradingPlatformRegistry,
  assertBrokerCatalogComplete,
  brokerCredentialGuidance,
  isBrokerId,
  tradingTypeFor,
  type BrokerId,
} from "../src/trading";
import { BROKER_IDS, brokerIdentity } from "../src/services/tenantProviders";
import { brokerPresentation } from "../src/trading/brokerPresentation";
import { DEFAULT_PUBLIC_OAUTH_SCOPES } from "../src/security/publicOAuth";
import { getOutcome } from "../src/outcomes/outcomeAspects";
import outcomeCatalog from "../src/outcomes/outcomeCatalog.json";
import { connectStatusEndpoint } from "../src/client/brokerEndpoints";
import { handleBrokerConnectRoutes as handleConnectRoute } from "../src/agents/routes/brokerConnect";
import { storePublicPersonalToken } from "../src/security/publicOAuth";
import type { Env } from "../src/types";

/* ------------------------- fake MCP transport ------------------------- */

type RpcCall = { method: string; tool?: string; args?: Record<string, unknown> };

const TOOL_SCHEMAS: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
  place_order: {
    properties: {
      symbol: { type: "string" },
      instrument_type: { type: "string" },
      order_side: { type: "string" },
      order_type: { type: "string" },
      quantity: { type: "number" },
      limit_price: { type: "number" },
      order_class: { type: "string" },
      take_profit_limit_price: { type: "number" },
      stop_loss_stop_price: { type: "number" },
      stop_loss_limit_price: { type: "number" },
    },
    required: ["symbol", "instrument_type", "order_side", "order_type", "quantity"],
  },
  preflight_order: {
    properties: {
      symbol: { type: "string" },
      instrument_type: { type: "string" },
      order_side: { type: "string" },
      order_type: { type: "string" },
      quantity: { type: "number" },
      limit_price: { type: "number" },
    },
    required: ["symbol", "instrument_type", "order_side", "order_type", "quantity"],
  },
  place_multileg_order: {
    properties: { legs: { type: "array" }, quantity: { type: "number" }, limit_price: { type: "number" } },
    required: ["legs", "quantity"],
  },
  preflight_multileg_order: {
    properties: { legs: { type: "array" }, quantity: { type: "number" }, limit_price: { type: "number" } },
    required: ["legs", "quantity"],
  },
  cancel_order: {
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
  get_accounts: { properties: {}, required: [] },
  get_orders: { properties: {}, required: [] },
  get_order: { properties: { order_id: { type: "string" } }, required: ["order_id"] },
  get_portfolio: { properties: {}, required: [] },
  get_quotes: { properties: { symbols: { type: "array" } }, required: ["symbols"] },
  get_option_greeks: { properties: { symbols: { type: "array" } }, required: ["symbols"] },
};

const TOOL_RESULTS: Record<string, unknown> = {
  get_accounts: { accounts: [{ account_id: "acc-1", account_number: "P-1234", account_type: "individual" }] },
  get_portfolio: {
    positions: [{ symbol: "AAPL", quantity: 10, market_value: 3423.7, average_cost: 300 }],
    buying_power: 5000,
  },
  get_orders: {
    orders: [
      { order_id: "ord-1", symbol: "AAPL", side: "BUY", quantity: 1, status: "FILLED", filled_quantity: 1, average_price: 342.37 },
    ],
  },
  preflight_order: { valid: true, estimated_total: 342.37, estimated_fees: 0, buying_power_after: 4657.63 },
  place_order: { order_id: "ord-99", status: "NEW" },
  place_multileg_order: { order_id: "ord-100", status: "NEW" },
  cancel_order: { order_id: "ord-1", status: "CANCELLED" },
  get_quotes: { quotes: [{ symbol: "AAPL", last_price: 342.37 }] },
};

function fakePublicFetch(calls: RpcCall[]) {
  return async (url: string, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (body.method === "tools/list") {
      calls.push({ method: "tools/list" });
      return Response.json({
        result: {
          tools: Object.entries(TOOL_SCHEMAS).map(([name, inputSchema]) => ({ name, inputSchema })),
        },
      });
    }
    if (body.method === "tools/call") {
      calls.push({ method: "tools/call", tool: body.params?.name, args: body.params?.arguments });
      const text = JSON.stringify(TOOL_RESULTS[body.params?.name ?? ""] ?? {});
      return Response.json({ result: { content: [{ type: "text", text }] } });
    }
    return Response.json({ error: { code: -32601, message: "unknown method " + body.method } });
  };
}

const tokenProvider = async () => "test-token-1234";

function makeClient(calls: RpcCall[]) {
  return new PublicTradingMcpClient({
    accessTokenProvider: tokenProvider,
    fetchImpl: fakePublicFetch(calls) as typeof fetch,
  });
}

function stubDataProvider() {
  return {
    getQuote: async (symbol: string) => ({
      providerId: "public",
      capability: "quotes",
      result: {
        symbol,
        lastPrice: 342.37,
        price: 342.37,
        change: 0,
        changePercent: 0,
        bid: 342.3,
        ask: 342.4,
        volume: 1000,
        open: 340,
        high: 343,
        low: 339,
        previousClose: 341,
      },
    }),
    getOptionsChain: async () => ({
      providerId: "public",
      capability: "optionsChains",
      result: { symbol: "AAPL", underlyingPrice: 342.37, pairs: [] },
    }),
    getOptionExpiryDates: async () => ({ providerId: "public", capability: "optionsChains", result: [] }),
  };
}

function makePlatform(calls: RpcCall[], overrideEnv: "TEST" | "PROD", orm?: unknown) {
  return new PublicTradingPlatform({} as Env, orm as never, "test-login", overrideEnv, {
    accessTokenProvider: tokenProvider,
    fetchImpl: fakePublicFetch(calls) as typeof fetch,
    dataProvider: stubDataProvider() as never,
  });
}

describe("Slice C — the trading client is a second allow-list over the same transport", () => {
  it("the trading allow-list carries the write tools, the preflights, and only the reads trading needs", () => {
    for (const tool of [
      "place_order",
      "place_multileg_order",
      "place_call_credit_spread",
      "place_call_debit_spread",
      "place_put_credit_spread",
      "place_put_debit_spread",
      "place_short_order",
      "cancel_order",
      "cancel_and_replace_order",
      "preflight_order",
      "preflight_multileg_order",
      "preflight_short_order",
      "preflight_call_credit_spread",
      "preflight_call_debit_spread",
      "preflight_put_credit_spread",
      "preflight_put_debit_spread",
      "get_accounts",
      "get_orders",
      "get_order",
      "search_orders",
      "get_portfolio",
      "get_option_greek",
      "get_option_greeks",
    ]) {
      expect(PUBLIC_TRADING_TOOL_ALLOWLIST).toContain(tool);
    }
    // Deliberately NOT on the list: flatten_and_go_short is
    // experimental and non-atomic (no neutral shape), and event
    // contracts are outside the equity/options scope.
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("flatten_and_go_short");
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("buy_event_contract");
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("preflight_buy_event_contract");
    // No data-only tools on the trading list: chains/quotes ride the
    // data adapter, never the trading client.
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("get_option_chain");
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("get_option_expirations");
    expect(PUBLIC_TRADING_TOOL_ALLOWLIST).not.toContain("get_quotes");
  });

  it("the data client stays read-only: it refuses place_order before any network call", async () => {
    const calls: RpcCall[] = [];
    const dataClient = new PublicMcpClient({
      accessTokenProvider: tokenProvider,
      fetchImpl: fakePublicFetch(calls) as typeof fetch,
    });
    await expect(dataClient.callToolText("place_order", {})).rejects.toThrow(/not on the Public data allow-list/);
    expect(calls).toEqual([]);
    expect([...PUBLIC_DATA_TOOL_ALLOWLIST]).toEqual([
      "get_accounts",
      "get_quotes",
      "get_option_expirations",
      "get_option_chain",
    ]);
  });

  it("a trading client refuses data-only tools, and probes tools/list at first use", async () => {
    const calls: RpcCall[] = [];
    const client = makeClient(calls);
    await expect(client.callTradingTool("get_option_chain", {})).rejects.toThrow(/not on the Public trading allow-list/);
    expect(calls).toEqual([]);
    const accounts = await client.callTradingTool("get_accounts", {});
    expect(calls[0].method).toBe("tools/list");
    expect(calls[1]).toEqual({ method: "tools/call", tool: "get_accounts", args: {} });
    expect(JSON.parse(accounts).accounts[0].account_id).toBe("acc-1");
  });

  it("a tool absent from the live list is refused by name instead of called", async () => {
    const calls: RpcCall[] = [];
    const client = makeClient(calls);
    // place_call_credit_spread IS on the trading allow-list, but this
    // server's tools/list does not offer it: the probe must refuse it
    // by name, never guess the call through.
    await expect(client.callTradingTool("place_call_credit_spread", {})).rejects.toThrow(
      /not offered by this Public MCP server/
    );
  });
});

describe("Slice C — the Public platform maps the neutral shapes", () => {
  it("status names Public, its own protocol, and configured-ness from the token", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "TEST");
    const status = await platform.getStatus();
    expect(status.broker).toBe("public");
    expect(status.name).toBe("Public.com");
    expect(status.configured).toBe(true);
    expect(status.protocol).toBe("mcp_json_rpc");
    expect(status.activeEnvironment).toBe("TEST");
    const noToken = new PublicTradingPlatform({} as Env, undefined, "test-login", "TEST", {
      accessTokenProvider: async () => null,
      fetchImpl: fakePublicFetch(calls) as typeof fetch,
    });
    expect((await noToken.getStatus()).configured).toBe(false);
  });

  it("preview is a preflight, never a placement — stock and single-leg option alike", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "TEST");
    const draft = await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
    });
    expect(draft.symbol).toBe("AAPL");
    expect(draft.quantity).toBe(1);
    expect(draft.estimatedTotal).toBe(342.37);
    const toolsCalled = calls.filter((c) => c.method === "tools/call").map((c) => c.tool);
    expect(toolsCalled).toEqual(["preflight_order"]);
    expect(toolsCalled).not.toContain("place_order");

    const optionCalls: RpcCall[] = [];
    const optionPlatform = makePlatform(optionCalls, "TEST");
    await optionPlatform.previewOrder({
      assetClass: "options",
      symbol: "AAPL260320C00100000",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 1.1,
    });
    const preflight = optionCalls.find((c) => c.tool === "preflight_order");
    expect(preflight?.args?.instrument_type).toBe("OPTION");
  });

  it("TEST-mode placement is refused with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP call", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "TEST");
    const result = await platform.placeOrderRemote({
      orderId: "draft-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "test-login",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(calls).toEqual([]);
  });

  it("TEST-mode executeOrder refuses the same way and leaves the previewed draft untouched", async () => {
    const calls: RpcCall[] = [];
    const draft = {
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      status: "previewed",
      proofSignature: "",
      previewNotes: "{}",
    };
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const orm = {
      trades: {
        findById: () => draft,
        update: (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
        },
      },
    };
    const platform = makePlatform(calls, "TEST", orm);
    const result = await platform.executeOrder("draft-1", "did:test:authorizer", "approved");
    expect(result.success).toBe(false);
    expect(result.message).toContain("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(calls).toEqual([]);
    expect(updates).toEqual([]);
    expect(draft.status).toBe("previewed");
  });

  it("PROD-mode placement calls place_order once and returns the broker order ref", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "PROD");
    const result = await platform.placeOrderRemote({
      orderId: "draft-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      userLogin: "test-login",
    });
    expect(result.success).toBe(true);
    expect(result.brokerOrderRef).toBe("ord-99");
    const placed = calls.filter((c) => c.tool === "place_order");
    expect(placed).toHaveLength(1);
    expect(placed[0].args?.symbol).toBe("AAPL");
    expect(placed[0].args?.instrument_type).toBe("EQUITY");
    expect(placed[0].args?.order_side).toBe("BUY");
  });

  it("PROD-mode bracket placement carries order_class BRACKET with the TP/SL legs", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "PROD");
    await platform.placeOrderRemote({
      orderId: "draft-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 342.37,
      orderClass: "bracket",
      takeProfit: { limitPrice: 356.06 },
      stopLoss: { stopPrice: 335.52 },
      userLogin: "test-login",
    });
    const placed = calls.find((c) => c.tool === "place_order");
    expect(placed?.args?.order_class).toBe("BRACKET");
    expect(placed?.args?.take_profit_limit_price).toBe(356.06);
    expect(placed?.args?.stop_loss_stop_price).toBe(335.52);
  });

  it("order history reads get_orders and cancel reads cancel_order", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls, "PROD");
    const history = await platform.getOrderHistory!("all");
    expect(history).toHaveLength(1);
    expect(history[0].orderId).toBe("ord-1");
    expect(history[0].symbol).toBe("AAPL");
    // The neutral status is EXECUTED; the broker's own word rides rawStatus.
    expect(history[0].status).toBe("EXECUTED");
    expect(history[0].rawStatus).toBe("FILLED");
    const cancelled = await platform.cancelOrderRemote!("ord-1");
    expect(cancelled.success).toBe(true);
    expect(calls.filter((c) => c.tool === "get_orders")).toHaveLength(1);
    expect(calls.filter((c) => c.tool === "cancel_order")).toHaveLength(1);
  });

  it("quote and chains delegate to the data adapter, never to a second quote mapping", async () => {
    const calls: RpcCall[] = [];
    const quote = { symbol: "AAPL", lastPrice: 342.37 };
    const chain = { symbol: "AAPL", underlyingPrice: 342.37, pairs: [] };
    const platform = makePlatform(calls, "TEST");
    (platform as unknown as { dataProvider: unknown }).dataProvider = {
      getQuote: async () => ({ providerId: "public", capability: "quotes", result: quote }),
      getOptionsChain: async () => ({ providerId: "public", capability: "optionsChains", result: chain }),
      getOptionExpiryDates: async () => ({ providerId: "public", capability: "optionsChains", result: [] }),
    };
    const got = await platform.getQuote("AAPL");
    expect(got.symbol).toBe("AAPL");
    expect(got.lastPrice).toBe(342.37);
    const gotChain = await platform.getOptionChains!({ symbol: "AAPL" });
    expect(gotChain?.symbol).toBe("AAPL");
    // No MCP call for either: the data adapter owns those reads.
    expect(calls).toEqual([]);
  });
});

describe("Slice C — catalog, registry, presentation, identities carry public", () => {
  it("the catalog carries public: personal_token, equity+options, honest supports, copilot block", () => {
    expect((BROKER_IDS as readonly string[])).toContain("public");
    expect(isBrokerId("public")).toBe(true);
    const entry = BROKER_CATALOG.public as (typeof BROKER_CATALOG)["alpaca"];
    expect(entry.id).toBe("public");
    expect(entry.label).toBe("Public.com");
    expect(entry.credentialKind).toBe("personal_token");
    expect([...entry.assetClasses]).toEqual(["equity", "options"]);
    expect(entry.supports.quote).toBe(true);
    expect(entry.supports.accounts).toBe(true);
    expect(entry.supports.positions).toBe(true);
    expect(entry.supports.orderPreview).toBe(true);
    expect(entry.supports.orderPlace).toBe(true);
    expect(entry.supports.optionChains).toBe(true);
    expect(entry.supports.orderHistory).toBe(true);
    expect(entry.supports.orderCancel).toBe(true);
    // Q3: no get_history tool verified — account activity is a stated
    // gap, never an empty table. No watchlists or alerts tool either.
    expect(entry.supports.accountActivity).toBe(false);
    expect(entry.supports.watchlists).toBe(false);
    expect(entry.supports.alerts).toBe(false);
    // Public has no paper mode: TEST resolves to the paper bucket for
    // the platform's mode machinery, and placement in TEST is refused
    // with FAILURE_PUBLIC_NO_PAPER_MODE at the platform seam.
    expect(tradingTypeFor("public", "TEST")).toBe("paper");
    expect(tradingTypeFor("public", "PROD")).toBe("live");
    expect(entry.statusVocabulary.protocol).toBe("mcp_json_rpc");
    expect(entry.copilot.supported).toBe(true);
    expect(entry.copilot.bracketOrders).toBe("native");
    expect(entry.copilot.tools.quote).toBe("public_get_quote");
    expect(entry.copilot.tools.preview).toBe("public_preview_order");
    expect(entry.copilot.tools.place).toBe("public_place_order");
    expect(entry.copilot.tools.orders).toBe("public_orders");
    expect(entry.copilot.tools.cancel).toBe("public_cancel_order");
  });

  it("the credential guidance for personal_token names the paste, not a key pair", () => {
    const guidance = brokerCredentialGuidance("public");
    expect(guidance.kind).toBe("personal_token");
    expect(guidance.summary).toMatch(/personal access token/i);
    expect(guidance.summary).not.toMatch(/key pair/i);
  });

  it("the registry registers public and the catalog covers every registered platform", () => {
    const registered = TradingPlatformRegistry.getRegisteredPlatforms() as string[];
    expect(registered).toContain("public");
    expect(() => assertBrokerCatalogComplete(registered)).not.toThrow();
    for (const id of ROUTED_BROKER_IDS) expect(registered).toContain(id);
    expect((ROUTED_BROKER_IDS as readonly string[])).toContain("public");
  });

  it("presentation names Public in its own words — preview-only in TEST, never paper trading", () => {
    const presentation = brokerPresentation("public");
    expect(presentation.known).toBe(true);
    expect(presentation.label).toBe("Public.com");
    expect(presentation.modeShort.paper).not.toMatch(/paper/i);
    expect(presentation.modeWord.paper).toMatch(/preview/i);
    expect(presentation.sessionCopy.paper).toMatch(/no paper trading/i);
    expect(brokerIdentity("public")?.displayName).toBe("Public.com");
  });

  it("the outcome catalog names the no-paper-mode refusal (Q2: no existing code fit)", () => {
    const entry = getOutcome("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(entry).toBeTruthy();
    expect(entry?.businessMessage).toMatch(/no paper trading/i);
    expect(entry?.businessMessage).toMatch(/live mode/i);
    expect(entry?.retryable).toBe(false);
    // 155: 146 on main 39155419 (145 on main c179492d (141: 136 on the #3246 slice-1 head
    // (124 on the #3990 head (123 on the #4002 head (122 on the
    // #3907 head + 1 FAILURE_ASYNC_JOB_ORPHANED) + 1 (#3990
    // FAILURE_PUBLIC_NO_PAPER_MODE)) + 12 (#3246 slice 1:
    // SUCCESS/FAILURE_OFFER_* (10) + SUCCESS/FAILURE_PRODUCT_RANK_*
    // (2)) + 5 (#3246 slice 3: SUCCESS_RUNS_PACK_PURCHASED +
    // FAILURE_RUNS_PACK_UNAVAILABLE + FAILURE_RUNS_PACK_NO_APPROVED_PRICE
    // + FAILURE_RUNS_PACK_REPLAY + FAILURE_RUNS_PACK_NOT_PAID)
    // + 4 (#3307 slice 1: FAILURE_CODE_RUNS_UNAVAILABLE +
    // FAILURE_REFERRAL_CODE_INVALID + FAILURE_REFERRAL_CODE_CAP_EXCEEDED
    // + FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE)
    // + 69 (#2846: the commercial outcome codes) + 1 (#2373 S1b:
    // FAILURE_PROVIDER_MISMATCH) + 9 (#3571 top-up codes, of which
    // SUCCESS_TOP_UP_CHECKOUT_CREATED was already added by #2846, so
    // the net addition is +8; the #3571 entry supersedes #2846's).
    expect(Object.keys((outcomeCatalog as { outcomes: Record<string, unknown> }).outcomes)).toHaveLength(223);
  });

  it("the OAuth scopes request trading.write (the connect grant must cover placement)", () => {
    expect(DEFAULT_PUBLIC_OAUTH_SCOPES.split(" ")).toContain("trading.write");
    expect(DEFAULT_PUBLIC_OAUTH_SCOPES.split(" ")).toContain("trading.read");
  });

  it("the connect-status endpoint answers for public, and Settings has a personal-token surface", () => {
    expect(connectStatusEndpoint("public")).toBe("/api/broker/connect/public");
    const menu = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");
    expect(menu).toContain("personal_token");
    expect(menu).toContain("PublicTokenCard");
    const card = readFileSync("src/client/PublicTokenCard.tsx", "utf8");
    expect(card).toContain("/api/public/connect");
    const routes = readFileSync("src/agents/routes/brokerConnect.ts", "utf8");
    // #4035: the status the card reads carries the verification evidence.
    expect(routes).toContain("verifiedAt: status.verifiedAt");
    expect(routes).toContain("toolCount: status.toolCount");
    expect(card).toContain("verifiedAt");
    expect(routes).toContain("/broker/connect/public");
  });
});

describe("Slice C — the neutral Public connect read", () => {
  function fakeSessionStore() {
    const rows = new Map<string, string>();
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (request: Request): Promise<Response> => {
          const payload = (await request.json()) as { op: string; ns: string; key: string; value?: string };
          const key = `${payload.ns}${payload.key}`;
          if (payload.op === "get") return Response.json({ value: rows.get(key) ?? null });
          if (payload.op === "put") {
            rows.set(key, payload.value ?? "");
            return Response.json({ ok: true, rowsWritten: 1 });
          }
          if (payload.op === "delete") {
            rows.delete(key);
            return Response.json({ ok: true, rowsWritten: 1 });
          }
          return Response.json({ ok: false });
        },
      }),
    };
    return { namespace, rows };
  }

  function ctx(env: Env): Parameters<typeof handleConnectRoute>[4] {
    return { env, getOrm: () => undefined, readSettingRaw: () => null };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GET /api/broker/connect/public answers configured/signedIn from the stored token set", async () => {
    const { namespace } = fakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    await storePublicPersonalToken(env, "test-login", "test-token-1234");
    const request = new Request("https://app.test/api/broker/connect/public", {
      method: "GET",
      headers: { "x-user-login": "test-login" },
    });
    const res = await handleConnectRoute(
      request,
      new URL("https://app.test/api/broker/connect/public"),
      "/broker/connect/public",
      "session-test",
      ctx(env),
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.broker).toBe("public");
    expect(body.configured).toBe(true);
    expect(body.signedIn).toBe(true);
    expect(body.method).toBe("personal");
    expect(JSON.stringify(body)).not.toContain("test-token-1234");
  });

  it("GET /api/broker/connect/public answers configured:false with no stored token", async () => {
    const { namespace } = fakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const request = new Request("https://app.test/api/broker/connect/public", {
      method: "GET",
      headers: { "x-user-login": "test-login" },
    });
    const res = await handleConnectRoute(
      request,
      new URL("https://app.test/api/broker/connect/public"),
      "/broker/connect/public",
      "session-test",
      ctx(env),
    );
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.signedIn).toBe(false);
  });

  it("separates configured from signedIn for a deployment credential (#4048)", async () => {
    const { namespace } = fakeSessionStore();
    const env = {
      SESSION_STORE: namespace,
      PUBLIC_API_KEY: "public-deployment-token-123456",
    } as unknown as Env;
    const request = new Request("https://app.test/api/broker/connect/public", {
      method: "GET",
      headers: { "x-user-login": "test-login" },
    });
    const res = await handleConnectRoute(
      request,
      new URL("https://app.test/api/broker/connect/public"),
      "/broker/connect/public",
      "session-test",
      ctx(env),
    );
    const body = (await res!.json()) as Record<string, unknown>;
    // configured by the deployment key, but THIS login never signed in
    expect(body.configured).toBe(true);
    expect(body.signedIn).toBe(false);
    expect(body.source).toBe("deployment");
    expect(body.verified).toBe(false);
    // a shared key is never hinted back
    expect(body.tokenHint).toBeNull();
    expect(JSON.stringify(body)).not.toContain("public-deployment-token-123456");
  });
});
