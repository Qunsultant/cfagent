// @vitest-environment node
/**
 * Issue #6473 — the report's layout defects, at the level they can be pinned:
 * the level-label placement is pure, so "entry and exit labels never overlap"
 * is an assertion rather than a screenshot.
 *
 * Pins:
 *  - 6473-P08 two levels a point apart get labels a readable distance apart,
 *    and both stay inside the chart box;
 *  - 6473-P09 a crowded stack (five levels within a few points) still yields
 *    five distinct labels — none dropped — each inside the box;
 *  - 6473-P10 well-separated levels keep their own line (no needless nudging);
 *  - 6473-P11 levels beyond the range clamp into the box instead of drawing
 *    outside the chart.
 */
import { describe, it, expect } from "vitest";
import { levelLabelYs } from "../src/trading/opportunityHuntReportPdf";

const Y_BOTTOM = 100;
const Y_TOP = 300;
const MIN_GAP = 9;

function insideBox(ys: readonly number[]): boolean {
  return ys.every((y) => y >= Y_BOTTOM + 2 && y <= Y_TOP - 10);
}

function minPairGap(ys: readonly number[]): number {
  let gap = Infinity;
  for (let i = 0; i < ys.length; i += 1) {
    for (let j = i + 1; j < ys.length; j += 1) {
      gap = Math.min(gap, Math.abs(ys[i] - ys[j]));
    }
  }
  return gap;
}

describe("#6473 — level labels on the report's price chart", () => {
  it("P08: adjacent levels get readable, in-box labels", () => {
    const ys = levelLabelYs([200, 201], Y_BOTTOM, Y_TOP);
    expect(ys).toHaveLength(2);
    expect(minPairGap(ys)).toBeGreaterThanOrEqual(MIN_GAP);
    expect(insideBox(ys)).toBe(true);
  });

  it("P09: a crowded stack keeps every label, none overlapping", () => {
    const ys = levelLabelYs([200, 201, 202, 203, 204], Y_BOTTOM, Y_TOP);
    expect(ys).toHaveLength(5);
    expect(new Set(ys).size).toBe(5);
    expect(minPairGap(ys)).toBeGreaterThanOrEqual(MIN_GAP);
    expect(insideBox(ys)).toBe(true);
  });

  it("P10: separated levels keep their own line", () => {
    // Each label sits 2pt above its line and nothing is within the gap, so no
    // level is nudged.
    expect(levelLabelYs([120, 200, 280], Y_BOTTOM, Y_TOP)).toEqual([122, 202, 282]);
  });

  it("P11: levels beyond the range clamp into the box", () => {
    const ys = levelLabelYs([-500, 5000], Y_BOTTOM, Y_TOP);
    expect(insideBox(ys)).toBe(true);
  });
});
