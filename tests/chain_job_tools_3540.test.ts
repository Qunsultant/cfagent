// @vitest-environment node
/**
 * Issue #3540 — the pipeline-chain copilot tools.
 *
 * "Run the Yahoo pipeline end-to-end and tell me where it is"
 * must work through the General Copilot's tool catalog:
 * run_pipeline_chain / get_pipeline_chain_status /
 * list_pipeline_chains / manage_pipeline_chain dispatch over
 * the ScheduledAgent door (the pipeline host's control plane,
 * #3543) — the same operations the UX surface makes, never a
 * second engine entry. manage carries the per-stage operations
 * (stage_pause / stage_resume / stage_cancel) inside a chain
 * run, addressed by stage kind.
 *
 * The ScheduledAgent namespace is faked over an in-memory
 * control harness (the deliver_job_tools_3539 idiom; the agent
 * RPC shapes are mirrored exactly, including the chain
 * definition refresh from the stored stage definitions);
 * identity rides the turn context, and the door refuses
 * without one.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  RunPipelineChainCommand,
  GetPipelineChainStatusCommand,
  ListPipelineChainsCommand,
  ManagePipelineChainCommand,
} from "../src/mcps/openaimp/chainJobCommands";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
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
  ensureDeliverPipelineJobs,
} from "../src/services/deliverPipelineJobs";
import {
  buildPipelineChainRegistry,
  chainStageNodePath,
  PIPELINE_CHAIN_STAGE_ORDER,
} from "../src/services/pipelineChains";
import {
  CHAIN_PIPELINE_CATALOG,
  buildChainSurfaceView,
  ensureChainPipelineJobs,
  refreshChainDefinitionFromStoredStages,
} from "../src/services/chainPipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchQuote,
} from "../src/types";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const FEED_ID = "yahoo-nasdaq100-quotes";
const DELIVER_ID = `${FEED_ID}-enrich-analyze-generate-deliver`;
const CHAIN_ID = `${FEED_ID}-pipeline`;

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
    getFundamentals: async (symbol: string) =>
      ({
        providerId: "yahoo",
        capability: "fundamentals",
        result: { symbol, marketCap: 1_000_000, peTrailing: 25 } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
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
  await ensureChainPipelineJobs(control, stores, {});
  const chainRegistry = buildPipelineChainRegistry({});
  const refresh = async (jobId: string) => {
    const chain = chainRegistry.forId(jobId);
    if (!chain) {
      throw new Error(`PIPELINE_CHAIN_NOT_FOUND: no pipeline chain with id "${jobId}".`);
    }
    await refreshChainDefinitionFromStoredStages(control, stores, chain);
  };
  const stageNodePath = (jobId: string, stage: string) => {
    const chain = chainRegistry.forId(jobId);
    if (!chain) {
      throw new Error(`PIPELINE_CHAIN_NOT_FOUND: no pipeline chain with id "${jobId}".`);
    }
    if (!(PIPELINE_CHAIN_STAGE_ORDER as readonly string[]).includes(stage)) {
      throw new Error(`PIPELINE_CHAIN_STAGE_UNKNOWN: chain "${jobId}" has no stage "${stage}".`);
    }
    return chainStageNodePath(chain, stage as (typeof PIPELINE_CHAIN_STAGE_ORDER)[number]);
  };
  const surface = async (jobId: string) => {
    const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === jobId)!;
    const chain = chainRegistry.forId(jobId)!;
    await refresh(jobId);
    const stagePipelines: Record<string, Awaited<ReturnType<JobPipelineControl["getJob"]>>> = {};
    for (const node of chain.nodes) {
      stagePipelines[node.jobId] = await control.getJob(node.jobId);
    }
    return buildChainSurfaceView({
      entry,
      chain,
      pipeline: await control.getJob(jobId).catch(() => null),
      stagePipelines,
      nowMs: Date.now(),
    });
  };
  const runOutcome = async (dispatch: { runId: string; state: string; completion?: Promise<{ state: string; error?: string }> }, jobId: string) => {
    if (!dispatch.completion) return { jobId, runId: dispatch.runId, state: dispatch.state };
    const outcome = await dispatch.completion;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  return {
    stub: {
      runPipelineJob: async (jobId: string) => runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId),
      pausePipelineJob: async (jobId: string) => control.pauseJob(jobId),
      resumePipelineJob: async (jobId: string) => runOutcome(await control.resumeJob(jobId), jobId),
      cancelPipelineJob: async (jobId: string) => control.cancelJob(jobId),
      retryPipelineJob: async (jobId: string) => runOutcome(await control.retryJob(jobId), jobId),
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
      getDeliverJobSurfaceStatus: async () => {
        throw new Error("not exercised by this suite");
      },
      listDeliverJobSurfaceStatuses: async () => [],
      runPipelineChain: async (jobId: string) => {
        await refresh(jobId);
        return runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId);
      },
      resumePipelineChain: async (jobId: string) => {
        await refresh(jobId);
        return runOutcome(await control.resumeJob(jobId), jobId);
      },
      retryPipelineChain: async (jobId: string) => {
        await refresh(jobId);
        return runOutcome(await control.retryJob(jobId), jobId);
      },
      getPipelineChainSurfaceStatus: surface,
      listPipelineChainSurfaceStatuses: async () =>
        Promise.all(CHAIN_PIPELINE_CATALOG.map((e) => surface(e.jobId))),
      stopPipelineChainStage: async (jobId: string, stage: string) =>
        control.stopStage(jobId, stageNodePath(jobId, stage)),
      resumePipelineChainStage: async (jobId: string, stage: string) =>
        runOutcome(await control.resumeStage(jobId, stageNodePath(jobId, stage)), jobId),
      cancelPipelineChainStage: async (jobId: string, stage: string) =>
        control.cancelStage(jobId, stageNodePath(jobId, stage)),
    },
    control,
    deliveryStore,
  };
}

async function makeContext(withIdentity = true) {
  const { stub, control, deliveryStore } = await makeStub();
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
  return { context, audits, stub, control, deliveryStore };
}

describe("pipeline-chain copilot tools (#3540)", () => {
  it("the catalog carries the four pipeline-chain tools (122 total since #3782: +2 Alpaca quote/preview tools)", () => {
    const names = McpToolFactory.getToolDefinitions().map((d) => d.name);
    expect(names).toHaveLength(122);
    for (const name of [
      "run_pipeline_chain",
      "get_pipeline_chain_status",
      "list_pipeline_chains",
      "manage_pipeline_chain",
    ]) {
      expect(names).toContain(name);
    }
    expect(MCP_TOOL_SCOPES.get_pipeline_chain_status).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES.list_pipeline_chains).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES.run_pipeline_chain).toBe("mcp:write");
    expect(MCP_TOOL_SCOPES.manage_pipeline_chain).toBe("mcp:write");
  });

  it("run_pipeline_chain runs the lineage end-to-end and returns the roll-up", async () => {
    const { context, audits, deliveryStore } = await makeContext();
    const result = (await new RunPipelineChainCommand().execute(
      { source: "yahoo nasdaq100 pipeline" },
      context,
    )) as any;
    expect(result.jobId).toBe(CHAIN_ID);
    expect(result.state).toBe("completed");
    expect(result.status.frontier).toBeNull();
    expect(result.status.stages.map((s: { status: string }) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    const delivery = await deliveryStore.latestUsable(DELIVER_ID);
    expect(delivery?.run.runId).toBe(result.runId);
    expect(audits.some((a) => a.type === "mcp.tool_called")).toBe(true);
  });

  it("get_pipeline_chain_status answers where the pipeline is (never-run: frontier feed)", async () => {
    const { context } = await makeContext();
    const view = (await new GetPipelineChainStatusCommand().execute(
      { source: "alpaca pipeline" },
      context,
    )) as any;
    expect(view.jobId).toBe("alpaca-nasdaq100-quotes-pipeline");
    expect(view.frontier).toBe("feed");
    expect(view.stages).toHaveLength(5);
    expect(view.stages.every((s: { status: string }) => s.status === "not-run")).toBe(true);
  });

  it("list_pipeline_chains lists all five chains with their roll-ups", async () => {
    const { context } = await makeContext();
    const result = (await new ListPipelineChainsCommand().execute({}, context)) as any;
    expect(result.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([
      "yahoo-nasdaq100-quotes-pipeline",
      "yahoo-sp100-quotes-pipeline",
      "alpaca-nasdaq100-quotes-pipeline",
      "etrade-nasdaq100-quotes-pipeline",
      "public-nasdaq100-quotes-pipeline",
    ]);
  });

  it("manage_pipeline_chain: chain refusals and stage addressing propagate honestly", async () => {
    const { context } = await makeContext();
    // Pausing an idle chain refuses (the control plane's own error).
    await expect(
      new ManagePipelineChainCommand().execute(
        { source: "alpaca pipeline", action: "pause" },
        context,
      ),
    ).rejects.toThrow(/can pause|pausable/i);
    // A stage action without a stage refuses by name at the door.
    await expect(
      new ManagePipelineChainCommand().execute(
        { source: "alpaca pipeline", action: "stage_pause" },
        context,
      ),
    ).rejects.toMatchObject({ code: "pipeline_chain_stage_required" });
    // An unknown stage name refuses by name at the host.
    await expect(
      new ManagePipelineChainCommand().execute(
        { source: "alpaca pipeline", action: "stage_cancel", stage: "publish" as never },
        context,
      ),
    ).rejects.toThrow(/PIPELINE_CHAIN_STAGE_UNKNOWN/);
    // Cancelling a completed stage of a completed run refuses.
    await new RunPipelineChainCommand().execute(
      { source: "yahoo nasdaq100 pipeline" },
      context,
    );
    await expect(
      new ManagePipelineChainCommand().execute(
        { source: "yahoo nasdaq100 pipeline", action: "stage_cancel", stage: "deliver" },
        context,
      ),
    ).rejects.toThrow(/already completed|cannot be cancelled|not_cancellable/i);
  });

  it("unknown chain names and missing identity refuse before dispatch", async () => {
    const { context } = await makeContext();
    await expect(
      new RunPipelineChainCommand().execute({ source: "bitcoin pipeline" }, context),
    ).rejects.toMatchObject({ code: "pipeline_chain_not_found" });
    await expect(
      new RunPipelineChainCommand().execute({ source: "yahoo chain" }, context),
    ).rejects.toBeInstanceOf(MeshDoorError);
    const anonymous = await makeContext(false);
    await expect(
      new ListPipelineChainsCommand().execute({}, anonymous.context),
    ).rejects.toMatchObject({ code: "identity_required" });
  });
});
