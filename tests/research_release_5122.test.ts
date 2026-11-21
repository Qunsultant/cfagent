import { describe, expect, it } from "vitest";
import { ALL_FEATURE_FLAGS } from "../src/features/featureFlagPorts";
import {
  dispatchResearchEngineRun,
  isResearchEngineCutoverEnabled,
} from "../src/workflows/researchScreenEngine";

describe("Issue #5122 (Sub-issue 8 of #5109) — Research Release & Operations", () => {
  it("runs the engine by default; only the explicit rollback flag disables it", async () => {
    expect(ALL_FEATURE_FLAGS).toContain("research_engine_cutover");
    expect(ALL_FEATURE_FLAGS).toContain("research_engine_direct_rollback");
    // Ordinary config — including the old cutover flag being off — cannot
    // turn the engine off (#5915).
    expect(await isResearchEngineCutoverEnabled({ isEnabled: async () => false })).toBe(true);
    // The named emergency lever is the only way to the direct path.
    expect(
      await isResearchEngineCutoverEnabled({
        isEnabled: async (flag) => flag === "research_engine_direct_rollback",
      }),
    ).toBe(false);
  });

  it("emits stageVisibility with start/end/duration for Workflow Runs", async () => {
    const res = await dispatchResearchEngineRun({
      runId: "r-rel-1",
      userLogin: "trader@example.com",
      trigger: "scheduled",
      execute: async () => ({ success: true }),
    });
    expect(res.cutoverMode).toBe("engine");
    expect(res.stageVisibility).toHaveLength(6);
    for (const stage of res.stageVisibility) {
      if (stage.status === "completed") {
        expect(stage.startedAt).toBeTruthy();
        expect(stage.finishedAt).toBeTruthy();
        expect(stage.durationMs).toBeGreaterThanOrEqual(0);
      } else {
        expect(stage.status).toBe("unknown");
        expect(stage.startedAt).toBeNull();
        expect(stage.finishedAt).toBeNull();
        expect(stage.durationMs).toBeNull();
      }
    }
  });
});
