// @vitest-environment node
/**
 * Issue #3534 (Pipeline J1) — the job foundation acceptance:
 * a trivial two-step dummy job defined by CONFIGURATION ALONE is
 * scheduled, run in each execution-mode combination, paused
 * mid-run, resumed from its checkpoint, cancelled, and retried —
 * with every transition published — and no job code written.
 * Plus the substrate proofs: run records through the platform
 * machinery (system "job-pipeline"), the DO-SQLite adapters over
 * a node:sqlite double, the queue composition root's named
 * unconfigured state, and the workflow flow's step.do journal.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { DoSqliteJobPipelineStores } from "../src/data/doSqliteJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { JobRunRecordStore } from "../src/data/jobRunRecordPorts";
import {
  JobPipelineControl,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import {
  JobPipelineError,
  resolveJobDefinition,
} from "../src/services/jobPipelineConfig";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JOB_PIPELINE_QUEUE_NOT_CONFIGURED,
  createJobPipelineMessaging,
} from "../src/messaging/createJobPipelineMessaging";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";

/** node:sqlite double for the SqlStorage seam (same shape as #2964's). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: JobRunRecordStore;
  messaging: InMemoryMessagingAdapter;
  events: MessageEnvelope[];
  stepLog: Array<{
    kind: string;
    step: string;
    stepIndex: number;
    itemIndex: number | null;
    itemCount: number;
    shardKey: string | null;
    input: unknown;
  }>;
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
  const events: MessageEnvelope[] = [];
  for (const state of [
    "queued",
    "running",
    "paused",
    "checkpointed",
    "completed",
    "failed",
    "cancelled",
  ]) {
    messaging.subscribe("collector", `job.${state}`, (envelope) => {
      events.push(envelope);
      return "processed";
    });
  }
  const stepLog: Harness["stepLog"] = [];
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => {
    stepLog.push({
      kind: ctx.kind,
      step: "track",
      stepIndex: ctx.stepIndex,
      itemIndex: ctx.itemIndex,
      itemCount: ctx.items.length,
      shardKey: ctx.shardKey,
      input: ctx.input ?? null,
    });
    return {
      output: {
        tracked: true,
        kind: ctx.kind,
        item: ctx.item ?? null,
        input: ctx.input ?? null,
      },
    };
  });
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
  return {
    control: createJobPipelineControl(deps),
    stores,
    runStore,
    messaging,
    events,
    stepLog,
  };
}

const DUMMY = {
  jobId: "dummy",
  name: "Dummy two-step job",
  root: {
    kind: "dummy",
    steps: [{ step: "record", params: { n: 1 } }, { step: "record", params: { n: 2 } }],
    executionMode: { delivery: "sync" },
  },
};

describe("J1 acceptance — a job defined by configuration alone", () => {
  it("runs a two-step dummy job to completion with persisted hand-offs, published transitions, and a run record", async () => {
    const h = makeHarness();
    const definition = await h.control.defineJob(DUMMY);
    expect(definition.version).toBe(1);
    expect(definition.config.processing.inMemory).toBe(false); // persisted is the default

    const dispatch = await h.control.runJob("dummy");
    expect(dispatch.state).toBe("completed");

    const view = await h.control.getJob("dummy");
    expect(view.instance?.state).toBe("completed");
    // Persisted hand-offs: both step artifacts + the node output exist in the store.
    const keys = await h.stores.artifacts.listArtifactKeys(dispatch.runId);
    expect(keys).toContain("root/step-0");
    expect(keys).toContain("root/step-1");
    expect(keys).toContain("root/output");
    const step1 = (await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-1")) as {
      input: { params: { n: number } };
    };
    expect(step1.input.params.n).toBe(1); // step 2 consumed step 1's persisted output

    // Every transition published, in order.
    const types = h.events.map((e) => e.type);
    expect(types[0]).toBe("job.queued");
    expect(types[1]).toBe("job.running");
    expect(types).toContain("job.checkpointed");
    expect(types[types.length - 1]).toBe("job.completed");
    for (const e of h.events) {
      expect(e.specversion).toBe("1.0");
      expect(e.jobid).toBe("dummy");
    }

    // The terminal run went through the platform run-record machinery.
    expect(view.history).toHaveLength(1);
    expect(view.history[0].system).toBe("job-pipeline");
    expect(view.history[0].outcome).toBe("success");
    expect(view.history[0].operation).toBe("dummy");
    expect(view.latestRun?.descriptor).toContain("2 step executions");
  });

  it("publishes job.completed to a downstream subscriber (the pub/sub substrate J3–J6 wire onto)", async () => {
    const h = makeHarness();
    const received: MessageEnvelope[] = [];
    h.messaging.subscribe("downstream-stage", "job.completed", (envelope) => {
      received.push(envelope);
      return "processed";
    });
    await h.control.defineJob(DUMMY);
    await h.control.runJob("dummy");
    expect(received).toHaveLength(1);
    expect(received[0].jobid).toBe("dummy");
    const data = received[0].data as { artifactKeys: string[] };
    expect(data.artifactKeys).toContain("root/output");
  });

  it("runs in each execution-mode combination; the online+sync family is a named refusal", async () => {
    const concurrencies = ["sequential", "parallel"] as const;
    const pacings = ["batch", "online"] as const;
    const deliveries = ["sync", "async"] as const;
    const shapes = ["monolith", "sharded"] as const;
    let refused = 0;
    let ran = 0;
    for (const concurrency of concurrencies) {
      for (const pacing of pacings) {
        for (const delivery of deliveries) {
          for (const shape of shapes) {
            const mode = { concurrency, pacing, delivery, shape };
            const h = makeHarness();
            const raw = {
              jobId: "combo",
              root: {
                kind: "dummy",
                steps: [{ step: "track" }],
                inputs: { items: [1, 2, 3] },
                processing: { shards: ["a", "b"] },
                executionMode: mode,
              },
            };
            if (pacing === "online" && delivery === "sync") {
              await expect(h.control.defineJob(raw)).rejects.toMatchObject({
                code: "job_execution_mode_unsupported",
              });
              refused++;
              continue;
            }
            await h.control.defineJob(raw);
            const dispatch = await h.control.runJob("combo");
            const outcome = dispatch.completion
              ? await dispatch.completion
              : { state: dispatch.state };
            expect(outcome.state).toBe("completed");
            ran++;
            // Mode evidence from the step log.
            if (pacing === "online") {
              const itemIndexes = h.stepLog.map((s) => s.itemIndex);
              expect(itemIndexes).toContain(0);
              expect(itemIndexes).toContain(2);
            } else {
              expect(h.stepLog.every((s) => s.itemIndex === null)).toBe(true);
              expect(h.stepLog[0].itemCount).toBe(3);
            }
            if (shape === "sharded") {
              const shardKeys = new Set(h.stepLog.map((s) => s.shardKey));
              expect(shardKeys).toEqual(new Set(["a", "b"]));
            }
          }
        }
      }
    }
    expect(refused).toBe(4);
    expect(ran).toBe(12);
  });

  it("chains children sequentially and fans them out in parallel, per the configured mode", async () => {
    const rawFor = (concurrency: string) => ({
      jobId: "parent",
      root: {
        kind: "parent",
        steps: [{ step: "record", params: { seed: true } }],
        executionMode: { delivery: "sync", concurrency },
        children: [
          { kind: "child-a", steps: [{ step: "track" }] },
          { kind: "child-b", steps: [{ step: "track" }] },
        ],
      },
    });
    // Sequential: child-b consumes child-a's output.
    const seq = makeHarness();
    await seq.control.defineJob(rawFor("sequential"));
    await seq.control.runJob("parent");
    const seqA = seq.stepLog.find((s) => s.kind === "child-a");
    const seqB = seq.stepLog.find((s) => s.kind === "child-b");
    expect(seqA?.input).toMatchObject({ recordedBy: "record" });
    expect(seqB?.input).toMatchObject({ tracked: true, kind: "child-a" });

    // Parallel: both children receive the parent's own output.
    const par = makeHarness();
    await par.control.defineJob(rawFor("parallel"));
    await par.control.runJob("parent");
    const parA = par.stepLog.find((s) => s.kind === "child-a");
    const parB = par.stepLog.find((s) => s.kind === "child-b");
    expect(parA?.input).toMatchObject({ recordedBy: "record" });
    expect(parB?.input).toMatchObject({ recordedBy: "record" });
  });
});

describe("J1 management operations", () => {
  function blockingHarness() {
    const h = makeHarness();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const releasePromise = new Promise<void>((r) => (release = r));
    let blockInvocations = 0;
    const steps = createBuiltinStepRegistry();
    steps.register("block", async () => {
      blockInvocations++;
      entered();
      await releasePromise;
      return { output: { blocked: true } };
    });
    const control = createJobPipelineControl({
      stores: h.stores,
      runRecorder: jobRunRecorderFromStore(h.runStore),
      publisher: null,
      steps,
      now: () => new Date(Date.parse("2026-11-06T12:00:00.000Z") + blockInvocations),
      newRunId: () => "run-block",
    });
    return { h, control, enteredPromise, release: () => release(), count: () => blockInvocations };
  }

  const BLOCKING_JOB = {
    jobId: "blocker",
    root: {
      kind: "dummy",
      steps: [{ step: "block" }, { step: "record" }],
      executionMode: { delivery: "async" },
    },
  };

  it("pauses mid-run at a step boundary, checkpoints, and resumes without re-executing completed steps", async () => {
    const { control, enteredPromise, release, count } = blockingHarness();
    await control.defineJob(BLOCKING_JOB);
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.pauseJob("blocker");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("paused");

    const pausedView = await control.getJob("blocker");
    expect(pausedView.instance?.state).toBe("paused");
    expect(pausedView.instance?.checkpoint?.stepIndex).toBe(1);
    expect(pausedView.instance?.checkpoint?.runId).toBe("run-block");
    expect(pausedView.history).toHaveLength(0); // no terminal record for a live run

    const resumed = await control.resumeJob("blocker");
    const resumedOutcome = await resumed.completion!;
    expect(resumedOutcome.state).toBe("completed");
    expect(count()).toBe(1); // the completed step was NOT re-executed
    const doneView = await control.getJob("blocker");
    expect(doneView.history).toHaveLength(1);
    expect(doneView.history[0].outcome).toBe("success");
  });

  it("cancels mid-run at a step boundary and records the cancellation honestly", async () => {
    const { control, enteredPromise, release } = blockingHarness();
    await control.defineJob(BLOCKING_JOB);
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.cancelJob("blocker");
    release();
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("cancelled");
    const view = await control.getJob("blocker");
    expect(view.instance?.state).toBe("cancelled");
    expect(view.history).toHaveLength(1);
    expect(view.history[0].outcome).toBe("skipped");
    expect(view.history[0].detail).toBe("job_cancelled");
  });

  it("cancels a paused job immediately, with no engine live", async () => {
    const { control, enteredPromise, release } = blockingHarness();
    await control.defineJob(BLOCKING_JOB);
    const dispatch = await control.runJob("blocker");
    await enteredPromise;
    await control.pauseJob("blocker");
    release();
    await dispatch.completion!;
    const settled = await control.cancelJob("blocker");
    expect(settled.state).toBe("cancelled");
    const view = await control.getJob("blocker");
    expect(view.history[0].detail).toBe("job_cancelled");
  });

  it("retries a failed job as a NEW run after reconfiguration, and the history shows both attempts", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "flaky",
      root: {
        kind: "dummy",
        steps: [{ step: "fail", params: { message: "boom" } }],
        executionMode: { delivery: "sync" },
      },
    });
    const first = await h.control.runJob("flaky");
    expect(first.state).toBe("failed");
    let view = await h.control.getJob("flaky");
    expect(view.history[0].outcome).toBe("failure");
    expect(view.history[0].error).toContain("boom");

    await h.control.configureJob("flaky", {
      root: { steps: [{ step: "record" }] },
    });
    const retried = await h.control.retryJob("flaky");
    expect(retried.runId).not.toBe(first.runId);
    expect(retried.state).toBe("completed");
    view = await h.control.getJob("flaky");
    expect(view.history).toHaveLength(2);
    expect(view.history[0].outcome).toBe("success");
  });

  it("refuses invalid management operations with coded errors", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await expect(h.control.pauseJob("dummy")).rejects.toMatchObject({ code: "job_not_pausable" });
    await expect(h.control.resumeJob("dummy")).rejects.toMatchObject({ code: "job_not_resumable" });
    await expect(h.control.cancelJob("dummy")).rejects.toMatchObject({ code: "job_not_cancellable" });
    await expect(h.control.runJob("missing")).rejects.toMatchObject({ code: "job_not_found" });
    await expect(h.control.pauseJob("missing")).rejects.toMatchObject({ code: "job_not_found" });
  });

  it("fails a run honestly when its configuration names an unknown step or unconfigured shards", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "bad-step",
      root: { kind: "dummy", steps: [{ step: "does-not-exist" }], executionMode: { delivery: "sync" } },
    });
    const bad = await h.control.runJob("bad-step");
    expect(bad.state).toBe("failed");
    const badView = await h.control.getJob("bad-step");
    expect(badView.history[0].error).toContain("does-not-exist");

    await h.control.defineJob({
      jobId: "bad-shards",
      root: {
        kind: "dummy",
        steps: [{ step: "record" }],
        executionMode: { delivery: "sync", shape: "sharded" },
      },
    });
    const badShards = await h.control.runJob("bad-shards");
    expect(badShards.state).toBe("failed");
    const shardView = await h.control.getJob("bad-shards");
    expect(shardView.history[0].error).toContain("shard keys");
  });
});


describe("J1 scheduling, configuration, and processing options", () => {
  it("registers the job's own schedule and each sub-job's schedule with the schedule host", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "scheduled-job",
      root: {
        kind: "pipeline",
        schedule: { enabled: true, interval: "every 30 minutes" },
        executionMode: { delivery: "sync" },
        children: [
          {
            kind: "feed",
            steps: [{ step: "track" }],
            schedule: { enabled: true, cron: "*/15 * * * *" },
          },
          { kind: "enrich", steps: [{ step: "track" }] },
        ],
      },
    });
    const registrations: Array<Record<string, unknown>> = [];
    const host = {
      schedule: async (spec: Record<string, unknown>) => {
        registrations.push(spec);
        return `reg-${registrations.length}`;
      },
    };
    const registered = await h.control.registerSchedules(host);
    expect(registered).toHaveLength(2);
    expect(registrations[0]).toMatchObject({ jobId: "scheduled-job", nodePath: "", interval: "every 30 minutes" });
    expect(registrations[1]).toMatchObject({ jobId: "scheduled-job", nodePath: "0", cron: "*/15 * * * *" });

    // A sub-job is individually runnable on its own scope, stamped as scheduled.
    const scoped = await h.control.runJob("scheduled-job", { trigger: "scheduled", scopePath: "0" });
    expect(scoped.state).toBe("completed");
    expect(h.stepLog.map((s) => s.kind)).toEqual(["feed"]);
    const view = await h.control.getJob("scheduled-job");
    expect(view.history[0].triggeredBy).toBe("scheduled");
  });

  it("keeps hand-offs in memory ONLY when the in-memory option is explicitly configured", async () => {
    const persisted = makeHarness();
    await persisted.control.defineJob(DUMMY);
    const pDispatch = await persisted.control.runJob("dummy");
    expect(
      (await persisted.stores.artifacts.listArtifactKeys(pDispatch.runId)).length,
    ).toBeGreaterThan(0);

    const inMemory = makeHarness();
    await inMemory.control.defineJob({
      jobId: "volatile",
      root: {
        kind: "dummy",
        steps: [{ step: "record" }, { step: "record" }],
        processing: { inMemory: true },
        executionMode: { delivery: "sync" },
      },
    });
    const vDispatch = await inMemory.control.runJob("volatile");
    expect(vDispatch.state).toBe("completed");
    expect(await inMemory.stores.artifacts.listArtifactKeys(vDispatch.runId)).toEqual([]);
  });

  it("checkpoints at the configured granularity", async () => {
    const countFor = async (granularity: number) => {
      const h = makeHarness();
      await h.control.defineJob({
        jobId: "granular",
        root: {
          kind: "dummy",
          steps: [{ step: "record" }, { step: "record" }, { step: "record" }],
          processing: { checkpointEverySteps: granularity },
          executionMode: { delivery: "sync" },
        },
      });
      await h.control.runJob("granular");
      return h.events.filter((e) => e.type === "job.checkpointed").length;
    };
    expect(await countFor(1)).toBe(3);
    expect(await countFor(3)).toBe(1);
  });

  it("applies configuration changes to the next run (config is read at run start)", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "mutable",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        inputs: { items: ["x"] },
        executionMode: { delivery: "sync", pacing: "batch" },
      },
    });
    await h.control.runJob("mutable");
    expect(h.stepLog[0].itemCount).toBe(1);
    const updated = await h.control.configureJob("mutable", {
      root: { executionMode: { delivery: "async", pacing: "online" }, inputs: { items: ["x", "y"] } },
    });
    expect(updated.version).toBe(2);
    h.stepLog.length = 0;
    const dispatch = await h.control.runJob("mutable");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.stepLog.map((s) => s.itemIndex)).toEqual([0, 1]); // online now, two items
  });

  it("validates externalized configuration with coded refusals", async () => {
    const invalid: Array<[string, unknown]> = [
      ["missing jobId", { root: { kind: "dummy" } }],
      ["missing root", { jobId: "x" }],
      ["bad mode value", { jobId: "x", root: { kind: "dummy", executionMode: { pacing: "sideways" } } }],
      ["schedule without cadence", { jobId: "x", root: { kind: "dummy", schedule: { enabled: true } } }],
      ["inMemory not boolean", { jobId: "x", root: { kind: "dummy", processing: { inMemory: "yes" } } }],
      ["step without a name", { jobId: "x", root: { kind: "dummy", steps: [{ params: {} }] } }],
    ];
    for (const [label, raw] of invalid) {
      expect(() => resolveJobDefinition(raw), label).toThrowError(JobPipelineError);
      try {
        resolveJobDefinition(raw);
      } catch (error) {
        expect((error as JobPipelineError).code, label).toBe("job_config_invalid");
      }
    }
  });
});

describe("J1 substrates — DO adapters, queue composition root, workflow flow", () => {
  it("runs the dummy job end-to-end over the DO-SQLite adapters and the platform run-record store", async () => {
    const storage = new SqliteTestStorage();
    const stores = new DoSqliteJobPipelineStores(
      storage as unknown as ConstructorParameters<typeof DoSqliteJobPipelineStores>[0],
    );
    const runStore = new SqlJobRunRecordStore(
      storage as unknown as ConstructorParameters<typeof SqlJobRunRecordStore>[0],
    );
    let tick = 0;
    const base = Date.parse("2026-11-06T12:00:00.000Z");
    const control = createJobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      now: () => new Date(base + tick++ * 1000),
      newRunId: () => "run-do-1",
    });
    await control.defineJob(DUMMY);
    const dispatch = await control.runJob("dummy");
    expect(dispatch.state).toBe("completed");
    const view = await control.getJob("dummy");
    expect(view.history).toHaveLength(1);
    expect(view.history[0].system).toBe("job-pipeline");
    expect(runStore.latestByJob("dummy")?.outcome).toBe("success");
  });

  it("names the unconfigured queue state and builds ports when the binding exists", async () => {
    const unconfigured = createJobPipelineMessaging({});
    expect(unconfigured.state).toBe(JOB_PIPELINE_QUEUE_NOT_CONFIGURED);
    expect(unconfigured.ports).toBeNull();

    const malformed = createJobPipelineMessaging({ JOB_PIPELINE_EVENTS: { nope: true } });
    expect(malformed.state).toBe(JOB_PIPELINE_QUEUE_NOT_CONFIGURED);

    const configured = createJobPipelineMessaging({
      JOB_PIPELINE_EVENTS: { send: async () => {}, sendBatch: async () => {} },
    });
    expect(configured.state).toBe("configured");
    expect(configured.ports).not.toBeNull();
  });

  it("runs without a publisher when the queue substrate is unconfigured (store state stays the truth)", async () => {
    const h = makeHarness({ publisher: null });
    await h.control.defineJob(DUMMY);
    const dispatch = await h.control.runJob("dummy");
    expect(dispatch.state).toBe("completed");
    expect(h.events).toHaveLength(0);
    const view = await h.control.getJob("dummy");
    expect(view.instance?.state).toBe("completed");
  });

  it("executes the workflow flow with step.do as the engine journal", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    const journaled: string[] = [];
    const outcome = await runJobPipelineWorkflowFlow(
      {
        stores: h.stores,
        runRecorder: jobRunRecorderFromStore(h.runStore),
        publisher: null,
        steps: createBuiltinStepRegistry(),
      },
      {
        do: async (name, fn) => {
          journaled.push(name);
          return fn();
        },
      },
      { jobId: "dummy", trigger: "scheduled" },
    );
    expect(outcome.state).toBe("completed");
    expect(journaled).toHaveLength(2);
    expect(journaled[0]).toContain("job-step:");
    await expect(
      runJobPipelineWorkflowFlow(
        {
          stores: h.stores,
          runRecorder: jobRunRecorderFromStore(h.runStore),
          publisher: null,
          steps: createBuiltinStepRegistry(),
        },
        { do: async (_name, fn) => fn() },
        { jobId: "" },
      ),
    ).rejects.toMatchObject({ code: "job_config_invalid" });
  });
});
