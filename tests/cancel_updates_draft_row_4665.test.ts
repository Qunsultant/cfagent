import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBrokerOrderRoutes } from "../src/agents/routes/brokerOrders";
import { TradingPlatformRegistry } from "../src/trading";
import * as tenantProviders from "../src/services/tenantProviders";

describe("Gap 11 — Cancel updates the mas_trades draft row (#4665)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates orm.trades status to 'cancelled' on neutral /broker/order/cancel when broker confirms cancellation", async () => {
    vi.spyOn(tenantProviders, "resolveTenantBroker").mockResolvedValue("public");
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockReturnValue({
      cancelOrderRemote: vi.fn().mockResolvedValue({ success: true, orderId: "ord-123" }),
    } as never);

    const updateSpy = vi.fn();
    const ctx = {
      env: {},
      getOrm: () => ({ trades: { update: updateSpy } }),
      audit: vi.fn(),
    };

    const req = new Request("https://example.com/api/broker/order/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": "alice" },
      body: JSON.stringify({ orderId: "ord-123" }),
    });
    const res = await handleBrokerOrderRoutes(
      req,
      new URL(req.url),
      "/api/broker/order/cancel",
      "sess-1",
      ctx as never,
    );

    expect(res?.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith("ord-123", { status: "cancelled" });
  });

  it("does not update orm.trades when broker cancellation fails", async () => {
    vi.spyOn(tenantProviders, "resolveTenantBroker").mockResolvedValue("public");
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockReturnValue({
      cancelOrderRemote: vi.fn().mockResolvedValue({ success: false, error: "already filled" }),
    } as never);

    const updateSpy = vi.fn();
    const ctx = {
      env: {},
      getOrm: () => ({ trades: { update: updateSpy } }),
      audit: vi.fn(),
    };

    const req = new Request("https://example.com/api/broker/order/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": "alice" },
      body: JSON.stringify({ orderId: "ord-456" }),
    });
    const res = await handleBrokerOrderRoutes(
      req,
      new URL(req.url),
      "/api/broker/order/cancel",
      "sess-1",
      ctx as never,
    );

    expect(res?.status).toBe(409);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
