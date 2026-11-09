/**
 * Issue #3535 — the feed-job copilot tools.
 *
 * "Run the Yahoo feed job and show its status" must work through
 * the General Copilot's tool catalog: run_feed_job /
 * get_feed_job_status / list_feed_jobs / manage_feed_job dispatch
 * over the ScheduledAgent door (the pipeline host's control plane,
 * #3543) — the same operations the UX surface makes, never a
 * second engine entry.
 *
 * The ScheduledAgent namespace is faked over an in-memory control
 * harness (the agent RPC shapes are mirrored exactly); identity
 * rides the turn context, and the door refuses without one.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  RunFeedJobCommand,
  GetFeedJobStatusCommand,
  ListFeedJobsCommand,
  ManageFeedJobCommand,
} from "../src/mcps/openaimp/feedJobCommands";
import type { McpToolContext } from "../src/patterns/interfaces";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
} from "../src/services/feedPipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");

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
    timestamp: new Date(T0).toISOString(),
  } as MarketDataResearchQuote;
}

/** A fake ScheduledAgent stub mirroring the host RPC surface. */
async function makeStub() {
  const datasetStore = new InMemoryFeedDatasetStore();
  const universeStore = new InMemoryIndexListStore();
  await universeStore.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    source: "manual",
    sourceLabel: "Test seed",
    derivedFromHoldings: false,
  });
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.map((s) => quote(s)),
      }) as DataResult<QuoteResult[]>,
  };
  const registry = buildFeedJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    steps: createFeedStepRegistry({
      registry,
      providerFor: (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined),
      universeStore,
      datasetStore,
    }),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  const surface = async (jobId: string) => {
    const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    return buildFeedJobSurfaceView({
      entry,
      datasetStore,
      registry,
      pipeline: await control.getJob(jobId).catch(() => null),
      nowMs: T0,
    });
  };
  const runOutcome = async (dispatch: { runId: string; completion?: Promise<{ state: string; error?: string }> }, jobId: string) => {
    const outcome = await dispatch.completion!;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  return {
    runPipelineJob: async (jobId: string) => runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId),
    pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
    resumePipelineJob: async (jobId: string) => runOutcome(await control.resumeJob(jobId, { trigger: "manual" }), jobId),
    cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
    retryPipelineJob: async (jobId: string) => runOutcome(await control.retryJob(jobId, { trigger: "manual" }), jobId),
    getFeedJobSurfaceStatus: surface,
    listFeedJobSurfaceStatuses: async () =>
      Promise.all(FEED_PIPELINE_CATALOG.map((e) => surface(e.jobId))),
  };
}

async function makeContext(withIdentity = true) {
  const stub = await makeStub();
  const env = {
    SCHEDULED_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
  } as unknown as Env;
  const audits: Array<{ type: string }> = [];
  const context = {
    env,
    orm: undefined,
    sessionId: "session-1",
    actingLogin: () => (withIdentity ? "owner" : undefined),
    audit: (type: string) => {
      audits.push({ type });
    },
  } as unknown as McpToolContext;
  return { context, audits };
}

describe("feed-job copilot tools (#3535)", () => {
  it("the catalog carries the four feed-job tools (124 total since #3888: +1 trading_limits tool)", () => {
    const names = McpToolFactory.getToolDefinitions().map((d) => d.name);
    expect(names).toHaveLength(124);
    for (const name of ["run_feed_job", "get_feed_job_status", "list_feed_jobs", "manage_feed_job"]) {
      expect(names).toContain(name);
    }
  });

  it("run_feed_job 'yahoo' runs the Yahoo job and returns its status", async () => {
    const { context, audits } = await makeContext();
    const result = (await new RunFeedJobCommand().execute({ source: "yahoo" }, context)) as any;
    expect(result.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(result.state).toBe("completed");
    expect(result.status.feed.state).toBe("ready");
    expect(result.status.feed.snapshot.rowsPersisted).toBe(2);
    expect(audits.some((a) => a.type === "mcp.tool_called")).toBe(true);
  });

  it("get_feed_job_status reports the honest never-run state", async () => {
    const { context } = await makeContext();
    const result = (await new GetFeedJobStatusCommand().execute({ source: "alpaca" }, context)) as any;
    expect(result.jobId).toBe("alpaca-nasdaq100-quotes");
    expect(result.feed.state).toBe("never-run");
    expect(result.feed.lastRun).toBeNull();
  });

  it("list_feed_jobs returns every feed job's merged view", async () => {
    const { context } = await makeContext();
    const result = (await new ListFeedJobsCommand().execute({}, context)) as any;
    expect(result.jobs).toHaveLength(9);
    expect(result.jobs.map((j: any) => j.jobId)).toContain("nasdaq-nasdaq100-universe");
  });

  it("manage_feed_job retries a completed run through the same plane", async () => {
    const { context } = await makeContext();
    await new RunFeedJobCommand().execute({ source: "yahoo" }, context);
    const result = (await new ManageFeedJobCommand().execute(
      { source: "yahoo", action: "retry" },
      context,
    )) as any;
    expect(result.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(result.action).toBe("retry");
    expect(result.run.state).toBe("completed");
    expect(result.status.feed.history).toHaveLength(2);
  });

  it("an unknown source refuses by name (feed_job_not_found)", async () => {
    const { context } = await makeContext();
    await expect(
      new RunFeedJobCommand().execute({ source: "bloomberg" }, context),
    ).rejects.toThrow(/No feed job matches "bloomberg"/);
  });

  it("no acting identity refuses before dispatch (identity_required)", async () => {
    const { context } = await makeContext(false);
    await expect(
      new RunFeedJobCommand().execute({ source: "yahoo" }, context),
    ).rejects.toThrow(/requires the chat turn's acting identity/);
  });
});
