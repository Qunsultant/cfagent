// @vitest-environment node
/**
 * Issue #4002 — Yahoo feed-runs failing with FAILURE_ASYNC_JOB_FAILED.
 *
 * Incident (2026-11-10): the #3980 production deploy restarted
 * the Orchestrator DO and orphaned two feed runs; the async-job
 * recovery (#3907) failed the rows, but the pipeline host
 * (ScheduledAgent DO) has NO onStart recovery, so the pipeline
 * instances stayed `running` — and the engine refuses re-dispatch
 * (job_already_running) and retry (job_not_retirable) while an
 * instance is `running`, and cancel of a `running` job only sets
 * desiredState: "cancel", honored at the next boundary by a live
 * engine. With no live engine, nothing settles it: the job is
 * wedged until someone intervenes.
 *
 * This file pins the fix, JobPipelineControl.settleOrphanedRuns:
 * at host start no executor can still be running — a live run
 * cannot survive its host's death — so every `running` instance
 * is settled as failed with a named orphan error (terminal run
 * record + published transition, mirroring the engine's own
 * failure path), and the job is dispatchable again. Paused,
 * queued, idle, completed, and failed instances are untouched.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { JobRunRecordStore } from "../src/data/jobRunRecordPorts";
import {
  JobPipelineControl,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import {
  createBuiltinStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";

interface Harness {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  runStore: JobRunRecordStore;
}

function makeHarness(): Harness {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => {
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
  };
  return {
    control: createJobPipelineControl(deps),
    stores,
    runStore,
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

async function orphanInstance(
  h: Harness,
  jobId: string,
  state: "running" | "paused" | "queued" | "idle" | "completed" | "failed",
): Promise<void> {
  const instance = await h.stores.instances.getInstance(jobId);
  if (!instance) throw new Error(`no instance for ${jobId}`);
  await h.stores.instances.saveInstance({
    ...instance,
    state,
    currentRunId: state === "idle" ? null : "run-orphan",
    // Before the harness clock (2026-11-06T12:00Z): the run
    // genuinely started before the host's restart, so the
    // terminal record's finished time follows its start.
    runStartedAt: state === "idle" ? null : "2026-11-06T11:00:00.000Z",
    runTrigger: "manual",
  });
}

describe("settleOrphanedRuns (#4002)", () => {
  it("a running instance settles as failed with a named orphan error, a terminal record, and the job dispatches again", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await orphanInstance(h, "dummy", "running");

    const result = await h.control.settleOrphanedRuns();
    expect(result).toEqual({ settled: ["dummy"] });

    const instance = await h.stores.instances.getInstance("dummy");
    expect(instance?.state).toBe("failed");
    expect(instance?.lastError).toContain("Orphaned by a host restart");
    expect(instance?.lastError).toContain("run-orphan");
    expect(instance?.desiredState).toBe("none");

    const records = await h.runStore.listByJob("dummy", 5);
    expect(records.some((r) => r.outcome === "failure")).toBe(true);

    // The wedge is gone: the job dispatches again and completes.
    const dispatch = await h.control.runJob("dummy");
    expect(dispatch.state).toBe("completed");
  });

  it("idle, completed, and failed instances are untouched", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await orphanInstance(h, "dummy", "idle");

    const result = await h.control.settleOrphanedRuns();
    expect(result).toEqual({ settled: [] });
    expect((await h.stores.instances.getInstance("dummy"))?.state).toBe("idle");

    // A completed run, then a failed run, both stay as they are.
    await h.control.runJob("dummy");
    expect((await h.stores.instances.getInstance("dummy"))?.state).toBe("completed");
    expect(await h.control.settleOrphanedRuns()).toEqual({ settled: [] });
    expect((await h.stores.instances.getInstance("dummy"))?.state).toBe("completed");
  });

  it("a paused instance is untouched — retry still works", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await orphanInstance(h, "dummy", "paused");

    const result = await h.control.settleOrphanedRuns();
    expect(result).toEqual({ settled: [] });
    expect((await h.stores.instances.getInstance("dummy"))?.state).toBe("paused");

    // A checkpoint-less paused run cannot resume (the engine
    // refuses it: "retry it instead") — but it is still usable
    // via retry, which the settle preserved.
    const retried = await h.control.retryJob("dummy");
    expect(retried.state).toBe("completed");
  });

  it("a queued instance is untouched", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await orphanInstance(h, "dummy", "queued");

    const result = await h.control.settleOrphanedRuns();
    expect(result).toEqual({ settled: [] });
    expect((await h.stores.instances.getInstance("dummy"))?.state).toBe("queued");
  });

  it("settling is idempotent: a second pass settles nothing", async () => {
    const h = makeHarness();
    await h.control.defineJob(DUMMY);
    await orphanInstance(h, "dummy", "running");

    await h.control.settleOrphanedRuns();
    const second = await h.control.settleOrphanedRuns();
    expect(second).toEqual({ settled: [] });
  });
});
