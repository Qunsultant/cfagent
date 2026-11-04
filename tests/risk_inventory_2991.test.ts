/**
 * Issue #2991 (#2770 Phase A) — risk module: INVENTORY ONLY. No
 * asset class is onboarded here, "onboarded" is not defined here,
 * and portfolio composition is not built here (those questions are
 * open with Venus). The inventory records per-class signals and
 * where the single-port module will sit.
 */
import { describe, expect, it } from "vitest";
import {
  RISK_INVENTORY,
  RISK_MODULE_SEAT,
  RISK_PORT_SHAPE,
} from "../src/workflows/blocks/riskInventory";

describe("risk inventory #2991", () => {
  it("covers all six asset classes, none silently omitted", () => {
    expect(RISK_INVENTORY.map((r) => r.assetClass).sort()).toEqual([
      "bonds",
      "commodities",
      "forex",
      "futures",
      "options",
      "stocks",
    ]);
  });

  it("options has the one existing assessor with its report signals", () => {
    const options = RISK_INVENTORY.find((r) => r.assetClass === "options")!;
    expect(options.status).toBe("present");
    expect(options.assessor).toBe("StrategyRiskAgent");
    for (const signal of [
      "maxLoss",
      "maxProfit",
      "breakevens",
      "probabilityOfProfit",
      "netGreeks",
      "budgetUsedPct",
    ]) {
      expect(options.signals).toContain(signal);
    }
    expect(options.notes).toContain("caller-supplied");
  });

  it("stocks is thin: no standalone equity assessor", () => {
    const stocks = RISK_INVENTORY.find((r) => r.assetClass === "stocks")!;
    expect(stocks.status).toBe("thin");
    expect(stocks.assessor).toBeNull();
    expect(stocks.signals).toContain("AVWAP guard");
  });

  it("bonds, forex, futures, commodities have no assessor — explicitly null, not missing", () => {
    for (const assetClass of ["bonds", "forex", "futures", "commodities"]) {
      const row = RISK_INVENTORY.find((r) => r.assetClass === assetClass)!;
      expect(row.status).toBe("absent");
      expect(row.assessor).toBeNull();
      expect(row.signals).toEqual([]);
    }
  });

  it("the module seat names the single port and its report shape, with no assessor implemented", () => {
    expect(RISK_MODULE_SEAT.port).toBe("RiskPort");
    expect(RISK_MODULE_SEAT.path).toContain("riskModule");
    expect(RISK_PORT_SHAPE.output).toContain("maxLoss");
    expect(RISK_PORT_SHAPE.output).toContain("breakevens");
    expect(RISK_PORT_SHAPE.output).toContain("probabilityOfProfit");
    expect(RISK_PORT_SHAPE.output).toContain("netGreeks");
    expect(RISK_PORT_SHAPE.output).toContain("budgetUsedPct");
  });
});
