// @vitest-environment node
/**
 * Issue #3549 (Pipeline J1, absorbing #3069) — the stage-runner
 * re-basing and the uniform stage control, evidenced:
 *  - job stages plan on the stage-runner contract (validation,
 *    the single-family rule, plan decisions over stopped /
 *    cancelled units);
 *  - a job runs end-to-end with the runner executing its
 *    stages: per-stage states surface in the status view and
 *    stage events carry the #2869 claim key;
 *  - the seven operations at (runId, stageId): run / re-run /
 *    stop / resume / cancel / schedule / re-schedule, with
 *    #3069's pinned meanings and fail-closed refusals;
 *  - unit failures retry within the stage's pipelinePolicy
 *    budget; poison (coded configuration errors) never does.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineControl,
  type JobPipelineDeps,
  type JobScheduleHost,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { resolvePipelinePolicy } from "../src/services/pipelinePolicy";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";
import {
  assertStageRunnerPlan,
  jobStageId,
  jobStageNodePath,
  type StageRunnerPlan,
} from "../src/workflows/stageRunnerPorts";
import { planNext, planRun, resumeUnits } from "../src/workflows/stageRunnerPlan";

describe("job stages on the stage-runner contract", () => {
  const jobPlan = (): StageRunnerPlan =>
    planRun({
      runId: "run-1",
      invocation: "sync",
      stages: [
        { stage: jobStageId(""), execution: "sequential", timeoutMs: 1000, pacing: "batch" },
        { stage: jobStageId("0"), execution: "parallel", timeoutMs: 1000 },
      ],
      units: [],
    });

  it("round-trips stage ids and validates a job-stage plan", () => {
    expect(jobStageNodePath(jobStageId(""))).toBe("");
    expect(jobStageNodePath(jobStageId("0/2"))).toBe("0/2");
    expect(jobPlan().stages.map((s) => s.stage)).toEqual(["job:root", "job:0"]);
  });

  it("refuses mixed-family plans and malformed job stage ids, and keeps vocabulary rules", () => {
    expect(() =>
      assertStageRunnerPlan({
        runId: "r",
        invocation: "sync",
        screenMode: "deterministic",
        units: [],
        stages: [
          { stage: "feed", execution: "sequential", timeoutMs: 1 },
          { stage: jobStageId("0"), execution: "sequential", timeoutMs: 1 },
        ],
      }),
    ).toThrow(/mixes stage families/);
    expect(() =>
      planRun({
        runId: "r",
        invocation: "sync",
        stages: [{ stage: "job:not-a-path" as never, execution: "sequential", timeoutMs: 1 }],
        units: [],
      }),
    ).toThrow(/does not name a node path/);
    expect(() =>
      planRun({
        runId: "r",
        invocation: "sync",
        stages: [
          { stage: "store", execution: "sequential", timeoutMs: 1 },
          { stage: "feed", execution: "sequential", timeoutMs: 1 },
        ],
        units: [],
      }),
    ).toThrow(/out of order/);
  });

  it("plan decisions: cancelled is terminal, stopped resumes, completed never re-runs", () => {
    const plan = jobPlan();
    const checkpoint = {
      runId: "run-1",
      units: [
        { stage: jobStageId(""), unitId: "run-1", status: "cancelled" as const, attempt: 1 },
        { stage: jobStageId("0"), unitId: "run-1", status: "stopped" as const, attempt: 1 },
      ],
    };
    // planNext skips the cancelled stage entirely and offers the stopped one.
    expect(planNext(plan, checkpoint)?.stage.stage).toBe(jobStageId("0"));
    const resume = resumeUnits(plan, checkpoint);
    expect(resume.map((r) => r.stage.stage)).toEqual([jobStageId("0")]);
    const done = {
      runId: "run-1",
      units: [
        { stage: jobStageId(""), unitId: "run-1", status: "completed" as const, attempt: 1 },
        { stage: jobStageId("0"), unitId: "run-1", status: "completed" as const, attempt: 2 },
      ],
    };
    expect(planNext(plan, done)).toBeNull();
    expect(resumeUnits(plan, done)).toEqual([]);
  });
});

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

const TWO_CHILD_JOB = {
  jobId: "two-child",
  root: {
    kind: "pipeline",
    steps: [{ step: "stepA" }],
    executionMode: { delivery: "sync" },
    children: [
      { kind: "feed", steps: [{ step: "stepB" }] },
      { kind: "enrich", steps: [{ step: "stepC" }] },
    ],
  },
};

describe("the runner executing a job's stages", () => {
  it("surfaces per-stage states and publishes stage events carrying the claim key", async () => {
    const h = makeHarness();
    await h.control.defineJob(TWO_CHILD_JOB);
    const outcome = await h.control.runJob("two-child");
    expect(outcome.state).toBe("completed");
    const view = await h.control.getJob("two-child");
    expect(view.stages.map((s) => s.stageId)).toEqual(["job:root", "job:0", "job:1"]);
    expect(view.stages.every((s) => s.units.every((u) => u.status === "completed"))).toBe(true);
    const completed = h.stageEvents.find(
      (e) => e.type === "job.stage.completed" && e.data?.stageId === "job:root",
    );
    expect(completed?.data?.idempotencyKey).toBe("run-1::jobs::job:root");
  });

  it("re-runs one completed stage from its persisted input, leaving the others' effects untouched", async () => {
    const h = makeHarness();
    await h.control.defineJob(TWO_CHILD_JOB);
    await h.control.runJob("two-child");
    expect(h.counts.get("stepB")).toBe(1);
    const result = await h.control.rerunStage("two-child", "0");
    expect(result.state).toBe("completed");
    expect(h.counts.get("stepB")).toBe(2);
    expect(h.counts.get("stepC")).toBe(1);
    // The re-run consumed the parent stage's persisted hand-off.
    expect(h.inputs.get("stepB")?.[1]).toEqual({ from: "stepA", input: null });
    const view = await h.control.getJob("two-child");
    const stage0 = view.stages.find((s) => s.stageId === "job:0");
    expect(stage0?.units[0].attempt).toBe(2);
    expect(stage0?.units[0].status).toBe("completed");
    expect(h.stageEvents.some((e) => e.type === "job.stage.rerun")).toBe(true);
  });

  it("refuses, fail-closed: re-run of a never-run stage, run of a completed stage, a wrong run address", async () => {
    const h = makeHarness();
    await h.control.defineJob(TWO_CHILD_JOB);
    await h.control.runJob("two-child");
    await expect(h.control.rerunStage("two-child", "1", { runId: "run-999" })).rejects.toMatchObject({
      code: "stage_run_mismatch",
    });
    await expect(h.control.runStage("two-child", "0")).rejects.toMatchObject({
      code: "stage_already_completed",
    });
    // A stage that has not run: configure a third child in, then
    // re-run must refuse (run is the operation) and run must work.
    await h.control.configureJob("two-child", {
      root: {
        children: [
          { kind: "feed", steps: [{ step: "stepB" }] },
          { kind: "enrich", steps: [{ step: "stepC" }] },
          { kind: "deliver", steps: [{ step: "stepB" }] },
        ],
      },
    });
    await expect(h.control.rerunStage("two-child", "2")).rejects.toMatchObject({
      code: "stage_not_rerunnable",
    });
    const ran = await h.control.runStage("two-child", "2");
    expect(ran.state).toBe("completed");
    const view = await h.control.getJob("two-child");
    expect(view.stages.find((s) => s.stageId === "job:2")?.units[0].status).toBe("completed");
  });

  it("retries a unit's processing failure within its budget; poison never retries", async () => {
    const policy = resolvePipelinePolicy();
    policy.retry.report = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };
    let flakyCalls = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("flaky", async () => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new Error("transient boom");
      return { output: { ok: true } };
    });
    const control = createJobPipelineControl({
      stores: createInMemoryJobPipelineStores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps,
      policy,
      newRunId: () => "run-flaky",
    });
    await control.defineJob({
      jobId: "flaky-job",
      root: { kind: "dummy", steps: [{ step: "flaky" }], executionMode: { delivery: "sync" } },
    });
    const outcome = await control.runJob("flaky-job");
    expect(outcome.state).toBe("completed");
    expect(flakyCalls).toBe(2);
    const view = await control.getJob("flaky-job");
    expect(view.stages[0]?.units[0]).toMatchObject({ status: "completed", attempt: 2 });

    await control.defineJob({
      jobId: "poison-job",
      root: { kind: "dummy", steps: [{ step: "does-not-exist" }], executionMode: { delivery: "sync" } },
    });
    const poisoned = await control.runJob("poison-job");
    expect(poisoned.state).toBe("failed");
    const poisonView = await control.getJob("poison-job");
    expect(poisonView.stages[0]?.units[0]).toMatchObject({ status: "failed", attempt: 1 });
  });
});

describe("stop / resume / cancel at stage granularity", () => {
  function blockingHarness() {
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
    return {
      control,
      enteredPromise,
      release: () => release(),
      count: () => blockInvocations,
    };
  }

  it("stops the running stage (recorded stopped, never failed) and resumes it from its checkpoint", async () => {
    const { control, enteredPromise, release, count } = blockingHarness();
    await control.defineJob({
      jobId: "blocker",
      root: {
        kind: "dummy",
        steps: [{ step: "block" }, { step: "record" }],
        executionMode: { delivery: "async" },
      },
    });
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.stopStage("blocker", "");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");
    const view = await control.getJob("blocker");
    expect(view.stages[0]?.units[0].status).toBe("stopped");
    const resumed = await control.resumeStage("blocker", "");
    const settled = await resumed.completion!;
    expect(settled.state).toBe("completed");
    expect(count()).toBe(1); // the completed step was NOT re-executed
  });

  it("cancels a not-yet-run stage of a live run: it never executes, downstream never proceeds, the run settles cancelled", async () => {
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
    await control.cancelStage("chain", "1");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    expect(secondCalls).toBe(0);
    const view = await control.getJob("chain");
    expect(view.stages.find((s) => s.stageId === "job:1")?.units[0].status).toBe("cancelled");
    expect(view.stages.find((s) => s.stageId === "job:0")?.units[0].status).toBe("completed");
    expect(view.history[0].detail).toBe("job_cancelled");
  });
});

describe("schedule / re-schedule at stage granularity", () => {
  it("records identity + reason at creation; re-schedule swaps atomically; a host without unschedule refuses", async () => {
    const h = makeHarness();
    await h.control.defineJob(TWO_CHILD_JOB);
    const unscheduled: string[] = [];
    let registrations = 0;
    const host: JobScheduleHost = {
      schedule: async () => `reg-${++registrations}`,
      unschedule: async (id) => {
        unscheduled.push(id);
      },
    };
    const scheduled = await h.control.scheduleStage(
      "two-child",
      "0",
      { interval: "every 15 minutes" },
      "keep the feed warm",
      host,
    );
    expect(scheduled.registrationId).toBe("reg-1");
    const view = await h.control.getJob("two-child");
    expect(view.definition.root.children?.[0].schedule).toMatchObject({
      enabled: true,
      interval: "every 15 minutes",
      registrationId: "reg-1",
      reason: "keep the feed warm",
    });
    await expect(
      h.control.scheduleStage("two-child", "0", { interval: "every hour" }, "again", host),
    ).rejects.toMatchObject({ code: "stage_already_scheduled" });

    const rescheduled = await h.control.rescheduleStage(
      "two-child",
      "0",
      { cron: "*/30 * * * *" },
      "tighten cadence",
      host,
    );
    expect(unscheduled).toEqual(["reg-1"]);
    expect(rescheduled.registrationId).toBe("reg-2");
    const view2 = await h.control.getJob("two-child");
    expect(view2.definition.root.children?.[0].schedule).toMatchObject({
      cron: "*/30 * * * *",
      registrationId: "reg-2",
      reason: "tighten cadence",
    });

    const noCancelHost: JobScheduleHost = { schedule: async () => "reg-x" };
    await expect(
      h.control.rescheduleStage("two-child", "0", { interval: "every hour" }, "nope", noCancelHost),
    ).rejects.toMatchObject({ code: "stage_reschedule_unsupported" });
    expect(
      h.stageEvents.some(
        (e) => e.type === "job.stage.schedule" && e.data?.detail === "reg-1",
      ),
    ).toBe(true);
    expect(h.stageEvents.some((e) => e.type === "job.stage.reschedule")).toBe(true);
  });
});
