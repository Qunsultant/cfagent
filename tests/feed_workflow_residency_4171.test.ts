// @vitest-environment node
/**
 * Issue #4171 — workflow-residency activation for feed runs.
 *
 * Pins:
 * - the externalized residency switch defaults to workflow and
 *   refuses the retired host residency by name;
 * - the workflow deps carry the feed run-settled observer;
 * - the ScheduledAgent feed dispatch starts JobPipelineWorkflow
 *   and awaits its outcome (never host execution);
 * - host and workflow residencies produce parity records;
 * - host orphan settlement does not settle workflow-resident runs;
 * - the workflow binding concurrency is sized for simultaneous
 *   multi-user invocations.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { JobOutcomeInput } from "../src/data/jobOutcomePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  buildFeedJobSurfaceView,
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  resolveFeedJob,
} from "../src/services/feedPipelineJobs";
import { createFeedRunSettledObserver } from "../src/services/feedJobOutcomes";
import {
  resolveFeedJobResidency,
  resolveFeedWorkflowPollMs,
} from "../src/services/feedJobResidency";
import { createJobPipelineWorkflowDeps } from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import {
  dispatchFeedJobWorkflow,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import type { Env } from "../src/types";
import type {
  DataProvider,
  DataResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];

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

async function universeStore() {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

function fakeProvider(id: DataProvider["id"]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = SYMBOLS.map((s) => quote(s)).filter((q) =>
        wanted.has(q.symbol.toUpperCase()),
      );
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
  };
}

interface ParityHarness {
  deps: JobPipelineDeps;
  stores: JobPipelineStores;
  runStore: InMemoryJobRunRecordStore;
  datasetStore: InMemoryFeedDatasetStore;
  outcomes: JobOutcomeInput[];
}

async function makeParityHarness(invocation: "sync" | "workflow-shard"): Promise<ParityHarness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universes = await universeStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const outcomes: JobOutcomeInput[] = [];
  const registry = buildFeedJobRegistry({});
  const steps = createFeedStepRegistry({
    registry,
    providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId),
    universeStore: universes,
    datasetStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
    indexRefresh: {
      store: universes,
      service: {
        getMembers: async () => ({
          index: "nasdaq100",
          snapshotDate: "2026-11-06",
          symbols: SYMBOLS.map((symbol) => ({ symbol })),
          source: "wikipedia",
          sourceLabel: "Wikipedia (Nasdaq-100 table)",
          derivedFromHoldings: false,
        }),
      },
    },
  });
  let runCounter = 0;
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    invocation,
    now: () => new Date(T0),
    newRunId: () => `run-${++runCounter}`,
    runSettledObserver: createFeedRunSettledObserver({
      record: async (input) => {
        outcomes.push(input);
      },
      readFeedRun: async (jobId, runId) => {
        const def = registry.get(jobId);
        if (!def) return null;
        const status = await buildFeedStatus(datasetStore, def, T0);
        return status.lastRun?.runId === runId ? status.lastRun : null;
      },
    }),
  };
  const control = new JobPipelineControl(deps);
  await ensureFeedPipelineJobs(control, stores, {});
  return { deps, stores, runStore, datasetStore, outcomes };
}

function normalizedRunRecord(record: unknown) {
  const r = record as Record<string, unknown>;
  return {
    system: r.system,
    jobId: r.jobId,
    outcome: r.outcome,
    error: r.error ?? null,
    trigger: r.trigger,
  };
}

describe("feed workflow residency (#4171)", () => {
  it("the residency switch defaults to workflow and refuses host/invalid values by name", () => {
    expect(resolveFeedJobResidency({})).toBe("workflow");
    expect(resolveFeedJobResidency({ FEED_JOB_RESIDENCY: "workflow" })).toBe("workflow");
    expect(() => resolveFeedJobResidency({ FEED_JOB_RESIDENCY: "host" })).toThrow(
      /feed_job_host_residency_retired/,
    );
    expect(() => resolveFeedJobResidency({ FEED_JOB_RESIDENCY: "sideways" })).toThrow(
      /FEED_JOB_RESIDENCY/,
    );
    expect(resolveFeedWorkflowPollMs({})).toBeGreaterThan(0);
    expect(resolveFeedWorkflowPollMs({ FEED_JOB_WORKFLOW_POLL_MS: "250" })).toBe(250);
    expect(() => resolveFeedWorkflowPollMs({ FEED_JOB_WORKFLOW_POLL_MS: "0" })).toThrow(
      /FEED_JOB_WORKFLOW_POLL_MS/,
    );
  });

  it("createJobPipelineWorkflowDeps carries the feed run-settled observer", () => {
    const deps = createJobPipelineWorkflowDeps({ AGENT_DB: {} } as unknown as Env);
    expect(typeof deps.runSettledObserver).toBe("function");
  });

  it("the feed dispatch starts the workflow with the run facts and awaits its outcome", async () => {
    const starts: Array<{ jobId: string; opts: Record<string, unknown> }> = [];
    const ctx = {
      env: {} as Env,
      agentCtx: { storage: {} },
      startWorkflow: async (jobId: string, opts: Record<string, unknown>) => {
        starts.push({ jobId, opts });
        return { instanceId: "wf-feed-1" };
      },
      workflowStatus: async (instanceId: string) => {
        expect(instanceId).toBe("wf-feed-1");
        return {
          status: "complete",
          output: { jobId: "alpaca-nasdaq100-quotes", runId: "run-wf-1", state: "completed" },
        };
      },
    } as unknown as ScheduledTasksPipelineContext;

    await expect(
      dispatchFeedJobWorkflow(ctx, "alpaca-nasdaq100-quotes", {
        trigger: "manual",
        userLogin: "operator@example.com",
        scheduleId: "schedule-1",
      }),
    ).resolves.toEqual({
      jobId: "alpaca-nasdaq100-quotes",
      runId: "run-wf-1",
      state: "completed",
    });
    expect(starts).toEqual([
      {
        jobId: "alpaca-nasdaq100-quotes",
        opts: {
          trigger: "manual",
          scheduleId: "schedule-1",
          userLogin: "operator@example.com",
          operation: "run",
        },
      },
    ]);
  });

  it("an errored workflow dispatch surfaces the engine refusal by name", async () => {
    const ctx = {
      env: {} as Env,
      agentCtx: { storage: {} },
      startWorkflow: async () => ({ instanceId: "wf-feed-2" }),
      workflowStatus: async () => ({
        status: "errored",
        error: { message: 'Job "alpaca-nasdaq100-quotes" is running (run run-1)' },
      }),
    } as unknown as ScheduledTasksPipelineContext;
    await expect(
      dispatchFeedJobWorkflow(ctx, "alpaca-nasdaq100-quotes", { trigger: "manual" }),
    ).rejects.toThrow(/is running/);
  });

  it("host and workflow residencies produce parity dataset, run, surface, and outcome records", async () => {
    const host = await makeParityHarness("sync");
    const hostDispatch = await new JobPipelineControl(host.deps).runJob(
      "yahoo-nasdaq100-quotes",
      { trigger: "manual" },
    );
    const hostOutcome = await hostDispatch.completion!;
    expect(hostOutcome.state).toBe("completed");

    const workflow = await makeParityHarness("workflow-shard");
    const workflowOutcome = await runJobPipelineWorkflowFlow(
      workflow.deps,
      { do: async (_name, fn) => fn() },
      { jobId: "yahoo-nasdaq100-quotes", trigger: "manual" },
      { workflowInstanceId: "wf-parity-1" },
    );
    expect(workflowOutcome.state).toBe("completed");

    const hostArtifact = await host.datasetStore.latest("yahoo", "quotes");
    const workflowArtifact = await workflow.datasetStore.latest("yahoo", "quotes");
    expect(workflowArtifact?.quotes).toEqual(hostArtifact?.quotes);
    expect(workflowArtifact?.run.status).toBe(hostArtifact?.run.status);
    expect(workflowArtifact?.run.requested).toBe(hostArtifact?.run.requested);
    expect(workflowArtifact?.run.received).toBe(hostArtifact?.run.received);

    expect(normalizedRunRecord(workflow.runStore.listByJob("yahoo-nasdaq100-quotes")[0])).toEqual(
      normalizedRunRecord(host.runStore.listByJob("yahoo-nasdaq100-quotes")[0]),
    );

    const entry = resolveFeedJob("yahoo")!;
    const hostView = await buildFeedJobSurfaceView({
      entry,
      datasetStore: host.datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await new JobPipelineControl(host.deps).getJob("yahoo-nasdaq100-quotes"),
      nowMs: T0,
    });
    const workflowView = await buildFeedJobSurfaceView({
      entry,
      datasetStore: workflow.datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await new JobPipelineControl(workflow.deps).getJob("yahoo-nasdaq100-quotes"),
      nowMs: T0,
    });
    expect(workflowView.feed?.state).toBe(hostView.feed?.state);
    expect(workflowView.feed?.snapshot?.rowsPersisted).toBe(hostView.feed?.snapshot?.rowsPersisted);
    expect(workflowView.feed?.history).toHaveLength(hostView.feed?.history.length ?? 0);
    expect(workflowView.pipeline?.state).toBe(hostView.pipeline?.state);

    const normalizeOutcome = (o: JobOutcomeInput) => ({
      kind: o.kind,
      trigger: o.trigger,
      origin: o.origin,
      status: o.status,
      scanned: o.scanned,
      matched: o.matched,
      codedError: o.codedError ?? null,
    });
    expect(workflow.outcomes.map(normalizeOutcome)).toEqual(host.outcomes.map(normalizeOutcome));
    expect(workflow.outcomes).toHaveLength(1);
  });

  it("host orphan settlement leaves workflow-resident running runs to their workflow executor", async () => {
    const h = await makeParityHarness("sync");
    const control = new JobPipelineControl(h.deps);
    const instance = await h.stores.instances.getInstance("yahoo-nasdaq100-quotes");
    if (!instance) throw new Error("feed instance missing");
    await h.stores.instances.saveInstance({
      ...instance,
      state: "running",
      currentRunId: "run-wf-live",
      runStartedAt: iso(T0 - 60_000),
      runTrigger: "manual",
      runWorkflowInstanceId: "wf-live-1",
    });
    await expect(control.settleOrphanedRuns()).resolves.toEqual({ settled: [] });
    expect((await h.stores.instances.getInstance("yahoo-nasdaq100-quotes"))?.state).toBe(
      "running",
    );
  });

  it("the JOB_PIPELINE_WORKFLOW concurrency limit is sized above one for simultaneous invocations", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    const match = wrangler.match(
      /"binding": "JOB_PIPELINE_WORKFLOW"[^}]*"concurrency": \{ "limit": (\d+) \}/,
    );
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThan(1);
    expect(wrangler).toContain("#4171");
  });
});
