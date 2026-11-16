/**
 * Issue #4650 — Gap 2 of #4634: Public.com cancel is not paper-gated.
 *
 * Two defects pinned here, both at the platform seam:
 *  1. `cancelOrderRemote()` had no `noPaperModeRefusal()` call, so a
 *     TEST-mode cancel reached Public's live `cancel_order` MCP tool —
 *     the one live-money hole the brokerage matrix found (§4 gap 2).
 *  2. It returned `success: true` unconditionally, so a refused or
 *     unconfirmed cancel read as cancelled. Alpaca and E*TRADE surface
 *     the broker's answer; this seam now does too — and a payload that
 *     carries no signal at all is reported as unconfirmed, never as
 *     success.
 *
 * The receipt mapper is pure (payload → receipt), so every signal class
 * is pinned directly, and the platform is exercised end to end through a
 * stubbed MCP transport for the accepted case.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { publicCancelReceipt } from "../src/services/publicTrading";
import type { Env } from "../src/types";

const USER = "owner@example.com";

function platform(env: "TEST" | "PROD", fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return new PublicTradingPlatform({} as Env, undefined, USER, env, {
    accessTokenProvider: async () => "pat-token",
    fetchImpl,
    sleep: async () => undefined,
  });
}

/** A JSON-RPC response body as the MCP transport reads it. */
function rpc(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stubbed Public MCP transport: `tools/list` advertises cancel_order
 * with its live-schema shape, `tools/call` returns the given payload.
 */
function cancelTransport(payload: unknown): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown };
    calls.push(request);
    if (request.method === "tools/list") {
      return rpc({
        tools: [
          {
            name: "cancel_order",
            inputSchema: {
              type: "object",
              properties: { order_id: { type: "string" } },
              required: ["order_id"],
            },
          },
        ],
      });
    }
    return rpc({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("#4650 — Public cancel is paper-gated and its receipt is truthful", () => {
  it("refuses a TEST-mode cancel before any MCP call, naming the no-paper-mode outcome", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const receipt = await platform("TEST", fetchImpl).cancelOrderRemote("pub-123");

    expect(receipt.success).toBe(false);
    expect(receipt.orderId).toBe("pub-123");
    expect(receipt.message).toContain("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels in PROD and reports the broker's own status word", async () => {
    const { fetchImpl, calls } = cancelTransport({ order_id: "pub-777", status: "CANCELLED" });
    const receipt = await platform("PROD", fetchImpl).cancelOrderRemote("pub-777");

    expect(receipt.success).toBe(true);
    expect(receipt.orderId).toBe("pub-777");
    expect(receipt.message).toMatch(/cancell?ed/i);
    // The live schema's property name carries the request.
    const call = calls.find((c) => (c as { method?: string }).method === "tools/call") as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(call.params?.name).toBe("cancel_order");
    expect(call.params?.arguments?.order_id).toBe("pub-777");
  });

  it("reports an explicit broker success as a cancellation", () => {
    const receipt = publicCancelReceipt({
      requestedOrderId: "pub-1",
      payload: { success: true, order_id: "pub-1", status: "PENDING_CANCEL" },
    });
    expect(receipt.success).toBe(true);
    expect(receipt.orderId).toBe("pub-1");
  });

  it("never reports a refusal as cancelled", () => {
    for (const payload of [
      { order_id: "pub-2", status: "REJECTED" },
      { order_id: "pub-2", success: false },
      { order_id: "pub-2", error: { code: "ORDER_NOT_CANCELLABLE" } },
      { order_id: "pub-2", errors: [{ code: "NOT_FOUND" }] },
    ]) {
      const receipt = publicCancelReceipt({ requestedOrderId: "pub-2", payload });
      expect(receipt.success, JSON.stringify(payload)).toBe(false);
      expect(receipt.message).toMatch(/did not cancel|not confirmed/i);
    }
  });

  it("treats an order that is still open, filled, or replaced as not cancelled", () => {
    for (const status of ["NEW", "PARTIALLY_FILLED", "FILLED", "REPLACED"]) {
      const receipt = publicCancelReceipt({
        requestedOrderId: "pub-3",
        payload: { order_id: "pub-3", status },
      });
      expect(receipt.success, status).toBe(false);
    }
  });

  it("does not fabricate success when the payload carries no signal", () => {
    for (const payload of [{}, null, [], { order_id: "pub-4" }]) {
      const receipt = publicCancelReceipt({ requestedOrderId: "pub-4", payload });
      expect(receipt.success, JSON.stringify(payload)).toBe(false);
      expect(receipt.message).toMatch(/no cancellation confirmation/i);
    }
  });

  it("keeps the deployment-credential refusal ahead of the no-paper refusal", async () => {
    // A deployment credential must refuse even in PROD, and before any call.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deployPlatform = new PublicTradingPlatform(
      { PUBLIC_API_KEY: "deployment-key" } as unknown as Env,
      undefined,
      USER,
      "PROD",
      { accessTokenProvider: async () => "deployment-key", fetchImpl, sleep: async () => undefined },
    );
    await expect(deployPlatform.cancelOrderRemote("pub-5")).rejects.toThrow(
      /PUBLIC_DEPLOYMENT_CREDENTIAL_READ_ONLY/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
