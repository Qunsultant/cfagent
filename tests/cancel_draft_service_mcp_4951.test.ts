import { describe, expect, it, vi } from "vitest";
import {
  markDraftRowCancelledIfPresent,
  markScopedDraftsCancelledIfPresent,
} from "../src/services/orderCancellation";
import { markDraftCancelledIfPresent } from "../src/agents/routes/brokerOrders";

describe("Issue #4951 — Service & route draft cancellation sync", () => {
  it("updates mas_trades draft row to cancelled when orderId and orm.trades.update are present", () => {
    const update = vi.fn();
    markDraftRowCancelledIfPresent({ trades: { update } }, "ord-123");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("ord-123", { status: "cancelled" });
  });

  it("is a no-op when orderId is empty, orm is missing, or update throws", () => {
    const throwingUpdate = vi.fn(() => {
      throw new Error("no such row");
    });
    expect(() => markDraftRowCancelledIfPresent(null, "ord-1")).not.toThrow();
    expect(() => markDraftRowCancelledIfPresent({ trades: { update: throwingUpdate } }, "")).not.toThrow();
    expect(throwingUpdate).not.toHaveBeenCalled();
    expect(() => markDraftRowCancelledIfPresent({ trades: { update: throwingUpdate } }, "ord-1")).not.toThrow();
    expect(throwingUpdate).toHaveBeenCalledTimes(1);
  });

  it("syncs all cancelled orders in a scoped receipt and skips dryRun", () => {
    const update = vi.fn();
    markScopedDraftsCancelledIfPresent(
      { trades: { update } },
      { dryRun: true, cancelled: [{ orderId: "ord-skip" }] as never },
    );
    expect(update).not.toHaveBeenCalled();

    markScopedDraftsCancelledIfPresent(
      { trades: { update } },
      { dryRun: false, cancelled: [{ orderId: "ord-a" }, { orderId: "ord-b" }] as never },
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, "ord-a", { status: "cancelled" });
    expect(update).toHaveBeenNthCalledWith(2, "ord-b", { status: "cancelled" });
  });

  it("delegates brokerOrders.markDraftCancelledIfPresent to the service helper", () => {
    const update = vi.fn();
    markDraftCancelledIfPresent({ getOrm: () => ({ trades: { update } }) }, "ord-route-1");
    expect(update).toHaveBeenCalledWith("ord-route-1", { status: "cancelled" });
  });
});
