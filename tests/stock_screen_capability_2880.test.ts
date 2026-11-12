import { describe, it, expect } from "vitest";
import {
  STOCK_SCREEN_CAPABILITIES,
  STOCK_SCREEN_EXTENSION_POINTS,
  stockScreenCapabilityById,
  unbuiltStockScreenCapabilities,
} from "../src/workflows/stockScreenCapability";

describe("stock screen capability inventory #2880", () => {
  it("covers every entry surface: REST x2, NLQ, mesh, scheduled x2, workflow child, goal leg, research subtab, replay, report generation, delivery, preset, pattern", () => {
    const ids = STOCK_SCREEN_CAPABILITIES.map((c) => c.id);
    for (const expected of [
      "rest-etrade-screen",
      "rest-market-data-screen",
      "nlq-chat-screen",
      "mesh-screen-door",
      "scheduled-monolithic",
      "scheduled-sharded",
      "workflow-child-screen",
      "goal-stock-leg",
      "research-screener-subtab",
      "report-replay",
      "report-generation",
      "delivery",
      "preset-resolution",
      "pattern-application",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("every entry names at least one canonical component or target, and has entry/engine/provider/persistence/delivery", () => {
    for (const c of STOCK_SCREEN_CAPABILITIES) {
      expect(c.canonical.length).toBeGreaterThan(0);
      for (const field of ["entry", "engine", "provider", "persistence", "delivery"] as const) {
        expect(c[field], `${c.id}.${field}`).toBeTruthy();
      }
      if (c.status !== "canonical") {
        expect(c.current, `${c.id} must name its current path, not hide it`).toBeTruthy();
      }
    }
  });

  it("entry ids are unique", () => {
    const ids = STOCK_SCREEN_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("extension points are exactly the five named — no parallel pipeline, no sixth seam", () => {
    expect([...STOCK_SCREEN_EXTENSION_POINTS].sort()).toEqual(
      ["aspect", "pattern", "preset", "provider", "stage"].sort(),
    );
    for (const c of STOCK_SCREEN_CAPABILITIES) {
      if (c.extensionPoint) {
        expect(STOCK_SCREEN_EXTENSION_POINTS).toContain(c.extensionPoint);
      }
    }
  });

  it("no entry names a second recorder, catalog, port layer, or unit store", () => {
    const banned = /second recorder|second catalog|second port|second unit store|parallel pipeline/i;
    for (const c of STOCK_SCREEN_CAPABILITIES) {
      const text = [c.name, c.engine, ...c.canonical, c.current ?? ""].join(" ");
      expect(text).not.toMatch(banned);
    }
  });

  it("the goal stock leg is built on the one engine (#4279 migrates it off the registry leg)", () => {
    const goal = stockScreenCapabilityById("goal-stock-leg");
    expect(goal?.status).toBe("canonical");
    expect(goal?.engine).toMatch(/runStockScreenViaEngine/);
    expect(goal?.current).toMatch(/runGoalStockLegViaWorkflow/);
    expect(unbuiltStockScreenCapabilities().map((c) => c.id)).not.toContain("goal-stock-leg");
  });

  it("pattern application is canonical once the patterns slice lands (#2884 updates this pin in the same PR)", () => {
    const pattern = stockScreenCapabilityById("pattern-application");
    expect(pattern?.status).toBe("canonical");
    expect(pattern?.extensionPoint).toBe("pattern");
    expect(unbuiltStockScreenCapabilities().map((c) => c.id)).not.toContain("pattern-application");
  });

  it("unknown ids resolve to undefined, never an invented mapping", () => {
    expect(stockScreenCapabilityById("no-such-capability")).toBeUndefined();
  });
});
