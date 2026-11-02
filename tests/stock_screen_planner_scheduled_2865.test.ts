/**
 * Issue #2865 (Phase 2 Slice 5 under #2764) — pins for
 * planScheduledScreen, the scheduled monolithic run's planner
 * entry. The fallback→yahoo rule is copied verbatim from
 * ScheduledTasksService.autonomousMarketScreen.
 */
import { describe, expect, it } from "vitest";
import { planScheduledScreen } from "../src/workflows/stockScreenPlanner";

const TS = "2026-11-02T13:00:00.000Z";

describe("planScheduledScreen", () => {
  it("defaults trigger to scheduled, universe to TECH, provider to etrade, sector to ALL", () => {
    const plan = planScheduledScreen({}, TS);
    expect(plan.sector).toBe("ALL");
    expect(plan.universe).toBe("TECH");
    expect(plan.provider).toBe("etrade");
    expect(plan.providerFallback).toBeUndefined();
    expect(plan.idempotencyKey).toBe("screener:scheduled:TECH:ALL:2026-11-02T13:00");
  });

  it("forces yahoo with the marker on a fallback run, even when etrade was requested", () => {
    const plan = planScheduledScreen(
      {
        provider: "etrade",
        providerFallback: { from: "etrade", reason: "etrade-auth-dead" },
      },
      TS,
    );
    expect(plan.provider).toBe("yahoo");
    expect(plan.providerFallback).toEqual({ from: "etrade", reason: "etrade-auth-dead" });
  });

  it("keeps a deliberate yahoo run marker-free", () => {
    const plan = planScheduledScreen({ provider: "yahoo" }, TS);
    expect(plan.provider).toBe("yahoo");
    expect(plan.providerFallback).toBeUndefined();
  });

  it("resolves sector from filters and honours an explicit manual trigger", () => {
    const plan = planScheduledScreen(
      { filters: { sector: "Technology" }, trigger: "manual" },
      TS,
    );
    expect(plan.sector).toBe("Technology");
    expect(plan.idempotencyKey.startsWith("screener:manual:")).toBe(true);
  });
});
