/**
 * Issue #4660 — Gap 8 of #4634: "E*TRADE has no MCP orders or cancel tools".
 *
 * Chat could list and cancel Alpaca and Public orders but not E*TRADE's: the
 * catalog declared `orders: null, cancel: null` for it and the command module had
 * no such tools. Pinned here:
 *  - both tools exist on the factory, with the scope the accounting pin expects
 *    (`mcp:read` for the read, `mcp:trade` for the cancel);
 *  - `etrade_orders` returns the neutral order rows the platform produces, with
 *    an audit record and the resolved environment;
 *  - `etrade_cancel_order` returns the broker's own receipt and refuses a call
 *    with no order id;
 *  - the catalog and the registry now name them, so the copilot can use them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";
import { resolvePromptBrokerTools } from "../src/agents/chatPrompt";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const HUMAN_DID = "did:user:github:boss";

const SANDBOX_ENV = {
  ETRADE_CONSUMER_KEY: "ckey_4660",
  ETRADE_CONSUMER_SECRET: "csecret_4660",
  ETRADE_OAUTH_TOKEN: "tok_4660",
  ETRADE_OAUTH_TOKEN_SECRET: "toksec_4660",
  ETRADE_ACCOUNT_ID_KEY: "acct_4660",
  ETRADE_ENVIRONMENT: "sandbox",
} as unknown as Env;

const ORDERS_PAYLOAD = {
  OrdersResponse: {
    Order: [
      {
        orderId: 700001,
        orderType: "EQ",
        OrderDetail: [
          {
            orderNumber: 700001,
            status: "OPEN",
            orderType: "EQ",
            priceType: "LIMIT",
            limitPrice: 100,
            orderTerm: "GOOD_FOR_DAY",
            Instrument: [{ Product: { symbol: "NVDA" }, orderAction: "BUY", orderedQuantity: 5 }],
          },
        ],
      },
    ],
  },
};

type Call = { url: string; method: string };

function installFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      calls.push({ url, method });
      if (url.includes("/orders/cancel")) {
        return new Response(
          JSON.stringify({ CancelOrderResponse: { orderId: 700001 } }),
          { status: 200 },
        );
      }
      if (url.includes("/orders")) {
        return new Response(JSON.stringify(ORDERS_PAYLOAD), { status: 200 });
      }
      if (url.includes("/accounts/list")) {
        return new Response(
          JSON.stringify({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "acct_4660" }] } } }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
  return calls;
}

function context() {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("sess_4660");
  return {
    env: SANDBOX_ENV,
    orm,
    sessionId: HUMAN_DID,
    audit: vi.fn(),
    // The stored mode is the authority (no per-call override on these tools).
    readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
  } as any;
}

describe("#4660 — E*TRADE order tools exist, with the right scope and wiring", () => {
  it("registers both tools and declares exactly one scope each", () => {
    const names = McpToolFactory.getAllTools().map((tool) => tool.name);
    expect(names).toContain("etrade_orders");
    expect(names).toContain("etrade_cancel_order");
    expect(MCP_TOOL_SCOPES.etrade_orders).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES.etrade_cancel_order).toBe("mcp:trade");
  });

  it("names them in the broker catalog's copilot block, like Alpaca and Public", () => {
    expect(BROKER_CATALOG.etrade.copilot.tools.orders).toBe("etrade_orders");
    expect(BROKER_CATALOG.etrade.copilot.tools.cancel).toBe("etrade_cancel_order");
    // The other two brokers keep their own tools — no cross-broker aliasing.
    expect(BROKER_CATALOG.alpaca.copilot.tools.orders).toBe("alpaca_orders");
    expect(BROKER_CATALOG.public.copilot.tools.orders).toBe("public_orders");
  });
});

describe("#4660 — etrade_orders reads the tenant's orders", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the neutral order rows with a count, environment and audit record", async () => {
    const calls = installFetch();
    const ctx = context();
    const result = await McpToolFactory.getTool("etrade_orders")!.execute({ status: "open" }, ctx);

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.environment).toBe("TEST");
    // The client maps the broker payload onto the neutral row; orderId stays
    // the broker's own numeric id (stringified only by callers that need text).
    expect(String(result.orders[0].orderId)).toBe("700001");
    expect(result.orders[0]).toMatchObject({ symbol: "NVDA", status: "OPEN" });
    expect(calls.some((call) => call.url.includes("/orders") && call.method === "GET")).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith(
      "etrade.orders_queried",
      "trading",
      expect.objectContaining({ status: "open", count: 1, environment: "TEST" }),
    );
  });
});

describe("#4660 — etrade_cancel_order returns the broker's receipt", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("cancels one order through the E*TRADE cancel endpoint and audits it", async () => {
    const calls = installFetch();
    const ctx = context();
    const receipt = await McpToolFactory.getTool("etrade_cancel_order")!.execute({ order_id: "700001" }, ctx);

    expect(receipt.success).toBe(true);
    expect(receipt.orderId).toBe("700001");
    expect(String(receipt.message)).toMatch(/cancell?ed/i);
    expect(calls.some((call) => call.url.includes("/orders/cancel"))).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith(
      "etrade.order_cancelled",
      "trading",
      expect.objectContaining({ success: true, environment: "TEST" }),
    );
  });

  it("refuses a call with no order id instead of cancelling something guessable", async () => {
    const calls = installFetch();
    await expect(
      McpToolFactory.getTool("etrade_cancel_order")!.execute({}, context()),
    ).rejects.toThrow(/order_id is required/);
    expect(calls).toHaveLength(0);
  });
});

describe("#4660/#6509 — chat is steered at the neutral order tools", () => {
  it("routes an E*TRADE session's list/cancel through the neutral tools", () => {
    const resolved = resolvePromptBrokerTools({ activeBroker: "etrade", activeMode: "live" });
    expect(resolved.ordersTool).toBe("tool_openaimp_broker_orders_list");
    expect(resolved.cancelBracketTool).toBe("tool_openaimp_broker_order_cancel");
  });

  it("routes an Alpaca session's list/cancel through the neutral tools", () => {
    const resolved = resolvePromptBrokerTools({ activeBroker: "alpaca" });
    expect(resolved.ordersTool).toBe("tool_openaimp_broker_orders_list");
    expect(resolved.cancelBracketTool).toBe("tool_openaimp_broker_order_cancel");
  });
});
