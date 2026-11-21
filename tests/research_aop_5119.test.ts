import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_JOB_CONFIG,
  RESEARCH_AOP_RULES,
  isWithinResearchGuardWindow,
  resolveResearchJobConfig,
} from "../src/config/researchJobConfig";
import { codedMessage } from "../src/outcomes/outcomeAspects";
import { maskAccountId } from "../src/config/accountBindings";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import {
  ANALYZE_OODA_STEP,
  EVALUATE_APPLY_STEP,
  assertResearchAopCompliance,
  registerResearchSteps,
} from "../src/services/researchPipelineJobs";

describe("Issue #5119 (Sub-issue 3 of #5109) — Research AOP Compliance", () => {
  it("externalizes OODA budget, guard window, and concurrency caps via resolveResearchJobConfig", () => {
    expect(DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour).toBe(21);
    expect(DEFAULT_RESEARCH_JOB_CONFIG.scheduleWindowMinutes).toBe(30);
    expect(RESEARCH_AOP_RULES).toEqual({
      configurable: true,
      storedDataOnly: true,
      durableResumableStages: true,
      ownerScopedReads: true,
      cappedParallel: true,
      fullProvenance: true,
    });

    const custom = resolveResearchJobConfig({
      RESEARCH_OODA_BUDGET_MS: "45000",
      RESEARCH_MAX_PARALLEL: "2",
      RESEARCH_SCHEDULE_UTC_HOUR: "21",
      RESEARCH_SCHEDULE_WINDOW_MINUTES: "30",
    });
    expect(custom.oodaBudgetMs).toBe(45000);
    expect(custom.maxParallelCandidates).toBe(2);
    expect(resolveResearchJobConfig().accountBindingType).toBe("options");
    expect(resolveResearchJobConfig({ RESEARCH_ACCOUNT_BINDING_TYPE: "stock" }).accountBindingType).toBe("stock");
    expect(() => resolveResearchJobConfig({ RESEARCH_ACCOUNT_BINDING_TYPE: "not-an-account" })).toThrow(
      "RESEARCH_ACCOUNT_BINDING_TYPE",
    );
    expect(maskAccountId("acct-123456")).toBe("•••••••3456");
    expect(maskAccountId("abc")).toBe("••••");

    expect(isWithinResearchGuardWindow(new Date("2026-11-17T21:15:00.000Z"), custom)).toBe(true);
    expect(isWithinResearchGuardWindow(new Date("2026-11-17T21:30:00.000Z"), custom)).toBe(false);
    expect(isWithinResearchGuardWindow(new Date("2026-11-17T20:59:00.000Z"), custom)).toBe(false);
  });

  it("enforces owner-scoped reads and surfaces coded messages on missing owner or evaluate failure", async () => {
    expect(() => assertResearchAopCompliance(DEFAULT_RESEARCH_JOB_CONFIG, {})).toThrow(
      codedMessage("FAILURE_RESEARCH_OWNER_MISSING"),
    );

    const registry = new JobStepRegistry();
    registerResearchSteps(registry, {
      runOodaAnalysis: async () => {
        throw new Error("should not reach");
      },
      runEvaluateStage: async () => {
        throw new Error("boom");
      },
    });

    await expect(
      registry.resolve(ANALYZE_OODA_STEP)({
        jobId: "research:r1",
        runId: "r1",
        params: {},
        inputs: [],
      } as any),
    ).rejects.toThrow(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));

    await expect(
      registry.resolve(EVALUATE_APPLY_STEP)({
        jobId: "research:r1",
        runId: "r1",
        params: { userLogin: "trader@example.com" },
        inputs: [],
      } as any),
    ).rejects.toThrow(codedMessage("FAILURE_RESEARCH_EVALUATE_FAILED"));
  });
});
