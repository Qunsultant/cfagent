// @vitest-environment node
/**
 * Issue #3539 — the deliver-job copilot tools.
 *
 * "Deliver the reports for the Yahoo dataset and show the
 * status" must work through the General Copilot's tool catalog:
 * run_deliver_job / get_deliver_job_status / list_deliver_jobs
 * / manage_deliver_job dispatch over the ScheduledAgent door
 * (the pipeline host's control plane, #3543) — the same
 * operations the UX surface makes, never a second engine entry.
 *
 * The ScheduledAgent namespace is faked over an in-memory
 * control harness (the generate_job_tools_3538 idiom; the agent
 * RPC shapes are mirrored exactly); identity rides the turn
 * context, and the door refuses without one.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  RunDeliverJobCommand,
  GetDeliverJobStatusCommand,
  ListDeliverJobsCommand,
  ManageDeliverJobCommand,
} from "../src/mcps/openaimp/deliverJobCommands";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import type { McpToolContext } from "../src/patterns/interfaces";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
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
  ensureGeneratePipelineJobs,
} from "../src/services/generatePipelineJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  DELIVER_PIPELINE_CATALOG,
  buildDeliverJobSurfaceView,
  ensureDeliverPipelineJobs,
} from "../src/services/deliverPipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const ENRICH_ID = "yahoo-nasdaq100-quotes-enrich";
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const GENERATE_ID = `${ANALYZE_ID}-generate`;
const DELIVER_ID = `${GENERATE_ID}-deliver`;

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
  const deliveryStore = new InMemoryDeliveryDatasetStore();
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
      {
        registry: buildDeliverJobRegistry({}),
        generatedStore,
        deliveryStore,
        senders: {
          slack: async () => ({ ok: true }),
          email: async () => ({ ok: true }),
          webhook: async () => ({ ok: true, target: "hooks.example.com" }),
        },
      },
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  const surface = async (jobId: string) => {
    const entry = DELIVER_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    return buildDeliverJobSurfaceView({
      entry,
      deliveryStore,
      registry: buildDeliverJobRegistry({}),
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
      getGenerateJobSurfaceStatus: async () => {
        throw new Error("not exercised by this suite");
      },
      listGenerateJobSurfaceStatuses: async () => [],
      getDeliverJobSurfaceStatus: surface,
      listDeliverJobSurfaceStatuses: async () =>
        Promise.all(DELIVER_PIPELINE_CATALOG.map((e) => surface(e.jobId))),
    },
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
    deliveryStore,
  };
}

async function makeContext(withIdentity = true) {
  const { stub, datasetStore, enrichedStore, analyzedStore, generatedStore, deliveryStore } = await makeStub();
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
  return { context, audits, stub, datasetStore, enrichedStore, analyzedStore, generatedStore, deliveryStore };
}

async function runChainToGenerate(stub: { runPipelineJob: (jobId: string) => Promise<unknown> }) {
  await stub.runPipelineJob("yahoo-nasdaq100-quotes");
  await stub.runPipelineJob(ENRICH_ID);
  await stub.runPipelineJob(ANALYZE_ID);
  await stub.runPipelineJob(GENERATE_ID);
}

describe("deliver-job copilot tools (#3539)", () => {
  it("the catalog carries the four deliver-job tools (125 total since #3883: +1 alpaca_cancel_order tool)", () => {
    const names = McpToolFactory.getToolDefinitions().map((d) => d.name);
    expect(names).toHaveLength(125);
    for (const name of ["run_deliver_job", "get_deliver_job_status", "list_deliver_jobs", "manage_deliver_job"]) {
      expect(names).toContain(name);
    }
  });

  it("run_deliver_job delivers the persisted generated copy and returns its status", async () => {
    const { context, audits, stub } = await makeContext();
    // The chain runs first (feed → enriched → analyzed → generated copies are the inputs).
    await runChainToGenerate(stub);
    const result = (await new RunDeliverJobCommand().execute({ source: "yahoo deliver" }, context)) as any;
    expect(result.jobId).toBe(DELIVER_ID);
    expect(result.state).toBe("completed");
    expect(result.status.deliver.snapshot.channelsDelivered).toBe(3);
    const email = result.status.deliver.snapshot.reports[0].channels.find(
      (c: any) => c.channel === "email",
    );
    expect(email.status).toBe("not_configured");
    expect(audits.map((a) => a.type)).toContain("mcp.tool_called");
  });

  it("run_deliver_job with no persisted generated copy surfaces the refusal, never a fake success", async () => {
    const { context } = await makeContext();
    const result = (await new RunDeliverJobCommand().execute({ source: "deliver alpaca" }, context)) as any;
    expect(result.state).toBe("failed");
    expect(result.error).toContain("DELIVER_INPUT_MISSING");
    expect(result.status.deliver.state).toBe("ready"); // the failed run IS recorded
    expect(result.status.deliver.snapshot).toBeNull(); // but no usable copy exists
  });

  it("get + list report the merged status the UX renders", async () => {
    const { context, stub } = await makeContext();
    await runChainToGenerate(stub);
    await new RunDeliverJobCommand().execute({ source: "yahoo deliver" }, context);
    const status = (await new GetDeliverJobStatusCommand().execute({ source: DELIVER_ID }, context)) as any;
    expect(status.jobId).toBe(DELIVER_ID);
    expect(status.deliver.snapshot.inputRunId).toBeTruthy();
    const list = (await new ListDeliverJobsCommand().execute({}, context)) as any;
    expect(list.jobs).toHaveLength(6);
    expect(list.jobs.map((j: any) => j.jobId)).toContain(DELIVER_ID);
  });

  it("manage_deliver_job retry re-runs through the control plane", async () => {
    const { context, stub } = await makeContext();
    await runChainToGenerate(stub);
    await new RunDeliverJobCommand().execute({ source: "yahoo deliver" }, context);
    const managed = (await new ManageDeliverJobCommand().execute(
      { source: "yahoo deliver", action: "retry" },
      context,
    )) as any;
    expect(managed.action).toBe("retry");
    expect(managed.run.state).toBe("completed");
  });

  it("the door refuses without an acting identity, and unknown names by code", async () => {
    const { context } = await makeContext(false);
    await expect(
      new RunDeliverJobCommand().execute({ source: "yahoo deliver" }, context),
    ).rejects.toMatchObject({ code: "identity_required" });
    const identified = (await makeContext()).context;
    await expect(
      new GetDeliverJobStatusCommand().execute({ source: "deliver bitcoin" }, identified),
    ).rejects.toBeInstanceOf(MeshDoorError);
    await expect(
      new GetDeliverJobStatusCommand().execute({ source: "deliver bitcoin" }, identified),
    ).rejects.toMatchObject({ code: "deliver_job_not_found" });
  });
});
