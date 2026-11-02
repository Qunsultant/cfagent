import { describe, it, expect } from "vitest";
import {
  listStockPatterns,
  stockPatternById,
} from "../src/workflows/stockPatternCatalog";

describe("stock pattern catalog #2884", () => {
  it("lists exactly the stock families from the setup catalog, in catalog order", () => {
    const patterns = listStockPatterns();
    expect(patterns.map((p) => p.id)).toEqual(["trend_breakout", "pullback_reversion"]);
    for (const p of patterns) {
      expect(p.assetClass).toBe("stock");
      expect(p.label).toBeTruthy();
      expect(p.indicators.length).toBeGreaterThan(0);
      expect(p.riskNotes.length).toBeGreaterThan(0);
    }
  });

  it("never lists options families", () => {
    const ids = listStockPatterns().map((p) => p.id);
    expect(ids).not.toContain("defined_risk_spread");
    expect(ids).not.toContain("pmcc");
  });

  it("trend_breakout applies as momentum bullish_breakout; volumeRatioMin stays unmapped, never converted", () => {
    const pattern = stockPatternById("trend_breakout");
    expect(pattern?.screenFilter).toEqual({ momentum: "bullish_breakout" });
    expect(pattern?.guardrails).toEqual({ volumeRatioMin: 1.2 });
    expect(pattern?.unmappedGuardrails).toEqual(["volumeRatioMin"]);
    expect(pattern?.screenFilter).not.toHaveProperty("minVolume");
  });

  it("pullback_reversion applies as maxRsi 30 from its rsiMax guardrail", () => {
    const pattern = stockPatternById("pullback_reversion");
    expect(pattern?.screenFilter).toEqual({ maxRsi: 30 });
    expect(pattern?.unmappedGuardrails).toEqual([]);
  });

  it("unknown ids resolve to undefined, never an invented pattern", () => {
    expect(stockPatternById("no-such-pattern")).toBeUndefined();
  });
});
