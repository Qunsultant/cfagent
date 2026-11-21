/**
 * Issue #2865 (Phase 2 Slice 5 under #2764) — pins for
 * planScheduledScreen, the scheduled monolithic run's planner
 * entry. Issue #4436: the explicit Yahoo data mode resolves the
 * provider — full-dataset runs Yahoo, gap-fill keeps the
 * configured provider.
 */
import { describe, expect, it } from "vitest";
import { planScheduledScreen } from "../src/workflows/stockScreenPlanner";

const TS = "2026-11-02T13:00:00.000Z";

describe("planScheduledScreen", () => {
  it("defaults trigger to scheduled, universe to the externalized default, sector to ALL", () => {
    // Issue #5516: the absent-selection universe is the externalized default
    // (config/vocabulary.json → universe), never the TECH sector.
    const plan = planScheduledScreen({ provider: "etrade" }, TS);
    expect(plan.sector).toBe("ALL");
    expect(plan.universe).toBe("NASDAQ100");
    expect(plan.provider).toBe("etrade");
    expect(plan.yahooDataMode).toBeUndefined();
    expect(plan.idempotencyKey).toBe("screener:scheduled:NASDAQ100:ALL:2026-11-02T13:00");
  });

  it("refuses a missing provider with FAILURE_NO_SCREENING_PROVIDER (#4431)", () => {
    expect(() => planScheduledScreen({}, TS)).toThrow(
      expect.objectContaining({ code: "FAILURE_NO_SCREENING_PROVIDER" }),
    );
  });

  it("forces yahoo under the full-dataset mode, even when etrade was requested (#4436)", () => {
    const plan = planScheduledScreen(
      {
        provider: "etrade",
        yahooDataMode: "full-dataset",
      },
      TS,
    );
    expect(plan.provider).toBe("yahoo");
    expect(plan.yahooDataMode).toBe("full-dataset");
  });

  it("resolves the provider from the full-dataset mode alone, with no provider input (#4436)", () => {
    const plan = planScheduledScreen({ yahooDataMode: "full-dataset" }, TS);
    expect(plan.provider).toBe("yahoo");
    expect(plan.yahooDataMode).toBe("full-dataset");
  });

  it("keeps the configured provider under the gap-fill mode (#4436)", () => {
    const plan = planScheduledScreen({ provider: "etrade", yahooDataMode: "gap-fill" }, TS);
    expect(plan.provider).toBe("etrade");
    expect(plan.yahooDataMode).toBe("gap-fill");
  });

  it("refuses a gap-fill run with no provider to fill gaps in (#4436)", () => {
    expect(() => planScheduledScreen({ yahooDataMode: "gap-fill" }, TS)).toThrow(
      expect.objectContaining({ code: "FAILURE_NO_SCREENING_PROVIDER" }),
    );
  });

  it("keeps a deliberate yahoo run mode-free", () => {
    const plan = planScheduledScreen({ provider: "yahoo" }, TS);
    expect(plan.provider).toBe("yahoo");
    expect(plan.yahooDataMode).toBeUndefined();
  });

  it("resolves sector from filters and honours an explicit manual trigger", () => {
    const plan = planScheduledScreen(
      { provider: "etrade", filters: { sector: "Technology" }, trigger: "manual" },
      TS,
    );
    expect(plan.sector).toBe("Technology");
    expect(plan.idempotencyKey.startsWith("screener:manual:")).toBe(true);
  });
});
