// @vitest-environment node
/**
 * Issue #3945 (#3550 prep slice) — the control plane extended to
 * vocabulary stages addressed by (runId, stageId):
 *  - a job node's kind names its vocabulary stage (feed, enrich,
 *    analyze, generate, store, serve, deliver) and the engine
 *    resolves a vocabulary stage to its node path — one node per
 *    stage, refusing by name when the stage is absent or two
 *    nodes claim it;
 *  - the seven uniform operations work addressed by vocabulary
 *    stage (run / re-run / stop / resume / cancel / schedule /
 *    re-schedule), delegating to the (jobId, nodePath) twins, so
 *    the twins' meanings, claims, and fail-closed refusals are
 *    unchanged and the existing addressing keeps working.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  vocabularyStageForNodeKind,
  vocabularyStageNodePath,
  type JobPipelineControl,
  type JobPipelineDeps,
  type JobScheduleHost,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";

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
    "schedule",
    "reschedule",
  ]) {
    messaging.subscribe("collector", `job.stage.${action}`, (envelope) => {
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
    newRunId: () => `run-${++runCounter}`,
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

describe("vocabulary resolution (node kind -> catalog stage -> node path)", () => {
  it("maps node kinds onto the six catalog stages; unmapped kinds name no stage", () => {
    expect(vocabularyStageForNodeKind("feed")).toBe("feed");
    expect(vocabularyStageForNodeKind("enrich")).toBe("gather");
    expect(vocabularyStageForNodeKind("analyze")).toBe("analysis");
    expect(vocabularyStageForNodeKind("generate")).toBe("analysis");
    expect(vocabularyStageForNodeKind("store")).toBe("store");
    expect(vocabularyStageForNodeKind("serve")).toBe("serve");
    expect(vocabularyStageForNodeKind("deliver")).toBe("deliver");
    expect(vocabularyStageForNodeKind("pipeline")).toBeNull();
    expect(vocabularyStageForNodeKind("dummy")).toBeNull();
    expect(vocabularyStageForNodeKind("")).toBeNull();
  });

  it("resolves each vocabulary stage of a definition to its node path", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(VOCAB_JOB);
    expect(vocabularyStageNodePath(definition, "feed")).toBe("0");
    expect(vocabularyStageNodePath(definition, "gather")).toBe("1");
    expect(vocabularyStageNodePath(definition, "deliver")).toBe("2");
  });

  it("resolves a root node whose kind is a vocabulary stage to the root path", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob({
      jobId: "root-feed",
      root: {
        kind: "feed",
        steps: [{ step: "stepA" }],
        executionMode: { delivery: "sync" },
      },
    });
    expect(vocabularyStageNodePath(definition, "feed")).toBe("");
  });

  it("refuses by name: a stage no node claims, and a stage two nodes claim", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(VOCAB_JOB);
    expect(() => vocabularyStageNodePath(definition, "store")).toThrow(
      expect.objectContaining({ code: "stage_vocabulary_unknown" }),
    );
    const ambiguous = await h.control.defineJob({
      jobId: "two-analysis",
      root: {
        kind: "pipeline",
        steps: [{ step: "stepA" }],
        executionMode: { delivery: "sync" },
        children: [
          { kind: "analyze", steps: [{ step: "stepB" }] },
          { kind: "generate", steps: [{ step: "stepC" }] },
        ],
      },
    });
    expect(() => vocabularyStageNodePath(ambiguous, "analysis")).toThrow(
      expect.objectContaining({ code: "stage_vocabulary_ambiguous" }),
    );
  });
});

describe("the seven operations addressed by vocabulary stage", () => {
  it("re-runs one completed stage by vocabulary name, leaving the others' effects untouched", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.runJob("vocab-job");
    expect(h.counts.get("stepB")).toBe(2); // feed child + deliver child
    const result = await h.control.rerunStageByVocabulary("vocab-job", "feed", {
      runId: "run-1",
    });
    expect(result.state).toBe("completed");
    expect(h.counts.get("stepB")).toBe(3);
    expect(h.counts.get("stepC")).toBe(1);
    const view = await h.control.getJob("vocab-job");
    const feed = view.stages.find((s) => s.stageId === "job:0");
    expect(feed?.units[0].attempt).toBe(2);
    expect(feed?.units[0].status).toBe("completed");
    expect(h.stageEvents.some((e) => e.type === "job.stage.rerun")).toBe(true);
  });

  it("runs a never-run stage by vocabulary name, and refuses a completed one and a wrong run address", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    await h.control.runJob("vocab-job");
    await expect(
      h.control.rerunStageByVocabulary("vocab-job", "feed", { runId: "run-999" }),
    ).rejects.toMatchObject({ code: "stage_run_mismatch" });
    await expect(h.control.runStageByVocabulary("vocab-job", "feed")).rejects.toMatchObject({
      code: "stage_already_completed",
    });
    // A stage that has not run: configure a store child in, then
    // re-run must refuse (run is the operation) and run must work.
    await h.control.configureJob("vocab-job", {
      root: {
        children: [
          { kind: "feed", steps: [{ step: "stepB" }] },
          { kind: "enrich", steps: [{ step: "stepC" }] },
          { kind: "deliver", steps: [{ step: "stepB" }] },
          { kind: "store", steps: [{ step: "stepB" }] },
        ],
      },
    });
    await expect(h.control.rerunStageByVocabulary("vocab-job", "store")).rejects.toMatchObject({
      code: "stage_not_rerunnable",
    });
    const ran = await h.control.runStageByVocabulary("vocab-job", "store");
    expect(ran.state).toBe("completed");
    const view = await h.control.getJob("vocab-job");
    expect(view.stages.find((s) => s.stageId === "job:3")?.units[0].status).toBe("completed");
  });

  it("stops the running stage by vocabulary name and resumes it from its checkpoint", async () => {
    const stores = createInMemoryJobPipelineStores();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    let blockInvocations = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      blockInvocations += 1;
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
    const view = await control.getJob("blocker");
    expect(view.stages[0]?.units[0].status).toBe("stopped");
    const resumed = await control.resumeStageByVocabulary("blocker", "feed");
    const settled = await resumed.completion!;
    expect(settled.state).toBe("completed");
    expect(blockInvocations).toBe(1); // the completed step was NOT re-executed
  });

  it("cancels a not-yet-run stage by vocabulary name: it never executes, downstream never proceeds", async () => {
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
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      newRunId: () => "run-cancel-stage",
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
    await control.cancelStageByVocabulary("chain", "gather");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    expect(secondCalls).toBe(0);
    const view = await control.getJob("chain");
    expect(view.stages.find((s) => s.stageId === "job:1")?.units[0].status).toBe("cancelled");
    expect(view.stages.find((s) => s.stageId === "job:0")?.units[0].status).toBe("completed");
  });

  it("schedules / re-schedules by vocabulary name; the nodePath twins keep working", async () => {
    const h = makeHarness();
    await h.control.defineJob(VOCAB_JOB);
    const unscheduled: string[] = [];
    let registrations = 0;
    const host: JobScheduleHost = {
      schedule: async () => `reg-${++registrations}`,
      unschedule: async (id) => {
        unscheduled.push(id);
      },
    };
    const scheduled = await h.control.scheduleStageByVocabulary(
      "vocab-job",
      "feed",
      { interval: "every 15 minutes" },
      "keep the feed warm",
      host,
    );
    expect(scheduled.registrationId).toBe("reg-1");
    const view = await h.control.getJob("vocab-job");
    expect(view.definition.root.children?.[0].schedule).toMatchObject({
      enabled: true,
      interval: "every 15 minutes",
      registrationId: "reg-1",
      reason: "keep the feed warm",
    });
    await expect(
      h.control.scheduleStageByVocabulary(
        "vocab-job",
        "feed",
        { interval: "every hour" },
        "again",
        host,
      ),
    ).rejects.toMatchObject({ code: "stage_already_scheduled" });

    const rescheduled = await h.control.rescheduleStageByVocabulary(
      "vocab-job",
      "feed",
      { cron: "*/30 * * * *" },
      "tighten cadence",
      host,
    );
    expect(unscheduled).toEqual(["reg-1"]);
    expect(rescheduled.registrationId).toBe("reg-2");
    const view2 = await h.control.getJob("vocab-job");
    expect(view2.definition.root.children?.[0].schedule).toMatchObject({
      cron: "*/30 * * * *",
      registrationId: "reg-2",
      reason: "tighten cadence",
    });

    const noCancelHost: JobScheduleHost = { schedule: async () => "reg-x" };
    await expect(
      h.control.rescheduleStageByVocabulary(
        "vocab-job",
        "feed",
        { interval: "every hour" },
        "nope",
        noCancelHost,
      ),
    ).rejects.toMatchObject({ code: "stage_reschedule_unsupported" });
    expect(
      h.stageEvents.some((e) => e.type === "job.stage.schedule" && e.data?.detail === "reg-1"),
    ).toBe(true);
    expect(h.stageEvents.some((e) => e.type === "job.stage.reschedule")).toBe(true);

    // Lossless: the (jobId, nodePath) twins are untouched — a twin
    // re-run of the same stage still works after vocabulary ops.
    await h.control.runJob("vocab-job");
    const reran = await h.control.rerunStage("vocab-job", "0");
    expect(reran.state).toBe("completed");
  });
});
