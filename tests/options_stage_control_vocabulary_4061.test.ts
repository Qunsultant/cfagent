// @vitest-environment node
/**
 * Issue #4061 (#3551 prep slice) — control-plane coverage for the
 * options stage vocabulary:
 *  - the 8 options execution stages (OPTIONS_ADDRESSABLE_STAGES,
 *    pinned by #4067) name themselves: an options job node's kind
 *    IS its vocabulary stage, so the merged #3945 mechanism
 *    resolves them through the same walk, with the same named
 *    refusals (stage_vocabulary_unknown / stage_vocabulary_ambiguous);
 *  - the seven uniform operations work addressed by (runId, stageId)
 *    on an options run, at the granularity of the 8 execution
 *    stages — delegating to the (jobId, nodePath) twins, so the
 *    twins' meanings, claims, and fail-closed refusals are
 *    unchanged and the existing addressing keeps working;
 *  - the display-only ids (feed/store/serve) stay unaddressable:
 *    they name no control address, never a silent fallback.
 * The generic mechanism is NOT duplicated: the options vocabulary
 * is an entry in the engine's one vocabulary walk, and the seven
 * operations are the same seven methods with a widened stage
 * parameter (VocabularyStage = StageName | OptionsPipelineStage).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  optionsVocabularyStageForNodeKind,
  vocabularyStageForNodeKind,
  vocabularyStageNodePath,
  type JobPipelineControl,
  type JobPipelineDeps,
  type JobScheduleHost,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";
import { OPTIONS_ADDRESSABLE_STAGES } from "../src/workflows/stageRuntimeIds";

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
  for (const stage of OPTIONS_ADDRESSABLE_STAGES) {
    const name = `opt-${stage}`;
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

/**
 * An options-shaped job: the root IS the first stage (plan), the
 * remaining seven are its children in pipeline order — the same
 * shape as #3945's VOCAB_JOB (root carries the first stage's step,
 * so its output is the hand-off every child consumes). A node's
 * kind IS its vocabulary stage. This is a stand-in for the job
 * definition #4068 will build when entry points route through the
 * engine; it proves the vocabulary and the seven operations, not
 * the real workflow's execution.
 */
const OPTIONS_JOB = {
  jobId: "options-job",
  root: {
    kind: "plan",
    steps: [{ step: "opt-plan" }],
    executionMode: { delivery: "sync" },
    children: OPTIONS_ADDRESSABLE_STAGES.slice(1).map((stage) => ({
      kind: stage,
      steps: [{ step: `opt-${stage}` }],
    })),
  },
};

describe("options vocabulary (node kind IS the options stage)", () => {
  it("maps each of the 8 options stage ids onto itself; display and host kinds name no stage", () => {
    for (const stage of OPTIONS_ADDRESSABLE_STAGES) {
      expect(optionsVocabularyStageForNodeKind(stage)).toBe(stage);
    }
    expect(optionsVocabularyStageForNodeKind("feed")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("store")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("serve")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("gather")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("analysis")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("pipeline")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("dummy")).toBeNull();
    expect(optionsVocabularyStageForNodeKind("")).toBeNull();
  });

  it("leaves the catalog kind mapping untouched", () => {
    expect(vocabularyStageForNodeKind("feed")).toBe("feed");
    expect(vocabularyStageForNodeKind("enrich")).toBe("gather");
    expect(vocabularyStageForNodeKind("analyze")).toBe("analysis");
    expect(vocabularyStageForNodeKind("generate")).toBe("analysis");
    expect(vocabularyStageForNodeKind("store")).toBe("store");
    expect(vocabularyStageForNodeKind("serve")).toBe("serve");
    expect(vocabularyStageForNodeKind("deliver")).toBe("deliver");
    expect(vocabularyStageForNodeKind("pipeline")).toBeNull();
    expect(vocabularyStageForNodeKind("dummy")).toBeNull();
  });

  it("resolves each of the 8 options stages of a definition to its node path", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(OPTIONS_JOB);
    // The root is plan; the remaining seven are children 0..6 in
    // pipeline order.
    expect(vocabularyStageNodePath(definition, "plan")).toBe("");
    expect(vocabularyStageNodePath(definition, "chainFetch")).toBe("0");
    expect(vocabularyStageNodePath(definition, "enrich")).toBe("1");
    expect(vocabularyStageNodePath(definition, "screen")).toBe("2");
    expect(vocabularyStageNodePath(definition, "risk")).toBe("3");
    expect(vocabularyStageNodePath(definition, "persistCanonicalResults")).toBe("4");
    expect(vocabularyStageNodePath(definition, "shapeReport")).toBe("5");
    expect(vocabularyStageNodePath(definition, "deliver")).toBe("6");
  });

  it("resolves deliver through both tables to the same single node, never ambiguous", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(OPTIONS_JOB);
    // "deliver" is the one id shared by the catalog and options
    // vocabularies (execution stage 8 AND catalog stage); both
    // naming rules match the same node, so it resolves once.
    expect(vocabularyStageNodePath(definition, "deliver")).toBe("6");
  });

  it("refuses the display-only ids by name: feed/store/serve are never control addresses", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(OPTIONS_JOB);
    for (const stage of ["feed", "store", "serve"] as const) {
      expect(() => vocabularyStageNodePath(definition, stage)).toThrow(
        expect.objectContaining({ code: "stage_vocabulary_unknown" }),
      );
    }
  });

  it("refuses by name a stage two nodes claim", async () => {
    const h = makeHarness();
    const ambiguous = await h.control.defineJob({
      jobId: "two-screen",
      root: {
        kind: "pipeline",
        steps: [{ step: "opt-plan" }],
        executionMode: { delivery: "sync" },
        children: [
          { kind: "screen", steps: [{ step: "opt-screen" }] },
          { kind: "screen", steps: [{ step: "opt-screen" }] },
        ],
      },
    });
    expect(() => vocabularyStageNodePath(ambiguous, "screen")).toThrow(
      expect.objectContaining({ code: "stage_vocabulary_ambiguous" }),
    );
  });

  it("documents the shared kind name: gather addresses the options enrich node, same node as enrich", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(OPTIONS_JOB);
    // The J-pipeline kind "enrich" IS the gather stage, and the
    // options enrich stage carries that same kind — so "gather"
    // and "enrich" address one node, and the twin behaves
    // identically under either name. Pinned, not accidental.
    expect(vocabularyStageNodePath(definition, "gather")).toBe("1");
    expect(vocabularyStageNodePath(definition, "enrich")).toBe("1");
  });
});

describe("the seven operations addressed by options stage", () => {
  it("re-runs one completed options stage by vocabulary name, leaving the others untouched", async () => {
    const h = makeHarness();
    await h.control.defineJob(OPTIONS_JOB);
    await h.control.runJob("options-job");
    for (const stage of OPTIONS_ADDRESSABLE_STAGES) {
      expect(h.counts.get(`opt-${stage}`)).toBe(1);
    }
    const result = await h.control.rerunStageByVocabulary("options-job", "screen", {
      runId: "run-1",
    });
    expect(result.state).toBe("completed");
    expect(h.counts.get("opt-screen")).toBe(2);
    expect(h.counts.get("opt-plan")).toBe(1);
    expect(h.counts.get("opt-risk")).toBe(1);
    const view = await h.control.getJob("options-job");
    const screen = view.stages.find((s) => s.stageId === "job:2");
    expect(screen?.units[0].attempt).toBe(2);
    expect(screen?.units[0].status).toBe("completed");
    expect(h.stageEvents.some((e) => e.type === "job.stage.rerun")).toBe(true);
  });

  it("runs a never-run options stage by vocabulary name, and refuses a completed one and a wrong run address", async () => {
    const h = makeHarness();
    // Define the job with seven of the eight stages, run it, then
    // configure the eighth (deliver) in — mirroring #3945's
    // configure-then-run case: the job has a run, the stage has
    // never run, so re-run must refuse and run must work.
    const seven = {
      jobId: "options-job",
      root: {
        kind: "plan",
        steps: [{ step: "opt-plan" }],
        executionMode: { delivery: "sync" },
        children: OPTIONS_ADDRESSABLE_STAGES.slice(1, -1).map((stage) => ({
          kind: stage,
          steps: [{ step: `opt-${stage}` }],
        })),
      },
    };
    await h.control.defineJob(seven);
    await h.control.runJob("options-job");
    await h.control.configureJob("options-job", {
      root: {
        children: OPTIONS_ADDRESSABLE_STAGES.slice(1).map((stage) => ({
          kind: stage,
          steps: [{ step: `opt-${stage}` }],
        })),
      },
    });
    await expect(
      h.control.rerunStageByVocabulary("options-job", "deliver"),
    ).rejects.toMatchObject({ code: "stage_not_rerunnable" });
    const ran = await h.control.runStageByVocabulary("options-job", "deliver");
    expect(ran.state).toBe("completed");
    expect(h.counts.get("opt-deliver")).toBe(1);
    expect(h.counts.get("opt-plan")).toBe(1);
    // Now deliver is completed: run refuses it, and a re-run
    // pinned to a wrong run refuses by run address.
    await expect(
      h.control.rerunStageByVocabulary("options-job", "deliver", { runId: "run-999" }),
    ).rejects.toMatchObject({ code: "stage_run_mismatch" });
    await expect(
      h.control.runStageByVocabulary("options-job", "deliver"),
    ).rejects.toMatchObject({ code: "stage_already_completed" });
  });

  it("refuses stage actions on a job with no run at all", async () => {
    const h = makeHarness();
    await h.control.defineJob(OPTIONS_JOB);
    await expect(
      h.control.rerunStageByVocabulary("options-job", "risk"),
    ).rejects.toMatchObject({ code: "stage_no_run" });
    await expect(h.control.runStageByVocabulary("options-job", "risk")).rejects.toMatchObject({
      code: "stage_no_run",
    });
  });

  it("stops the running options stage by vocabulary name and resumes it from its checkpoint", async () => {
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
        kind: "risk",
        steps: [{ step: "block" }, { step: "record" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.stopStageByVocabulary("blocker", "risk");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    const view = await control.getJob("blocker");
    expect(view.stages[0]?.units[0].status).toBe("stopped");
    const resumed = await control.resumeStageByVocabulary("blocker", "risk");
    const settled = await resumed.completion!;
    expect(settled.state).toBe("completed");
    expect(blockInvocations).toBe(1); // the completed step was NOT re-executed
  });

  it("cancels a not-yet-run options stage by vocabulary name: it never executes, downstream never proceeds", async () => {
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
          { kind: "plan", steps: [{ step: "block" }] },
          { kind: "chainFetch", steps: [{ step: "second" }] },
        ],
      },
    });
    const dispatch = await control.runJob("chain");
    await enteredPromise;
    await control.cancelStageByVocabulary("chain", "chainFetch");
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
    await h.control.defineJob(OPTIONS_JOB);
    let registrations = 0;
    const unscheduled: string[] = [];
    const host: JobScheduleHost = {
      schedule: async () => `reg-${++registrations}`,
      unschedule: async (id) => {
        unscheduled.push(id);
      },
    };
    const scheduled = await h.control.scheduleStageByVocabulary(
      "options-job",
      "shapeReport",
      { interval: "every 15 minutes" },
      "keep the report warm",
      host,
    );
    expect(scheduled.registrationId).toBe("reg-1");
    const view = await h.control.getJob("options-job");
    expect(view.definition.root.children?.[5].schedule).toMatchObject({
      enabled: true,
      interval: "every 15 minutes",
      registrationId: "reg-1",
      reason: "keep the report warm",
    });
    await expect(
      h.control.scheduleStageByVocabulary(
        "options-job",
        "shapeReport",
        { interval: "every hour" },
        "again",
        host,
      ),
    ).rejects.toMatchObject({ code: "stage_already_scheduled" });

    const rescheduled = await h.control.rescheduleStageByVocabulary(
      "options-job",
      "shapeReport",
      { cron: "*/30 * * * *" },
      "tighten cadence",
      host,
    );
    expect(unscheduled).toEqual(["reg-1"]);
    expect(rescheduled.registrationId).toBe("reg-2");
    const view2 = await h.control.getJob("options-job");
    expect(view2.definition.root.children?.[5].schedule).toMatchObject({
      cron: "*/30 * * * *",
      registrationId: "reg-2",
      reason: "tighten cadence",
    });

    const noCancelHost: JobScheduleHost = { schedule: async () => "reg-x" };
    await expect(
      h.control.rescheduleStageByVocabulary(
        "options-job",
        "shapeReport",
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
    await h.control.runJob("options-job");
    const reran = await h.control.rerunStage("options-job", "5");
    expect(reran.state).toBe("completed");
  });
});
