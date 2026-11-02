/**
 * #1771 slice C: rebalance proposals — RED pins (written before
 * the implementation; the first run must fail on the missing
 * src/orchestrations/rebalanceProposals.ts module).
 *
 * Pins: drift math (buy underweight, sell overweight, hold under
 * threshold); every proposal is DRAFT and no order is placed
 * (the module exports no execution function — asserted by the
 * shape: status/shares/notional only); unlisted holdings are
 * named with no proposal; bad target sums and bad prices throw
 * naming the problem; a target with no holding gets priceUnknown,
 * never a fabricated price.
 */
import { describe, expect, it } from "vitest";
import { computeRebalanceProposals } from "../src/orchestrations/rebalanceProposals";

describe("rebalance proposals (#1771 slice C)", () => {
  it("buys underweight, sells overweight, holds small drift — all DRAFT", () => {
    const r = computeRebalanceProposals(
      [
        { symbol: "AAA", shares: 100, price: 10 },
        { symbol: "BBB", shares: 100, price: 10 },
      ],
      [
        { symbol: "AAA", targetWeight: 0.8 },
        { symbol: "BBB", targetWeight: 0.2 },
      ],
    );
    expect(r.status).toBe("DRAFT");
    expect(r.totalValue).toBe(2000);
    const a = r.proposals.find((p) => p.symbol === "AAA")!;
    const b = r.proposals.find((p) => p.symbol === "BBB")!;
    expect(a.status).toBe("DRAFT");
    expect(a.action).toBe("buy");
    expect(a.shares).toBeCloseTo(60);
    expect(a.notional).toBeCloseTo(600);
    expect(b.action).toBe("sell");
    expect(b.shares).toBeCloseTo(-60);
    expect(r.unlisted).toEqual([]);
  });

  it("drift below minDrift is hold, not churn", () => {
    const r = computeRebalanceProposals(
      [{ symbol: "AAA", shares: 100, price: 10 }],
      [{ symbol: "AAA", targetWeight: 1 }],
      { minDrift: 0.01 },
    );
    expect(r.proposals[0]!.action).toBe("hold");
    expect(r.proposals[0]!.shares).toBe(0);
  });

  it("unlisted holdings are named and get no proposal", () => {
    const r = computeRebalanceProposals(
      [
        { symbol: "AAA", shares: 10, price: 10 },
        { symbol: "ZZZ", shares: 10, price: 10 },
      ],
      [{ symbol: "AAA", targetWeight: 1 }],
    );
    expect(r.unlisted).toEqual(["ZZZ"]);
    expect(r.proposals.map((p) => p.symbol)).toEqual(["AAA"]);
  });

  it("bad target sums, bad prices, and unknown-price targets fail loud", () => {
    expect(() =>
      computeRebalanceProposals([{ symbol: "AAA", shares: 1, price: 10 }], [
        { symbol: "AAA", targetWeight: 0.5 },
      ]),
    ).toThrow(/sum to 0\.5/);
    expect(() =>
      computeRebalanceProposals([{ symbol: "AAA", shares: 1, price: 0 }], [
        { symbol: "AAA", targetWeight: 1 },
      ]),
    ).toThrow(/non-positive price/);
    const r = computeRebalanceProposals([], [{ symbol: "NEW", targetWeight: 1 }]);
    expect(r.proposals[0]!.priceUnknown).toBe(true);
    expect(r.proposals[0]!.shares).toBe(0);
  });
});
