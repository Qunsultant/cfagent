/**
 * Issue #3892 — protective exits and multi-rung scale-outs.
 *
 * A protective exit takes the POSITION's quantity, so it can never open a
 * short by accident; a scale-out can never sell more than is held.
 */
import { describe, it, expect } from "vitest";
import { buildScaleOutPlan, protectiveExitForPosition } from "../src/trading";

describe("#3892 — protective exit on an existing position", () => {
  it("computes a stop from a percent of the average entry", () => {
    const result = protectiveExitForPosition({ symbol: "AAPL", quantity: 100, averageEntryPrice: 200 }, { percent: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({ symbol: "AAPL", side: "sell", type: "stop", qty: 100, stop_price: 190, time_in_force: "gtc" });
  });

  it("takes an absolute stop price", () => {
    const result = protectiveExitForPosition({ symbol: "msft", quantity: 25 }, { stopPrice: 410.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({ symbol: "MSFT", qty: 25, stop_price: 410.5 });
  });

  it("can trail instead of stopping at a fixed price", () => {
    const result = protectiveExitForPosition({ symbol: "NVDA", quantity: 10 }, { trailPercent: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toMatchObject({ type: "trailing_stop", trail_percent: 8, qty: 10 });
  });

  it("refuses when there is nothing to protect, and when it cannot compute a stop", () => {
    expect(protectiveExitForPosition({ symbol: "AAPL", quantity: 0 }, { percent: 5 })).toMatchObject({
      ok: false,
      code: "protective_exit_without_shares",
    });
    expect(protectiveExitForPosition({ symbol: "AAPL", quantity: 10, averageEntryPrice: null }, { percent: 5 })).toMatchObject({
      ok: false,
      code: "invalid_protective_exit",
    });
  });
});

describe("#3892 — multi-rung scale-out", () => {
  it("builds one sell per target and totals them", () => {
    const plan = buildScaleOutPlan({
      symbol: "aapl",
      quantity: 100,
      targets: [
        { price: 210, quantity: 40 },
        { price: 220, quantity: 30 },
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.totalQuantity).toBe(70);
    expect(plan.legs).toEqual([
      { symbol: "AAPL", side: "sell", type: "limit", qty: 40, limit_price: 210, time_in_force: "gtc" },
      { symbol: "AAPL", side: "sell", type: "limit", qty: 30, limit_price: 220, time_in_force: "gtc" },
    ]);
  });

  it("refuses to sell more than the position holds", () => {
    const plan = buildScaleOutPlan({
      symbol: "AAPL",
      quantity: 50,
      targets: [
        { price: 210, quantity: 40 },
        { price: 220, quantity: 30 },
      ],
    });
    expect(plan).toMatchObject({ ok: false, code: "scale_out_exceeds_position" });
    if (plan.ok) return;
    expect(plan.message).toContain("sell 70 shares but the position is 50");
  });

  it("refuses an empty or malformed plan", () => {
    expect(buildScaleOutPlan({ symbol: "AAPL", quantity: 10, targets: [] })).toMatchObject({ ok: false });
    expect(buildScaleOutPlan({ symbol: "AAPL", quantity: 10, targets: [{ price: 0, quantity: 1 }] })).toMatchObject({ ok: false });
  });
});
