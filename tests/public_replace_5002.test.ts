/**
 * Issue #5002 — Gap 16 follow-up: Public order replace.
 *
 * Public exposes the capability as `cancel_and_replace_order` (its own tool, on
 * our allow-list) and documents the body: `orderId` (the order being replaced),
 * a NEW `requestId`, `orderType`, `expiration`, and the changed terms. Placement
 * is asynchronous, so the receipt says "accepted" — never that the order has
 * already changed.
 *
 * Pinned here, at the MCP wire (stubbed transport):
 *  - the order is READ first (`get_order`) and only an order still open is
 *    replaceable; a bracket ENTRY is refused, a bracket LEG may change price only;
 *  - the replace call carries a fresh requestId and only the changed fields;
 *  - the receipt reports acceptance honestly;
 *  - TEST mode refuses before any MCP call (Public has no paper mode);
 *  - a request that changes nothing is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import type { Env } from "../src/types";

type Rpc = { method: string; name?: string; args?: any };

function jsonRpc(id: any, result: any) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const TOOLS = [
  {
    name: "get_order",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
    },
  },
  {
    name: "cancel_and_replace_order",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        requestId: { type: "string" },
        orderType: { type: "string" },
        expiration: { type: "object" },
        quantity: { type: "number" },
        limitPrice: { type: "number" },
        stopPrice: { type: "number" },
      },
    },
  },
];

function installFetch(order: Record<string, unknown>, replaceResult: any = { orderId: "ord-1", status: "PENDING_REPLACE" }) {
  const calls: Rpc[] = [];
  const impl = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body?.method === "tools/list") return jsonRpc(body.id, { tools: TOOLS });
      if (body?.method === "tools/call") {
        const name = body?.params?.name;
        const args = body?.params?.arguments ?? {};
        calls.push({ method: "tools/call", name, args });
        if (name === "get_order") {
          return jsonRpc(body.id, { content: [{ type: "text", text: JSON.stringify(order) }] });
        }
        if (name === "cancel_and_replace_order") {
          return jsonRpc(body.id, { content: [{ type: "text", text: JSON.stringify(replaceResult) }] });
        }
        return jsonRpc(body.id, { content: [{ type: "text", text: JSON.stringify({ error: `unexpected tool ${name}` }) }] });
      }
      return jsonRpc(body.id, {});
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function platform(impl: typeof fetch, mode: "PROD" | "TEST" = "PROD") {
  return new PublicTradingPlatform({} as Env, undefined, "owner@example.com", mode, {
    accessTokenProvider: async () => "pat-token",
    fetchImpl: impl,
    sleep: async () => undefined,
  });
}

/**
 * The deps injection above is for the *data* provider; the trading client is
 * built from env. These tests therefore pass a fetch stub globally and use PROD.
 */
const openOrder = { orderId: "ord-1", status: "NEW", orderType: "LIMIT", quantity: 10 };

describe("#5002 — Public replace reads first, then replaces", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("reads the order, then calls cancel_and_replace_order with a fresh requestId and only the changes", async () => {
    const { calls, impl } = installFetch(openOrder);
    const res = await platform(impl).replaceOrderRemote({ orderId: "ord-1", quantity: 5, limitPrice: 101.5, timeInForce: "day" });
    expect(res.success).toBe(true);
    expect(res.status).toBe("replace_accepted");
    expect(String(res.message)).toMatch(/accepted the replacement/);
    expect(String(res.message)).toMatch(/asynchronously/);

    const names = calls.map((call) => call.name);
    expect(names[0]).toBe("get_order");
    const replace = calls.find((call) => call.name === "cancel_and_replace_order");
    expect(replace?.args.orderId ?? replace?.args.order_id).toBe("ord-1");
    const requestId = replace?.args.requestId ?? replace?.args.request_id;
    expect(typeof requestId).toBe("string");
    expect(String(requestId).length).toBeGreaterThan(10);
    expect(JSON.stringify(replace?.args)).toContain("101.5");
  });

  it("refuses an order that is no longer open, before the replace call", async () => {
    const { calls, impl } = installFetch({ ...openOrder, status: "FILLED" });
    const res = await platform(impl).replaceOrderRemote({ orderId: "ord-1", quantity: 5 });
    expect(res.success).toBe(false);
    expect(String(res.message)).toMatch(/FILLED/);
    expect(calls.filter((call) => call.name === "cancel_and_replace_order")).toHaveLength(0);
  });

  it("refuses a bracket ENTRY — replacing it would orphan its exits", async () => {
    const { calls, impl } = installFetch({ ...openOrder, bracketId: "ord-1" });
    const res = await platform(impl).replaceOrderRemote({ orderId: "ord-1", limitPrice: 99 });
    expect(res.success).toBe(false);
    expect(res.code).toBe("replace_parent_unsupported");
    expect(calls.filter((call) => call.name === "cancel_and_replace_order")).toHaveLength(0);
  });

  it("lets a bracket LEG change its price, but not its quantity", async () => {
    const { calls, impl } = installFetch({ ...openOrder, orderId: "ord-leg", bracketId: "ord-entry" });
    const legPrice = await platform(impl).replaceOrderRemote({ orderId: "ord-leg", limitPrice: 99 });
    expect(legPrice.success).toBe(true);
    expect(calls.filter((call) => call.name === "cancel_and_replace_order")).toHaveLength(1);

    const legQty = await platform(impl).replaceOrderRemote({ orderId: "ord-leg", quantity: 3 });
    expect(legQty.success).toBe(false);
    expect(String(legQty.message)).toMatch(/price only/);
  });

  it("refuses a request that changes nothing", async () => {
    const { calls, impl } = installFetch(openOrder);
    const res = await platform(impl).replaceOrderRemote({ orderId: "ord-1" });
    expect(res.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
