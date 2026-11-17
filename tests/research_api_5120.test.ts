import { describe, expect, it } from "vitest";
import {
  controlResearchStage,
  dispatchResearchEngineRun,
} from "../src/workflows/researchScreenEngine";
import { codedMessage } from "../src/outcomes/outcomeAspects";

describe("Issue #5120 (Sub-issue 4 of #5109) — Research API Endpoints", () => {
  it("dispatches both manual and scheduled runs as research:<runId> with explicit owner identity", async () => {
    const manual = await dispatchResearchEngineRun({
      runId: "r-man-1",
      userLogin: "trader@example.com",
      trigger: "manual",
      execute: async () => ({ success: true, runId: "r-man-1" }),
    });
    expect(manual.engineJobId).toBe("research:r-man-1");
    expect(manual.userLogin).toBe("trader@example.com");
    expect(manual.stages).toContain("evaluate");

    await expect(
      dispatchResearchEngineRun({
        runId: "r-bad",
        userLogin: "default",
        trigger: "scheduled",
        execute: async () => ({}),
      }),
    ).rejects.toThrow(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  });

  it("addresses research:<runId> stages by (runId, stageId) and refuses unknown stages", () => {
    const res = controlResearchStage({
      runId: "r-1",
      stageId: "evaluate",
      op: "run",
      userLogin: "trader@example.com",
    });
    expect(res).toEqual({
      ok: true,
      engineJobId: "research:r-1",
      runId: "r-1",
      stageId: "evaluate",
      op: "run",
      userLogin: "trader@example.com",
    });

    expect(() =>
      controlResearchStage({
        runId: "r-1",
        stageId: "nonexistent",
        op: "status",
        userLogin: "trader@example.com",
      }),
    ).toThrow(/Unknown research stage/);
  });
});
