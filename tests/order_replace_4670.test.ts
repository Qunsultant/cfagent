/**
 * Issue #4670 — Gap 16 of #4634: "Replace/modify exists as a validator only".
 *
 * `validateReplaceOrder` had no caller and there was no PATCH anywhere, so the
 * only way to change an order was cancel-and-replace — which loses queue
 * position and, for a bracket, detaches the held legs.
 *
 * Pinned here, at every layer:
 *  - the provider sends a real `PATCH /v2/orders/{id}` carrying ONLY the fields
 *    the caller changed, and reports the broker's own refusal otherwise;
 *  - the platform READS the order first, so a compound parent and an order that
 *    is no longer open are refused by name before any PATCH;
 *  - the neutral route serves the selected broker and refuses a broker without
 *    the capability by name (never cancel-and-replace behind the caller);
 *  - the agent tool exists with the trade scope, on the same platform method.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" | "public" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { TradingPlatformRegistry } from "../src/trading";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { handleBrokerOrderRoutes, type BrokerOrderRouteContext } from "../src/agents/routes/brokerOrders";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const PAPER_ENV = {
  ALPACA_API_KEY_ID: ["PK", "TEST"].join(""),
  ALPACA_API_SECRET_KEY: ["SK", "TEST"].join(""),
} as unknown as Env;

type Call = { url: string; method: string; body: any };

/** Stub the order read and the PATCH; the current order is the caller's fixture. */
function installFetch(currentOrder: Record<string, unknown>, patchResponse?: { status: number; body: any }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.includes("/v2/orders/")) {
        return Response.json(currentOrder);
      }
      if (method === "PATCH" && url.includes("/v2/orders/")) {
        const response = patchResponse ?? { status: 200, body: { ...currentOrder, ...(init?.body ? JSON.parse(String(init.body)) : {}) } };
        return new Response(JSON.stringify(response.body), { status: response.status });
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
  return calls;
}

function platform(): AlpacaTradingPlatform {
  return new AlpacaTradingPlatform(PAPER_ENV, undefined, "boss");
}

const openSimple = { id: "ord-1", order_class: "simple", status: "new", symbol: "AAPL", qty: "10" };

describe("#4670 — the provider sends a real PATCH, with only the changed fields", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes the order path and returns the broker's own status", async () => {
    const calls = installFetch(openSimple);
    const res = await platform().replaceOrderRemote({ orderId: "ord-1", quantity: 5, limitPrice: 101.5 });
    expect(res.success).toBe(true);
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toContain("/v2/orders/ord-1");
    expect(patch?.body).toEqual({ qty: "5", limit_price: "101.5" });
    // Nothing the caller did not state is on the wire.
    expect(patch?.body.time_in_force).toBeUndefined();
    expect(patch?.body.stop_price).toBeUndefined();
  });

  it("reports the broker's refusal instead of claiming a change", async () => {
    installFetch(openSimple, { status: 422, body: { message: "order is not replaceable" } });
    const res = await platform().replaceOrderRemote({ orderId: "ord-1", quantity: 5 });
    expect(res.success).toBe(false);
    expect(res.httpStatus).toBe(422);
    expect(String(res.message)).toMatch(/order is not replaceable/);
  });

  it("refuses a request with nothing to change, before any call", async () => {
    const calls = installFetch(openSimple);
    const res = await platform().replaceOrderRemote({ orderId: "ord-1" });
    expect(res.success).toBe(false);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });
});

describe("#4670 — the platform reads the order first, so the refusal is factual", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a bracket parent rather than detaching its held legs", async () => {
    const calls = installFetch({ ...openSimple, order_class: "bracket" });
    const res = await platform().replaceOrderRemote({ orderId: "ord-1", quantity: 5 });
    expect(res.success).toBe(false);
    expect(res.code).toBe("replace_parent_unsupported");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("refuses an order that is no longer open, naming its status", async () => {
    const calls = installFetch({ ...openSimple, status: "filled" });
    const res = await platform().replaceOrderRemote({ orderId: "ord-1", quantity: 5 });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/filled/);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("replaces an open simple order", async () => {
    const calls = installFetch(openSimple);
    const res = await platform().replaceOrderRemote({ orderId: "ord-1", stopPrice: 95 });
    expect(res.success).toBe(true);
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ stop_price: "95" });
  });
});

describe("#4670 — the neutral route serves the selected broker", () => {
  const req = (body: unknown, login = "alice") =>
    new Request("https://agent.internal/broker/order/replace", {
      method: "POST",
      headers: { "x-user-login": login, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  function ctx(): BrokerOrderRouteContext {
    return {
      env: {} as any,
      getOrm: () => ({ trades: { findMany: () => [] }, getSql: () => new MockSqlStorage() }) as any,
      readSettingRaw: () => null,
      audit: vi.fn(),
      getScreenerAgent: () => ({}) as any,
      persistScreenerReportCanonical: vi.fn(),
      evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as any,
      getAutopilotState: () => ({ running: false }),
      incrementAutopilotOrdersToday: vi.fn(),
      schedule: async () => ({ id: "sched-1" }) as any,
      cancelSchedule: async () => true,
    } as BrokerOrderRouteContext;
  }

  const path = "/broker/order/replace";

  it("calls the selected broker's replace and returns its receipt", async () => {
    const seen: any[] = [];
    TradingPlatformRegistry.register("alpaca", () =>
      ({
        platformId: "alpaca",
        name: "Alpaca",
        async replaceOrderRemote(params: any) {
          seen.push(params);
          return { success: true, orderId: params.orderId, message: "replaced", status: "new" };
        },
      }) as any,
    );
    const res = await handleBrokerOrderRoutes(req({ orderId: "ord-9", quantity: 3, timeInForce: "GTC" }), new URL(`https://agent.internal${path}`), path, "alice", ctx());
    expect(res!.status).toBe(200);
    expect(seen[0]).toMatchObject({ orderId: "ord-9", quantity: 3, timeInForce: "gtc" });
  });

  it("refuses a broker without replace by name — it never cancels and re-places", async () => {
    tenant.broker = "etrade";
    TradingPlatformRegistry.register("etrade", () => ({ platformId: "etrade", name: "E*TRADE" }) as any);
    const res = await handleBrokerOrderRoutes(req({ orderId: "ord-9", quantity: 3 }), new URL(`https://agent.internal${path}`), path, "alice", ctx());
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("provider_unsupported");
    expect(String(body.message)).toMatch(/cannot replace an open order/);
    tenant.broker = "alpaca";
  });

  it("refuses a request that changes nothing", async () => {
    const res = await handleBrokerOrderRoutes(req({ orderId: "ord-9" }), new URL(`https://agent.internal${path}`), path, "alice", ctx());
    expect(res!.status).toBe(400);
  });
});

describe("#4670 — the agent tool rides the same platform method", () => {
  it("is registered with the trade scope", () => {
    const names = McpToolFactory.getAllTools().map((tool) => tool.name);
    expect(names).toContain("alpaca_replace_order");
    expect(MCP_TOOL_SCOPES.alpaca_replace_order).toBe("mcp:trade");
  });
});
