// @vitest-environment node
/**
 * Issue #3944 (#3550 prep slice) — the retire operation, the eighth
 * uniform stage operation:
 *  - retire is definition-level and permanent: a retired stage never
 *    re-runs in any run of the job; run / re-run / resume on it
 *    refuse by name (stage_not_retirable), and a new dispatch of a
 *    job carrying a retired stage refuses before any step executes;
 *  - a live run reaching a retired stage settles cancelled with the
 *    stage named; the stage's units are recorded "retired" (the
 *    stage contract's new unit status), and downstream never
 *    proceeds — silently or otherwise;
 *  - retire works addressed like the other seven operations, by
 *    (jobId, nodePath) and by (runId, stageId) on vocabulary
 *    stages (#3945), delegating to the node-path twin;
 *  - the seven existing operations are unchanged.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";
import {
  lifecycleStateForRun,
  lifecycleStateForRunStatus,
} from "../src/services/workflowLifecycle";

interface Harness {
  control: JobPipelineControl;
  counts: Map<string, number>;
  inputs: Map<string, unknown[]>;
  stageEvents: MessageEnvelope[];
}

function makeHarness(overrides?: Partial<JobPipelineDeps>): Harness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const stageEvents: MessageEnvelope[] = [];
  for (const action of [
    "completed",
    "failed",
    "rerun",
    "run",
    "stop",
    "stopped",
    "cancelled",
    "cancel",
    "retire",
    "retired",
    "resume",
    "schedule",
    "reschedule",
  ]) {
    messaging.subscribe("collector", "job.stage." + action, (envelope) => {
      stageEvents.push(envelope);
      return "processed";
    });
  }
  const counts = new Map<string, number>();
  const inputs = new Map<string, unknown[]>();
  const steps = createBuiltinStepRegistry();
  for (const name of ["stepA", "stepB", "stepC"]) {
    steps.register(name, async (ctx: JobStepContext) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const seen = inputs.get(name) ?? [];
      seen.push(ctx.input ?? null);
      inputs.set(name, seen);
      return { output: { from: name, input: ctx.input ?? null } };
    });
  }
  let tick = 0;
  const base = Date.parse("2026-11-06T12:00:00.000Z");
  let runCounter = 0;
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    now: () => new Date(base + tick++ * 1000),
    newRunId: () => "run-" + ++runCounter,
    ...overrides,
  };
  return { control: createJobPipelineControl(deps), counts, inputs, stageEvents };
}

const VOCAB_JOB = {
  jobId: "vocab-job",
  root: {
    kind: "pipeline",
    steps: [{ step: "stepA" }],
    executionMode: { delivery: "sync" },
    children: [
      { kind: "feed", steps: [{ step: "stepB" }] },
      { kind: "enrich", steps: [{ step: "stepC" }] },
      { kind: "deliver", steps: [{ step: "stepB" }] },
    ],
  },
};

describe("retire persists on the definition and refuses twice", () => {
  it("retiring a stage stamps retired on its node; a second retire refuses by name", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    const retired = await h.control.retireStage("vocab-job", "0");
    expect(retired.jobId).toBe("vocab-job");
    const view = await h.control.getJob("vocab-job");
    expect(view.definition.root.children?.[0].retired).toBe(true);
    expect(view.definition.root.children?.[1].retired).toBeUndefined();
    expect(h.stageEvents.some((e) => e.type === "job.stage.retire")).toBe(true);
    await expect(h.control.retireStage("vocab-job", "0")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
  });

  it("retireStageByVocabulary resolves the vocabulary stage and retires its node", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.retireStageByVocabulary("vocab-job", "feed");
    const view = await h.control.getJob("vocab-job");
    expect(view.definition.root.children?.[0].retired).toBe(true);
    await expect(
      h.control.retireStageByVocabulary("vocab-job", "feed"),
    ).rejects.toMatchObject({ code: "stage_not_retirable" });
  });

  it("a definition carrying retired in its raw config parses it; its runs refuse", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "pre-retired",
      root: {
        kind: "pipeline",
        steps: [{ step: "stepA" }],
        executionMode: { delivery: "sync" },
        children: [
          { kind: "feed", steps: [{ step: "stepB" }], retired: true },
          { kind: "deliver", steps: [{ step: "stepB" }] },
        ],
      },
    });
    const view = await h.control.getJob("pre-retired");
    expect(view.definition.root.children?.[0].retired).toBe(true);
    await expect(h.control.runJob("pre-retired")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
    expect(h.counts.get("stepA") ?? 0).toBe(0);
    expect(h.counts.get("stepB") ?? 0).toBe(0);
  });
});

describe("a retired stage never re-runs", () => {
  it("run / re-run on a retired stage refuse by name", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.runJob("vocab-job");
    await h.control.retireStage("vocab-job", "0");
    await expect(h.control.rerunStage("vocab-job", "0")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
    await expect(h.control.runStage("vocab-job", "0")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
  });

  it("a new dispatch of a job with a retired stage refuses before any step executes", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.retireStageByVocabulary("vocab-job", "deliver");
    await expect(h.control.runJob("vocab-job")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
    expect(h.counts.get("stepA") ?? 0).toBe(0);
    expect(h.counts.get("stepB") ?? 0).toBe(0);
    expect(h.counts.get("stepC") ?? 0).toBe(0);
  });

  it("resume of a stage retired in the definition refuses by name", async () => {
    const stores = createInMemoryJobPipelineStores();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      newRunId: () => "run-block",
    });
    await control.defineJob({
      jobId: "blocker",
      root: {
        kind: "feed",
        steps: [{ step: "block" }, { step: "record" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.stopStageByVocabulary("blocker", "feed");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    // Retire the stopped stage through configuration (not the
    // retire operation, which settles a paused run outright).
    await control.configureJob("blocker", { root: { retired: true } });
    await expect(control.resumeStage("blocker", "")).rejects.toMatchObject({
      code: "stage_not_retirable",
    });
  });
});

describe("a live run reaching a retired stage settles cancelled, downstream never proceeds", () => {
  it("retires a not-yet-run stage by vocabulary name: it never executes, downstream never proceeds", async () => {
    const stores = createInMemoryJobPipelineStores();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    let secondCalls = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    steps.register("second", async () => {
      secondCalls += 1;
      return { output: { second: true } };
    });
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const stageEvents: MessageEnvelope[] = [];
    for (const action of ["retire", "retired", "cancel", "cancelled"]) {
      messaging.subscribe("collector", "job.stage." + action, (envelope) => {
        stageEvents.push(envelope);
        return "processed";
      });
    }
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: ports.publisher,
      steps,
      newRunId: () => "run-retire-stage",
    });
    await control.defineJob({
      jobId: "chain",
      root: {
        kind: "pipeline",
        executionMode: { delivery: "async" },
        children: [
          { kind: "feed", steps: [{ step: "block" }] },
          { kind: "enrich", steps: [{ step: "second" }] },
        ],
      },
    });
    const dispatch = await control.runJob("chain");
    await enteredPromise;
    await control.retireStageByVocabulary("chain", "gather");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    expect(secondCalls).toBe(0);
    const view = await control.getJob("chain");
    expect(view.stages.find((s) => s.stageId === "job:1")?.units[0].status).toBe("retired");
    expect(view.stages.find((s) => s.stageId === "job:0")?.units[0].status).toBe("completed");
    expect(stageEvents.some((e) => e.type === "job.stage.retire")).toBe(true);
    expect(stageEvents.some((e) => e.type === "job.stage.retired")).toBe(true);
  });

  it("retiring the stopped stage of a paused run settles the run cancelled with retired entries", async () => {
    const stores = createInMemoryJobPipelineStores();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      newRunId: () => "run-block",
    });
    await control.defineJob({
      jobId: "blocker",
      root: {
        kind: "feed",
        steps: [{ step: "block" }, { step: "record" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.stopStageByVocabulary("blocker", "feed");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    const settled = await control.retireStage("blocker", "");
    expect(settled.state).toBe("cancelled");
    const view = await control.getJob("blocker");
    expect(view.stages[0]?.units[0].status).toBe("retired");
  });
});

describe("lifecycle: a retired stage is cancelled, never in-progress", () => {
  it("maps a retired stage status onto the cancelled lifecycle state", () => {
    expect(lifecycleStateForRunStatus("retired")).toBe("cancelled");
    expect(
      lifecycleStateForRun({ status: "unknown", stages: [{ status: "retired" }] }),
    ).toBe("cancelled");
    expect(
      lifecycleStateForRun({
        status: "unknown",
        stages: [{ status: "retired" }, { status: "retired" }],
      }),
    ).toBe("cancelled");
  });
});

describe("the seven operations are unbroken beside retire", () => {
  it("scheduling another stage still works after one stage is retired", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.retireStageByVocabulary("vocab-job", "feed");
    const scheduled = await h.control.scheduleStageByVocabulary(
      "vocab-job",
      "gather",
      { interval: "every 15 minutes" },
      "keep the gather warm",
      { schedule: async () => "reg-1" },
    );
    expect(scheduled.registrationId).toBe("reg-1");
    const view = await h.control.getJob("vocab-job");
    expect(view.definition.root.children?.[1].schedule).toMatchObject({
      enabled: true,
      registrationId: "reg-1",
    });
  });
});
