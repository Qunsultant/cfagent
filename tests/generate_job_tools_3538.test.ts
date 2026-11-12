// @vitest-environment node
/**
 * Issue #3538 — the generate-job copilot tools.
 *
 * "Generate the reports for the Yahoo dataset and show the
 * status" must work through the General Copilot's tool catalog:
 * run_generate_job / get_generate_job_status / list_generate_jobs
 * / manage_generate_job dispatch over the ScheduledAgent door
 * (the pipeline host's control plane, #3543) — the same
 * operations the UX surface makes, never a second engine entry.
 *
 * The ScheduledAgent namespace is faked over an in-memory
 * control harness (the analyze_job_tools_3537 idiom; the agent
 * RPC shapes are mirrored exactly); identity rides the turn
 * context, and the door refuses without one.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  RunGenerateJobCommand,
  GetGenerateJobStatusCommand,
  ListGenerateJobsCommand,
  ManageGenerateJobCommand,
} from "../src/mcps/openaimp/generateJobCommands";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import type { McpToolContext } from "../src/patterns/interfaces";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import {
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
} from "../src/services/enrichPipelineJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import {
  ensureAnalyzePipelineJobs,
} from "../src/services/analyzePipelineJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import {
  GENERATE_PIPELINE_CATALOG,
  buildGenerateJobSurfaceView,
  ensureGeneratePipelineJobs,
} from "../src/services/generatePipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const GENERATE_ID = `${ANALYZE_ID}-generate`;

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
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
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
  const feedRegistry = buildFeedJobRegistry({});
  const stores = createInMemoryJobPipelineStores();
  const feedDeps: FeedStepDeps = {
    registry: feedRegistry,
    providerFor: (def: FeedJobDefinition) => (def.sourceId === "yahoo" ? provider : undefined),
    universeStore,
    datasetStore,
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    steps: createPipelineStepRegistry(
      feedDeps,
      {
        registry: buildEnrichJobRegistry({}),
        datasetStore,
        enrichedStore,
      },
      {
        registry: buildAnalyzeJobRegistry({}),
        enrichedStore,
        analyzedStore,
      },
      {
        registry: buildGenerateJobRegistry({}),
        analyzedStore,
        generatedStore,
        canonicalReportStore: null,
      },
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  const surface = async (jobId: string) => {
    const entry = GENERATE_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    return buildGenerateJobSurfaceView({
      entry,
      generatedStore,
      registry: buildGenerateJobRegistry({}),
      pipeline: await control.getJob(jobId).catch(() => null),
      nowMs: Date.now(),
    });
  };
  const runOutcome = async (dispatch: { runId: string; completion?: Promise<{ state: string; error?: string }> }, jobId: string) => {
    const outcome = await dispatch.completion!;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  return {
    stub: {
      runPipelineJob: async (jobId: string) => runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId),
      pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
      resumePipelineJob: async (jobId: string) => runOutcome(await control.resumeJob(jobId, { trigger: "manual" }), jobId),
      cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
      retryPipelineJob: async (jobId: string) => runOutcome(await control.retryJob(jobId, { trigger: "manual" }), jobId),
      getFeedJobSurfaceStatus: async () => {
        throw new Error("not exercised by this suite");
      },
      listFeedJobSurfaceStatuses: async () => [],
      getEnrichJobSurfaceStatus: async () => {
        throw new Error("not exercised by this suite");
      },
      listEnrichJobSurfaceStatuses: async () => [],
      getAnalyzeJobSurfaceStatus: async () => {
        throw new Error("not exercised by this suite");
      },
      listAnalyzeJobSurfaceStatuses: async () => [],
      getGenerateJobSurfaceStatus: surface,
      listGenerateJobSurfaceStatuses: async () =>
        Promise.all(GENERATE_PIPELINE_CATALOG.map((e) => surface(e.jobId))),
    },
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
  };
}

async function makeContext(withIdentity = true) {
  const { stub, datasetStore, enrichedStore, analyzedStore, generatedStore } = await makeStub();
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
  return { context, audits, stub, datasetStore, enrichedStore, analyzedStore, generatedStore };
}

async function runChainToAnalyze(stub: { runPipelineJob: (jobId: string) => Promise<unknown> }) {
  await stub.runPipelineJob("yahoo-nasdaq100-quotes");
  await stub.runPipelineJob(ENRICH_ID);
  await stub.runPipelineJob(ANALYZE_ID);
}

describe("generate-job copilot tools (#3538)", () => {
  it("the catalog carries the four generate-job tools", () => {
    const names = McpToolFactory.getToolDefinitions().map((d) => d.name);
    // Issue #3917: the catalog SIZE is not pinned here — one new tool would
    // rewrite this line in eleven suites. The tool↔scope accounting pin lives
    // in tests/tool_attribution_audit_1763.test.ts (sets must match exactly).
    for (const name of ["run_generate_job", "get_generate_job_status", "list_generate_jobs", "manage_generate_job"]) {
      expect(names).toContain(name);
    }
  });

  it("run_generate_job generates from the persisted analyzed copy and returns its status", async () => {
    const { context, audits, stub } = await makeContext();
    // The chain runs first (feed copy → enriched copy → analyzed copy are the inputs).
    await runChainToAnalyze(stub);
    const result = (await new RunGenerateJobCommand().execute({ source: "yahoo generate" }, context)) as any;
    expect(result.jobId).toBe(GENERATE_ID);
    expect(result.state).toBe("completed");
    expect(result.status.generate.snapshot.reportsPersisted).toBe(1);
    expect(result.status.generate.snapshot.formatsPersisted).toBe(4);
    expect(result.status.generate.snapshot.reports[0].canonicalStatus).toBe("not_wired");
    expect(audits.map((a) => a.type)).toContain("mcp.tool_called");
  });

  it("run_generate_job with no persisted analyzed copy surfaces the refusal, never a fake success", async () => {
    const { context } = await makeContext();
    const result = (await new RunGenerateJobCommand().execute({ source: "generate alpaca" }, context)) as any;
    expect(result.state).toBe("failed");
    expect(result.error).toContain("GENERATE_INPUT_MISSING");
    expect(result.status.generate.state).toBe("ready"); // the failed run IS recorded
    expect(result.status.generate.snapshot).toBeNull(); // but no usable copy exists
  });

  it("get + list report the merged status the UX renders", async () => {
    const { context, stub } = await makeContext();
    await runChainToAnalyze(stub);
    await new RunGenerateJobCommand().execute({ source: "yahoo generate" }, context);
    const status = (await new GetGenerateJobStatusCommand().execute({ source: GENERATE_ID }, context)) as any;
    expect(status.jobId).toBe(GENERATE_ID);
    expect(status.generate.snapshot.inputRunId).toBeTruthy();
    const list = (await new ListGenerateJobsCommand().execute({}, context)) as any;
    expect(list.jobs).toHaveLength(12);
    expect(list.jobs.map((j: any) => j.jobId)).toContain(GENERATE_ID);
  });

  it("manage_generate_job retry re-runs through the control plane", async () => {
    const { context, stub } = await makeContext();
    await runChainToAnalyze(stub);
    await new RunGenerateJobCommand().execute({ source: "yahoo generate" }, context);
    const managed = (await new ManageGenerateJobCommand().execute(
      { source: "yahoo generate", action: "retry" },
      context,
    )) as any;
    expect(managed.action).toBe("retry");
    expect(managed.run.state).toBe("completed");
  });

  it("the door refuses without an acting identity, and unknown names by code", async () => {
    const { context } = await makeContext(false);
    await expect(
      new RunGenerateJobCommand().execute({ source: "yahoo generate" }, context),
    ).rejects.toMatchObject({ code: "identity_required" });
    const identified = (await makeContext()).context;
    await expect(
      new GetGenerateJobStatusCommand().execute({ source: "generate bitcoin" }, identified),
    ).rejects.toBeInstanceOf(MeshDoorError);
    await expect(
      new GetGenerateJobStatusCommand().execute({ source: "generate bitcoin" }, identified),
    ).rejects.toMatchObject({ code: "generate_job_not_found" });
  });
});
