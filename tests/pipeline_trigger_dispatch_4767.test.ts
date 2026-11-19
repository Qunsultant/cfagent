// @vitest-environment node
/**
 * Issue #4767 — split the pipeline run trigger into scheduled /
 * triggered / manual (five dispatch modes on main: scheduled /
 * manual / triggered / copilot / autopilot — Venus ruling #5028).
 *
 * TDD pins for the dispatch-site wiring (the type/ledger widening
 * is already on main, pinned by tests/dispatch-modes-5028.test.ts
 * and tests/dispatch-triggered-5052.test.ts):
 *  - the runJob boundary is fail-closed: an unknown or missing
 *    trigger records "manual", never an invented value;
 *  - a Run-now (door / retry) records "triggered" UNCONDITIONALLY
 *    (Q4 ruling 2026-11-18: a re-run is a triggered dispatch, full
 *    stop — the schedule-enabled check the build first shipped
 *    was wrong and is removed);
 *  - resume / replay inherit the original run's trigger;
 *  - the step context carries the run's trigger into the steps, so
 *    the feed pull step records the run's trigger instead of its
 *    hardcoded "manual";
 *  - the feed runners accept all five modes and normalize an
 *    unknown trigger to "manual";
 *  - old stored "manual" rows keep their meaning.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_RUN_TRIGGERS,
  normalizeJobRunTrigger,
} from "../src/data/jobRunRecordPorts";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  resolveRunNowTrigger,
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
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => {
    seenTriggers.push((ctx as JobStepContext).trigger);
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

const SCHEDULED_TRACK_JOB = {
  ...TRACK_JOB,
  jobId: "scheduled-track-job",
  root: {
    ...TRACK_JOB.root,
    schedule: { enabled: true, interval: "every 60 minutes" },
  },
};

async function latestRun(
  runStore: InMemoryJobRunRecordStore,
  jobId: string,
) {
  return runStore.listByJob(jobId, 1)[0];
}

describe("pipeline run trigger dispatch (#4767)", () => {
  it("pins the trigger type to exactly the five dispatch modes", () => {
    expect([...JOB_RUN_TRIGGERS]).toEqual([
      "scheduled",
      "manual",
      "triggered",
      "copilot",
      "autopilot",
    ]);
  });

  it("runJob with no trigger records manual on the instance and the run record", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    const dispatch = await h.control.runJob("track-job");
    expect(dispatch.state).toBe("completed");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runTrigger).toBe("manual");
    expect((await latestRun(h.runStore, "track-job"))?.triggeredBy).toBe(
      "manual",
    );
  });

  it("runJob with an unknown trigger records manual, never the unknown value", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    const dispatch = await h.control.runJob("track-job", {
      trigger: "bogus" as never,
    });
    expect(dispatch.state).toBe("completed");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runTrigger).toBe("manual");
    expect((await latestRun(h.runStore, "track-job"))?.triggeredBy).toBe(
      "manual",
    );
  });

  it("runJob passes triggered, copilot and autopilot through to the run record", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    for (const trigger of ["triggered", "copilot", "autopilot"] as const) {
      await h.control.runJob("track-job", { trigger });
      const job = await h.control.getJob("track-job");
      expect(job.instance?.runTrigger).toBe(trigger);
      expect((await latestRun(h.runStore, "track-job"))?.triggeredBy).toBe(
        trigger,
      );
    }
  });

  it("retryJob on a scheduled job records triggered", async () => {
    const h = makeHarness();
    await h.control.defineJob(SCHEDULED_TRACK_JOB);
    await h.control.runJob("scheduled-track-job", { trigger: "scheduled" });
    const retried = await h.control.retryJob("scheduled-track-job");
    expect(retried.state).toBe("completed");
    const job = await h.control.getJob("scheduled-track-job");
    expect(job.instance?.runTrigger).toBe("triggered");
    expect(
      (await latestRun(h.runStore, "scheduled-track-job"))?.triggeredBy,
    ).toBe("triggered");
  });

  // ADAPTED 2026-11-18 (Q4 ruling): the build asserted a re-run
  // of an unscheduled job records "manual"; the user ruled a
  // re-run records "triggered" unconditionally — the
  // schedule-enabled check in resolveRunNowTrigger was wrong.
  it("retryJob on an unscheduled job records triggered", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "manual" });
    await h.control.retryJob("track-job");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runTrigger).toBe("triggered");
    expect((await latestRun(h.runStore, "track-job"))?.triggeredBy).toBe(
      "triggered",
    );
  });

  it("resumeJob inherits the original run's trigger", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "triggered" });
    // Seed a paused instance carrying the original run's trigger,
    // as a pause mid-run would leave it.
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    await h.stores.instances.saveInstance({
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
    });
    const resumed = await h.control.resumeJob("track-job");
    expect(resumed.state).toBe("completed");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runTrigger).toBe("triggered");
  });

  it("resumeJob on a legacy instance with no trigger records manual", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "manual" });
    const instance = await h.stores.instances.getInstance("track-job");
    if (!instance) throw new Error("track-job instance missing");
    await h.stores.instances.saveInstance({
      ...instance,
      state: "paused",
      desiredState: "none",
      currentRunId: "run-legacy",
      runStartedAt: "2026-11-06T12:00:00.000Z",
      runTrigger: null,
      checkpoint: {
        runId: "run-legacy",
        nodePath: "",
        scopePath: "",
        stepIndex: 0,
        itemIndex: 0,
        shardIndex: 0,
        childIndex: 0,
        artifactKeys: [],
        updatedAt: "2026-11-06T12:00:00.000Z",
      },
      stageCheckpoint: { runId: "run-legacy", units: [] },
    });
    await h.control.resumeJob("track-job");
    const job = await h.control.getJob("track-job");
    expect(job.instance?.runTrigger).toBe("manual");
  });

  it("the step context carries the run's trigger into the steps", async () => {
    const h = makeHarness();
    await h.control.defineJob(TRACK_JOB);
    await h.control.runJob("track-job", { trigger: "triggered" });
    expect(h.seenTriggers).toEqual(["triggered"]);
  });

  // ADAPTED 2026-11-18 (Q4 ruling): the build asserted an
  // unscheduled job resolves to "manual"; the user ruled a
  // Run-now records "triggered" regardless of schedule.
  it("resolveRunNowTrigger maps a scheduled job to triggered and an unscheduled job to triggered", async () => {
    const h = makeHarness();
    const scheduled = await h.control.defineJob(SCHEDULED_TRACK_JOB);
    expect(resolveRunNowTrigger(scheduled)).toBe("triggered");
    const unscheduled = await h.control.defineJob(TRACK_JOB);
    expect(resolveRunNowTrigger(unscheduled)).toBe("triggered");
  });

  it("an old stored manual row keeps its meaning", () => {
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: "track-job",
      operation: "test.op",
      started: "2026-11-06T12:00:00.000Z",
      finished: "2026-11-06T12:00:01.000Z",
      outcome: "success",
      triggeredBy: "manual",
    });
    expect(record.triggeredBy).toBe("manual");
    expect(record.trigger).toBe("manual");
    expect(normalizeJobRunTrigger("manual")).toBe("manual");
    expect(normalizeJobRunTrigger("bogus")).toBe("manual");
    expect(normalizeJobRunTrigger(undefined)).toBe("manual");
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

describe("feed pull step trigger (#4767)", () => {
  it("the feed pull step records the run's trigger instead of hardcoded manual", async () => {
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
      runId: "run-feed-triggered",
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
    } as JobStepContext;
    await handler(ctx);
    const runs = await datasetStore.listRuns(
      "yahoo",
      "quotes",
      5,
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].run.trigger).toBe("triggered");
  });

  it("a feed runner normalizes an unknown trigger to manual", async () => {
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
    const result = await runFeedJob(
      registry,
      { datasetStore, universeStore, provider },
      "yahoo-nasdaq100-quotes",
      { trigger: "bogus" as never, runId: "run-feed-bogus" },
    );
    expect(result.status).not.toBe("failed");
    const runs = await datasetStore.listRuns("yahoo", "quotes", 5);
    expect(runs[0].run.trigger).toBe("manual");
  });
});
