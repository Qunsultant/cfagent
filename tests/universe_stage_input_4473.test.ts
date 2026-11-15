/**
 * Issue #4473 — universe deps travel as a stage input.
 *
 * Before this slice, universe deps existed only as call-site
 * construction inputs: the scheduled firer built them via
 * scheduledUniverseDeps (DO sql + blob + env) and the evaluate
 * route via etrade.getUniverseDeps, and both handed the LIVE deps
 * to the screener's third constructor argument. No per-invocation
 * rebuild could reproduce deps that only exist as construction
 * inputs — so the shared rebuild (optionsStepPorts.ts) constructed
 * the screener without them, and any discovery-mode leg (no
 * explicit symbols) failed at the screen stage with the #1378
 * error. The goal seam refused such legs earlier, by name, and the
 * manual route's gate kept them on the sync dispatch.
 *
 * This slice carries a SERIALIZABLE stage input on the stored
 * dispatch request (classInput.universeDeps): the provider the
 * route must resolve plus the tenant the run's captures attribute
 * to. The resolving steps decode it per invocation, resolve LIVE
 * deps through a residency factory (the route bundle over D1
 * ports, no DO sql handle), and the shared rebuild constructs the
 * screener with them. The live deps are never stored — functions
 * cannot ride the stored request; the input is the descriptor,
 * and the factory rebuilds the deps from it on every invocation.
 *
 * These tests prove: the decode (absent / valid / malformed), the
 * rebuild constructing the screener with the deps (a
 * discovery-mode screen through the host flow completes the
 * screen stage with discovered symbols, on the manual and goal
 * shapes), the resolving steps' factory contract (called when the
 * input is present, never called when absent, named refusal when
 * the input is present but no factory is bound), the residency
 * factory over fake D1 ports (listings resolve, the run context
 * round-trips, the capture split follows the bindings, unbound
 * and unroutable residencies refuse by name), and the start seams
 * stamping the input (strategy + goal + options seams; the goal
 * seam's discovery refusal narrows to legs carrying no input).
 * The #4450 gate is pinned UNCHANGED: the manual route stamps no
 * input, so discovery-mode screens stay on sync until a cutover
 * slice decides otherwise.
 *
 * Honesty notes: fixture chains intercept the screener's fetches
 * (the #4271 idiom) and the factory's listings fetcher is
 * injected — no live listings feed, no live broker, no real
 * workflow.create (the injected startWorkflow seam, as in #4291).
 * The listings fixture is deliberately NEVER set through
 * DynamicOptionsScreener.setTestListingsFixture: that fixture
 * bypasses the seam under test (it wins over fetchUniverseListings),
 * so every discovery assertion here runs through the deps.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { UniverseDepsResidencyPorts } from "../src/workflows/universeDepsResidency";
import type { ProviderConfigStore } from "../src/data/providerConfigPorts";
import type { ProviderCaptureStore } from "../src/data/providerCapturePorts";
import type { CaptureBlobStorage } from "../src/data/providerCapturePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  OPTIONS_SCREEN_STEP,
  optionsScreenJobDefinition,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import {
  decodeUniverseDepsStageInput,
  OptionsStepPortsError,
  type UniverseDepsStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  startGoalOptionsLegWorkflow,
  startOptionsScreenWorkflow,
  startStrategyScreenWorkflow,
} from "../src/workflows/optionsWorkflowHost";
import { optionsStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { resolveUniverseDepsFromStageInput } from "../src/workflows/universeDepsResidency";
import { manualScreenDispatchRoute } from "../src/agents/routes/etradeOptionsScreen";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { NasdaqUniverseDeps } from "../src/trading/screenerPipeline";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";

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

/** The listings the injected fetcher returns: two symbols, both chain-fixtured below. */
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

const UNIVERSE_INPUT: UniverseDepsStageInput = { provider: "nasdaq" };

/** A stored dispatch request carrying the universe stage input on classInput. */
function withUniverse<T extends { classInput: Record<string, unknown> }>(
  request: T,
  universe: UniverseDepsStageInput = UNIVERSE_INPUT,
): T {
  return {
    ...request,
    classInput: { ...request.classInput, universeDeps: universe },
  };
}

const DISCOVERY_MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "universe-host-manual" },
  trigger: "manual",
  // Symbol-less, but carrying the visible maximum-underlyings
  // limit: the screen stage refuses a symbol-less filter with no
  // cap before discovery ever runs (the pre-existing guard in
  // optionsScreener.ts/fetchChains), so a discovery fixture
  // without the cap would fail for the wrong reason.
  classInput: { request: { filter: { minDte: 14, maxDte: 60, maxUnderlyings: 10 } } },
};

const SYMBOL_MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "universe-host-manual-symbol" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const GOAL_RUN_ID = "goal-run-4473";

const DISCOVERY_GOAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "universe-host-goal" },
  trigger: "manual",
  classInput: {
    goalPlan: {
      goal: "screen the universe",
      optionsFilter: { minDte: 21, maxDte: 60, maxUnderlyings: 10 },
      goalRunId: GOAL_RUN_ID,
    },
  },
};

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "universe-host-panel" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      targetDate: targetDate(),
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
      minDte: 14,
      maxDte: 60,
    },
  },
};

const SCAN_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "universe-host-scan" },
  trigger: "manual",
  classInput: {
    scan: {
      symbols: ["AAPL"],
      template: {
        thesis: "bullish",
        targetDate: targetDate(),
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        minDte: 14,
        maxDte: 60,
        contractLimit: 500,
        candidateLimit: 10,
        maxStrikesPerSide: 12,
        maxIronCondors: 100,
        maxQuoteAgeSeconds: 60,
        eventPolicy: "warn",
      },
      options: { riskProfile: "balanced" },
    },
  },
};

/** A journal that records every step name + result and executes the handler. */
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

function hostStepDeps(
  stores: JobPipelineStores,
  overrides: Partial<OptionsWorkflowStepDeps> = {},
): OptionsWorkflowStepDeps {
  return {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    // No chain source: the static test-chains fixture intercepts the
    // screener's fetches (the #4271 panel-helper idiom).
    chainSourceFor: () => undefined,
    ...overrides,
  };
}

function hostFlowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  deps: OptionsWorkflowStepDeps,
): JobPipelineDeps {
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), deps),
    invocation: "workflow-shard",
  };
}

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  return { stores, runRecorder };
}

function stepCtx(overrides: {
  jobId: string;
  runId?: string;
  params?: Record<string, unknown>;
  input?: unknown;
}) {
  return {
    jobId: overrides.jobId,
    runId: overrides.runId ?? "engine-run-1",
    nodePath: "0",
    kind: "plan",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    params: overrides.params ?? { stageId: "plan" },
    input: overrides.input ?? null,
  };
}

/**
 * Fake D1 provider ports for the residency factory: an enabled
 * nasdaq config + a screenUniverse route naming nasdaq as primary
 * (the seeded production shape), unless overridden. Only the
 * methods the route bundle touches are implemented; the rest of
 * the port surfaces are unreachable from the bundle and throw if
 * touched, so a test that reaches them fails loudly instead of
 * passing on a silent stub.
 */
function fakeProviderPorts(overrides: {
  routePrimary?: string;
  nasdaqEnabled?: boolean;
  onOutcome?: (meta: Record<string, unknown>) => void;
  onCapture?: (input: Record<string, unknown>) => void;
} = {}): UniverseDepsResidencyPorts {
  const routePrimary = overrides.routePrimary ?? "nasdaq";
  const nasdaqEnabled = overrides.nasdaqEnabled ?? true;
  const configRecord = {
    id: "nasdaq",
    adapterKind: "nasdaq",
    lifecycleState: "enabled",
    enabled: nasdaqEnabled,
    precedence: 1,
    credentialRef: null,
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const routeRecord = {
    capability: "screenUniverse",
    primaryProviderId: routePrimary,
    gapFillProviderId: null,
    minTier: "freemium",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const unreachable = (name: string): never => {
    throw new Error(`fake provider port: ${name} is unreachable from the route bundle`);
  };
  const config = {
    bootstrapDataProviders: async () => [configRecord],
    getProviderConfig: async () => configRecord,
    listProviderConfigs: async () => [configRecord],
    listCapabilityRoutes: async () => [routeRecord],
    upsertProviderConfig: async () => unreachable("upsertProviderConfig"),
    setProviderLifecycleState: async () => unreachable("setProviderLifecycleState"),
    setProviderEnabled: async () => unreachable("setProviderEnabled"),
    clearProviderCredentialRef: async () => unreachable("clearProviderCredentialRef"),
    upsertCapabilityRoute: async () => unreachable("upsertCapabilityRoute"),
    getCapabilityRoute: async () => routeRecord,
  } as unknown as ProviderConfigStore;
  const captures = {
    recordCapture: async (_blobDeps: unknown, input: Record<string, unknown>) => {
      overrides.onCapture?.(input);
      return { id: "capture-1" };
    },
    recordFetchFailure: async () => ({ id: "capture-1" }),
    createFetchOutcomeRecorder: () => ({
      recordSuccess: async (meta: Record<string, unknown>) => {
        overrides.onOutcome?.(meta);
      },
      recordFailure: async () => {},
    }),
    getCaptureById: async () => null,
    listCapturesByRun: async () => [],
    listCapturesByProvider: async () => [],
  } as unknown as ProviderCaptureStore;
  return { config, captures };
}

describe("universe stage input decode (#4473)", () => {
  it("absent input decodes to undefined — existing runs are untouched", () => {
    expect(decodeUniverseDepsStageInput(PANEL_REQUEST, "r1")).toBeUndefined();
    expect(decodeUniverseDepsStageInput({ classInput: {} }, "r1")).toBeUndefined();
    expect(decodeUniverseDepsStageInput(null, "r1")).toBeUndefined();
    expect(decodeUniverseDepsStageInput({ assetClass: "options" }, "r1")).toBeUndefined();
  });

  it("a valid input decodes through, tenant included", () => {
    expect(decodeUniverseDepsStageInput(withUniverse(PANEL_REQUEST), "r1")).toEqual({
      provider: "nasdaq",
    });
    expect(
      decodeUniverseDepsStageInput(
        withUniverse(PANEL_REQUEST, { provider: "nasdaq", tenantId: "tenant-9" }),
        "r1",
      ),
    ).toEqual({ provider: "nasdaq", tenantId: "tenant-9" });
  });

  it("a malformed input refuses by name, never guessed", () => {
    const malformed: unknown[] = [
      "nasdaq",
      42,
      { provider: "yahoo" },
      { provider: "NASDAQ" },
      { provider: "nasdaq", tenantId: 7 },
      { tenantId: "tenant-9" },
    ];
    for (const value of malformed) {
      expect(() =>
        decodeUniverseDepsStageInput(
          { classInput: { strategyRequest: {}, universeDeps: value } },
          "run-malformed",
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "stage_request_unrecognized",
        }),
      );
      try {
        decodeUniverseDepsStageInput(
          { classInput: { strategyRequest: {}, universeDeps: value } },
          "run-malformed",
        );
        expect.unreachable("decode must throw for a malformed universe input");
      } catch (err) {
        expect((err as Error).message).toMatch(/run-malformed/);
        expect((err as Error).message).toMatch(/universe/);
      }
    }
  });
});

describe("shared rebuild constructs the screener with universe deps (#4473)", () => {
  it("a discovery-mode manual screen through the host flow completes with discovered symbols", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      AAPL: makeChain("AAPL"),
      MSFT: makeChain("MSFT"),
    });
    DynamicOptionsScreener.setTestListingsFixture(null);
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = fakeUniverseDeps();
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          env: {} as unknown as Env,
          universeDepsFor: async () => deps,
        }),
      );
      const runId = "universe-host:manual:discovery:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        optionsScreenJobDefinition(
          jobId,
          withUniverse(DISCOVERY_MANUAL_REQUEST),
          "tester",
        ),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      // The screen stage resolved its underlyings through the deps:
      // two listings in, two underlyings scanned — the #1378 error
      // never fired, and no listings fixture bypassed the seam.
      expect(deps.calls).toBeGreaterThanOrEqual(1);
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      const screened = await storage.get<{ result: { totalUnderlyingsScanned: number } }>(
        optionsArtifactKey(runId, "screen"),
      );
      expect(screened?.result.totalUnderlyingsScanned).toBe(2);
      const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, jobId);
      expect(readBack.state).toBe("completed");
      for (const stage of readBack.stages) {
        expect(stage.status).toBe("completed");
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });

  it("without the input, a discovery-mode manual screen still throws the #1378 error (unchanged default)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    DynamicOptionsScreener.setTestListingsFixture(null);
    try {
      const { stores, runRecorder } = fakeStores();
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, { env: {} as unknown as Env }),
      );
      const runId = "universe-host:manual:nodeps:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        optionsScreenJobDefinition(jobId, DISCOVERY_MANUAL_REQUEST, "tester"),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("failed");
      const view = await control.getJob(jobId);
      const errors = view.stages.flatMap((stage) => stage.units.map((unit) => unit.error ?? ""));
      expect(errors.some((error) => error.includes("#1378"))).toBe(true);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });

  it("a discovery-mode goal leg through the host flow completes with discovered symbols", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      AAPL: makeChain("AAPL"),
      MSFT: makeChain("MSFT"),
    });
    DynamicOptionsScreener.setTestListingsFixture(null);
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = fakeUniverseDeps();
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          universeDepsFor: async () => deps,
        }),
      );
      const runId = "universe-host:goal:discovery:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        optionsScreenJobDefinition(
          jobId,
          withUniverse(DISCOVERY_GOAL_REQUEST),
          "tester",
        ),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(deps.calls).toBeGreaterThanOrEqual(1);
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      const screened = await storage.get<{ result: { totalUnderlyingsScanned: number } }>(
        optionsArtifactKey(runId, "screen"),
      );
      expect(screened?.result.totalUnderlyingsScanned).toBe(2);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });

  it("a symbol-scoped manual screen with the input completes — the input is inert when symbols are explicit", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    DynamicOptionsScreener.setTestListingsFixture(null);
    try {
      const { stores, runRecorder } = fakeStores();
      const deps = fakeUniverseDeps();
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          env: {} as unknown as Env,
          universeDepsFor: async () => deps,
        }),
      );
      const runId = "universe-host:manual:symbol:1";
      const jobId = optionsScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        optionsScreenJobDefinition(
          jobId,
          withUniverse(SYMBOL_MANUAL_REQUEST),
          "tester",
        ),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      // Explicit symbols win: discovery never runs, the deps are
      // never fetched through, even though the input traveled.
      expect(deps.calls).toBe(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });
});

describe("resolving steps resolve deps from the stage input (#4473)", () => {
  it("the factory is called with the decoded input + engine run id, on the panel shape", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const calls: Array<{ userLogin?: string; runId: string; universe: UniverseDepsStageInput }> =
        [];
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          universeDepsFor: async (args) => {
            calls.push(args);
            return fakeUniverseDeps();
          },
        }),
      );
      const runId = "universe-host:panel:factory:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        strategyScreenJobDefinition(
          jobId,
          withUniverse(PANEL_REQUEST, { provider: "nasdaq", tenantId: "tenant-9" }),
          "tester",
        ),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]).toEqual({
        userLogin: "tester",
        runId: outcome.runId,
        universe: { provider: "nasdaq", tenantId: "tenant-9" },
      });
      // Every call resolves for the same engine run id.
      for (const call of calls) {
        expect(call.runId).toBe(outcome.runId);
        expect(call.universe).toEqual({ provider: "nasdaq", tenantId: "tenant-9" });
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the factory is called on the scan shape too — the input travels for both strategy shapes", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      let calls = 0;
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          universeDepsFor: async () => {
            calls += 1;
            return fakeUniverseDeps();
          },
        }),
      );
      const runId = "universe-host:scan:factory:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        strategyScreenJobDefinition(jobId, withUniverse(SCAN_REQUEST), "tester"),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the factory is never called when the input is absent — zero cost for existing runs", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      let calls = 0;
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          universeDepsFor: async () => {
            calls += 1;
            return fakeUniverseDeps();
          },
        }),
      );
      const runId = "universe-host:panel:nofactory:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(strategyScreenJobDefinition(jobId, PANEL_REQUEST, "tester"));
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(calls).toBe(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an input with no bound factory refuses by name, before any execution", async () => {
    const { stores } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const jobId = optionsScreenJobId("universe-host:nofactory:1");
    await control.defineJob(
      optionsScreenJobDefinition(jobId, withUniverse(DISCOVERY_MANUAL_REQUEST), "tester"),
    );
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    try {
      await registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never);
      expect.unreachable("the step must refuse when the input has no factory");
    } catch (err) {
      expect((err as Error).message).toMatch(/universe/);
      expect((err as Error).message).toMatch(/universe-host:nofactory:1/);
    }
  });

  it("a factory failure surfaces with its code intact", async () => {
    const { stores } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores, {
        universeDepsFor: async () => {
          throw new OptionsStepPortsError(
            "stage_port_unavailable",
            "universe factory boom for the test",
          );
        },
      }),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const jobId = optionsScreenJobId("universe-host:factoryboom:1");
    await control.defineJob(
      optionsScreenJobDefinition(jobId, withUniverse(DISCOVERY_MANUAL_REQUEST), "tester"),
    );
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "stage_port_unavailable",
        message: expect.stringContaining("universe factory boom"),
      }),
    );
  });
});

describe("residency factory resolves live deps from the stage input (#4473)", () => {
  it("resolves listings through the route bundle over D1 ports, with no sql handle anywhere", async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    const deps = await resolveUniverseDepsFromStageInput(
      {} as Env,
      { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
      {
        ports: fakeProviderPorts({ onOutcome: (meta) => outcomes.push(meta) }),
        fetchListings: async () => LISTINGS,
        blobStorage: null,
      },
    );
    const listings = await deps.fetchListings();
    expect(listings.map((listing) => listing.symbol)).toEqual(["AAPL", "MSFT"]);
    // The run context round-trips: captures/outcomes attribute to
    // the engine run, the acting login, and the default tenant —
    // the values the firer and evaluate route thread today, minus
    // the firer's fresh-UUID exception (the engine run id is the
    // run's id in the residency).
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes[0]).toMatchObject({
      providerId: "nasdaq",
      capability: "screenUniverse",
      runId: "engine-run-4473",
      tenantId: "default",
      userLogin: "tester",
    });
  });

  it("the input's tenantId rides the run context", async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    const deps = await resolveUniverseDepsFromStageInput(
      {} as Env,
      {
        userLogin: "tester",
        runId: "engine-run-4473",
        universe: { provider: "nasdaq", tenantId: "tenant-9" },
      },
      {
        ports: fakeProviderPorts({ onOutcome: (meta) => outcomes.push(meta) }),
        fetchListings: async () => LISTINGS,
        blobStorage: null,
      },
    );
    await deps.fetchListings();
    expect(outcomes[0]).toMatchObject({ tenantId: "tenant-9" });
  });

  it("an unbound residency (no AGENT_DB, no injected ports) refuses by name", async () => {
    await expect(
      resolveUniverseDepsFromStageInput(
        {} as Env,
        { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
        { fetchListings: async () => LISTINGS },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    try {
      await resolveUniverseDepsFromStageInput(
        {} as Env,
        { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
        { fetchListings: async () => LISTINGS },
      );
      expect.unreachable("the factory must refuse when the D1 ports are unbound");
    } catch (err) {
      expect((err as Error).message).toMatch(/AGENT_DB/);
    }
  });

  it("a route that does not name nasdaq refuses by name, naming the route", async () => {
    await expect(
      resolveUniverseDepsFromStageInput(
        {} as Env,
        { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
        {
          ports: fakeProviderPorts({ routePrimary: "yahoo" }),
          fetchListings: async () => LISTINGS,
          blobStorage: null,
        },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    try {
      await resolveUniverseDepsFromStageInput(
        {} as Env,
        { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
        {
          ports: fakeProviderPorts({ routePrimary: "yahoo" }),
          fetchListings: async () => LISTINGS,
          blobStorage: null,
        },
      );
      expect.unreachable("the factory must refuse when the route names another primary");
    } catch (err) {
      expect((err as Error).message).toMatch(/screenUniverse/);
    }
  });

  it("full capture when a blob store is bound, outcome-only without it (the established split)", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const blobStorage: CaptureBlobStorage = {
      get: async () => undefined,
      put: async () => {},
    };
    const withStorage = await resolveUniverseDepsFromStageInput(
      {} as Env,
      { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
      {
        ports: fakeProviderPorts({ onCapture: (input) => captures.push(input) }),
        fetchListings: async () => LISTINGS,
        blobStorage,
      },
    );
    await withStorage.fetchListings();
    expect(captures.length).toBeGreaterThanOrEqual(1);
    expect(captures[0]).toMatchObject({ providerId: "nasdaq", capability: "screenUniverse" });

    const outcomes: Array<Record<string, unknown>> = [];
    const withoutStorage = await resolveUniverseDepsFromStageInput(
      {} as Env,
      { userLogin: "tester", runId: "engine-run-4473", universe: UNIVERSE_INPUT },
      {
        ports: fakeProviderPorts({
          onOutcome: (meta) => outcomes.push(meta),
          onCapture: (input) => captures.push(input),
        }),
        fetchListings: async () => LISTINGS,
        blobStorage: null,
      },
    );
    const before = captures.length;
    await withoutStorage.fetchListings();
    expect(captures.length).toBe(before);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("the workflow wiring binds the factory, refusing honestly on an unbound env", async () => {
    const { stores } = fakeStores();
    const deps = optionsStepDepsForWorkflow({} as Env, stores);
    expect(typeof deps.universeDepsFor).toBe("function");
    await expect(
      deps.universeDepsFor!({
        userLogin: "tester",
        runId: "engine-run-4473",
        universe: UNIVERSE_INPUT,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
  });
});

describe("start seams stamp the universe stage input (#4473)", () => {
  it("the strategy seam stamps the input on the stored request", async () => {
    const { stores, runRecorder } = fakeStores();
    const started = await startStrategyScreenWorkflow(
      {} as Env,
      {
        runId: "universe-seam:strategy:1",
        request: PANEL_REQUEST,
        userLogin: "tester",
        universe: { provider: "nasdaq", tenantId: "tenant-9" },
      },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-universe-1" }),
      },
    );
    const definition = await stores.definitions.getDefinition(started.jobId);
    const classInput = (
      definition?.rawConfig as { request?: { classInput?: Record<string, unknown> } } | null
    )?.request?.classInput;
    expect(classInput?.universeDeps).toEqual({ provider: "nasdaq", tenantId: "tenant-9" });
    // The shape payload is untouched by the stamp.
    expect(classInput?.strategyRequest).toEqual(PANEL_REQUEST.classInput.strategyRequest);
  });

  it("without the input, the stored request carries no universe key (byte-identical for existing callers)", async () => {
    const { stores, runRecorder } = fakeStores();
    const started = await startStrategyScreenWorkflow(
      {} as Env,
      { runId: "universe-seam:strategy:2", request: PANEL_REQUEST, userLogin: "tester" },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-universe-2" }),
      },
    );
    const definition = await stores.definitions.getDefinition(started.jobId);
    const classInput = (
      definition?.rawConfig as { request?: { classInput?: Record<string, unknown> } } | null
    )?.request?.classInput;
    expect(classInput && "universeDeps" in classInput).toBe(false);
  });

  it("an invalid input is refused synchronously, with no job defined", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      startStrategyScreenWorkflow(
        {} as Env,
        {
          runId: "universe-seam:strategy:bad",
          request: PANEL_REQUEST,
          userLogin: "tester",
          universe: { provider: "yahoo" } as unknown as UniverseDepsStageInput,
        },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "never" }),
        },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_request_unrecognized" }),
    );
    const definition = await stores.definitions.getDefinition(
      strategyScreenJobId("universe-seam:strategy:bad"),
    );
    expect(definition).toBeNull();
  });

  it("the options seam stamps the input on the stored request", async () => {
    const { stores, runRecorder } = fakeStores();
    const started = await startOptionsScreenWorkflow(
      {} as Env,
      {
        runId: "universe-seam:options:1",
        request: SYMBOL_MANUAL_REQUEST,
        userLogin: "tester",
        universe: UNIVERSE_INPUT,
      },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-universe-3" }),
      },
    );
    const definition = await stores.definitions.getDefinition(started.jobId);
    const classInput = (
      definition?.rawConfig as { request?: { classInput?: Record<string, unknown> } } | null
    )?.request?.classInput;
    expect(classInput?.universeDeps).toEqual({ provider: "nasdaq" });
  });

  it("the goal seam dispatches a discovery-mode leg carrying the input, stamping both ids", async () => {
    const { stores, runRecorder } = fakeStores();
    const discoveryGoal = {
      ...DISCOVERY_GOAL_REQUEST,
      classInput: {
        goalPlan: {
          goal: "screen the universe",
          optionsFilter: { minDte: 21, maxDte: 60 },
        },
      },
    };
    const started = await startGoalOptionsLegWorkflow(
      {} as Env,
      {
        runId: "universe-seam:goal:1",
        request: discoveryGoal,
        goalRunId: GOAL_RUN_ID,
        userLogin: "tester",
        universe: UNIVERSE_INPUT,
      },
      {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-universe-4" }),
      },
    );
    const definition = await stores.definitions.getDefinition(started.jobId);
    const goalPlan = (
      definition?.rawConfig as {
        request?: { classInput?: { goalPlan?: Record<string, unknown>; universeDeps?: unknown } };
      } | null
    )?.request?.classInput;
    expect(goalPlan?.goalPlan?.goalRunId).toBe(GOAL_RUN_ID);
    expect(goalPlan?.universeDeps).toEqual({ provider: "nasdaq" });
  });

  it("the goal seam still refuses a discovery-mode leg carrying no input, naming the input", async () => {
    const { stores, runRecorder } = fakeStores();
    const discoveryGoal = {
      ...DISCOVERY_GOAL_REQUEST,
      classInput: {
        goalPlan: {
          goal: "screen the universe",
          optionsFilter: { minDte: 21, maxDte: 60 },
        },
      },
    };
    await expect(
      startGoalOptionsLegWorkflow(
        {} as Env,
        {
          runId: "universe-seam:goal:2",
          request: discoveryGoal,
          goalRunId: GOAL_RUN_ID,
          userLogin: "tester",
        },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "never" }),
        },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    try {
      await startGoalOptionsLegWorkflow(
        {} as Env,
        {
          runId: "universe-seam:goal:2",
          request: discoveryGoal,
          goalRunId: GOAL_RUN_ID,
          userLogin: "tester",
        },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "never" }),
        },
      );
      expect.unreachable("the goal seam must refuse a discovery-mode leg with no universe input");
    } catch (err) {
      expect((err as Error).message).toMatch(/universe/);
    }
    const definition = await stores.definitions.getDefinition(
      optionsScreenJobId("universe-seam:goal:2"),
    );
    expect(definition).toBeNull();
  });
});

describe("end to end: the real factory through the resolving steps (#4473)", () => {
  it("start → flow: a discovery-mode manual screen resolves listings through the real factory over fake D1 ports", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      AAPL: makeChain("AAPL"),
      MSFT: makeChain("MSFT"),
    });
    DynamicOptionsScreener.setTestListingsFixture(null);
    try {
      const { stores, runRecorder } = fakeStores();
      const outcomes: Array<Record<string, unknown>> = [];
      const ports = fakeProviderPorts({ onOutcome: (meta) => outcomes.push(meta) });
      const started = await startOptionsScreenWorkflow(
        {} as Env,
        {
          runId: "universe-e2e:manual:1",
          request: DISCOVERY_MANUAL_REQUEST,
          userLogin: "tester",
          universe: UNIVERSE_INPUT,
        },
        {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-universe-e2e-1" }),
        },
      );
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          env: {} as unknown as Env,
          // The REAL factory, with the D1 ports + listings fetcher
          // injected (the production wiring builds the ports from
          // env; the injection seam is the bundle's own test hook).
          universeDepsFor: async (args) =>
            resolveUniverseDepsFromStageInput({} as Env, args, {
              ports,
              fetchListings: async () => LISTINGS,
              blobStorage: null,
            }),
        }),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId: started.jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      const storage = optionsStageStorageFromArtifacts(stores.artifacts, outcome.runId);
      const screened = await storage.get<{ result: { totalUnderlyingsScanned: number } }>(
        optionsArtifactKey("universe-e2e:manual:1", "screen"),
      );
      expect(screened?.result.totalUnderlyingsScanned).toBe(2);
      // The factory resolved for the engine run id, not the
      // dispatch run id: captures attribute to the engine run.
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      expect(outcomes[0]).toMatchObject({
        runId: outcome.runId,
        userLogin: "tester",
        tenantId: "default",
      });
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });
});

describe("the #4450 gate stands unchanged (#4473)", () => {
  it("a discovery-mode screen still routes to sync — the route stamps no universe input", () => {
    const decision = manualScreenDispatchRoute({
      broker: "etrade",
      filter: {},
      env: {} as Env,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/4473/);
  });
});

