// @vitest-environment node
/**
 * Issue #4425 (ONC RCA N11) — completion-triggered scheduling.
 *
 * The binding used to not exist anywhere: a schedule could fire on cron, on an
 * interval, or by hand, and a job's completion triggered nothing. Worse, the
 * `job-pipeline-events` handler was defined (#3543) and never instantiated, so
 * even the completion record never reached the host.
 *
 * Pins:
 *  - 4425-P01 the binding parses strictly off the target job's raw config:
 *    absent = not configured; malformed = a named error, never a silent skip;
 *    a missing state defaults to "completed".
 *  - 4425-P02 matching is exact — a state must match (or be "any"), a named
 *    source job must be the event's job, and a stage-scoped binding never
 *    fires from a job-level event (no invented stage).
 *  - 4425-P03 the host fires exactly the matching targets, through the same
 *    control plane an ordinary run uses.
 *  - 4425-P04 a binding that would fire its own job is refused by name (an
 *    unbounded loop the owner never asked for), and a malformed binding is
 *    reported rather than ignored.
 *  - 4425-P05 the queue entry instantiates the handler and calls the host's
 *    two RPCs — the consumer is no longer "never wired".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import {
  completionMatchesTrigger,
  parseCompletionTrigger,
  type CompletionTriggerBinding,
} from "../src/services/completionTrigger";
import { dispatchCompletionSchedules } from "../src/agents/scheduledTasksCompletion";

function noopRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  return registry;
}

function jobConfig(jobId: string, over: Record<string, unknown> = {}) {
  return {
    jobId,
    name: `Job ${jobId}`,
    root: { kind: "feed", steps: [{ step: "noop" }] },
    ...over,
  };
}

async function makeControl() {
  const stores = createInMemoryJobPipelineStores();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: noopRegistry(),
  });
  return { stores, control };
}

const BINDING: CompletionTriggerBinding = {
  sourceJobId: "source-1",
  sourceStage: null,
  state: "completed",
  targetStage: null,
};

describe("4425-P01 the binding parses strictly, and says why when it cannot", () => {
  it("treats an absent key as not configured", () => {
    expect(parseCompletionTrigger(jobConfig("target-1"))).toEqual({ binding: null, error: null });
  });

  it("reads a full binding", () => {
    const parsed = parseCompletionTrigger(
      jobConfig("target-1", {
        completionTrigger: {
          source: { jobId: "source-1", stage: "feed" },
          state: "failed",
          targetStage: "enrich",
        },
      }),
    );
    expect(parsed.error).toBeNull();
    expect(parsed.binding).toEqual({
      sourceJobId: "source-1",
      sourceStage: "feed",
      state: "failed",
      targetStage: "enrich",
    });
  });

  it("defaults the state to completed", () => {
    const parsed = parseCompletionTrigger(
      jobConfig("target-1", { completionTrigger: { source: { jobId: "source-1" } } }),
    );
    expect(parsed.binding?.state).toBe("completed");
  });

  it("reports a source-less, a non-object, and an unknown-state binding", () => {
    expect(
      parseCompletionTrigger(jobConfig("t", { completionTrigger: { source: {} } })).error,
    ).toContain("must name a jobId, a stage, or both");
    expect(parseCompletionTrigger(jobConfig("t", { completionTrigger: "soon" })).error).toContain(
      "must be an object",
    );
    expect(
      parseCompletionTrigger(
        jobConfig("t", { completionTrigger: { source: { jobId: "s" }, state: "someday" } }),
      ).error,
    ).toContain("state must be one of");
  });
});

describe("4425-P02 matching is exact, never a guess", () => {
  it("matches the named job and state", () => {
    expect(completionMatchesTrigger(BINDING, { jobId: "source-1", state: "completed" })).toBe(true);
  });

  it("does not match another job, another state, or an unstated state", () => {
    expect(completionMatchesTrigger(BINDING, { jobId: "source-2", state: "completed" })).toBe(false);
    expect(completionMatchesTrigger(BINDING, { jobId: "source-1", state: "failed" })).toBe(false);
  });

  it("fires on any terminal state when the binding says any", () => {
    const anyState: CompletionTriggerBinding = { ...BINDING, state: "any" };
    expect(completionMatchesTrigger(anyState, { jobId: "source-1", state: "failed" })).toBe(true);
    expect(completionMatchesTrigger(anyState, { jobId: "source-1", state: "cancelled" })).toBe(true);
  });

  it("does not fire a stage-scoped binding from a job-level event", () => {
    const stageBound: CompletionTriggerBinding = { ...BINDING, sourceStage: "feed" };
    expect(completionMatchesTrigger(stageBound, { jobId: "source-1", state: "completed" })).toBe(false);
    expect(
      completionMatchesTrigger(stageBound, {
        jobId: "source-1",
        state: "completed",
        stage: "feed",
      }),
    ).toBe(true);
    expect(
      completionMatchesTrigger(stageBound, {
        jobId: "source-1",
        state: "completed",
        stage: "enrich",
      }),
    ).toBe(false);
  });
});

describe("4425-P03 the host fires exactly the matching targets", () => {
  it("runs the bound target and leaves an unbound sibling alone", async () => {
    const { control } = await makeControl();
    await control.defineJob(
      jobConfig("target-bound", {
        completionTrigger: { source: { jobId: "source-1" }, state: "completed" },
      }),
    );
    await control.defineJob(
      jobConfig("target-other", {
        completionTrigger: { source: { jobId: "source-2" }, state: "completed" },
      }),
    );
    await control.defineJob(jobConfig("target-plain"));

    const result = await dispatchCompletionSchedules(control, {
      jobId: "source-1",
      runId: "run-9",
      state: "completed",
    });

    expect(result.fired).toEqual(["target-bound"]);
    expect(result.skipped).toEqual([]);
    expect(result.invalid).toEqual([]);
    // The fired target is an ordinary run: its instance carries the scheduled trigger.
    const instance = await control.getJob("target-bound");
    expect(instance.instance?.runTrigger).toBe("scheduled");
  });

  it("does not fire when the completion state does not match", async () => {
    const { control } = await makeControl();
    await control.defineJob(
      jobConfig("target-bound", {
        completionTrigger: { source: { jobId: "source-1" }, state: "completed" },
      }),
    );
    const result = await dispatchCompletionSchedules(control, {
      jobId: "source-1",
      state: "failed",
    });
    expect(result.fired).toEqual([]);
  });
});

describe("4425-P04 a self-trigger and a malformed binding are reported, not run", () => {
  it("refuses a job fired by its own completion", async () => {
    const { control } = await makeControl();
    await control.defineJob(
      jobConfig("loop", { completionTrigger: { source: { jobId: "loop" } } }),
    );
    const result = await dispatchCompletionSchedules(control, { jobId: "loop", state: "completed" });
    expect(result.fired).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ jobId: "loop" });
    expect(result.skipped[0].reason).toContain("self-trigger refused");
  });

  it("names a malformed binding instead of ignoring it", async () => {
    const { control } = await makeControl();
    await control.defineJob(jobConfig("broken", { completionTrigger: { source: {} } }));
    const result = await dispatchCompletionSchedules(control, {
      jobId: "source-1",
      state: "completed",
    });
    expect(result.fired).toEqual([]);
    expect(result.invalid[0]).toMatchObject({ jobId: "broken" });
  });
});

describe("4425-P05 the queue entry wires the consumer", () => {
  const source = readFileSync("src/server/routes/queue.ts", "utf8");

  it("instantiates the job-pipeline-events handler on its own queue", () => {
    expect(source).toContain('batch?.queue === "job-pipeline-events"');
    expect(source).toContain("createJobPipelineEventsHandler({");
  });

  it("routes completions and stage events to the host's RPCs", () => {
    expect(source).toContain("recordPipelineCompletion({");
    expect(source).toContain("recordStageEvent(event)");
    expect(source).toContain("fireCompletionSchedules({");
  });
});
