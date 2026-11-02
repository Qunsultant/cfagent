import { describe, it, expect } from "vitest";
import {
  STOCK_CLEANUP_DEPRECATIONS,
  STOCK_CLEANUP_RETENTIONS,
  stockCleanupRetentionBySurface,
} from "../src/workflows/stockCleanupRegister";

describe("cleanup-last retention register #2892", () => {
  it("audits the replaced-in-place surfaces with named successors", () => {
    const replaced = STOCK_CLEANUP_RETENTIONS.filter((e) => e.verdict === "replaced-in-place");
    expect(replaced.map((e) => e.surface)).toEqual([
      "Hand-assembled run spec in the REST routes",
      "Shard ternary copied across broker, NLQ port, and mesh door",
      "Hand-derived scheduled planner values in ScheduledTasksService",
      "Deliver-then-persist ordering on E*TRADE ALL sharded runs",
    ]);
    for (const entry of replaced) {
      expect(entry.successorOrReason).toMatch(/src\/workflows\//);
    }
  });

  it("retains the fused path for #2869 follow-through, with its reason named", () => {
    const fused = stockCleanupRetentionBySurface(
      "Fused single-call ScreenerAgent.runScreen path (stages in-process, no stage messages)",
    );
    expect(fused?.verdict).toBe("retained");
    expect(fused?.successorOrReason).toMatch(/#2869/);
  });

  it("preserves legacy aliases with the canonical form named", () => {
    const aliases = stockCleanupRetentionBySurface("Legacy hub tab aliases ?screenerTab= and ?tab=");
    expect(aliases?.verdict).toBe("preserved-alias");
    expect(aliases?.successorOrReason).toMatch(/\?view=/);
  });

  it("issues zero deprecations and deletes zero files — the empty list is the audit finding", () => {
    expect(STOCK_CLEANUP_DEPRECATIONS).toEqual([]);
  });

  it("every entry names a successor or a preservation reason — no bare verdicts", () => {
    for (const entry of STOCK_CLEANUP_RETENTIONS) {
      expect(entry.successorOrReason).toBeTruthy();
    }
  });

  it("unknown surfaces resolve to undefined, never an invented verdict", () => {
    expect(stockCleanupRetentionBySurface("no-such-surface")).toBeUndefined();
  });
});
