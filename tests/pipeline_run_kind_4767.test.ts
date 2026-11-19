// @vitest-environment node
/**
 * Issue #4767 — the run-kind dimension (user ruling 2026-11-18):
 * kind and trigger are TWO dimensions. The trigger says what
 * dispatched THIS execution (scheduled / manual / triggered /
 * copilot / autopilot); the kind says what this execution IS
 * relative to the original (original / re-run / resume / replay).
 * A re-run can be manual, scheduled, triggered, copilot, or
 * autopilot — the kind never constrains the trigger.
 *
 * TDD pins:
 *  - runJob records kind "original" with no origin link;
 *  - retryJob records kind "re-run" + the origin run id it
 *    retried + trigger "triggered" (unconditional, Q4);
 *  - resumeJob / replayJob reuse the run id and record kind
 *    "resume" / "replay" with the run itself as origin;
 *  - an unknown or missing kind normalizes fail-closed to
 *    "original" — a run never claims lineage it cannot name;
 *  - the stage checkpoint carries trigger + kind, and the
 *    resume path refuses a checkpoint whose trigger does not
 *    match the run's trigger (a consistency guard);
 *  - the step context carries the run's kind into the steps,
 *    and the feed pull step records it on the dataset run.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_RUN_KINDS,
  normalizeJobRunKind,
  type JobRunKind,
} from "../src/data/jobRunRecordPorts";
import {
  buildJobRunRecord,
  normalizeJobRunRecord,
} from "../src/services/jobRunRecords";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
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
import {
  buildFeedJobRegistry,
  runFeedJob,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  FEED_PULL_STEP,
} from "../src/services/feedPipelineJobs";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

function makeHarness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const seenTriggers: Array<string | undefined> = [];
  const seenKinds: Array<string | undefined> = [];
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => {
    seenTriggers.push((ctx as JobStepContext).trigger);
    seenKinds.push((ctx as JobStepContext).runKind);
    return { output: { tracked: true } };
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
    seenTriggers,
    seenKinds,
  };
}

const TRACK_JOB = {
  jobId: "track-job",
  name: "Track job",
  root: {
    kind: "track",
    steps: [{ step: "track", params: {} }],
    executionMode: { delivery: "sync" },
  },
};

async function latestRun(
  runStore: InMemoryJobRunRecordStore,
  jobId: string,
) {
  return runStore.listByJob(jobId, 1)[0];
}

function pausedInstance(instance: NonNullable<Awaited<ReturnType<ReturnType<typeof makeHarness>["stores"]["instances"]["getInstance"]>>>, overrides: Record<string, unknown> = {}) {
  return {
    ...instance,
    state: "paused",
    desiredState: "none",
    currentRunId: "run-paused",
    runStartedAt: "2026-11-06T12:00:00.000Z",
    runTrigger: "triggered",
    checkpoint: {
      runId: "run-paused",
      nodePath: "",
      scopePath: "",
      stepIndex: 0,
      itemIndex: 0,
      shardIndex: 0,
      childIndex: 0,
      artifactKeys: [],
      updatedAt: "2026-11-06T12:00:00.000Z",
    },
    stageCheckpoint: { runId: "run-paused", units: [] },
    ...overrides,
  };
}

describe("pipeline run kind (#4767)", () => {
  it("pins the run-kind type to exactly original / re-run / resume / replay", () => {
    expect([...JOB_RUN_KINDS]).toEqual([
      "original",
      "re-run",
      "resume",
      "replay",
    ]);
  });

  it("normalizeJobRunKind is fail-closed: unknown or missing reads as original, never an invented kind", () => {
    expect(normalizeJobRunKind("original")).toBe("original");
    expect(normalizeJobRunKind("re-run")).toBe("re-run");
    expect(normalizeJobRunKind("resume")).toBe("resume");
    expect(normalizeJobRunKind("replay")).toBe("replay");
    expect(normalizeJobRunKind("bogus")).toBe("original");
    expect(normalizeJobRunKind(undefined)).toBe("original");
    expect(normalizeJobRunKind(null)).toBe("original");
  });

  it("runJob records kind original with no origin on the instance and the run record", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "scheduled" });
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runKind).toBe("original");
    expect(job.instance?.runOriginId).toBeNull();
    const record = await latestRun(h.runStore, "track-job");
    expect(record?.kind).toBe("original");
    expect(record?.originRunId).toBeNull();
    expect(record?.triggeredBy).toBe("scheduled");
    expect(h.seenKinds).toEqual(["original"]);
  });

  it("retryJob records kind re-run + the origin run id + trigger triggered, unconditionally", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    const first = await h.control.runJob("track-job", { trigger: "manual" });
    await h.control.retryJob("track-job");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.currentRunId).not.toBe(first.runId);
    expect(job.instance?.runKind).toBe("re-run");
    expect(job.instance?.runOriginId).toBe(first.runId);
    const record = await latestRun(h.runStore, "track-job");
    expect(record?.kind).toBe("re-run");
    expect(record?.originRunId).toBe(first.runId);
    expect(record?.triggeredBy).toBe("triggered");
    expect(h.seenKinds).toEqual(["original", "re-run"]);
  });

  it("resumeJob records kind resume on the same run id, with the run itself as origin", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "triggered" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    await h.stores.instances.saveInstance(
      pausedInstance(instance) as never,
    );
    const resumed = await h.control.resumeJob("track-job");
    expect(resumed.runId).toBe("run-paused");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.currentRunId).toBe("run-paused");
    expect(job.instance?.runKind).toBe("resume");
    expect(job.instance?.runOriginId).toBe("run-paused");
    // The resume's terminal record is found by RUN id, not by
    // "latest by started": a resumed run keeps the original
    // run's start time, so latest-by-started surfaces the
    // original dispatch's record. The terminal record's
    // workflowId is the run id (recordTerminal stamps it).
    const record = h.runStore
      .listByJob("track-job", 10)
      .find((r) => r.workflowId === "run-paused");
    expect(record?.kind).toBe("resume");
    expect(record?.originRunId).toBe("run-paused");
    expect(record?.triggeredBy).toBe("triggered");
    expect(h.seenKinds).toEqual(["original", "resume"]);
  });

  it("replayJob records kind replay on the same run id, with the run itself as origin", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "scheduled" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    // A still-running run under one workflow executor (the
    // eviction re-entry #4454 guards on): same run id, same
    // workflow instance id, no checkpoint yet.
    await h.stores.instances.saveInstance({
      ...instance,
      state: "running",
      desiredState: "none",
      currentRunId: "run-live",
      runStartedAt: "2026-11-06T12:00:00.000Z",
      runTrigger: "scheduled",
      runWorkflowInstanceId: "wf-1",
      checkpoint: null,
      stageCheckpoint: null,
    } as never);
    const replayed = await h.control.replayJob("track-job", {
      workflowInstanceId: "wf-1",
    });
    expect(replayed.runId).toBe("run-live");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.currentRunId).toBe("run-live");
    expect(job.instance?.runKind).toBe("replay");
    expect(job.instance?.runOriginId).toBe("run-live");
    // As for a resume: the replay's terminal record is found by
    // RUN id (workflowId), not by latest-by-started — the replay
    // keeps the original run's start time.
    const record = h.runStore
      .listByJob("track-job", 10)
      .find((r) => r.workflowId === "run-live");
    expect(record?.kind).toBe("replay");
    expect(record?.originRunId).toBe("run-live");
    expect(record?.triggeredBy).toBe("scheduled");
  });

  it("a legacy run record with no kind normalizes to original with no origin", () => {
    const record = normalizeJobRunRecord({
      system: "job-pipeline",
      jobId: "track-job",
      operation: "test.op",
      started: "2026-11-06T12:00:00.000Z",
      finished: "2026-11-06T12:00:01.000Z",
      outcome: "success",
      triggeredBy: "manual",
    } as never);
    expect(record.kind).toBe("original");
    expect(record.originRunId).toBeNull();
  });

  it("buildJobRunRecord defaults kind original and drops an invalid origin run id", () => {
    const base = {
      system: "job-pipeline",
      jobId: "track-job",
      operation: "test.op",
      started: "2026-11-06T12:00:00.000Z",
      finished: "2026-11-06T12:00:01.000Z",
      outcome: "success",
      triggeredBy: "manual",
    } as const;
    const kept = buildJobRunRecord({
      ...base,
      kind: "re-run" as JobRunKind,
      originRunId: "run-old",
    });
    expect(kept.kind).toBe("re-run");
    expect(kept.originRunId).toBe("run-old");
    // The S1 honesty gate: an empty origin id is a programming
    // error, like an empty schedule id — it throws, it is never
    // silently dropped to null.
    expect(() => buildJobRunRecord({ ...base, originRunId: "" })).toThrow(
      /originRunId/,
    );
    expect(() =>
      buildJobRunRecord({ ...base, originRunId: "undefined" }),
    ).toThrow(/originRunId/);
  });

  it("the stage checkpoint stamps the run's trigger and kind at dispatch", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "copilot" });
    const job = await h.control.getJob("track-job");
    expect(job.instance?.stageCheckpoint?.trigger).toBe("copilot");
    expect(job.instance?.stageCheckpoint?.kind).toBe("original");
    const stages = await h.control.getJobStages("track-job");
    expect(stages.checkpointKind).toBe("original");
  });

  it("the resume path refuses a checkpoint whose trigger does not match the run's trigger", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "triggered" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    // A checkpoint stamped by a different execution than the
    // run it claims to belong to: resume must refuse, never
    // silently restamp it under the wrong trigger.
    await h.stores.instances.saveInstance(
      pausedInstance(instance, {
        stageCheckpoint: {
          runId: "run-paused",
          trigger: "scheduled",
          kind: "original",
          units: [],
        },
      }) as never,
    );
    await expect(h.control.resumeJob("track-job")).rejects.toThrow(
      /checkpoint.*trigger/i,
    );
  });

  it("a legacy checkpoint with no trigger resumes and restamps the run's trigger and kind", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "triggered" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    await h.stores.instances.saveInstance(
      pausedInstance(instance) as never,
    );
    const resumed = await h.control.resumeJob("track-job");
    expect(resumed.state).toBe("completed");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.stageCheckpoint?.trigger).toBe("triggered");
    expect(job.instance?.stageCheckpoint?.kind).toBe("resume");
    expect(job.instance?.runKind).toBe("resume");
  });

  it("getJobStages falls back to the instance kind when the checkpoint predates the kind field", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "manual" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    await h.stores.instances.saveInstance({
      ...instance,
      stageCheckpoint: { runId: "run-1", units: [] },
    } as never);
    const stages = await h.control.getJobStages("track-job");
    expect(stages.checkpointKind).toBe("original");
    expect(stages.checkpointRunId).toBe("run-1");
  });
});

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function quote(symbol: string): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price: 100,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

describe("feed leg run kind (#4767)", () => {
  it("a feed runner records the run kind on the dataset run and normalizes an unknown kind to original", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const universeStore = new InMemoryIndexListStore();
    await universeStore.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: ["AAPL"].map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
    const provider: DataProvider = {
      id: "yahoo",
      name: "Yahoo Finance",
      capabilities: ["quotes", "historicalBars", "fundamentals"],
      isConfigured: () => true,
      getQuotesBatch: async (symbols: string[]) => ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((symbol) => ({
          symbol,
          ...quote(symbol),
        })) as QuoteResult[],
      }) as DataResult<QuoteResult[]>,
    };
    const rerun = await runFeedJob(
      registry,
      { datasetStore, universeStore, provider },
      "yahoo-nasdaq100-quotes",
      { trigger: "triggered", kind: "re-run", runId: "run-feed-rerun" },
    );
    expect(rerun.status).not.toBe("failed");
    let runs = await datasetStore.listRuns("yahoo", "quotes", 5);
    expect(runs[0].run.kind).toBe("re-run");
    const bogus = await runFeedJob(
      registry,
      { datasetStore, universeStore, provider },
      "yahoo-nasdaq100-quotes",
      { trigger: "manual", kind: "bogus" as never, runId: "run-feed-bogus" },
    );
    expect(bogus.status).not.toBe("failed");
    runs = await datasetStore.listRuns("yahoo", "quotes", 5);
    expect(runs[0].run.kind).toBe("original");
  });

  it("the feed pull step records the step context's run kind on the dataset run", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const universeStore = new InMemoryIndexListStore();
    await universeStore.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: ["AAPL", "MSFT", "NVDA"].map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
    const provider: DataProvider = {
      id: "yahoo",
      name: "Yahoo Finance",
      capabilities: ["quotes", "historicalBars", "fundamentals"],
      isConfigured: () => true,
      getQuotesBatch: async (symbols: string[]) => ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((symbol) => ({
          symbol,
          ...quote(symbol),
        })) as QuoteResult[],
      }) as DataResult<QuoteResult[]>,
    };
    const steps = createFeedStepRegistry({
      registry,
      providerFor: () => provider,
      universeStore,
      datasetStore,
    });
    const handler = steps.resolve(FEED_PULL_STEP);
    if (!handler) throw new Error("feed.pull step missing");
    const ctx = {
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-feed-rerun",
      nodePath: "",
      kind: "feed",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { feedJobId: "yahoo-nasdaq100-quotes" },
      input: null,
      now: iso(T0),
      trigger: "triggered",
      runKind: "re-run",
    } as JobStepContext;
    await handler(ctx);
    const runs = await datasetStore.listRuns("yahoo", "quotes", 5);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].run.trigger).toBe("triggered");
    expect(runs[0].run.kind).toBe("re-run");
  });
});
