// @vitest-environment node
/**
 * Issue #5912 (slices 2–3) — the venue/mode selection reaches the engine job.
 *
 * Pins:
 *  - 5912-P05 a run that names a venue/mode carries both onto the analyze
 *    stage's params — the stage that runs the research loop, so the run it
 *    names is its own;
 *  - 5912-P06 a run that names none carries neither (today's default path).
 */
import { describe, it, expect } from "vitest";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";

const analyze = (config: Record<string, unknown>) =>
  (buildResearchJobDefinition("r-sel", {
    userLogin: "trader@example.com",
    trigger: "manual",
    ...config,
  } as never).root.children ?? []).find((c) => c.kind === "analyze")!;

describe("5912-P05 the selection rides the analyze stage's params", () => {
  it("carries brokerId and mode", () => {
    const stage = analyze({ brokerId: "alpaca", mode: "paper" });
    expect((stage.steps?.[0]?.params as Record<string, unknown>).brokerId).toBe("alpaca");
    expect((stage.steps?.[0]?.params as Record<string, unknown>).mode).toBe("paper");
  });

  it("keeps the runId the step already needed", () => {
    const stage = analyze({ brokerId: "alpaca" });
    expect((stage.steps?.[0]?.params as Record<string, unknown>).runId).toBe("r-sel");
  });
});

describe("5912-P06 no selection keeps today's params", () => {
  it("adds neither key", () => {
    const params = analyze({}).steps?.[0]?.params as Record<string, unknown>;
    expect(params.brokerId).toBeUndefined();
    expect(params.mode).toBeUndefined();
  });
});
