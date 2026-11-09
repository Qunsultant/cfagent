import { describe, expect, it, vi, afterEach } from "vitest";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { resolvePipelineChain } from "../src/services/chainPipelineJobs";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
} from "../src/services/feedPipelineJobs";
import {
  buildCuratedWikipediaFallbackHtml,
  fetchWikipediaIndexHtml,
  WIKIPEDIA_INDEX_USER_AGENT,
} from "../src/services/indexListJob";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import {
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
} from "../src/trading/indexMembership";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import {
  resolveCopilotUniversePreset,
  parseUniverseInput,
} from "../src/services/stockCopilotConfiguration";
import {
  controlStockCopilotViaDoor,
  getStockCopilotStatusViaDoor,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Issue #3875 — Feed universe auto-bootstrap, Wikipedia egress resilience & Copilot universe preset sync", () => {
  it("marks run_feed_job and all pipeline stage execution/management tools as synchronous MCP tools", () => {
    for (const toolName of [
      "run_feed_job",
      "manage_feed_job",
      "get_feed_job_status",
      "list_feed_jobs",
      "get_feed_job_schedule",
      "set_feed_job_schedule",
      "run_pipeline_chain",
      "resume_pipeline_chain",
      "manage_pipeline_chain",
      "get_pipeline_chain_status",
      "list_pipeline_chains",
      "run_enrich_job",
      "manage_enrich_job",
      "run_analyze_job",
      "manage_analyze_job",
      "run_generate_job",
      "manage_generate_job",
      "run_deliver_job",
      "manage_deliver_job",
    ]) {
      expect(isSynchronousMcpTool(toolName)).toBe(true);
    }
  });

  it("resolves 'nasdaq100 pipeline' and 'pipeline nasdaq100' to yahoo-nasdaq100-quotes-pipeline", () => {
    expect(resolvePipelineChain("nasdaq100 pipeline")?.jobId).toBe(
      "yahoo-nasdaq100-quotes-pipeline",
    );
    expect(resolvePipelineChain("pipeline nasdaq100")?.jobId).toBe(
      "yahoo-nasdaq100-quotes-pipeline",
    );
  });

  it("auto-bootstraps missing stored index universe via indexRefresh during FEED_PULL_STEP so run_feed_job / run_pipeline_chain never fail with FEED_UNIVERSE_MISSING", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const datasetStore = new InMemoryFeedDatasetStore();
    // Start with an EMPTY universeStore (no nasdaq100 row seeded yet)
    const universeStore = new InMemoryIndexListStore();
    expect(await universeStore.latest("nasdaq100")).toBeUndefined();

    const registry = buildFeedJobRegistry({});
    const provider: DataProvider = {
      id: "yahoo",
      name: "Yahoo",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuotesBatch: async (symbols: string[]) =>
        ({
          providerId: "yahoo",
          capability: "quotes",
          result: symbols.map((symbol) => ({
            symbol,
            price: 150,
            lastPrice: 150,
          })),
        }) as DataResult<QuoteResult[]>,
    };

    const steps = createFeedStepRegistry({
      registry,
      providerFor: (_def: FeedJobDefinition) => provider,
      universeStore,
      datasetStore,
      indexRefresh: {
        store: universeStore,
        service: {
          getMembers: async (index) => ({
            index,
            snapshotDate: "2026-11-09",
            symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }, { symbol: "NVDA" }],
            source: "wikipedia",
            sourceLabel: "Wikipedia component table",
            derivedFromHoldings: false,
          }),
        },
      },
    });

    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      steps,
    });
    await ensureFeedPipelineJobs(control, stores, {});

    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    // Verify universeStore was auto-populated and quotes persisted
    const storedUniverse = await universeStore.latest("nasdaq100");
    expect(storedUniverse?.symbols.map((s) => s.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
    const artifact = await datasetStore.latest("yahoo", "quotes");
    expect(artifact?.run.status).toBe("completed");
    expect(artifact?.run.received).toBe(3);
  });

  it("sends Wikimedia User-Agent on fetchWikipediaIndexHtml and falls back to curated Wikipedia table HTML on HTTP 403", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const html = await fetchWikipediaIndexHtml(
      "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": WIKIPEDIA_INDEX_USER_AGENT,
        }),
      }),
    );
    expect(html).toContain("<table>");

    // Verify the fallback HTML parses cleanly through createWikipediaIndexMembershipAdapter
    const service = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(
        async (url) => buildCuratedWikipediaFallbackHtml(url),
        "2026-11-09",
      ),
      holdings: {
        getMembers: async () => {
          throw new Error("not used");
        },
      },
    });

    const ndx = await service.getMembers("nasdaq100");
    expect(ndx.symbols.length).toBeGreaterThan(10);
    expect(ndx.symbols.some((s) => s.symbol === "AAPL")).toBe(true);

    const sp100 = await service.getMembers("sp100");
    expect(sp100.symbols.length).toBeGreaterThan(10);

    const dow = await service.getMembers("dow");
    expect(dow.symbols.length).toBeGreaterThan(10);
  });

  it("surfaces universePreset ('NASDAQ100') when NASDAQ100 preset is applied via Stock Copilot control and read via status", async () => {
    expect(resolveCopilotUniversePreset(parseUniverseInput("NASDAQ100"))).toBe("NASDAQ100");
    expect(resolveCopilotUniversePreset(parseUniverseInput("SP100"))).toBe("SP100");
    expect(resolveCopilotUniversePreset(["AAPL", "TSLA"])).toBeNull();

    const sql = new MockSqlStorage();
    const settings = new Map<string, string>();
    const ctx = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" } as unknown as Env,
      sql: sql as never,
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, value: string) => {
        settings.set(key, value);
      },
    };

    const controlRes = await controlStockCopilotViaDoor(ctx, "mubasher", {
      universe: "NASDAQ100",
    });
    expect(controlRes.universePreset).toBe("NASDAQ100");
    expect(controlRes.universe).toContain("QQQ");
    expect(controlRes.universe).toContain("AAPL");

    const statusRes = await getStockCopilotStatusViaDoor(ctx, "mubasher");
    expect(statusRes.universePreset).toBe("NASDAQ100");
    expect(statusRes.universe).toEqual(controlRes.universe);
  });
});
