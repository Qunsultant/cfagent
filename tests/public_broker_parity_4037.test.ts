/**
 * Issue #4037 — Public.com broker-surface parity: what is implemented, what is
 * deliberately absent, and the live-only guardrails.
 *
 * Public is a live-only broker (no paper mode). The surface must therefore be
 * honest in three ways: every required platform method is real, the optional
 * gaps are absent rather than fake, and placement in TEST refuses before any
 * broker call — returning an acceptance receipt, never a claimed fill.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { publicPlacedExecution } from "../src/services/publicTrading";
import type { Env } from "../src/types";

function platform(fetchImpl: typeof fetch, overrideEnv?: string) {
  return new PublicTradingPlatform(
    {} as Env,
    undefined,
    "owner@example.com",
    overrideEnv,
    {
      accessTokenProvider: async () => "pat-token",
      fetchImpl,
      sleep: async () => undefined,
    },
  );
}

describe("Issue #4037 — Public broker surface parity", () => {
  it("implements every required platform method", () => {
    const proto = PublicTradingPlatform.prototype as unknown as Record<string, unknown>;
    for (const method of [
      "getStatus",
      "getQuote",
      "getAccounts",
      "getPositions",
      "previewOrder",
      "executeOrder",
      "placeOrderRemote",
      "cancelOrderRemote",
      "getOrderHistory",
      "getOptionChains",
      "getOptionExpireDates",
    ]) {
      expect(typeof proto[method], method).toBe("function");
    }
  });

  it("declares its absences instead of faking them", () => {
    const proto = PublicTradingPlatform.prototype as unknown as Record<string, unknown>;
    // Public's MCP surface exposes no lot-level position read, no session-order
    // terms, and no watchlist tools. Absent means the neutral routes answer
    // provider_unsupported; a stub returning empty data would be a lie.
    expect(proto.getPositionLots).toBeUndefined();
    expect(proto.supportsSessionOrders).toBeUndefined();
    expect(proto.getWatchlists).toBeUndefined();
  });

  it("refuses placement in TEST before any broker call (no paper mode)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await platform(fetchImpl, "TEST").placeOrderRemote({
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "MARKET",
      orderId: "draft-1",
      authorisation: "did:agent:openaimp:trading",
    } as never);

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("FAILURE_PUBLIC_NO_PAPER_MODE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an acceptance receipt as submitted, and only a FILLED payload as executed", () => {
    const base = {
      orderId: "draft-1",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      authorizerDid: "did:agent:openaimp:trading",
    };
    const accepted = publicPlacedExecution({
      ...base,
      payload: { order_id: "pub-123", status: "NEW" },
    });
    expect(accepted.status).toBe("submitted");
    expect(accepted.brokerOrderRef).toBe("pub-123");

    const filled = publicPlacedExecution({
      ...base,
      payload: { order_id: "pub-124", status: "FILLED" },
    });
    expect(filled.status).toBe("executed");
  });
});
