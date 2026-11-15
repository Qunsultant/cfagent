// @vitest-environment node
/**
 * Issue #2863 (S3, narrowed) — replay pinning, store-stage
 * producer only: the workflow store stage stamps the validated
 * criteria (the run request's filters) onto the canonical copy,
 * so report replay reads the criteria from persisted data
 * instead of marking the criteria gap partial.
 *
 * The writer end already accepts criteria
 * (persistScreenerReportCanonical, reportDispatch.ts) and the
 * reader end already reads it (buildReplayFromRecord) — only
 * the store-stage producer was missing: the result built in
 * screenStoreStage carried filterSummary only, so successful
 * hub runs persisted no criteria and replay reported
 * "criteria (filters) not recorded for this run".
 *
 * - With filters on the request, the store payload carries
 *   criteria, and a replay built from that payload shows
 *   them (no criteria partial gap).
 * - Without filters on the request, the store payload omits
 *   criteria — a run that screened on no filters never
 *   invents criteria at store time; its replay marks the
 *   gap partial, exactly as before.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import {
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { buildReplayFromRecord } from "../src/workflows/reportReplay";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type {
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const PRICES: Record<string, number> = { AAPL: 150, MSFT: 300, NVDA: 180, AMZN: 200 };

function quote(symbol: string): MarketDataResearchQuote {
  const price = PRICES[symbol] ?? 100;
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: price - 1,
    high: price + 1,
    low: price - 2,
    previousClose: price - 1,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

function bars(): MarketDataResearchHistoricalBar[] {
  const out: MarketDataResearchHistoricalBar[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i;
    out.push({
      provenance: "live",
      timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function listing(symbol: string) {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    exchange: "NASDAQ" as const,
    change: 1,
    changePercent: 1,
  };
}

function marketCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "screen-manual-2863",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("AMZN")] },
    ],
    provider: "yahoo",
    deliver: true,
    ...over,
  };
}

interface Harness {
  control: JobPipelineControl;
  stored: unknown[];
}

async function makeHarness(): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const storage = new FakeStorage();
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const stored: unknown[] = [];
  const deps: ScreenerStepDeps = {
    agentFor: () => agent as never,
    quoteDepsFor: () => ({
      yahoo: { fetchYahooQuote: async (s: string) => quote(s) },
    }),
    historyDepsFor: () => ({ fetchBars: async () => bars() }),
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async () => {},
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createScreenerStepRegistry(deps),
    now: () => new Date(T0),
  });
  return { control, stored };
}

async function dispatch(command: WorkflowJobCommand): Promise<unknown[]> {
  const h = await makeHarness();
  await h.control.defineJob(buildScreenerJobDefinition(command));
  const dispatch = await h.control.runJob(command.jobId);
  const outcome = await dispatch.completion!;
  expect(outcome.state).toBe("completed");
  return h.stored;
}

const FILTERS = { sector: "ALL", minPrice: 5 };

describe("store stage stamps criteria (#2863 S3)", () => {
  it("stamps the run request filters onto the store payload", async () => {
    const stored = await dispatch(marketCommand({ filters: FILTERS as any }));
    expect(stored).toHaveLength(1);
    const payload = stored[0] as Record<string, unknown>;
    expect(payload.criteria).toEqual(FILTERS);
  });

  it("a replay built from the store payload shows the stamped criteria", async () => {
    const stored = await dispatch(marketCommand({ filters: FILTERS as any }));
    const payload = stored[0] as Record<string, unknown>;
    const envelope = buildReplayFromRecord(
      {
        id: "row-2863",
        runId: `screener:${String(payload.timestamp)}`,
        source: "screener",
        body: payload,
        userLogin: "owner",
      },
      "2026-11-13T00:00:00.000Z",
    );
    expect(envelope.kind).toBe("replay");
    expect((envelope as { criteria?: unknown }).criteria).toEqual(FILTERS);
    expect(
      (envelope as { partialReasons: string[] }).partialReasons.join(" "),
    ).not.toMatch(/criteria/);
  });

  it("omits criteria when the request has no filters — never invents them", async () => {
    const stored = await dispatch(marketCommand());
    expect(stored).toHaveLength(1);
    const payload = stored[0] as Record<string, unknown>;
    expect("criteria" in payload).toBe(false);
    const envelope = buildReplayFromRecord(
      {
        id: "row-2863-nofilter",
        runId: `screener:${String(payload.timestamp)}`,
        source: "screener",
        body: payload,
        userLogin: "owner",
      },
      "2026-11-13T00:00:00.000Z",
    );
    expect((envelope as { criteria?: unknown }).criteria).toBeNull();
    expect(
      (envelope as { partialReasons: string[] }).partialReasons.join(" "),
    ).toMatch(/criteria/);
  });
});
