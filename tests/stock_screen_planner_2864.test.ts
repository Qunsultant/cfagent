/**
 * Issue #2864 (Phase 2 Slice 4 under #2764) — pins for the
 * stock-screen planner, extracted verbatim from
 * ScreenerAgent.runScreenInner. Every formula here is copied
 * from runScreenInner; a divergence is a regression, not a
 * judgment call.
 */
import { describe, expect, it } from "vitest";
import {
  planFromSpec,
  planStockScreenRun,
} from "../src/workflows/stockScreenPlanner";
import type { StockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

const TS = "2026-11-02T13:00:00.000Z";

describe("planStockScreenRun", () => {
  it("prefers req.sector, then filters.sector, then ALL", () => {
    expect(
      planStockScreenRun({ trigger: "manual", sector: "Technology", filters: { sector: "Energy" } }, TS).sector,
    ).toBe("Technology");
    expect(
      planStockScreenRun({ trigger: "manual", filters: { sector: "Energy" } }, TS).sector,
    ).toBe("Energy");
    expect(planStockScreenRun({ trigger: "manual" }, TS).sector).toBe("ALL");
  });

  it("defaults universe to TECH and provider to etrade", () => {
    const plan = planStockScreenRun({ trigger: "manual" }, TS);
    expect(plan.universe).toBe("TECH");
    expect(plan.provider).toBe("etrade");
  });

  it("keys manual runs on the full timestamp and scheduled runs on the minute", () => {
    const manual = planStockScreenRun(
      { trigger: "manual", universe: "NASDAQ100", sector: "ALL" },
      TS,
    );
    expect(manual.idempotencyKey).toBe(
      "screener:manual:NASDAQ100:ALL:2026-11-02T13:00:00.000Z",
    );
    const scheduled = planStockScreenRun(
      { trigger: "scheduled", universe: "NASDAQ100", sector: "ALL" },
      TS,
    );
    expect(scheduled.idempotencyKey).toBe(
      "screener:scheduled:NASDAQ100:ALL:2026-11-02T13:00",
    );
  });

  it("claims scheduled duplicates on stock:<universe> and carries the fallback marker", () => {
    const plan = planStockScreenRun(
      {
        trigger: "scheduled",
        universe: "NASDAQ100",
        providerFallback: { from: "etrade", reason: "auth dead" },
      },
      TS,
    );
    expect(plan.scheduledClaimKey).toBe("stock:NASDAQ100");
    expect(plan.providerFallback).toEqual({ from: "etrade", reason: "auth dead" });
  });
});

describe("planFromSpec", () => {
  function spec(overrides: Partial<StockScreenRunSpec> = {}): StockScreenRunSpec {
    return {
      source: "etrade",
      deliver: true,
      filters: {},
      universe: "NASDAQ100",
      asyncRequested: false,
      delivery: {},
      ...overrides,
    } as StockScreenRunSpec;
  }

  it("maps the E*TRADE spec to the etrade default provider", () => {
    const plan = planFromSpec(spec(), "manual", TS);
    expect(plan.provider).toBe("etrade");
    expect(plan.universe).toBe("NASDAQ100");
    expect(plan.sector).toBe("ALL");
  });

  it("maps the market-data spec provider and filter sector through", () => {
    const plan = planFromSpec(
      spec({
        source: "market-data",
        provider: "yahoo",
        filters: { sector: "Technology" } as StockScreenRunSpec["filters"],
      }),
      "manual",
      TS,
    );
    expect(plan.provider).toBe("yahoo");
    expect(plan.sector).toBe("Technology");
  });
});
