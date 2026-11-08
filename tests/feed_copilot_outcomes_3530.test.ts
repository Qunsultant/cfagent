/**
 * Issue #3530 slice B — feed outcomes in the Autopilot feed +
 * Copilot schedule commands.
 *
 * Half 1 (outcomes): a feed run that settles on the pipeline host
 * writes exactly one outcome row — kind "feed", keys + outcome
 * codes + counts only — into the outcome store the Autopilot route
 * reads (the residency pin drives GET /autopilot/jobs against the
 * very store the settle observer recorded into). Honesty pins: a
 * run that never ran writes NO row; a partial pull renders
 * "partial", never success; an unattended firing refused by
 * provider wiring renders failed with its typed code; a failed
 * outcome write never fails the run.
 *
 * Half 2 (Copilot): get_feed_job_schedule reports the STORED
 * schedule; set_feed_job_schedule applies a patch through slice A's
 * door with the route's validation (typed refusal, no partial
 * write). Identity rides the turn context; no login input exists.
 *
 * The harness mirrors tests/feed_job_tools_3535.test.ts: an
 * in-memory control plane behind a fake ScheduledAgent stub whose
 * RPC shapes mirror the host's exactly.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import {
  RunFeedJobCommand,
  GetFeedJobScheduleCommand,
  SetFeedJobScheduleCommand,
} from "../src/mcps/openaimp/feedJobCommands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import type { McpToolContext } from "../src/patterns/interfaces";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryJobOutcomeStore } from "../src/data/inMemoryJobOutcomeAdapter";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  FEED_JOB_CODES,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  createFeedStepRegistry,
  ensureFeedPipelineJobs,
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
} from "../src/services/feedPipelineJobs";
import {
  createFeedRunSettledObserver,
  buildFeedJobOutcomeInput,
  FEED_JOB_OUTCOME_ORIGIN,
} from "../src/services/feedJobOutcomes";
import {
  recordJobOutcome,
  listJobOutcomes,
} from "../src/services/jobOutcomes";
import { handleAutopilotRoutes } from "../src/agents/routes/autopilot";
import type { JobOutcomeInput } from "../src/data/jobOutcomePorts";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

const T0 = Date.parse("2026-11-08T12:00:00.000Z");

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

/* ------------------------------------------------------------------ */
/* Harness A — the outcome write path                                  */
/* ------------------------------------------------------------------ */

async function makeOutcomeHarness(args: {
  quotesBack?: number;
  record?: (input: JobOutcomeInput) => void | Promise<void>;
}) {
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
  const quotesBack = args.quotesBack ?? 2;
  const provider: DataProvider = {
    id: "yahoo",
    name: "Yahoo Finance",
    capabilities: ["quotes", "historicalBars", "fundamentals"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) =>
      ({
        providerId: "yahoo",
        capability: "quotes",
        result: symbols.slice(0, quotesBack).map((s) => quote(s)),
      }) as DataResult<QuoteResult[]>,
  };
  const registry = buildFeedJobRegistry({});
  const outcomeStore = new InMemoryJobOutcomeStore();
  const record =
    args.record ?? ((input: JobOutcomeInput) => void outcomeStore.record(input));
  const readFeedRun = async (jobId: string, runId: string) => {
    const def = registry.get(jobId);
    if (!def) return null;
    const status = await buildFeedStatus(datasetStore, def, T0);
    return status.lastRun?.runId === runId ? status.lastRun : null;
  };
  const observer = createFeedRunSettledObserver({ record, readFeedRun });
  const stores = createInMemoryJobPipelineStores();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    steps: createFeedStepRegistry({
      registry,
      providerFor: (def: FeedJobDefinition) =>
        def.sourceId === "yahoo" ? provider : undefined,
      universeStore,
      datasetStore,
    }),
    now: () => new Date(T0),
    runSettledObserver: observer,
  });
  await ensureFeedPipelineJobs(control, stores, {});
  return { control, outcomeStore, datasetStore, observer };
}

describe("feed outcomes at settle (#3530 slice B)", () => {
  it("a settled manual feed run writes exactly one keys/codes-only feed row", async () => {
    const { control, outcomeStore } = await makeOutcomeHarness({});
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const rows = outcomeStore.list(10).filter((r) => r.kind === "feed");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(dispatch.runId);
    expect(row.trigger).toBe("manual");
    expect(row.status).toBe("completed");
    expect(row.scanned).toBe(2);
    expect(row.matched).toBe(2);
    expect(row.codedError).toBeNull();
    expect(row.origin).toBe(FEED_JOB_OUTCOME_ORIGIN);
    // Keys + codes + counts only — no artifact keys, no content.
    expect(row.reportUrl).toBeNull();
    expect(row.pdfKey).toBeNull();
    expect(row.xlsxKey).toBeNull();
    expect(row.csvKey).toBeNull();
    expect(row.deliveryStates).toEqual({});
  });

  it("a settled scheduled feed run records the scheduled trigger", async () => {
    const { control, outcomeStore } = await makeOutcomeHarness({});
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "scheduled" });
    await dispatch.completion!;
    const rows = outcomeStore.list(10).filter((r) => r.kind === "feed");
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("scheduled");
    expect(rows[0].status).toBe("completed");
  });

  it("a partial pull renders partial — never success", async () => {
    const { control, outcomeStore } = await makeOutcomeHarness({ quotesBack: 1 });
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const rows = outcomeStore.list(10).filter((r) => r.kind === "feed");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("partial");
    expect(rows[0].scanned).toBe(2);
    expect(rows[0].matched).toBe(1);
  });

  it("an unattended firing refused by provider wiring renders failed with its typed code", async () => {
    const { control, outcomeStore } = await makeOutcomeHarness({});
    const dispatch = await control.runJob("etrade-nasdaq100-quotes", { trigger: "scheduled" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    const rows = outcomeStore.list(10).filter((r) => r.kind === "feed");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].codedError).toBe("FEED_JOB_NOT_CONFIGURED");
  });

  it("a job that never ran writes NO outcome row", async () => {
    const { outcomeStore } = await makeOutcomeHarness({});
    expect(outcomeStore.list(10).filter((r) => r.kind === "feed")).toHaveLength(0);
  });

  it("a non-feed job's settle writes no feed row", async () => {
    const { observer, outcomeStore } = await makeOutcomeHarness({});
    await observer({
      jobId: "yahoo-nasdaq100-enrich",
      runId: "run-x",
      trigger: "manual",
      state: "completed",
    });
    expect(outcomeStore.list(10)).toHaveLength(0);
  });

  it("a re-delivered settle converges to one row (id = run id)", async () => {
    const { observer, outcomeStore } = await makeOutcomeHarness({});
    const info = {
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-dup",
      trigger: "manual" as const,
      state: "failed" as const,
      error: "FEED_JOB_NOT_CONFIGURED: not wired",
    };
    await observer(info);
    await observer(info);
    expect(outcomeStore.list(10)).toHaveLength(1);
  });

  it("a failed outcome write never fails the run and never throws", async () => {
    const { control, datasetStore } = await makeOutcomeHarness({
      record: () => {
        throw new Error("sink unavailable");
      },
    });
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const view = await buildFeedJobSurfaceView({
      entry: FEED_PIPELINE_CATALOG.find((e) => e.jobId === "yahoo-nasdaq100-quotes")!,
      datasetStore,
      registry: buildFeedJobRegistry({}),
      pipeline: await control.getJob("yahoo-nasdaq100-quotes"),
      nowMs: T0,
    });
    expect(view.feed?.state).toBe("ready");
  });

  it("residency: the store the Autopilot route reads contains the feed outcome after a host-settled run", async () => {
    const readerSql = new MockSqlStorage();
    const { control } = await makeOutcomeHarness({
      record: (input) => void recordJobOutcome(readerSql, input),
    });
    const dispatch = await control.runJob("yahoo-nasdaq100-quotes", { trigger: "manual" });
    await dispatch.completion!;
    const stored = listJobOutcomes(readerSql, 10).filter((r) => r.kind === "feed");
    expect(stored).toHaveLength(1);
    const ctx = {
      ensureTables: () => readerSql,
      audit: () => {},
      getAutopilotState: () => ({}),
      writeAutopilotState: (p: any) => p,
      evaluateAndRecordAutopilotVerdict: async () => ({}),
    } as any;
    const res = await handleAutopilotRoutes(
      new Request("https://agent.internal/api/autopilot/jobs", { method: "GET" }),
      new URL("https://agent.internal/api/autopilot/jobs"),
      "/api/autopilot/jobs",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    const data = (await res!.json()) as any;
    const feedRows = (data.jobs as any[]).filter((j) => j.kind === "feed");
    expect(feedRows).toHaveLength(1);
    expect(feedRows[0].id).toBe(dispatch.runId);
    expect(feedRows[0].status).toBe("completed");
  });
});

describe("feed outcome projection (honest status mapping)", () => {
  const base = { jobId: "yahoo-nasdaq100-quotes", runId: "r1", trigger: "manual" as const };

  it("a cancelled run renders failed with the job_cancelled code", () => {
    const input = buildFeedJobOutcomeInput({ ...base, state: "cancelled" }, null);
    expect(input.status).toBe("failed");
    expect(input.codedError).toBe("job_cancelled");
    expect(input.kind).toBe("feed");
    expect(input.origin).toBe(FEED_JOB_OUTCOME_ORIGIN);
  });

  it("a failed settle with no feed record keeps the settle error's leading code", () => {
    const input = buildFeedJobOutcomeInput(
      { ...base, state: "failed", error: "FEED_JOB_NOT_CONFIGURED: feed job cannot run" },
      null,
    );
    expect(input.status).toBe("failed");
    expect(input.codedError).toBe("FEED_JOB_NOT_CONFIGURED");
  });

  it("a failed settle with a codeless error falls back to the stable run-failed code", () => {
    const input = buildFeedJobOutcomeInput({ ...base, state: "failed", error: "boom" }, null);
    expect(input.codedError).toBe("feed_job_run_failed");
  });

  it("a failed settle keeps the code the engine's unit wrap names", () => {
    const input = buildFeedJobOutcomeInput(
      {
        ...base,
        state: "failed",
        error:
          'stage "feed" unit "feed.pull" failed after 3 attempt(s): last error code: FEED_JOB_NOT_CONFIGURED: feed job "etrade-nasdaq100-quotes" cannot run on this host',
      },
      null,
    );
    expect(input.codedError).toBe("FEED_JOB_NOT_CONFIGURED");
  });

  it("a failed settle keeps the code the engine's step wrap names", () => {
    const input = buildFeedJobOutcomeInput(
      {
        ...base,
        state: "failed",
        error:
          'Step "feed.pull" of node "root" (kind "feed") failed: FEED_JOB_NOT_CONFIGURED: feed job "etrade-nasdaq100-quotes" cannot run on this host — a capture-wired provider is not wired.',
      },
      null,
    );
    expect(input.codedError).toBe("FEED_JOB_NOT_CONFIGURED");
  });

  it("the feed record governs status and counts when it matches the run", () => {
    const input = buildFeedJobOutcomeInput(
      { ...base, state: "completed" },
      {
        runId: "r1",
        status: "failed",
        requested: 2,
        received: 0,
        codedError: FEED_JOB_CODES.universeMissing,
      } as any,
    );
    expect(input.status).toBe("failed");
    expect(input.scanned).toBe(2);
    expect(input.matched).toBe(0);
    expect(input.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });
});

/* ------------------------------------------------------------------ */
/* Harness B — the Copilot schedule commands                           */
/* ------------------------------------------------------------------ */

async function makeScheduleStub() {
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
      providerFor: (def: FeedJobDefinition) =>
        def.sourceId === "yahoo" ? provider : undefined,
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
  const runOutcome = async (
    dispatch: { runId: string; completion?: Promise<{ state: string; error?: string }> },
    jobId: string,
  ) => {
    const outcome = await dispatch.completion!;
    return { jobId, runId: dispatch.runId, state: outcome.state, error: outcome.error };
  };
  return {
    control,
    stub: {
      runPipelineJob: async (jobId: string) =>
        runOutcome(await control.runJob(jobId, { trigger: "manual" }), jobId),
      getFeedJobSurfaceStatus: surface,
      configurePipelineJob: async (jobId: string, patch: unknown) =>
        control.configureJob(jobId, patch as any),
    },
  };
}

async function makeScheduleContext(withIdentity = true) {
  const { control, stub } = await makeScheduleStub();
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
  return { context, audits, control };
}

describe("feed-job schedule copilot tools (#3530 slice B)", () => {
  it("the catalog carries both schedule tools (122 total since #3782: +2 Alpaca quote/preview tools) with sibling scopes", () => {
    const names = McpToolFactory.getToolDefinitions().map((d) => d.name);
    expect(names).toHaveLength(122);
    expect(names).toContain("get_feed_job_schedule");
    expect(names).toContain("set_feed_job_schedule");
    expect(MCP_TOOL_SCOPES["get_feed_job_schedule"]).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES["set_feed_job_schedule"]).toBe("mcp:write");
  });

  it("get_feed_job_schedule reports the stored schedule", async () => {
    const { context } = await makeScheduleContext();
    const result = (await new GetFeedJobScheduleCommand().execute(
      { source: "yahoo" },
      context,
    )) as any;
    expect(result.jobId).toBe("yahoo-nasdaq100-quotes");
    expect(result.schedule).toEqual({
      enabled: true,
      interval: "every 60 minutes",
      cron: null,
    });
    expect(result.nextScheduledRun).toBeNull();
  });

  it("set then get round-trips the cadence, and the stored definition carries it", async () => {
    const { context, control } = await makeScheduleContext();
    const set = (await new SetFeedJobScheduleCommand().execute(
      { source: "yahoo", intervalMinutes: 25 },
      context,
    )) as any;
    expect(set.schedule.interval).toBe("every 25 minutes");
    const got = (await new GetFeedJobScheduleCommand().execute(
      { source: "yahoo" },
      context,
    )) as any;
    expect(got.schedule.interval).toBe("every 25 minutes");
    const view = await control.getJob("yahoo-nasdaq100-quotes");
    expect(view.definition.config.schedule?.interval).toBe("every 25 minutes");
  });

  it("disabling preserves the cadence; a cron patch supersedes the interval", async () => {
    const { context } = await makeScheduleContext();
    const off = (await new SetFeedJobScheduleCommand().execute(
      { source: "yahoo", enabled: false },
      context,
    )) as any;
    expect(off.schedule).toEqual({
      enabled: false,
      interval: "every 60 minutes",
      cron: null,
    });
    const cron = (await new SetFeedJobScheduleCommand().execute(
      { source: "yahoo", cron: "0 6 * * *" },
      context,
    )) as any;
    expect(cron.schedule.cron).toBe("0 6 * * *");
    expect(cron.schedule.interval).toBeNull();
    expect(cron.schedule.enabled).toBe(false);
  });

  it("invalid patches refuse typed, before any write (stored schedule untouched)", async () => {
    const { context, control } = await makeScheduleContext();
    const before = (await control.getJob("yahoo-nasdaq100-quotes")).definition.config
      .schedule;
    await expect(
      new SetFeedJobScheduleCommand().execute({ source: "yahoo" }, context),
    ).rejects.toThrow(/FEED_JOB_SCHEDULE_INVALID/);
    await expect(
      new SetFeedJobScheduleCommand().execute(
        { source: "yahoo", intervalMinutes: 0 },
        context,
      ),
    ).rejects.toThrow(/FEED_JOB_SCHEDULE_INVALID/);
    await expect(
      new SetFeedJobScheduleCommand().execute(
        { source: "yahoo", intervalMinutes: 15, cron: "0 6 * * *" },
        context,
      ),
    ).rejects.toThrow(/FEED_JOB_SCHEDULE_INVALID/);
    await expect(
      new SetFeedJobScheduleCommand().execute(
        { source: "yahoo", enabled: "yes" as any },
        context,
      ),
    ).rejects.toThrow(/FEED_JOB_SCHEDULE_INVALID/);
    await expect(
      new SetFeedJobScheduleCommand().execute(
        { source: "yahoo", bogus: 1 } as any,
        context,
      ),
    ).rejects.toThrow(/FEED_JOB_SCHEDULE_INVALID/);
    const after = (await control.getJob("yahoo-nasdaq100-quotes")).definition.config
      .schedule;
    expect(after).toEqual(before);
  });

  it("both schedule tools refuse without the turn's acting identity", async () => {
    const { context } = await makeScheduleContext(false);
    await expect(
      new GetFeedJobScheduleCommand().execute({ source: "yahoo" }, context),
    ).rejects.toThrow(/requires the chat turn's acting identity/);
    await expect(
      new SetFeedJobScheduleCommand().execute(
        { source: "yahoo", intervalMinutes: 25 },
        context,
      ),
    ).rejects.toThrow(/requires the chat turn's acting identity/);
    // Identity is checked before patch validation (the route's order:
    // session first, body second).
    await expect(
      new SetFeedJobScheduleCommand().execute({ source: "yahoo" }, context),
    ).rejects.toThrow(/requires the chat turn's acting identity/);
  });

  it("an unknown source refuses by name (feed_job_not_found)", async () => {
    const { context } = await makeScheduleContext();
    await expect(
      new GetFeedJobScheduleCommand().execute({ source: "bloomberg" }, context),
    ).rejects.toThrow(/No feed job matches "bloomberg"/);
  });

  it("run_feed_job still works alongside the new tools", async () => {
    const { context } = await makeScheduleContext();
    const result = (await new RunFeedJobCommand().execute(
      { source: "yahoo" },
      context,
    )) as any;
    expect(result.state).toBe("completed");
  });
});
