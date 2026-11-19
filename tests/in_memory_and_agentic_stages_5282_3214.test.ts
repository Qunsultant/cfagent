import { describe, expect, it } from "vitest";
import { EPHEMERAL_GUARANTEE_CONTRACT } from "../src/data/jobPipelinePorts";
import { buildEphemeralGuaranteeNotice, resolveExecutionMode } from "../src/services/jobPipelineConfig";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { runStageInMemory } from "../src/services/stageInMemoryExecution";
import { executeAgenticStageControl, parseStageControlIntent } from "../src/services/agenticStageControl";

describe("5282 in-memory stage execution with ephemeral guarantees", () => {
  it("resolves durability axis and returns explicit ephemeral guarantee notice when in-memory", () => {
    const durable = resolveExecutionMode({});
    expect(durable.durability).toBeUndefined();
    expect(buildEphemeralGuaranteeNotice("feed", durable)).toBeNull();

    const inMem = resolveExecutionMode({ durability: "in-memory" });
    expect(inMem.durability).toBe("in-memory");
    const notice = buildEphemeralGuaranteeNotice("feed", inMem);
    expect(notice?.guarantees).toEqual(EPHEMERAL_GUARANTEE_CONTRACT);
    expect(notice?.guarantees.resumable).toBe(false);
    expect(notice?.guarantees.journalReuse).toBe(false);
  });

  it("refuses implicit in-memory execution and runs when explicitly opted in", async () => {
    const steps = new JobStepRegistry();
    steps.register("test.echo", async (ctx) => ({ output: { ok: true, jobId: ctx.jobId } }));

    await expect(
      runStageInMemory({
        jobId: "inmem:test-1",
        stageId: "feed",
        step: "test.echo",
        steps,
        optIn: false,
      }),
    ).rejects.toThrow(/opt-in must be explicit/i);

    const result = await runStageInMemory({
      jobId: "inmem:test-1",
      stageId: "feed",
      step: "test.echo",
      steps,
      optIn: true,
    });
    expect(result.durability).toBe("in-memory");
    expect(result.ephemeralGuarantees.durable).toBe(false);
    expect(result.state).toBe("completed");
  });
});

describe("3214 agentic stage control via chat", () => {
  it("parses conversational stage control intents for one, some, or all stages", () => {
    expect(parseStageControlIntent("re-run the deliver stage of run abc-123")).toEqual({
      op: "rerun",
      stageIds: ["deliver"],
      allStages: false,
      runId: "abc-123",
    });
    expect(parseStageControlIntent("pause feed and enrich for run r-42")).toEqual({
      op: "pause",
      stageIds: ["feed", "enrich"],
      allStages: false,
      runId: "r-42",
    });
    expect(parseStageControlIntent("cancel all stages of run r-99")).toEqual({
      op: "cancel",
      stageIds: ["feed", "enrich", "analyze", "generate", "deliver", "evaluate"],
      allStages: true,
      runId: "r-99",
    });
  });

  it("executes multi-stage control uniformly", async () => {
    const seen: string[] = [];
    const res = await executeAgenticStageControl({
      runId: "r-42",
      stageIds: ["feed", "enrich"],
      op: "retire",
      executeOne: async (_runId, stageId, op) => {
        seen.push(`${stageId}:${op}`);
        return { ok: true, stageId, op };
      },
    });
    expect(seen).toEqual(["feed:retire", "enrich:retire"]);
    expect(res.results).toHaveLength(2);
  });
});
