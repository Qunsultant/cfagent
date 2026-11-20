// @vitest-environment node
/**
 * Issue #4775 S1 — externalize the stage deadline budgets.
 *
 * The 600s stage per-unit deadline and the 240s feed run deadline
 * were literals with no decided relationship: a feed job's stage
 * deadline (600s) could never fire before the run race (240s).
 * This slice decides it in code and externalizes both budgets:
 *
 * - Decision 1: the effective stage deadline is min(node timeout,
 *   run deadline) whenever a run deadline applies (feed jobs);
 *   non-feed jobs carry the stage timeout alone.
 * - Decision 2: `timeoutMs?: number` on JobNodeConfig; the global
 *   default lives in src/services/stageTimeouts.ts (defaults table
 *   + STAGE_TIMEOUT_MS env knob + resolveStageTimeoutMs, fail-closed
 *   by name), resolved node → env-resolved default; stageForNode
 *   reads it and clamps to the run bound threaded from executeRun.
 * - Decision 3: the screen await deadlines derive from the resolved
 *   global stage default — goal 2x, stock 1x; no separate knob, no
 *   per-job override.
 * - Decision 4: the define surface gains a per-stage timeout field
 *   (posted as stageTimeouts, applied onto the matching nodes);
 *   resolveJobDefinition preserves the new node field.
 *
 * Defaults are unchanged: 600s stage / 240s run.
 */
import { describe, expect, it } from "vitest";
import {
  resolveGoalScreenAwaitDeadlineMs,
  resolveStageTimeoutMs,
  resolveStageTimeoutMsForNode,
  resolveStockScreenAwaitDeadlineMs,
  STAGE_TIMEOUT_KNOB,
  STAGE_TIMEOUTS,
} from "../src/services/stageTimeouts";
import { GOAL_SCREEN_AWAIT_DEADLINE_MS } from "../src/workflows/runGoalScreenViaEngine";
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
import { bindStageOverrides } from "../src/services/jobDefinitionParamBinders";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";
import type { JobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { createFeedStepRegistry } from "../src/services/feedPipelineJobs";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];

describe("stage timeout defaults (#4775 S1, Decision 2)", () => {
  it("the defaults table carries the recorded 600s stage bound", () => {
    expect(STAGE_TIMEOUTS.stageMs).toBe(600_000);
  });

  it("the env knob is named STAGE_TIMEOUT_MS", () => {
    expect(STAGE_TIMEOUT_KNOB).toBe("STAGE_TIMEOUT_MS");
  });

  it("absent knob resolves to the 600s default", () => {
    expect(resolveStageTimeoutMs({})).toBe(600_000);
    expect(resolveStageTimeoutMs()).toBe(600_000);
  });

  it("a set knob wins, as a string or a number", () => {
    expect(resolveStageTimeoutMs({ STAGE_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(resolveStageTimeoutMs({ STAGE_TIMEOUT_MS: 45_000 })).toBe(45_000);
  });

  it("an invalid knob is refused by name, never silently the default", () => {
    for (const raw of ["0", "-1", "abc", "", 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveStageTimeoutMs({ STAGE_TIMEOUT_MS: raw })).toThrow(
        /STAGE_TIMEOUT_MS/,
      );
      expect(() => resolveStageTimeoutMs({ STAGE_TIMEOUT_MS: raw })).toThrow(
        /positive finite number of milliseconds/,
      );
    }
  });
});

describe("per-node stage timeout resolution (#4775 S1, Decisions 1–2)", () => {
  it("a node timeoutMs wins over the global default", () => {
    expect(
      resolveStageTimeoutMsForNode({ kind: "feed", timeoutMs: 30_000 }, 600_000),
    ).toBe(30_000);
  });

  it("absent, the env-resolved global default applies", () => {
    expect(resolveStageTimeoutMsForNode({ kind: "feed" }, 600_000)).toBe(600_000);
    expect(
      resolveStageTimeoutMsForNode({ kind: "feed" }, resolveStageTimeoutMs({ STAGE_TIMEOUT_MS: "30000" })),
    ).toBe(30_000);
  });

  it("the clamp holds: a feed job's stage resolves to at most the run deadline", () => {
    expect(
      resolveStageTimeoutMsForNode({ kind: "feed", timeoutMs: 600_000 }, 600_000, 240_000),
    ).toBe(240_000);
    expect(
      resolveStageTimeoutMsForNode({ kind: "feed" }, 600_000, 240_000),
    ).toBe(240_000);
    expect(
      resolveStageTimeoutMsForNode({ kind: "feed", timeoutMs: 30_000 }, 600_000, 240_000),
    ).toBe(30_000);
  });

  it("without a run deadline the stage timeout stands alone", () => {
    expect(
      resolveStageTimeoutMsForNode({ kind: "analyze", timeoutMs: 600_000 }, 600_000),
    ).toBe(600_000);
  });

  it("an invalid node value is refused by name", () => {
    for (const raw of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60000"]) {
      expect(() =>
        resolveStageTimeoutMsForNode({ kind: "feed", timeoutMs: raw }, 600_000),
      ).toThrow(/timeoutMs/);
    }
  });
});

describe("screen await derivation (#4775 S1, Decision 3)", () => {
  it("the goal await is 2x the resolved global stage default", () => {
    expect(resolveGoalScreenAwaitDeadlineMs({})).toBe(1_200_000);
    expect(resolveGoalScreenAwaitDeadlineMs({ STAGE_TIMEOUT_MS: "30000" })).toBe(60_000);
  });

  it("the stock await is 1x the resolved global stage default", () => {
    expect(resolveStockScreenAwaitDeadlineMs({})).toBe(600_000);
    expect(resolveStockScreenAwaitDeadlineMs({ STAGE_TIMEOUT_MS: "30000" })).toBe(30_000);
  });

  it("the exported goal constant keeps the recorded default", () => {
    expect(GOAL_SCREEN_AWAIT_DEADLINE_MS).toBe(1_200_000);
  });
});

describe("resolve-time timeoutMs (#4775 S1, Decisions 2 + 4)", () => {
  it("an invalid node timeoutMs is refused by name at resolve time", () => {
    for (const raw of [0, -1, "60000", Number.NaN]) {
      expect(() =>
        resolveJobDefinition({
          jobId: "bad-timeout",
          root: { kind: "feed", timeoutMs: raw, steps: [{ step: "track" }] },
        }),
      ).toThrow(/timeoutMs/);
    }
  });

  it("a valid node timeoutMs is preserved through resolution, on children too", () => {
    const resolved = resolveJobDefinition({
      jobId: "good-timeout",
      root: {
        kind: "feed",
        timeoutMs: 30_000,
        steps: [{ step: "track" }],
        children: [{ kind: "analyze", timeoutMs: 45_000, steps: [{ step: "track" }] }],
      },
    });
    expect(resolved.root.timeoutMs).toBe(30_000);
    expect(resolved.root.children?.[0]?.timeoutMs).toBe(45_000);
  });
});

const TEST_SPEC: JobDefinitionSpec = {
  id: "test-def",
  name: "Test",
  version: 1,
  stages: [{ kind: "feed", step: "feed.pull" }],
};

describe("define-time timeouts (#4775 S1, Decision 4)", () => {
  it("an invalid stage timeout is refused by name at define time", () => {
    for (const raw of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bindStageOverrides(TEST_SPEC, { stageTimeouts: { feed: raw } })).toThrow(
        /feed/,
      );
      expect(() => bindStageOverrides(TEST_SPEC, { stageTimeouts: { feed: raw } })).toThrow(
        /timeout/,
      );
    }
  });

  it("an unknown stage is refused by name", () => {
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageTimeouts: { nosuch: 30_000 } }),
    ).toThrow(/has no stage "nosuch"/);
  });

  it("a valid stage timeout binds and lands on the node", () => {
    const perStage = bindStageOverrides(TEST_SPEC, { stageTimeouts: { feed: 30_000 } });
    expect(perStage.timeouts).toEqual({ feed: 30_000 });
    const raw = buildJobConfigFromSpec(TEST_SPEC, "test-job", {}, perStage);
    expect((raw.root as { timeoutMs?: number }).timeoutMs).toBe(30_000);
  });

  it("absent stage timeouts change nothing", () => {
    const perStage = bindStageOverrides(TEST_SPEC, {});
    expect(perStage.timeouts).toBeUndefined();
    const raw = buildJobConfigFromSpec(TEST_SPEC, "test-job", {}, perStage);
    expect((raw.root as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });
});

describe("define route timeouts (#4775 S1, Decision 4)", () => {
  async function define(
    stageTimeouts: unknown,
    seen: Array<Record<string, unknown> | undefined>,
  ): Promise<Response> {
    const request = new Request("http://localhost/api/job-definitions/screener/define", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "test-job", stageTimeouts }),
    });
    const result = await handleJobDefinitionsRoutes(
      request,
      new URL(request.url),
      "/api/job-definitions/screener/define",
      {
        defineJobFromSpec: async (_specId, jobId, _params, overrides) => {
          seen.push(overrides.stageTimeouts);
          return { jobId, name: "Test", version: 1, stages: 6 };
        },
      },
    );
    expect(result).not.toBeNull();
    return result!;
  }

  it("a valid stage timeout reaches the define call", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define({ feed: 30_000 }, seen);
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ feed: 30_000 }]);
  });

  it("a numeric-string timeout is parsed", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define({ feed: "30000" }, seen);
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ feed: 30_000 }]);
  });

  it("an invalid stage timeout refuses with 400, naming the stage", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define({ feed: 0 }, seen);
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('Stage "feed"');
    expect(body.error).toContain("must be a positive finite number");
  });
});

/* ------------------------------------------------------------------ */
/* Engine harness (mirrors tests/job_pipeline_3534.test.ts)             */
/* ------------------------------------------------------------------ */

function makeEngineHarness(overrides?: Partial<JobPipelineDeps>) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const sleepCalls: number[] = [];
  let runCounter = 0;
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (_ctx: JobStepContext) => ({ output: { tracked: true } }));
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    now: () => new Date(T0),
    newRunId: () => `run-${++runCounter}`,
    // The unit-deadline seam: record the bound the engine races
    // each unit against, and never fire it (the unit settles
    // first) — so the recorded value IS the stage's timeoutMs.
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return new Promise<void>(() => {});
    },
    ...overrides,
  };
  return { control: createJobPipelineControl(deps), sleepCalls };
}

describe("engine: node timeout flows to the stage (#4775 S1)", () => {
  it("a node timeoutMs is the stage's per-unit deadline", async () => {
    const h = makeEngineHarness();
    await h.control.defineJob({
      jobId: "stage-timeout-job",
      root: {
        kind: "dummy",
        timeoutMs: 30_000,
        steps: [{ step: "track" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("stage-timeout-job");
    expect(dispatch.state).toBe("completed");
    expect(h.sleepCalls).toEqual([30_000]);
  });

  it("absent, the stage runs under the 600s global default", async () => {
    const h = makeEngineHarness();
    await h.control.defineJob({
      jobId: "stage-default-job",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("stage-default-job");
    expect(dispatch.state).toBe("completed");
    expect(h.sleepCalls).toEqual([600_000]);
  });
});

/* ------------------------------------------------------------------ */
/* Feed harness (mirrors tests/feed_execution_deadline_3992.test.ts)    */
/* ------------------------------------------------------------------ */

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
  } as unknown as MarketDataResearchQuote;
}

function healthyProvider(id: DataProvider["id"]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuotesBatch: (symbols: string[]) =>
      Promise.resolve({
        providerId: id,
        capability: "quotes",
        result: SYMBOLS.filter((s) => symbols.includes(s)).map((s) => quote(s)),
      } as unknown as DataResult<QuoteResult[]>),
  };
}

async function makeFeedHarness(feedExecutionDeadlineMs: number) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universes = new InMemoryIndexListStore();
  await universes.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const registry = buildFeedJobRegistry({});
  const steps = createFeedStepRegistry({
    registry,
    providerFor: () => healthyProvider("yahoo"),
    universeStore: universes,
    datasetStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
    indexRefresh: {
      store: universes,
      service: {
        getMembers: async (index: string) => ({
          index,
          snapshotDate: "2026-11-06",
          symbols: SYMBOLS.map((symbol) => ({ symbol })),
          source: "wikipedia",
          sourceLabel: "Wikipedia (Nasdaq-100 table)",
          derivedFromHoldings: false,
        }),
      },
    },
  });
  const sleepCalls: number[] = [];
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    now: () => new Date(T0),
    feedExecutionDeadlineMs,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return new Promise<void>(() => {});
    },
  });
  return { control, sleepCalls };
}

describe("engine: feed clamp (#4775 S1, Decision 1)", () => {
  it("a feed job's stage resolves to at most the run deadline", async () => {
    const h = await makeFeedHarness(60);
    await h.control.defineJob({
      jobId: "clamp-feed-job",
      root: {
        kind: "feed",
        timeoutMs: 600_000,
        steps: [{ step: "feed.pull", params: { feedJobId: "yahoo-nasdaq100-quotes" } }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("clamp-feed-job", { trigger: "manual" });
    expect(dispatch.state).toBe("completed");
    expect(h.sleepCalls).toEqual([60]);
  });
});
