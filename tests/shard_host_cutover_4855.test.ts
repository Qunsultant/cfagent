/**
 * Issue #4855 — the shard executor's per-symbol options scans move
 * onto the strategy workflow host (startStrategyScreenWorkflow),
 * gated: the host only when the chain's recorded (broker, mode)
 * pair validates — the recorded mode wins, per #3655; when the
 * mode is unrecorded it derives from the recorded broker + the
 * chain's environment through the #4853 derivation — and the
 * residency bindings are configured; otherwise the unchanged sync
 * dispatch (runStrategyScreenViaEngine, #3186 step 3e).
 *
 * What these tests defend:
 *   1. The gate: no recorded broker, an unrecognized broker, no
 *      AGENT_DB, or no workflow binding keeps the shard on sync;
 *      a recorded pair + configured bindings routes host. The
 *      recorded mode wins over the environment derivation, so a
 *      chain executes under the broker + mode it was submitted
 *      with, never a fresh read that could disagree mid-chain.
 *   2. The host dispatch defines the strategy job with the scan
 *      request (the sync dispatch's envelope, same run id),
 *      stamps the broker pair and NO universe input (a shard scan
 *      is symbol-scoped; the rebuild constructs the screener
 *      without deps, exactly as the in-process shard does), runs
 *      under the chain's trigger, completes through the real flow
 *      with the real residency factory resolving the chain
 *      source, and returns the shapeReport as the shard result.
 *   3. Scan semantics are unchanged: the same shard through the
 *      host and through sync yields the same scan result (the
 *      #3186 equivalence pin, extended across the dispatch move).
 *   4. Gated-out shards stay on the unchanged sync path (the host
 *      seam is never invoked).
 *   5. A failed run throws naming the stage and reason; a run that
 *      completes without a report refuses to answer from nothing;
 *      an unsettled run throws the named timeout — the manual
 *      route's failure shapes (#4848).
 *   6. The skipped-verdict retry contract survives the move: a
 *      host run whose matrix row is skipped throws the skip
 *      reason, so the acquisition bucket retries the symbol
 *      independently.
 *   7. The scan clock survives the D1 job definition: the scanner
 *      accepts `now` as an ISO string (the JSON round-trip of a
 *      Date) as well as a Date, at both consumption sites
 *      (enrich + collate) — the stored definition round-trips
 *      Dates to strings, and the sync path never exposed that
 *      because its step body reads the request from the closure.
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the workflow create call is injected (the
 * #4291/#4848 idiom — real workflow.create is never executed); the
 * stores are the in-memory job-pipeline adapters; the shard SQL
 * handle is real in-memory SQLite (the #3186 idiom). The engine,
 * the ports, the resolving steps, and the residency factory are
 * real. Queue publishing rides the residency binding (#4851 — the
 * workflow builds its queue from env.SCREENER_EVENTS, the same
 * binding the shard threads), so no queue assertion lives here:
 * the residency's queue test covers it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockD1Database } from "./mock-d1";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import {
  decodeBrokerStageInput,
  decodeUniverseDepsStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env, ETradeOptionChain, ETradeOptionExpireDate, ShardChainContext } from "../src/types";
import { DatabaseORM } from "../src/orm";
import {
  executeShardJob,
  resolveShardHostDispatch,
  runShardScanViaHost,
  shardDispatchRoute,
  type ShardExecutorDeps,
  type ShardHostSeams,
} from "../src/services/shardExecutors";
import type { ShardPayload } from "../src/services/shardJobs";
import {
  collateScanResult,
  enrichScanSnapshots,
  normalizeScanPlan,
  skippedScanMatrixRow,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";

const USER = "shard_cutover_tester";
const CHAIN_TIMESTAMP = "2026-11-05T12:00:00.000Z";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** The #4291 panel fixture: one strike pair, spot 100, expiry +30d. */
function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function targetDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

/** An env with the residency bindings present (values never read: the seams inject fakes). */
function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ...extra,
    // #6101: a real D1, not {} — the sync leg builds its engine
    // stores from env, and {} is truthy enough to build the D1
    // adapter, whose first Drizzle call dies on prepare().
    AGENT_DB: new MockD1Database(),
    JOB_PIPELINE_WORKFLOW: {
      create: async () => ({ id: "never-created" }),
    },
  } as unknown as Env;
}

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  return { stores, runRecorder };
}

function recordingJournal() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        return fn();
      },
    },
  };
}

/**
 * The production residency shape, minus the universe factory: the
 * shard stamps no universe input, so the resolving steps rebuild
 * ports per invocation with the REAL broker factory over the real
 * platform registry (construction only, no I/O — the fixture
 * intercepts the screener's fetches) and no universe deps, exactly
 * as the in-process shard constructs its screener. No queue: the
 * test env carries no SCREENER_EVENTS binding, so both dispatches
 * run queue-less, as the sync shard does here.
 */
function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  env: Env,
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    env,
    chainSourceFor: (userLogin, request, runId) =>
      resolveChainSourceForRequest(env, { userLogin, request, runId }),
  };
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), stepDeps),
    invocation: "workflow-shard",
  };
}

/** Real in-memory SQLite for the shard executor's SQL handle (the #3186 idiom). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

const stubClient = {
  getOptionExpireDates: async () => [expiryAtDte(30)],
  getOptionChains: async () => null,
};

function makeShardDeps(
  env: Record<string, unknown>,
  hostSeams?: ShardHostSeams,
): ShardExecutorDeps {
  const mockOrm = new DatabaseORM({ exec: vi.fn(() => []) } as any);
  return {
    sql: new SqliteTestStorage() as any,
    env,
    orm: mockOrm,
    storage: {},
    createETradeService: () => ({ client: stubClient }) as never,
    sessionId: "test-4855",
    ...(hostSeams ? { hostSeams } : {}),
  };
}

function testChain(overrides: Partial<ShardChainContext> = {}): ShardChainContext {
  return {
    chainId: "chain-4855",
    universe: "symbols",
    userLogin: USER,
    timestamp: CHAIN_TIMESTAMP,
    channels: [],
    ...overrides,
  };
}

function makePayload(overrides: Partial<ShardChainContext> = {}): ShardPayload {
  return {
    shard: { stage: "feed", key: "AAPL" },
    chain: {
      chainId: "chain-4855",
      universe: "symbols",
      userLogin: USER,
      trigger: "scheduled",
      timestamp: CHAIN_TIMESTAMP,
      channels: [],
      screenType: "options",
      options: {
        symbols: ["AAPL"],
        thesis: "bullish",
        targetDate: targetDate(),
        riskProfile: "balanced",
        allowedStrategies: ["all"],
      },
      ...overrides,
    },
    inputs: { eventCalendar: { covered: false } },
  };
}

/** Strip volatile / pipeline-added fields before equivalence compare (the #3186 idiom). */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "scannedAt" && k !== "persisted")
        .map(([k, v]) => [k, stripVolatile(v)]),
    );
  }
  return value;
}

/** The shard's scan request, as the sync dispatch builds it (the host dispatch takes the same envelope). */
function scanRequest(runId: string): unknown {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "scheduled",
    classInput: {
      scan: {
        symbols: ["AAPL"],
        template: {
          thesis: "bullish",
          targetDate: targetDate(),
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 1000,
          minRewardRisk: 1.5,
          allowedStrategies: ["all"],
        },
        options: {
          riskProfile: "balanced",
          maxSymbols: 1,
          eventCalendarBySymbol: { AAPL: { covered: false } },
          now: new Date(CHAIN_TIMESTAMP),
        },
      },
    },
  };
}

const SCRUBBED_ENV_KEYS = ["ETRADE_ACCESS_TOKEN", "ETRADE_ACCESS_SECRET"];
let savedProcessEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
  vi.unstubAllGlobals();
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
});

describe("shard dispatch gate (#4855)", () => {
  const broker = { broker: "etrade", mode: "paper" } as const;

  it("routes host when the pair derives and the residency bindings are configured", () => {
    expect(shardDispatchRoute({ broker, env: boundEnv() }).route).toBe("host");
  });

  it("stays on sync when no pair derives", () => {
    const decision = shardDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/broker/i);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    delete (env as Record<string, unknown>).AGENT_DB;
    expect(shardDispatchRoute({ broker, env }).route).toBe("sync");
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = boundEnv();
    delete (noBinding as Record<string, unknown>).JOB_PIPELINE_WORKFLOW;
    expect(shardDispatchRoute({ broker, env: noBinding }).route).toBe("sync");
    const noCreate = boundEnv() as unknown as Record<string, unknown>;
    noCreate.JOB_PIPELINE_WORKFLOW = {};
    expect(shardDispatchRoute({ broker, env: noCreate as unknown as Env }).route).toBe("sync");
  });

  it("the recorded (broker, mode) pair wins — a chain executes under the broker + mode it was submitted with", () => {
    const host = resolveShardHostDispatch(boundEnv(), testChain({
      brokerId: "etrade",
      mode: "live",
      environment: "TEST",
    }));
    expect(host.broker).toEqual({ broker: "etrade", mode: "live" });
    expect(host.decision.route).toBe("host");
  });

  it("an unrecorded mode derives from the recorded broker + the chain environment (the #4853 derivation)", () => {
    const paper = resolveShardHostDispatch(boundEnv(), testChain({
      brokerId: "etrade",
      environment: "TEST",
    }));
    expect(paper.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(paper.decision.route).toBe("host");
    const live = resolveShardHostDispatch(boundEnv(), testChain({
      brokerId: "etrade",
      environment: "PROD",
    }));
    expect(live.broker).toEqual({ broker: "etrade", mode: "live" });
    expect(live.decision.route).toBe("host");
  });

  it("stays on sync when no broker is recorded — the in-process fresh-read fallback still applies", () => {
    const host = resolveShardHostDispatch(boundEnv(), testChain({ environment: "TEST" }));
    expect(host.broker).toBeNull();
    expect(host.decision.route).toBe("sync");
  });

  it("stays on sync when the recorded broker is unrecognized", () => {
    const host = resolveShardHostDispatch(boundEnv(), testChain({
      brokerId: "nope",
      mode: "paper",
      environment: "TEST",
    }));
    expect(host.broker).toBeNull();
    expect(host.decision.route).toBe("sync");
  });

  it("stays on sync when the residency bindings are unbound, even with a recorded pair", () => {
    const host = resolveShardHostDispatch(
      {} as Env,
      testChain({ brokerId: "etrade", mode: "paper", environment: "TEST" }),
    );
    expect(host.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(host.decision.route).toBe("sync");
  });
});

describe("shard scan through the host (#4855)", () => {
  it("dispatches through the host seam, stamps the broker pair and no universe input, and completes through the real flow", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const runId = "options-scan:chain-4855:AAPL";
    const broker = { broker: "etrade", mode: "paper" } as const;

    const result = await runShardScanViaHost({
      env,
      request: scanRequest(runId),
      runId,
      symbol: "AAPL",
      userLogin: USER,
      trigger: "scheduled",
      broker,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, trigger: params.trigger });
          const journal = recordingJournal();
          const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          expect(outcome.state).toBe("completed");
          return { instanceId: "wf-4855-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toBe(`strategy-screen:${runId}`);
    expect(created[0].trigger).toBe("scheduled");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "shard-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    // No universe input: a shard scan is symbol-scoped, so the
    // rebuild constructs the screener without deps, exactly as
    // the in-process shard does.
    expect(decodeUniverseDepsStageInput(stored, "shard-cutover:1")).toBeUndefined();
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    const scan = classInput?.scan as { symbols?: string[]; options?: { now?: unknown } } | undefined;
    expect(scan?.symbols).toEqual(["AAPL"]);
    // The chain-timestamp clock rides the stored request (a Date
    // here; an ISO string after the D1 round-trip — both read the
    // same instant, per the `now` pins below).
    expect(new Date(scan?.options?.now as string | Date).toISOString()).toBe(
      new Date(CHAIN_TIMESTAMP).toISOString(),
    );
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, created[0].jobId);
    expect(readBack.state).toBe("completed");
    expect(readBack.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const stage of readBack.stages) {
      expect(stage.status).toBe("completed");
    }
    expect(readBack.shapeReport).toBeDefined();
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix[0].symbol).toBe("AAPL");
    expect(result.generatedAt).toBe(new Date(CHAIN_TIMESTAMP).toISOString());
  });

  it("a failed run throws naming the stage and reason", async () => {
    const { stores, runRecorder } = fakeStores();
    const failedView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:failed:1",
      runId: "failed:1",
      state: "failed",
      engineRunId: "engine-1",
      stages: [
        { stageId: "feed", status: "completed" },
        { stageId: "screen", status: "failed", error: "no chains for AAPL" },
      ] as OptionsWorkflowRunView["stages"],
    };
    await expect(
      runShardScanViaHost({
        env: boundEnv(),
        request: scanRequest("failed:1"),
        runId: "failed:1",
        symbol: "AAPL",
        userLogin: USER,
        trigger: "scheduled",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4855-failed" }),
          awaitOptions: { readRun: async () => failedView },
        },
      }),
    ).rejects.toThrow(/Options shard scan failed at screen: no chains for AAPL/);
  });

  it("a run that completes without a report refuses to answer from nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const emptyView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:empty:1",
      runId: "empty:1",
      state: "completed",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runShardScanViaHost({
        env: boundEnv(),
        request: scanRequest("empty:1"),
        runId: "empty:1",
        symbol: "AAPL",
        userLogin: USER,
        trigger: "scheduled",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4855-empty" }),
          awaitOptions: { readRun: async () => emptyView },
        },
      }),
    ).rejects.toThrow(/completed without a report artifact for AAPL/);
  });

  it("an unsettled run throws the named timeout", async () => {
    const { stores, runRecorder } = fakeStores();
    const pendingView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:pending:1",
      runId: "pending:1",
      state: "running",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runShardScanViaHost({
        env: boundEnv(),
        request: scanRequest("pending:1"),
        runId: "pending:1",
        symbol: "AAPL",
        userLogin: USER,
        trigger: "scheduled",
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4855-pending" }),
          awaitOptions: {
            readRun: async () => pendingView,
            timeoutMs: 5,
            intervalMs: 1,
            sleep: async () => {},
          },
        },
      }),
    ).rejects.toThrow(/options_workflow_run_timeout/);
  });
});

describe("shard wiring (#4855)", () => {
  function hostSeams(
    stores: JobPipelineStores,
    runRecorder: JobRunRecorder,
    deps: JobPipelineDeps,
    created: Array<{ jobId: string; trigger: string }>,
  ): ShardHostSeams {
    return {
      stores,
      runRecorder,
      startWorkflow: async (jobId, params) => {
        created.push({ jobId, trigger: params.trigger });
        const journal = recordingJournal();
        const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
          jobId,
          trigger: params.trigger,
        });
        expect(outcome.state).toBe("completed");
        return { instanceId: "wf-4855-wiring" };
      },
    };
  }

  it("a gated shard dispatches through the host with the shard's own run id and request", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const shardDeps = makeShardDeps(
      env as unknown as Record<string, unknown>,
      hostSeams(stores, runRecorder, deps, created),
    );

    const result = (await executeShardJob(
      shardDeps,
      makePayload({ brokerId: "etrade", mode: "paper", environment: "TEST" }),
    )) as any;

    expect(created).toHaveLength(1);
    expect(created[0].trigger).toBe("scheduled");
    // The shard run id is the #4420 identity: the Workflow Runs
    // read derives the same id from the shard payload.
    expect(created[0].jobId).toMatch(/^strategy-screen:/);
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "shard-cutover:2")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    expect(decodeUniverseDepsStageInput(stored, "shard-cutover:2")).toBeUndefined();
    const scan = (
      stored as { classInput?: { scan?: { symbols?: string[]; template?: Record<string, unknown> } } }
    )?.classInput?.scan;
    expect(scan?.symbols).toEqual(["AAPL"]);
    expect(scan?.template).toMatchObject({ thesis: "bullish", allowedStrategies: ["all"] });
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix[0].symbol).toBe("AAPL");
    expect(result.generatedAt).toBe(new Date(CHAIN_TIMESTAMP).toISOString());
  });

  it("scan semantics are unchanged across the dispatch move (the #3186 pin, host vs sync)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const chainOverrides = { brokerId: "etrade", mode: "paper", environment: "TEST" } as const;

    const syncResult = await executeShardJob(
      makeShardDeps({ AGENT_DB: new MockD1Database() }),
      makePayload({ ...chainOverrides }),
    );

    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const hostResult = await executeShardJob(
      makeShardDeps(
        env as unknown as Record<string, unknown>,
        hostSeams(stores, runRecorder, deps, created),
      ),
      makePayload({ ...chainOverrides }),
    );

    expect(created).toHaveLength(1);
    expect(stripVolatile(hostResult)).toEqual(stripVolatile(syncResult));
  });

  it("stays on sync when the residency bindings are unbound — the host seam is never invoked", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const startWorkflow = vi.fn(async () => ({ instanceId: "wf-4855-never" }));
    const { stores, runRecorder } = fakeStores();
    const result = (await executeShardJob(
      makeShardDeps({ AGENT_DB: new MockD1Database() }, { stores, runRecorder, startWorkflow }),
      makePayload({ brokerId: "etrade", mode: "paper", environment: "TEST" }),
    )) as any;

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix[0].symbol).toBe("AAPL");
  });

  it("stays on sync when no broker is recorded — the host seam is never invoked", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const startWorkflow = vi.fn(async () => ({ instanceId: "wf-4855-never" }));
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const result = (await executeShardJob(
      makeShardDeps(env as unknown as Record<string, unknown>, {
        stores,
        runRecorder,
        startWorkflow,
      }),
      makePayload({ environment: "TEST" }),
    )) as any;

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix[0].symbol).toBe("AAPL");
  });

  it("a skipped host run throws, so the acquisition bucket retries the symbol independently", async () => {
    // No chain fixture: the residency's chain fetch hits the
    // disabled network, and the scanner converts the fetch
    // exception into a skipped row — the shard re-throws the skip
    // reason so the acquisition bucket retries this one symbol.
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const shardDeps = makeShardDeps(
      env as unknown as Record<string, unknown>,
      hostSeams(stores, runRecorder, deps, created),
    );

    await expect(
      executeShardJob(
        shardDeps,
        makePayload({ brokerId: "etrade", mode: "paper", environment: "TEST" }),
      ),
    ).rejects.toThrow();
    // The acquisition bucket retries the dispatch (3 attempts):
    // each retry re-defines the same job and runs a fresh engine
    // run — the skipped artifact is never replayed.
    expect(created).toHaveLength(3);
  });
});

describe("scan clock over a stored request (#4855)", () => {
  const NOW_ISO = CHAIN_TIMESTAMP;
  const NOW_DATE = new Date(NOW_ISO);

  function template(): ScanRequestTemplate {
    return {
      thesis: "bullish",
      targetDate: "2026-12-05",
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 1000,
      minRewardRisk: 1.5,
      allowedStrategies: ["all"],
    } as ScanRequestTemplate;
  }

  it("collate stamps generatedAt from an ISO-string `now` exactly as from a Date", () => {
    const plan = normalizeScanPlan(["AAPL"], template(), {});
    const skipped = [
      { symbol: "AAPL", reason: "no chains", matrix: skippedScanMatrixRow("AAPL", "no chains") },
    ];
    const fromString = collateScanResult(plan, [], skipped, { now: NOW_ISO });
    const fromDate = collateScanResult(plan, [], skipped, { now: NOW_DATE });
    expect(fromString.generatedAt).toBe(NOW_ISO);
    expect(fromString.generatedAt).toBe(fromDate.generatedAt);
  });

  it("enrich computes the same target from an ISO-string `now` as from a Date", () => {
    const plan = normalizeScanPlan(["AAPL"], template(), {});
    const snapshot = {
      contracts: [
        {
          symbol: "AAPL",
          underlyingPrice: 100,
          impliedVolatility: 0.3,
          strikePrice: 100,
          expirationDate: "2026-12-05",
        },
      ],
    };
    const snapshots = [{ symbol: "AAPL", snapshot }] as never;
    const fromString = enrichScanSnapshots(snapshots, plan, { now: NOW_ISO });
    const fromDate = enrichScanSnapshots(snapshots, plan, { now: NOW_DATE });
    expect(fromString.skipped).toHaveLength(0);
    expect(fromString.enriched).toHaveLength(1);
    expect(fromString.enriched[0].targetPrice).toBe(fromDate.enriched[0].targetPrice);
  });
});
