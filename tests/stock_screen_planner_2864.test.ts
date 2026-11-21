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
      planStockScreenRun({ trigger: "manual", provider: "etrade", sector: "Technology", filters: { sector: "Energy" } }, TS).sector,
    ).toBe("Technology");
    expect(
      planStockScreenRun({ trigger: "manual", provider: "etrade", filters: { sector: "Energy" } }, TS).sector,
    ).toBe("Energy");
    expect(planStockScreenRun({ trigger: "manual", provider: "etrade" }, TS).sector).toBe("ALL");
  });

  it("defaults universe to the externalized default (#5516: nasdaq100)", () => {
    // Issue #5516: TECH was a sector, and the planner defaulted to it. The
    // absent-selection universe now resolves config/vocabulary.json → universe.
    const plan = planStockScreenRun({ trigger: "manual", provider: "yahoo" }, TS);
    expect(plan.universe).toBe("NASDAQ100");
    expect(plan.provider).toBe("yahoo");
  });

  it("refuses a missing provider with FAILURE_NO_SCREENING_PROVIDER (#4431)", () => {
    expect(() => planStockScreenRun({ trigger: "manual" }, TS)).toThrow(
      expect.objectContaining({ code: "FAILURE_NO_SCREENING_PROVIDER" }),
    );
  });

  it("keys manual runs on the full timestamp and scheduled runs on the minute", () => {
    const manual = planStockScreenRun(
      { trigger: "manual", provider: "etrade", universe: "NASDAQ100", sector: "ALL" },
      TS,
    );
    expect(manual.idempotencyKey).toBe(
      "screener:manual:NASDAQ100:ALL:2026-11-02T13:00:00.000Z",
    );
    const scheduled = planStockScreenRun(
      { trigger: "scheduled", provider: "etrade", universe: "NASDAQ100", sector: "ALL" },
      TS,
    );
    expect(scheduled.idempotencyKey).toBe(
      "screener:scheduled:NASDAQ100:ALL:2026-11-02T13:00",
    );
  });

  it("claims scheduled duplicates on stock:<universe> and carries the Yahoo data mode (#4436)", () => {
    const plan = planStockScreenRun(
      {
        trigger: "scheduled",
        universe: "NASDAQ100",
        provider: "yahoo",
        yahooDataMode: "full-dataset",
      },
      TS,
    );
    expect(plan.scheduledClaimKey).toBe("stock:NASDAQ100");
    expect(plan.yahooDataMode).toBe("full-dataset");
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

  it("refuses a spec with no provider with FAILURE_NO_SCREENING_PROVIDER (#4431)", () => {
    expect(() => planFromSpec(spec(), "manual", TS)).toThrow(
      expect.objectContaining({ code: "FAILURE_NO_SCREENING_PROVIDER" }),
    );
  });

  it("maps the spec's tenant-resolved provider through (#4431)", () => {
    const plan = planFromSpec(spec({ provider: "etrade" }), "manual", TS);
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
