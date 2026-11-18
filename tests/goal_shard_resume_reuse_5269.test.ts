/**
 * Issue #5269 — a paused + resumed goal shard reuses the leg's
 * journaled result instead of re-executing it, and never produces
 * a result-less stored row.
 *
 * The defect (#4860 ground 3): resumeJob reuses the run id, the
 * resumed analysis step re-enters runGoalDrivenScreenWithLedger,
 * which short-circuited on ANY existing ledger record with the run
 * key, returning {executed: false} with NO result — and the store
 * stage then persisted a goal envelope with result: undefined.
 * The leg was neither reused nor re-run; its result was silently
 * absent. The same re-entry shape covers workflow eviction replay
 * (#4454) and step retry: any same-run-id re-execution of the
 * analysis step hit the short-circuit.
 *
 * The mechanism (Fork C — status-aware ledger re-entry + seam
 * read-back-first; the journal's unit stays the engine step):
 * 1. The ledger wrapper short-circuits ONLY on terminal records
 *    (a true duplicate delivery). An ACTIVE record is an
 *    interrupted run of the same run id: the wrapper adopts it
 *    through the ledger's legal transitions (claim/start/
 *    heartbeat) and re-enters the composition. The create-
 *    collision guard stays: a genuinely concurrent attempt
 *    still returns executed:false without executing.
 * 2. runGoalLegViaHost reads back FIRST: the leg job's D1
 *    residency record IS the leg's journal. When the recorded
 *    run already settled completed and its screen artifact is
 *    present, the dispatch returns the journaled result without
 *    creating a second workflow instance. Any other state (no
 *    record, in flight, failed, cancelled, missing artifact)
 *    falls through to today's dispatch — attach-to-in-flight
 *    and duplicate-instance semantics are #5270's.
 * 3. The sync path has no durable settlement proof (its engine
 *    stores are in-memory), so a resumed sync leg re-executes —
 *    named here as re-execution, within the #4860 criterion
 *    (re-execution only where no journaled result exists).
 * 4. The store boundary refuses a result-less envelope by name
 *    instead of throwing a TypeError dereferencing it.
 *
 * No live runs; no real workflow.create (the injected seam, the
 * #4291/#4450/#4468 idiom). The settled-leg fixtures run the REAL
 * flow over in-memory residency stores, so the read-back proof
 * exercises the real seam code (readOptionsWorkflowRun + the
 * artifact-store adapter), not a fixture of it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import { persistWorkflowGoalScreenReport } from "../src/agents/orchestrator/goalScreenDispatch";
import {
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { JobPipelineError } from "../src/services/jobPipelineConfig";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  runGoalDrivenScreenWithLedger,
  type GoalDrivenScreenResult,
} from "../src/services/goalDrivenScreen";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  goalLegDispatchRoute,
  runGoalLegViaHost,
  type GoalLegHostSeams,
} from "../src/services/goalLegHostDispatch";
import {
  ScreenerTaskLedger,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";
import {
  ScreeningProviderRegistry,
  type ScreeningProvider,
  type ScreeningResult,
} from "../src/trading/screeningProvider";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { NasdaqUniverseDeps } from "../src/trading/screenerPipeline";
import { optionsStageStorageFromArtifacts } from "../src/workflows/optionsScreenEngine";
import {
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import type {
  BrokerStageInput,
  UniverseDepsStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";

const USER = "owner@example.com";
const NOW = new Date("2026-11-04T23:30:00.000Z");
const UNIVERSE_INPUT: UniverseDepsStageInput = { provider: "nasdaq" };
const PAPER_PAIR: BrokerStageInput = { broker: "etrade", mode: "paper" };

/* ------------------------------------------------------------------ */
/* Ledger fixtures (the phase3 idiom)                                  */
/* ------------------------------------------------------------------ */

function memoryStore(): ScreenerTaskStore {
  const map = new Map<string, string>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async list(prefix) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

function stockResult(symbols: string[]): any {
  return {
    totalScanned: 500,
    totalScreened: 500,
    matchedCount: symbols.length,
    filterApplied: {},
    filterSummary: "fixture",
    stocks: symbols.map((symbol) => ({ symbol, lastPrice: 100 })),
    scannedAt: "2026-10-22T20:00:00.000Z",
  };
}

function optionsResult(underlyings: string[]): any {
  return {
    totalUnderlyingsScanned: 40,
    totalContractsEvaluated: 900,
    matchedCount: underlyings.length * 3,
    filterApplied: {},
    filterSummary: "fixture",
    contracts: underlyings.flatMap((u) =>
      [0, 1, 2].map((i) => ({ underlyingSymbol: u, strikePrice: 100 + i })),
    ),
    scannedAt: "2026-10-22T20:00:00.000Z",
    dataSource: "live",
  };
}

function fakeProvider(
  id: string,
  assetClass: "stocks" | "options",
  behavior: () => any,
): ScreeningProvider {
  return {
    id,
    assetClasses: [assetClass],
    async screen(): Promise<ScreeningResult> {
      const result = behavior();
      return { assetClass, providerId: id, result } as ScreeningResult;
    },
  };
}

function registryWith(opts: {
  stocks?: () => any;
  options?: () => any;
}): ScreeningProviderRegistry {
  const registry = new ScreeningProviderRegistry();
  if (opts.stocks) registry.register(fakeProvider("fake-stocks", "stocks", opts.stocks));
  if (opts.options) registry.register(fakeProvider("fake-options", "options", opts.options));
  return registry;
}

function incomeScenario() {
  return buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

/* ------------------------------------------------------------------ */
/* Host fixtures (the #4858 idiom)                                     */
/* ------------------------------------------------------------------ */

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

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
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAPL", companyName: "Apple Inc", exchange: "nasdaq", change: 0, changePercent: 0 },
  { symbol: "MSFT", companyName: "Microsoft Corp", exchange: "nasdaq", change: 0, changePercent: 0 },
];

function fakeUniverseDeps(
  listings: NasdaqStockListing[] = LISTINGS,
): NasdaqUniverseDeps & { calls: number } {
  const deps = {
    calls: 0,
    fetchListings: async () => {
      deps.calls += 1;
      return listings;
    },
  };
  return deps;
}

function goalEnvelope(
  runId: string,
  optionsFilter: Record<string, unknown>,
  structures: string[] = ["long_call"],
) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    provenanceTrigger: "goal",
    classInput: {
      goalPlan: { optionsFilter, structures },
    },
  };
}

function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: {
      create: async () => ({ id: "never-created" }),
    },
    ...extra,
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

function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  extra: Partial<OptionsWorkflowStepDeps> = {},
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    chainSourceFor: () => undefined,
    universeDepsFor: async () => fakeUniverseDeps(),
    ...extra,
  };
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), stepDeps),
    invocation: "workflow-shard",
  };
}

function lazyFlowReadRun(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  extra: Partial<OptionsWorkflowStepDeps> = {},
): (jobId: string) => Promise<OptionsWorkflowRunView> {
  let ran = false;
  return async (jobId: string) => {
    if (!ran) {
      ran = true;
      const deps = flowDeps(stores, runRecorder, extra);
      const journal = recordingJournal();
      await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: "manual" });
    }
    return readOptionsWorkflowRun({ stores, runRecorder }, jobId);
  };
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

function registryWithThrowingOptions(): ScreeningProviderRegistry {
  const registry = new ScreeningProviderRegistry();
  registry.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
  registry.register(
    fakeProvider("fake-options", "options", () => {
      throw new Error("registry options screen must not be called on the pipeline path");
    }),
  );
  return registry;
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("ledger adoption on re-entry (#5269)", () => {
  it("a running record is adopted: re-entry executes and yields a result", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const { task } = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "goal-screen:resume:running",
    });
    await ledger.claim(task.id);
    await ledger.start(task.id);

    let stockCalls = 0;
    let optionsCalls = 0;
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry: registryWith({
        stocks: () => {
          stockCalls++;
          return stockResult(["AAPL"]);
        },
        options: () => {
          optionsCalls++;
          return optionsResult(["NVDA"]);
        },
      }),
      scenario,
      trigger: "manual",
      idempotencyKey: "goal-screen:resume:running",
    });
    expect(out.executed).toBe(true);
    expect(out.task.id).toBe(task.id);
    expect(out.task.status).toBe("completed");
    expect(out.result?.status).toBe("complete");
    expect(stockCalls).toBe(1);
    expect(optionsCalls).toBe(1);
    const all = await ledger.list(50);
    expect(all.filter((t) => t.idempotencyKey === "goal-screen:resume:running")).toHaveLength(1);
  });

  it("a queued record is adopted through claim + start", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const { task } = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "goal-screen:resume:queued",
    });
    expect(task.status).toBe("queued");
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry: registryWith({
        stocks: () => stockResult(["AAPL"]),
        options: () => optionsResult(["NVDA"]),
      }),
      scenario,
      trigger: "manual",
      idempotencyKey: "goal-screen:resume:queued",
    });
    expect(out.executed).toBe(true);
    expect(out.task.status).toBe("completed");
    expect(out.result?.status).toBe("complete");
  });

  it("a claimed record is adopted through start", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const { task } = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "goal-screen:resume:claimed",
    });
    await ledger.claim(task.id);
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry: registryWith({
        stocks: () => stockResult(["AAPL"]),
        options: () => optionsResult(["NVDA"]),
      }),
      scenario,
      trigger: "manual",
      idempotencyKey: "goal-screen:resume:claimed",
    });
    expect(out.executed).toBe(true);
    expect(out.task.status).toBe("completed");
    expect(out.result?.status).toBe("complete");
  });

  it("terminal records still short-circuit without re-executing: failed and cancelled", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const failed = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "goal-screen:resume:failed",
    });
    await ledger.claim(failed.task.id);
    await ledger.start(failed.task.id);
    await ledger.fail(failed.task.id, "boom");
    const cancelled = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "goal-screen:resume:cancelled",
    });
    await ledger.cancel(cancelled.task.id);

    let calls = 0;
    const counting = () => {
      calls++;
      return stockResult(["AAPL"]);
    };
    for (const key of ["goal-screen:resume:failed", "goal-screen:resume:cancelled"]) {
      const out = await runGoalDrivenScreenWithLedger({
        ledger,
        registry: registryWith({ stocks: counting, options: () => optionsResult(["NVDA"]) }),
        scenario,
        trigger: "manual",
        idempotencyKey: key,
      });
      expect(out.executed).toBe(false);
      expect(out.result).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it("the create-collision guard still refuses a genuinely concurrent attempt", async () => {
    const scenario = incomeScenario();
    const raced = {
      id: "task-raced",
      status: "running",
      idempotencyKey: "goal-screen:resume:raced",
    };
    const racingLedger = {
      list: async () => [],
      create: async () => ({ task: raced, created: false }),
    } as unknown as ScreenerTaskLedger;
    let calls = 0;
    const out = await runGoalDrivenScreenWithLedger({
      ledger: racingLedger,
      registry: registryWith({
        stocks: () => {
          calls++;
          return stockResult(["AAPL"]);
        },
        options: () => optionsResult(["NVDA"]),
      }),
      scenario,
      trigger: "manual",
      idempotencyKey: "goal-screen:resume:raced",
    });
    expect(out.executed).toBe(false);
    expect(out.task.id).toBe("task-raced");
    expect(calls).toBe(0);
  });
});

describe("host read-back-first (#5269)", () => {
  const RUN_ID = "goal-screen:dispatch-5269:options";
  const GOAL_RUN_ID = "goal-screen:test-key-5269";

  function completedView(overrides: Partial<OptionsWorkflowRunView> = {}): OptionsWorkflowRunView {
    return {
      jobId: `options-screen:${RUN_ID}`,
      runId: RUN_ID,
      state: "completed",
      engineRunId: "engine-run-1",
      stages: [],
      ...overrides,
    };
  }

  it("a settled leg job's screen artifact is reused without a second workflow instance", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const { stores, runRecorder } = fakeStores();
    const firstStarts: string[] = [];
    const first = (await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          firstStarts.push(jobId);
          return { instanceId: "wf-goal-5269-1" };
        },
        awaitOptions: { readRun: lazyFlowReadRun(stores, runRecorder) },
      },
    })) as { totalUnderlyingsScanned?: number; matchedCount?: number };
    expect(first.totalUnderlyingsScanned).toBe(1);
    expect(first.matchedCount).toBe(2);
    expect(firstStarts).toEqual([`options-screen:${RUN_ID}`]);

    // Resume: the same run id re-enters. The read-back returns the
    // journaled result; no second instance is created and the await
    // never runs (its read seam throws if consulted).
    const resumeStarts: string[] = [];
    const reused = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          resumeStarts.push(jobId);
          return { instanceId: "wf-goal-5269-2" };
        },
        awaitOptions: {
          readRun: async () => {
            throw new Error("await must not run when the journaled result is reused");
          },
        },
      },
    });
    expect(reused).toEqual(first);
    expect(resumeStarts).toEqual([]);
  });

  it("no leg record falls through to dispatch, unchanged (the fresh-run branch)", async () => {
    const { stores, runRecorder } = fakeStores();
    const screenResult = { status: "complete", totalUnderlyingsScanned: 1, matchedCount: 2 };
    await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
      optionsArtifactKey(RUN_ID, "screen"),
      { result: screenResult },
    );
    const created: string[] = [];
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      universe: UNIVERSE_INPUT,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "wf-goal-5269-fresh" };
        },
        awaitOptions: { readRun: async () => completedView() },
      },
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([`options-screen:${RUN_ID}`]);
  });

  it("an in-flight leg falls through to dispatch (attach is #5270's, not built here)", async () => {
    const { stores, runRecorder } = fakeStores();
    const screenResult = { status: "complete", totalUnderlyingsScanned: 1, matchedCount: 2 };
    await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
      optionsArtifactKey(RUN_ID, "screen"),
      { result: screenResult },
    );
    const created: string[] = [];
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "wf-goal-5269-flight" };
        },
        readRun: async () => completedView({ state: "running" }),
        awaitOptions: { readRun: async () => completedView() },
      },
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([`options-screen:${RUN_ID}`]);
  });

  it("a completed leg without a screen artifact falls through to dispatch", async () => {
    const { stores, runRecorder } = fakeStores();
    const screenResult = { status: "complete", totalUnderlyingsScanned: 1, matchedCount: 2 };
    const created: string[] = [];
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "wf-goal-5269-noartifact" };
        },
        readRun: async () => completedView(),
        awaitOptions: {
          readRun: async () => {
            // The fresh dispatch writes its artifact, then settles.
            await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
              optionsArtifactKey(RUN_ID, "screen"),
              { result: screenResult },
            );
            return completedView();
          },
        },
      },
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([`options-screen:${RUN_ID}`]);
  });

  it("a read-back error other than job_not_found propagates fail-closed, without dispatching", async () => {
    const { stores, runRecorder } = fakeStores();
    const created: string[] = [];
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async (jobId) => {
            created.push(jobId);
            return { instanceId: "wf-goal-5269-never" };
          },
          readRun: async () => {
            throw new Error("residency read failed");
          },
        },
      }),
    ).rejects.toThrow("residency read failed");
    expect(created).toEqual([]);
  });

  it("job_not_found through the read seam falls through to dispatch", async () => {
    const { stores, runRecorder } = fakeStores();
    const screenResult = { status: "complete", totalUnderlyingsScanned: 1, matchedCount: 2 };
    await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
      optionsArtifactKey(RUN_ID, "screen"),
      { result: screenResult },
    );
    const created: string[] = [];
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "wf-goal-5269-notfound" };
        },
        readRun: async () => {
          throw new JobPipelineError("job_not_found", `No job defined with id "options-screen:${RUN_ID}".`);
        },
        awaitOptions: { readRun: async () => completedView() },
      },
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([`options-screen:${RUN_ID}`]);
  });
});

describe("pause+resume composition (#5269)", () => {
  const IDEMPOTENCY_KEY = "test-key-5269-resume";
  const GOAL_RUN_ID = `goal-screen:${IDEMPOTENCY_KEY}`;
  const LEG_RUN_ID = `goal-screen:${IDEMPOTENCY_KEY}:options`;

  it("a resumed goal run reuses the journaled options leg and yields a complete result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const { stores, runRecorder } = fakeStores();
    // The first attempt dispatched the leg and settled it; the
    // shard was then interrupted before the composition completed.
    const settled = (await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(LEG_RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: LEG_RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-goal-5269-first" }),
        awaitOptions: { readRun: lazyFlowReadRun(stores, runRecorder) },
      },
    })) as { totalUnderlyingsScanned?: number; matchedCount?: number };
    expect(settled.totalUnderlyingsScanned).toBe(1);
    expect(settled.matchedCount).toBe(2);

    // The interrupted composition left an ACTIVE ledger record.
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const { task } = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await ledger.claim(task.id);
    await ledger.start(task.id);

    // Resume: same run id re-enters. The options leg is reused
    // (no second workflow instance, no await); the stock leg
    // serves from the registry; the result is complete.
    const resumeStarts: string[] = [];
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry: registryWithThrowingOptions(),
      scenario,
      trigger: "manual",
      idempotencyKey: IDEMPOTENCY_KEY,
      userLogin: USER,
      symbols: ["AAPL"],
      now: NOW,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: memoryStorage(),
        ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
      goalLegHost: {
        env: boundEnv({ ETRADE_ENVIRONMENT: "sandbox" }),
        universe: UNIVERSE_INPUT,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async (jobId) => {
            resumeStarts.push(jobId);
            return { instanceId: "wf-goal-5269-resumed" };
          },
          awaitOptions: {
            readRun: async () => {
              throw new Error("await must not run when the journaled leg result is reused");
            },
          },
          readSelection: async () => ({ status: "ok", brokerId: "etrade" }),
        },
      },
    });
    expect(out.executed).toBe(true);
    expect(out.task.id).toBe(task.id);
    expect(out.task.status).toBe("completed");
    expect(out.result?.status).toBe("complete");
    expect(out.result?.counts.optionsUnderlyingsScanned).toBe(1);
    expect(out.result?.counts.optionsContractsMatched).toBe(2);
    expect(resumeStarts).toEqual([]);
    const all = await ledger.list(50);
    expect(all.filter((t) => t.idempotencyKey === IDEMPOTENCY_KEY)).toHaveLength(1);
  });

  it("a resumed goal run on the sync path re-executes the leg, named (no journaled result exists)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const ledger = new ScreenerTaskLedger(memoryStore());
    const scenario = incomeScenario();
    const { task } = await ledger.create({
      trigger: "manual",
      universe: `goal:${scenario.goalKind}`,
      sector: scenario.direction,
      userLogin: USER,
      idempotencyKey: "test-key-5269-sync",
    });
    await ledger.claim(task.id);
    await ledger.start(task.id);

    // No host input: the gate never holds, the leg stays on sync.
    // The sync engine stores are in-memory, so no settlement proof
    // survives the interruption — the leg re-executes, and the
    // re-execution is what this test names: fresh artifacts in the
    // caller's storage, a complete result, the same record.
    const syncStorage = memoryStorage();
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry: registryWithThrowingOptions(),
      scenario,
      trigger: "manual",
      idempotencyKey: "test-key-5269-sync",
      userLogin: USER,
      symbols: ["AAPL"],
      now: NOW,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: syncStorage,
        ...createGoalOptionsLegDelivery({ goalRunId: "goal-screen:test-key-5269-sync" }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    });
    expect(out.executed).toBe(true);
    expect(out.task.id).toBe(task.id);
    expect(out.task.status).toBe("completed");
    expect(out.result?.status).toBe("complete");
    expect(syncStorage.keys().length).toBeGreaterThan(0);
  });
});

describe("store boundary refuses a result-less envelope (#5269)", () => {
  it("a result-less envelope refuses by name; nothing is stored", async () => {
    const storeCanonicalReport = vi.fn(() => ({ reportId: "rep-1" }));
    const orm = { storeCanonicalReport } as never;
    await expect(
      persistWorkflowGoalScreenReport(
        { env: {}, getOrm: () => orm },
        {
          taskId: "task-1",
          scenarioSource: "stored",
          trigger: "scheduled",
          result: undefined as unknown as GoalDrivenScreenResult,
        },
        "alice",
      ),
    ).rejects.toThrow("goal_screen_report_requires_result");
    expect(storeCanonicalReport).not.toHaveBeenCalled();
  });
});

describe("gate unchanged (#5269)", () => {
  it("the dispatch gate still evaluates once per dispatch with the same inputs", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv(),
      goalRunId: "goal-screen:test-key-5269",
      hasSymbols: true,
      universe: UNIVERSE_INPUT,
    });
    expect(decision.route).toBe("host");
    const gatedOut = goalLegDispatchRoute({
      broker: null,
      env: boundEnv(),
      goalRunId: "goal-screen:test-key-5269",
      hasSymbols: true,
    });
    expect(gatedOut.route).toBe("sync");
  });
});
