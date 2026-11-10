/**
 * Issue #4021 — a bracket ladder must never invent its exits.
 *
 * Live incident: an AAPL ladder was placed BUY 10 @ 347.44 with broker exits at
 * 348.44 (+0.29%) and 345.44 (-0.56%) where +4% / -2% were requested. Cause:
 * `take_profit_delta ?? 1.0` and `stop_loss_delta ?? 2.0` — the tool silently
 * substituted +$1.00 / -$2.00 for a caller that spoke the #3812 percent
 * vocabulary. Exits are now resolved from absolute deltas OR percents, and a
 * caller that names neither is refused before a rung is placed.
 */
import { describe, it, expect } from "vitest";
import {
  resolveLadderExitDeltas,
  deriveLadderIdFromKey,
} from "../src/services/bracketLadder";

describe("Issue #4021 — ladder exit resolution", () => {
  it("keeps absolute deltas when given", () => {
    expect(
      resolveLadderExitDeltas({ basePrice: 347.44, takeProfitDelta: 13.9, stopLossDelta: 6.95 }),
    ).toEqual({ takeProfitDelta: 13.9, stopLossDelta: 6.95 });
  });

  it("converts percents against the tier entry, to cents", () => {
    expect(
      resolveLadderExitDeltas({ basePrice: 347.44, takeProfitPct: 4, stopLossPct: 2 }),
    ).toEqual({ takeProfitDelta: 13.9, stopLossDelta: 6.95 });
    expect(
      resolveLadderExitDeltas({ basePrice: 100.005, takeProfitPct: 4, stopLossPct: 2 }),
    ).toEqual({ takeProfitDelta: 4, stopLossDelta: 2 });
  });

  it("lets an absolute delta win over a percent for the same side", () => {
    expect(
      resolveLadderExitDeltas({
        basePrice: 200,
        takeProfitDelta: 3,
        takeProfitPct: 4,
        stopLossPct: 2,
      }),
    ).toEqual({ takeProfitDelta: 3, stopLossDelta: 4 });
  });

  it("refuses instead of defaulting when no exit distance is named", () => {
    expect(() => resolveLadderExitDeltas({ basePrice: 347.44 })).toThrow(
      /No default exit is invented/,
    );
    expect(() =>
      resolveLadderExitDeltas({ basePrice: 347.44, takeProfitDelta: 5 }),
    ).toThrow(/No default exit is invented/);
  });

  it("refuses non-positive distances", () => {
    expect(() =>
      resolveLadderExitDeltas({ basePrice: 100, takeProfitDelta: 0, stopLossDelta: 2 }),
    ).toThrow(/must both be positive/);
  });
});

describe("Issue #4022 — ladder idempotency", () => {
  it("derives the same ladder id for the same key, so a retry cannot duplicate rungs", async () => {
    const first = await deriveLadderIdFromKey("aapl-2026-11-10-bracket-1");
    const second = await deriveLadderIdFromKey("aapl-2026-11-10-bracket-1");
    expect(first).toBe(second);
    expect(first).toMatch(/^lad_idem_[0-9a-f]{16}$/);
  });

  it("treats a padded key as the same request", async () => {
    expect(await deriveLadderIdFromKey("  key-1  ")).toBe(
      await deriveLadderIdFromKey("key-1"),
    );
  });

  it("gives different keys different ladder ids", async () => {
    expect(await deriveLadderIdFromKey("key-1")).not.toBe(
      await deriveLadderIdFromKey("key-2"),
    );
  });
});
