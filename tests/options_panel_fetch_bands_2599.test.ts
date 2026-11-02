/**
 * Issue #2599 (F7): the panel fetch band builder.
 *
 * The panel snapshot used to fetch only the request's min/maxDte
 * window (default 0-90), so LEAPS (365-550 DTE) and PMCC (180+
 * DTE far leg) contracts were unreachable from the panel. These
 * pins assert the builder's rule — the scheduled scanner's near
 * + extended band rule, applied to a panel request — without
 * asserting the full catalog (other strategies' horizons may
 * grow; the LEAPS/PMCC bands and the thesis gate must not move).
 */
import { describe, expect, it } from "vitest";
import { buildPanelFetchDteBands } from "../src/trading/options/panelFetchDteBands";

const hasBand = (
  bands: Array<{ minDte: number; maxDte: number; maxExpirations: number }>,
  minDte: number,
  maxDte: number,
) => bands.some((b) => b.minDte === minDte && b.maxDte === maxDte);

describe("panel fetch DTE bands (#2599 F7)", () => {
  it("bullish + all: near band first, LEAPS 365-550 and PMCC 180-365 reachable", () => {
    const bands = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["all"],
    });
    expect(bands[0]).toEqual({ minDte: 0, maxDte: 90, maxExpirations: 100 });
    expect(hasBand(bands, 365, 550)).toBe(true);
    expect(hasBand(bands, 180, 365)).toBe(true);
    const leaps = bands.find((b) => b.minDte === 365 && b.maxDte === 550)!;
    expect(leaps.maxExpirations).toBe(4);
    const pmcc = bands.find((b) => b.minDte === 180 && b.maxDte === 365)!;
    expect(pmcc.maxExpirations).toBe(4);
    // Deduped by (minDte, maxDte), as the scanner dedupes.
    const keys = bands.map((b) => `${b.minDte}-${b.maxDte}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("thesis-gates the extended bands: the same strategy id adds its band only under a matching thesis", () => {
    // leaps_call is bullish-only: a bullish panel fetches its
    // 365-550 band, a bearish panel does not (the bearish 365-550
    // band in the all-strategies case comes from leaps_put, and
    // the bearish 180-365 band from poor_mans_covered_put).
    const bullish = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["leaps_call"],
    });
    expect(hasBand(bullish, 365, 550)).toBe(true);
    const bearish = buildPanelFetchDteBands({
      thesis: "bearish",
      allowedStrategies: ["leaps_call"],
    });
    expect(bearish).toEqual([{ minDte: 0, maxDte: 90, maxExpirations: 100 }]);
    const bearishAll = buildPanelFetchDteBands({
      thesis: "bearish",
      allowedStrategies: ["all"],
    });
    expect(hasBand(bearishAll, 365, 550)).toBe(true);
    expect(hasBand(bearishAll, 180, 365)).toBe(true);
  });

  it("allowedStrategies narrow the extended bands: long_call alone adds no extended band", () => {
    const bands = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["long_call"],
    });
    expect(bands).toEqual([{ minDte: 0, maxDte: 90, maxExpirations: 100 }]);
  });

  it("allowedStrategies leaps_call alone adds exactly the LEAPS band", () => {
    const bands = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["leaps_call"],
    });
    expect(bands).toEqual([
      { minDte: 0, maxDte: 90, maxExpirations: 100 },
      { minDte: 365, maxDte: 550, maxExpirations: 4 },
    ]);
  });

  it("unknown strategies resolve to the near band only (no invented bands)", () => {
    const bands = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["no_such_strategy"],
    });
    expect(bands).toEqual([{ minDte: 0, maxDte: 90, maxExpirations: 100 }]);
  });

  it("honours the request's own near window; extended bands still anchor on required DTE", () => {
    const bands = buildPanelFetchDteBands({
      thesis: "bullish",
      allowedStrategies: ["leaps_call"],
      minDte: 14,
      maxDte: 60,
    });
    expect(bands[0]).toEqual({ minDte: 14, maxDte: 60, maxExpirations: 100 });
    expect(hasBand(bands, 365, 550)).toBe(true);
  });
});
