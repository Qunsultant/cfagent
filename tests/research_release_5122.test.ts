import { describe, expect, it } from "vitest";
import { ALL_FEATURE_FLAGS } from "../src/features/featureFlagPorts";
import {
  dispatchResearchEngineRun,
  isResearchEngineCutoverEnabled,
} from "../src/workflows/researchScreenEngine";

describe("Issue #5122 (Sub-issue 8 of #5109) — Research Release & Operations", () => {
  it("registers research_engine_cutover flag and supports rollback when disabled", async () => {
    expect(ALL_FEATURE_FLAGS).toContain("research_engine_cutover");
    expect(await isResearchEngineCutoverEnabled({ isEnabled: async () => true })).toBe(true);
    expect(await isResearchEngineCutoverEnabled({ isEnabled: async () => false })).toBe(false);
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
      expect(stage.startedAt).toBeTruthy();
      expect(stage.finishedAt).toBeTruthy();
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
      expect(stage.status).toBe("completed");
    }
  });
});
