/** @vitest-environment jsdom */
/**
 * Issue #3990 Slice D — Public.com through Stock Copilot (orders +
 * screening) + the broker-neutral panel.
 *
 * TDD Red: these FAIL on the Slice C tree —
 *  - no public_* MCP tools exist (the catalog names them, nothing
 *    implements them), so McpToolFactory.getTool returns undefined;
 *  - the screener has no public mode (UniverseMode / StockScreenProvider
 *    are etrade|yahoo|alpaca; no bindPublicQuoteDeps, no
 *    publicQuoteProviderFromRoute);
 *  - the Public platform has no screenMarkets, so the catalog's
 *    marketScreening stays false;
 *  - AlpacaCancelAllControl renders for every broker the panel serves,
 *    including public (there is no cancel-all on the Public MCP surface).
 *
 * Green when: the five public_* copilot tools are registered and route
 * through the neutral platform (preview persists a draft; place settles
 * it; TEST refuses with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP
 * call; PROD places via place_order); a public-mode screen acquires
 * quotes through the Public adapter with Public.com provenance; the
 * platform exposes screenMarkets and the catalog declares it; the
 * panel renders no Alpaca-only child for broker=public.
 *
 * No live network, no live orders: every MCP call goes through an
 * injected fake fetch; the PROD test asserts the call that WOULD be
 * made, never a real one. The token is mocked at the
 * getPublicAccessToken seam (both the data adapter and the trading
 * platform resolve their credential through it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../src/security/publicOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security/publicOAuth")>();
  return { ...actual, getPublicAccessToken: async () => "fake-public-token" };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { BROKER_CATALOG, brokerSupports } from "../src/trading/brokerCatalog";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import {
  acquireUniverse,
  bindPublicQuoteDeps,
  publicQuoteProviderFromRoute,
} from "../src/trading/screenerPipeline";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import { createPublicDataProviderFromEnv } from "../src/trading/dataProviders/adapters";
import { AlpacaBrokerPanel } from "../src/client/AlpacaBrokerPanel";
import { PublicTokenCard } from "../src/client/PublicTokenCard";
import type { Env } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------- fake MCP transport ------------------------- */

type RpcCall = { method: string; tool?: string; args?: Record<string, unknown> };

const TOOL_SCHEMAS: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
  get_quotes: { properties: { symbols: { type: "array" } }, required: ["symbols"] },
  get_option_chain: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  get_option_expirations: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  get_accounts: { properties: {}, required: [] },
  get_portfolio: { properties: {}, required: [] },
  get_orders: { properties: {}, required: [] },
  get_order: { properties: { order_id: { type: "string" } }, required: ["order_id"] },
  get_option_greek: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  get_option_greeks: { properties: { symbols: { type: "array" } }, required: ["symbols"] },
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
  preflight_multileg_order: {
    properties: { legs: { type: "array" }, quantity: { type: "number" }, limit_price: { type: "number" } },
    required: ["legs", "quantity"],
  },
  preflight_short_order: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  preflight_call_credit_spread: { properties: {}, required: [] },
  preflight_call_debit_spread: { properties: {}, required: [] },
  preflight_put_credit_spread: { properties: {}, required: [] },
  preflight_put_debit_spread: { properties: {}, required: [] },
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
  place_multileg_order: {
    properties: { legs: { type: "array" }, quantity: { type: "number" }, limit_price: { type: "number" } },
    required: ["legs", "quantity"],
  },
  place_short_order: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
  place_call_credit_spread: { properties: {}, required: [] },
  place_call_debit_spread: { properties: {}, required: [] },
  place_put_credit_spread: { properties: {}, required: [] },
  place_put_debit_spread: { properties: {}, required: [] },
  cancel_order: { properties: { order_id: { type: "string" } }, required: ["order_id"] },
  cancel_and_replace_order: { properties: { order_id: { type: "string" } }, required: ["order_id"] },
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
  get_order: { order_id: "ord-99", symbol: "AAPL", side: "BUY", quantity: 1, status: "NEW" },
  preflight_order: { valid: true, estimated_total: 342.37, estimated_fees: 0, buying_power_after: 4657.63 },
  preflight_multileg_order: { valid: true, estimated_total: 100, estimated_fees: 0, buying_power_after: 4900 },
  place_order: { order_id: "ord-99", status: "NEW" },
  place_multileg_order: { order_id: "ord-100", status: "NEW" },
  cancel_order: { order_id: "ord-1", status: "CANCELLED" },
  get_quotes: { quotes: [{ symbol: "AAPL", last: 342.37 }] },
  get_option_chain: { options: [] },
  get_option_expirations: { expirations: [] },
  get_option_greek: { symbol: "AAPL", delta: 0.5 },
  get_option_greeks: { greeks: [] },
};

function installFakeMcp(calls: RpcCall[]) {
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: { body?: string }): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === "tools/list") {
        calls.push({ method: "tools/list" });
        return Response.json({
          result: {
            tools: Object.entries(TOOL_SCHEMAS).map(([name, schema]) => ({
              name,
              inputSchema: { type: "object", ...schema },
            })),
          },
        });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name ?? "";
        calls.push({ method: "tools/call", tool: name, args: body.params?.arguments });
        const result = TOOL_RESULTS[name] ?? {};
        return Response.json({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      }
      return Response.json({}, { status: 404 });
    },
  );
}

const ENV = {} as unknown as Env;
const LOGIN = "trader_3990d";

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema(LOGIN);
  return orm;
}

function ctx(orm: DatabaseORM, readSettingRaw?: (key: string) => string | null): any {
  return {
    env: ENV,
    orm,
    sessionId: LOGIN,
    audit: vi.fn(),
    ...(readSettingRaw ? { readSettingRaw } : {}),
  };
}

async function previewDraft(orm: DatabaseORM): Promise<string> {
  const tool = McpToolFactory.getTool("public_preview_order")!;
  const result = await tool.execute(
    { symbol: "AAPL", quantity: 1, side: "buy", type: "limit", limitPrice: 342.37 },
    ctx(orm),
  );
  expect(result.success).toBe(true);
  expect(typeof result.orderId).toBe("string");
  return result.orderId as string;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public copilot tools are registered (#3990 Slice D)", () => {
  it("all five tools exist and match the catalog's public copilot block", () => {
    const tools = BROKER_CATALOG.public.copilot.tools;
    for (const name of [tools.quote, tools.preview, tools.place, tools.orders, tools.cancel]) {
      expect(name, `catalog names ${name}`).toBeTruthy();
      expect(McpToolFactory.getTool(name!), `tool ${name} is registered`).toBeTruthy();
    }
    expect(tools.quote).toBe("public_get_quote");
    expect(tools.preview).toBe("public_preview_order");
    expect(tools.place).toBe("public_place_order");
    expect(tools.orders).toBe("public_orders");
    expect(tools.cancel).toBe("public_cancel_order");
  });

  it("every public tool declares its scope (#1744, mirroring Alpaca)", () => {
    expect(MCP_TOOL_SCOPES["public_get_quote"]).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES["public_orders"]).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES["public_preview_order"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["public_place_order"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["public_cancel_order"]).toBe("mcp:trade");
  });
});

describe("public_get_quote (#3990 Slice D)", () => {
  it("returns a live Public quote with provider + provenance", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const result = await McpToolFactory.getTool("public_get_quote")!.execute({ symbol: "AAPL" }, ctx(orm));
    expect(result.provider).toBe("public");
    expect(result.provenance).toBe("live");
    expect(result.price).toBe(342.37);
    expect(result.symbol).toBe("AAPL");
    expect(calls.some((c) => c.tool === "get_quotes")).toBe(true);
  });
});

describe("public_preview_order (#3990 Slice D)", () => {
  it("persists a preview draft and audits public.order_previewed", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const context = ctx(orm);
    const tool = McpToolFactory.getTool("public_preview_order")!;
    const result = await tool.execute(
      { symbol: "AAPL", quantity: 1, side: "buy", type: "limit", limitPrice: 342.37 },
      context,
    );
    expect(result.success).toBe(true);
    expect(typeof result.orderId).toBe("string");
    const draft = orm.trades.findById(result.orderId);
    expect(draft).toBeTruthy();
    expect(draft!.status).toBe("previewed");
    expect(context.audit).toHaveBeenCalledWith(
      "public.order_previewed",
      "trading",
      expect.objectContaining({ symbol: "AAPL" }),
    );
    expect(calls.some((c) => c.tool === "preflight_order")).toBe(true);
    expect(calls.some((c) => c.tool === "place_order")).toBe(false);
  });
});

describe("public_place_order (#3990 Slice D)", () => {
  it("in TEST (default) refuses with FAILURE_PUBLIC_NO_PAPER_MODE before any MCP placement call", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const orderId = await previewDraft(orm);
    const callsBeforePlace = calls.length;
    const result = await McpToolFactory.getTool("public_place_order")!.execute(
      { orderId },
      ctx(orm),
    );
    expect(result.success).toBe(false);
    expect(String(result.message ?? "")).toContain("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(calls.slice(callsBeforePlace).some((c) => c.tool === "place_order")).toBe(false);
    expect(orm.trades.findById(orderId)!.status).toBe("previewed");
  });

  it("without an orderId refuses and names the preview step", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const result = await McpToolFactory.getTool("public_place_order")!.execute(
      { symbol: "AAPL", quantity: 1, side: "buy", type: "market" },
      ctx(orm),
    );
    expect(result.success).toBe(false);
    expect(String(result.message ?? "")).toMatch(/preview/i);
    expect(calls.some((c) => c.tool === "place_order")).toBe(false);
  });

  it("in PROD (stored broker environment) places via place_order and reports acceptance, not a fill", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const orderId = await previewDraft(orm);
    const result = await McpToolFactory.getTool("public_place_order")!.execute(
      { orderId },
      ctx(orm, (key) => (key === "etrade:environment" ? "PROD" : null)),
    );
    expect(result.success).toBe(true);
    expect(result.brokerOrderRef).toBe("ord-99");
    expect(String(result.message ?? "")).toMatch(/acceptance/i);
    expect(String(result.message ?? "")).not.toMatch(/filled/i);
    expect(calls.some((c) => c.tool === "place_order")).toBe(true);
    expect(orm.trades.findById(orderId)!.status).toBe("submitted");
  });
});

describe("public_orders + public_cancel_order (#3990 Slice D)", () => {
  it("public_orders returns the broker's orders with the neutral status", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const result = await McpToolFactory.getTool("public_orders")!.execute({ status: "all" }, ctx(orm));
    expect(result.success).toBe(true);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].status).toBe("EXECUTED");
    expect(result.orders[0].rawStatus).toBe("FILLED");
    expect(calls.some((c) => c.tool === "get_orders")).toBe(true);
  });

  it("public_cancel_order cancels one order by id", async () => {
    const calls: RpcCall[] = [];
    installFakeMcp(calls);
    const orm = makeOrm();
    const result = await McpToolFactory.getTool("public_cancel_order")!.execute({ order_id: "ord-1" }, ctx(orm));
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.tool === "cancel_order")).toBe(true);
  });
});

describe("public-mode screening (#3990 Slice D)", () => {
  it("bindPublicQuoteDeps delegates fetchQuote to the bound provider", async () => {
    const provider: any = {
      getQuote: vi.fn(async () => ({ result: { symbol: "AAPL", lastPrice: 342.37 } })),
      getQuotesBatch: vi.fn(async () => ({ result: [{ symbol: "AAPL", lastPrice: 342.37 }] })),
    };
    const deps = bindPublicQuoteDeps(provider, { runId: "run-1", userLogin: LOGIN });
    const quote = await deps.fetchQuote!("AAPL");
    expect(quote.symbol).toBe("AAPL");
    expect(provider.getQuote).toHaveBeenCalledWith("AAPL", expect.objectContaining({ runId: "run-1" }));
    const batch = await deps.fetchQuotes!(["AAPL"]);
    expect(batch).toHaveLength(1);
  });

  it("publicQuoteProviderFromRoute refuses an unenabled public provider and resolves an enabled one", async () => {
    const registry = new DataProviderRegistry();
    const adapter = createPublicDataProviderFromEnv(ENV, LOGIN);
    registry.register(adapter);
    const configs = [{ id: "public", lifecycleState: "registered", enabled: false } as any];
    const routes = [{ capability: "quotes", primaryProviderId: "public", gapFillProviderId: null } as any];
    expect(() => publicQuoteProviderFromRoute(registry, configs, routes)).toThrow(/not enabled/);
    const enabled = [{ id: "public", lifecycleState: "enabled", enabled: true } as any];
    expect(publicQuoteProviderFromRoute(registry, enabled, routes)).toBe(adapter);
  });

  it("acquireUniverse mode public quotes through the bound deps with Public.com provenance", async () => {
    const listings = [{ symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ" } as any];
    const deps = bindPublicQuoteDeps(
      {
        getQuote: async () => ({ result: { symbol: "AAPL", lastPrice: 342.37, companyName: "Apple Inc." } }),
      } as any,
      { runId: "run-1", userLogin: LOGIN },
    );
    const acquired = await acquireUniverse({
      mode: "public",
      symbols: listings,
      maxSymbols: 1,
      quoteDeps: deps,
    });
    expect(acquired.quotes).toHaveLength(1);
    expect(acquired.provider).toBe("public");
    expect(acquired.quotes[0].source).toBe("Public.com live");
  });
});

describe("public screenMarkets (#3990 Slice D)", () => {
  it("the platform exposes screenMarkets and the catalog declares marketScreening", () => {
    expect(brokerSupports("public", "marketScreening")).toBe(true);
    const platform = new PublicTradingPlatform(ENV, undefined, LOGIN);
    expect(typeof (platform as any).screenMarkets).toBe("function");
  });
});

describe("broker panel is broker-neutral for public (#3990 Slice D)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("broker=public renders no Alpaca sign-in card and no cancel-all control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ code: "not_found" }) }) as unknown as Response),
    );
    await act(async () => {
      root.render(<AlpacaBrokerPanel broker="public" activeEnv="TEST" />);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.textContent).not.toContain("Alpaca");
    expect(container.textContent).not.toContain("Cancel all open orders");
  });
});

describe("PublicTokenCard — the deployment credential (#4048)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says configured-not-verified, offers no Disconnect, and raises no verification warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          broker: "public",
          configured: true,
          signedIn: false,
          source: "deployment",
          method: "deployment",
          tokenHint: null,
          verified: false,
          verifiedAt: null,
          toolCount: 0,
          tools: [],
        }),
      ),
    );
    await act(async () => {
      root.render(<PublicTokenCard />);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.textContent).toContain("configured, not verified");
    // a verification failure message for a credential nothing verified
    expect(container.textContent).not.toContain("observed no tools");
    // nothing the button could disconnect: the key lives in the deployment
    expect(container.textContent).not.toContain("Disconnect");
    expect(container.textContent).toContain("Use my token");
  });
});
