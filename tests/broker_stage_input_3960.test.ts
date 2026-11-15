/**
 * Issue #3960 — provider/broker selection travels as a stage input.
 *
 * Before this slice, the workflow residency bound the chain source
 * directly: `optionsStepDepsForWorkflow` constructed one broker's
 * client from env + login, and the host-side mirror did the same —
 * so a run's provider/broker selection lived nowhere the engine
 * could see, and every leg that needed a different broker (or a
 * different mode) stayed on the sync dispatch. The tenant's
 * independent dataProviderId/brokerId selections had no engine
 * representation at all.
 *
 * This slice carries a SERIALIZABLE stage input on the stored
 * dispatch request (classInput.broker): the (broker, mode) pair —
 * the broker id from the catalog plus the first-class trading
 * mode (#3451: paper | live), per-stage/per-run, never a global
 * or per-tenant singleton. The resolving steps decode it per
 * invocation; the residency factory resolves the chain source
 * from the pair through the trading platform registry (the
 * existing broker-neutral seam), adapting the platform through
 * platformChainSource (#3272); the shared rebuild constructs
 * every screener with the resolved source. Runs carrying no
 * input dispatch exactly as before: the factory constructs the
 * legacy client, byte-identically.
 *
 * These tests prove: the decode (absent / valid / malformed —
 * never guessed), the residency factory (legacy path, pair
 * resolution, mode→environment mapping, no-data-plane and
 * unregistered-broker refusals, multi-pair independence, real
 * registry construction for every catalog broker), the resolving
 * steps' contract (decode before execution, no-factory refusal,
 * the comparison step), the start seams stamping the input, and
 * composition with #4473's universe input on one run. The #4450
 * gate is pinned UNCHANGED: the manual route stamps no input, so
 * non-residency-broker and discovery-mode screens stay on sync
 * until a cutover slice decides otherwise.
 *
 * Honesty notes: fixture chains intercept the screener's fetches
 * (the #4271 idiom); the factory's platform resolver is injected
 * in the unit tests and the real registry is exercised for
 * construction only — no live broker call, no live chain fetch,
 * no real workflow.create (the injected startWorkflow seam, as
 * in #4291). Credential absence is NOT a factory refusal: it
 * surfaces at the first chain fetch through the platform's own
 * error, exactly as the legacy path behaves today.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
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
  COMPARISON_STEP,
  OPTIONS_SCREEN_STEP,
  comparisonJobDefinition,
  comparisonJobId,
  optionsScreenJobDefinition,
  optionsScreenJobId,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  BROKER_STAGE_INPUT_KEY,
  decodeBrokerStageInput,
  decodeUniverseDepsStageInput,
  OptionsStepPortsError,
  stampBrokerStageInput,
  validateBrokerStageInput,
  type BrokerStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  startComparisonWorkflow,
  startGoalOptionsLegWorkflow,
  startOptionsScreenWorkflow,
  startStrategyScreenWorkflow,
} from "../src/workflows/optionsWorkflowHost";
import { optionsStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import { manualScreenDispatchRoute } from "../src/agents/routes/etradeOptionsScreen";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { ETradeRestClient } from "../src/trading";
import type { ITradingPlatform, OptionChainSource } from "../src/trading";
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

const BROKER_INPUT: BrokerStageInput = { broker: "alpaca", mode: "paper" };

/** A stored dispatch request carrying the broker stage input on classInput. */
function withBroker<T extends { classInput: Record<string, unknown> }>(
  request: T,
  broker: BrokerStageInput = BROKER_INPUT,
): T {
  return {
    ...request,
    classInput: { ...request.classInput, [BROKER_STAGE_INPUT_KEY]: broker },
  };
}

const SYMBOL_MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "broker-host-manual" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const DISCOVERY_MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "broker-host-manual-discovery" },
  trigger: "manual",
  classInput: { request: { filter: { minDte: 14, maxDte: 60, maxUnderlyings: 10 } } },
};

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "broker-host-panel" },
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

const COMPARISON_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "broker-host-comparison" },
  trigger: "manual",
  classInput: {
    comparisonRequest: {
      request: {
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
      riskProfile: "balanced",
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

/** A fake platform whose chain methods record their calls. */
function fakePlatform(overrides: Partial<ITradingPlatform> = {}): ITradingPlatform & {
  chainCalls: Array<{ params: unknown; budget: unknown }>;
  expiryCalls: Array<{ symbol: string }>;
  errorValue: string | undefined;
} {
  const platform = {
    chainCalls: [] as Array<{ params: unknown; budget: unknown }>,
    expiryCalls: [] as Array<{ symbol: string }>,
    errorValue: undefined as string | undefined,
    getOptionChains: async (params: unknown, budget: unknown) => {
      platform.chainCalls.push({ params, budget });
      return makeChain("AAPL");
    },
    getOptionExpireDates: async (symbol: string) => {
      platform.expiryCalls.push({ symbol });
      return [expiryAtDte(30)];
    },
    getLastError: () => platform.errorValue,
    ...overrides,
  };
  return platform as unknown as ITradingPlatform & {
    chainCalls: Array<{ params: unknown; budget: unknown }>;
    expiryCalls: Array<{ symbol: string }>;
    errorValue: string | undefined;
  };
}

describe("broker stage input decode (#3960)", () => {
  it("absent input decodes to undefined — existing runs are untouched", () => {
    expect(decodeBrokerStageInput(null, "run-1")).toBeUndefined();
    expect(decodeBrokerStageInput(undefined, "run-1")).toBeUndefined();
    expect(decodeBrokerStageInput({}, "run-1")).toBeUndefined();
    expect(decodeBrokerStageInput({ classInput: {} }, "run-1")).toBeUndefined();
    expect(
      decodeBrokerStageInput({ classInput: { request: { filter: {} } } }, "run-1"),
    ).toBeUndefined();
  });

  it("a valid input decodes through, for every catalog broker and both modes", () => {
    for (const broker of ["etrade", "alpaca", "public"] as const) {
      for (const mode of ["paper", "live"] as const) {
        expect(
          decodeBrokerStageInput({ classInput: { broker: { broker, mode } } }, "run-1"),
        ).toEqual({ broker, mode });
      }
    }
  });

  it("a malformed input refuses by name, never guessed", () => {
    const malformed: Array<[string, unknown]> = [
      ["not an object", "alpaca"],
      ["array", [{ broker: "alpaca", mode: "paper" }]],
      ["missing broker", { mode: "paper" }],
      ["missing mode", { broker: "alpaca" }],
      ["unknown broker", { broker: "schwab", mode: "paper" }],
      ["legacy sandbox alias", { broker: "sandbox", mode: "paper" }],
      ["case-folded broker", { broker: "ETrade", mode: "paper" }],
      ["non-string broker", { broker: 7, mode: "paper" }],
      ["caps mode", { broker: "alpaca", mode: "PAPER" }],
      ["environment token as mode", { broker: "alpaca", mode: "TEST" }],
      ["live token as mode", { broker: "alpaca", mode: "LIVE" }],
      ["padded mode", { broker: "alpaca", mode: "paper " }],
      ["non-string mode", { broker: "alpaca", mode: 1 }],
      ["empty object", {}],
    ];
    for (const [label, value] of malformed) {
      try {
        validateBrokerStageInput(value, "run-malformed-1");
        expect.unreachable(`the ${label} input must refuse`);
      } catch (err) {
        expect(err).toBeInstanceOf(OptionsStepPortsError);
        expect((err as OptionsStepPortsError).code).toBe("stage_request_unrecognized");
        expect((err as Error).message).toMatch(/run-malformed-1/);
      }
      expect(() =>
        decodeBrokerStageInput({ classInput: { broker: value } }, "run-malformed-1"),
      ).toThrowError(
        expect.objectContaining({ code: "stage_request_unrecognized" }),
      );
    }
  });

  it("extra fields are ignored for forward compatibility", () => {
    expect(
      decodeBrokerStageInput(
        { classInput: { broker: { broker: "alpaca", mode: "live", tenantId: "t-1" } } },
        "run-1",
      ),
    ).toEqual({ broker: "alpaca", mode: "live" });
  });

  it("stamping copies — the caller's request is never mutated", () => {
    const request = { classInput: { request: { filter: {} } } };
    const stamped = stampBrokerStageInput(request, BROKER_INPUT) as {
      classInput: Record<string, unknown>;
    };
    expect(stamped.classInput[BROKER_STAGE_INPUT_KEY]).toEqual(BROKER_INPUT);
    expect(stamped.classInput.request).toEqual({ filter: {} });
    expect(request.classInput).toEqual({ request: { filter: {} } });
    expect(stamped).not.toBe(request);
    expect(stamped.classInput).not.toBe(request.classInput);
    const bare = stampBrokerStageInput({}, BROKER_INPUT) as {
      classInput: Record<string, unknown>;
    };
    expect(bare.classInput[BROKER_STAGE_INPUT_KEY]).toEqual(BROKER_INPUT);
  });
});

describe("residency factory resolves the chain source from the stage input (#3960)", () => {
  it("no descriptor — the legacy client, byte-identical (same construction, no override)", () => {
    const env = {} as Env;
    const source = resolveChainSourceForRequest(env, {
      userLogin: "tester",
      request: SYMBOL_MANUAL_REQUEST,
      runId: "broker-legacy:1",
    });
    expect(source).toBeInstanceOf(ETradeRestClient);
    const client = source as ETradeRestClient;
    expect(client.userLogin).toBe("tester");
    expect(client.env).toBe(env);
    expect(client.overrideEnv).toBeUndefined();
  });

  it("no login — no source, with or without a descriptor", () => {
    expect(
      resolveChainSourceForRequest({} as Env, {
        userLogin: undefined,
        request: SYMBOL_MANUAL_REQUEST,
        runId: "broker-nologin:1",
      }),
    ).toBeUndefined();
    expect(
      resolveChainSourceForRequest({} as Env, {
        userLogin: undefined,
        request: withBroker(SYMBOL_MANUAL_REQUEST),
        runId: "broker-nologin:2",
      }),
    ).toBeUndefined();
    expect(
      resolveChainSourceForRequest({} as Env, {
        userLogin: "",
        request: withBroker(SYMBOL_MANUAL_REQUEST),
        runId: "broker-nologin:3",
      }),
    ).toBeUndefined();
  });

  it("a pair resolves through the platform resolver with the mode's environment token", () => {
    const calls: Array<{ broker: string; overrideEnv: string | undefined; login: string }> = [];
    const platform = fakePlatform();
    const env = { SOME: "env" } as unknown as Env;
    for (const [broker, mode, token] of [
      ["alpaca", "paper", "TEST"],
      ["alpaca", "live", "PROD"],
      ["etrade", "paper", "TEST"],
      ["public", "live", "PROD"],
    ] as const) {
      const source = resolveChainSourceForRequest(
        env,
        {
          userLogin: "tester",
          request: withBroker(SYMBOL_MANUAL_REQUEST, { broker, mode }),
          runId: `broker-pair:${broker}:${mode}`,
        },
        {
          resolvePlatform: (resolvedBroker, _env, login, overrideEnv) => {
            calls.push({ broker: resolvedBroker, overrideEnv, login });
            return platform;
          },
        },
      );
      expect(source).toBeDefined();
      // The screener resolves its config from the source's env +
      // overrideEnv — the pair's environment must ride the source.
      expect((source as OptionChainSource & { env?: unknown }).env).toBe(env);
      expect((source as OptionChainSource).overrideEnv).toBe(token);
    }
    expect(calls).toEqual([
      { broker: "alpaca", overrideEnv: "TEST", login: "tester" },
      { broker: "alpaca", overrideEnv: "PROD", login: "tester" },
      { broker: "etrade", overrideEnv: "TEST", login: "tester" },
      { broker: "public", overrideEnv: "PROD", login: "tester" },
    ]);
  });

  it("the resolved source delegates chain fetches to the platform, with a live lastError", async () => {
    const platform = fakePlatform();
    const source = resolveChainSourceForRequest(
      {} as Env,
      {
        userLogin: "tester",
        request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "alpaca", mode: "live" }),
        runId: "broker-delegate:1",
      },
      { resolvePlatform: () => platform },
    ) as OptionChainSource;
    expect(source.supportsOptionRequestBudget).toBe(true);
    const budget = { remaining: 10 } as never;
    await source.getOptionChains({ symbol: "AAPL" }, budget);
    await source.getOptionExpireDates("AAPL");
    expect(platform.chainCalls).toEqual([{ params: { symbol: "AAPL" }, budget }]);
    expect(platform.expiryCalls).toEqual([{ symbol: "AAPL" }]);
    // lastError is a LIVE getter over the platform — a snapshot
    // taken at construction would freeze it at undefined.
    expect(source.lastError).toBeUndefined();
    platform.errorValue = "upstream boom";
    expect(source.lastError).toBe("upstream boom");
  });

  it("a platform with no options data plane refuses by name, naming broker + mode", () => {
    const noPlane = { getLastError: () => undefined } as unknown as ITradingPlatform;
    try {
      resolveChainSourceForRequest(
        {} as Env,
        {
          userLogin: "tester",
          request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "alpaca", mode: "paper" }),
          runId: "broker-noplane:1",
        },
        { resolvePlatform: () => noPlane },
      );
      expect.unreachable("a platform with no chain methods must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(OptionsStepPortsError);
      expect((err as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((err as Error).message).toMatch(/alpaca/);
      expect((err as Error).message).toMatch(/paper/);
      expect((err as Error).message).toMatch(/broker-noplane:1/);
    }
  });

  it("a resolver failure surfaces as a named refusal with the underlying reason", () => {
    try {
      resolveChainSourceForRequest(
        {} as Env,
        {
          userLogin: "tester",
          request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "etrade", mode: "live" }),
          runId: "broker-boom:1",
        },
        {
          resolvePlatform: () => {
            throw new Error("registry exploded");
          },
        },
      );
      expect.unreachable("a resolver failure must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(OptionsStepPortsError);
      expect((err as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((err as Error).message).toMatch(/registry exploded/);
      expect((err as Error).message).toMatch(/broker-boom:1/);
    }
  });

  it("a named refusal from the resolver keeps its code intact", () => {
    try {
      resolveChainSourceForRequest(
        {} as Env,
        {
          userLogin: "tester",
          request: withBroker(SYMBOL_MANUAL_REQUEST),
          runId: "broker-passthrough:1",
        },
        {
          resolvePlatform: () => {
            throw new OptionsStepPortsError("stage_port_unavailable", "resolver boom for the test");
          },
        },
      );
      expect.unreachable("a named refusal must propagate");
    } catch (err) {
      expect(err).toBeInstanceOf(OptionsStepPortsError);
      expect((err as OptionsStepPortsError).code).toBe("stage_port_unavailable");
      expect((err as Error).message).toBe("resolver boom for the test");
    }
  });

  it("the real registry constructs a source for every catalog broker, with no orm and no I/O", () => {
    for (const broker of ["etrade", "alpaca", "public"] as const) {
      for (const mode of ["paper", "live"] as const) {
        const source = resolveChainSourceForRequest({} as Env, {
          userLogin: "tester",
          request: withBroker(SYMBOL_MANUAL_REQUEST, { broker, mode }),
          runId: `broker-registry:${broker}:${mode}`,
        });
        expect(source).toBeDefined();
        expect(typeof source?.getOptionChains).toBe("function");
        expect(typeof source?.getOptionExpireDates).toBe("function");
        expect(source?.overrideEnv).toBe(mode === "paper" ? "TEST" : "PROD");
      }
    }
  });

  it("multiple pairs resolve simultaneously — no singleton state, no cross-run leakage", () => {
    const seen: Array<{ broker: string; mode: string }> = [];
    const resolvePlatform = (broker: string, _env: Env, _login: string, overrideEnv?: string) => {
      seen.push({ broker, mode: overrideEnv === "PROD" ? "live" : "paper" });
      return fakePlatform();
    };
    const first = resolveChainSourceForRequest(
      {} as Env,
      {
        userLogin: "tester",
        request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "alpaca", mode: "paper" }),
        runId: "broker-multi:1",
      },
      { resolvePlatform: resolvePlatform as never },
    );
    const second = resolveChainSourceForRequest(
      {} as Env,
      {
        userLogin: "tester",
        request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "etrade", mode: "live" }),
        runId: "broker-multi:2",
      },
      { resolvePlatform: resolvePlatform as never },
    );
    const third = resolveChainSourceForRequest(
      {} as Env,
      {
        userLogin: "tester",
        request: withBroker(SYMBOL_MANUAL_REQUEST, { broker: "alpaca", mode: "paper" }),
        runId: "broker-multi:3",
      },
      { resolvePlatform: resolvePlatform as never },
    );
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
    expect(seen).toEqual([
      { broker: "alpaca", mode: "paper" },
      { broker: "etrade", mode: "live" },
      { broker: "alpaca", mode: "paper" },
    ]);
  });
});

describe("resolving steps decode the broker input before execution (#3960)", () => {
  it("a malformed input refuses by name, before any execution, naming the run", async () => {
    const { stores } = fakeStores();
    let factoryCalls = 0;
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores, {
        chainSourceFor: () => {
          factoryCalls += 1;
          return undefined;
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
    const jobId = optionsScreenJobId("broker-host:malformed:1");
    const bad = {
      ...SYMBOL_MANUAL_REQUEST,
      classInput: { ...SYMBOL_MANUAL_REQUEST.classInput, broker: { broker: "schwab", mode: "paper" } },
    };
    await control.defineJob(optionsScreenJobDefinition(jobId, bad, "tester"));
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_request_unrecognized" }),
    );
    expect(factoryCalls).toBe(0);
    try {
      await registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never);
      expect.unreachable("the step must refuse a malformed broker input");
    } catch (err) {
      expect((err as Error).message).toMatch(/broker-host:malformed:1/);
      expect((err as Error).message).toMatch(/schwab/);
    }
  });

  it("an input with no bound chain source refuses by name, before any execution", async () => {
    const { stores } = fakeStores();
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores, { chainSourceFor: undefined }),
    );
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const jobId = optionsScreenJobId("broker-host:nofactory:1");
    await control.defineJob(
      optionsScreenJobDefinition(jobId, withBroker(SYMBOL_MANUAL_REQUEST), "tester"),
    );
    await expect(
      registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_port_unavailable" }),
    );
    try {
      await registry.resolve(OPTIONS_SCREEN_STEP)(stepCtx({ jobId }) as never);
      expect.unreachable("the step must refuse when the input has no chain source");
    } catch (err) {
      expect((err as Error).message).toMatch(/broker/);
      expect((err as Error).message).toMatch(/broker-host:nofactory:1/);
    }
  });

  it("the flow consults the chain source with the pair-carrying request on every step", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const calls: Array<{ login: string | undefined; request: unknown; runId: string }> = [];
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        hostStepDeps(stores, {
          chainSourceFor: (login, request, runId) => {
            calls.push({ login, request, runId });
            return undefined;
          },
        }),
      );
      const runId = "broker-host:panel:factory:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        strategyScreenJobDefinition(
          jobId,
          withBroker(PANEL_REQUEST, { broker: "alpaca", mode: "live" }),
          "tester",
        ),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call.login).toBe("tester");
        expect(call.runId).toBe(runId);
        expect(decodeBrokerStageInput(call.request, runId)).toEqual({
          broker: "alpaca",
          mode: "live",
        });
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the comparison step decodes the input before execution too", async () => {
    const { stores } = fakeStores();
    const calls: unknown[] = [];
    const registry = registerOptionsWorkflowSteps(
      createBuiltinStepRegistry(),
      hostStepDeps(stores, {
        env: {} as Env,
        chainSourceFor: (_login, request) => {
          calls.push(request);
          throw new OptionsStepPortsError("stage_port_unavailable", "sentinel for the test");
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
    const jobId = comparisonJobId("broker-host:comparison:1");
    await control.defineJob(
      comparisonJobDefinition(
        jobId,
        withBroker(COMPARISON_REQUEST, { broker: "etrade", mode: "paper" }),
        "tester",
      ),
    );
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId, params: {} }) as never),
    ).rejects.toThrowError(expect.objectContaining({ message: "sentinel for the test" }));
    expect(calls).toHaveLength(1);
    expect(decodeBrokerStageInput(calls[0], "broker-host:comparison:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    // Malformed: the step refuses before the factory is ever called.
    const badJobId = comparisonJobId("broker-host:comparison:bad");
    const bad = {
      ...COMPARISON_REQUEST,
      classInput: { ...COMPARISON_REQUEST.classInput, broker: { broker: "alpaca", mode: "LIVE" } },
    };
    await control.defineJob(comparisonJobDefinition(badJobId, bad, "tester"));
    await expect(
      registry.resolve(COMPARISON_STEP)(stepCtx({ jobId: badJobId, params: {} }) as never),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_request_unrecognized" }),
    );
    expect(calls).toHaveLength(1);
  });
});

describe("start seams stamp the broker stage input (#3960)", () => {
  it("the options seam stamps the input on the stored request", async () => {
    const { stores, runRecorder } = fakeStores();
    const { jobId } = await startOptionsScreenWorkflow(
      {} as Env,
      {
        runId: "broker-seam:options:1",
        request: SYMBOL_MANUAL_REQUEST,
        userLogin: "tester",
        broker: { broker: "alpaca", mode: "paper" },
      },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
    );
    expect(jobId).toBe(optionsScreenJobId("broker-seam:options:1"));
    const definition = await stores.definitions.getDefinition(jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "broker-seam:options:1")).toEqual({
      broker: "alpaca",
      mode: "paper",
    });
    // The caller's request is never mutated.
    expect(SYMBOL_MANUAL_REQUEST.classInput).not.toHaveProperty(BROKER_STAGE_INPUT_KEY);
  });

  it("the strategy seam stamps the input (via the shared start)", async () => {
    const { stores, runRecorder } = fakeStores();
    const { jobId } = await startStrategyScreenWorkflow(
      {} as Env,
      {
        runId: "broker-seam:strategy:1",
        request: PANEL_REQUEST,
        userLogin: "tester",
        broker: { broker: "etrade", mode: "live" },
      },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
    );
    const definition = await stores.definitions.getDefinition(jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "broker-seam:strategy:1")).toEqual({
      broker: "etrade",
      mode: "live",
    });
  });

  it("the comparison seam stamps the input", async () => {
    const { stores, runRecorder } = fakeStores();
    const { jobId } = await startComparisonWorkflow(
      {} as Env,
      {
        runId: "broker-seam:comparison:1",
        request: COMPARISON_REQUEST,
        userLogin: "tester",
        broker: { broker: "public", mode: "paper" },
      },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
    );
    expect(jobId).toBe(comparisonJobId("broker-seam:comparison:1"));
    const definition = await stores.definitions.getDefinition(jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "broker-seam:comparison:1")).toEqual({
      broker: "public",
      mode: "paper",
    });
  });

  it("the goal seam stamps the input beside the goal run id", async () => {
    const { stores, runRecorder } = fakeStores();
    const goalRequest = {
      assetClass: "options",
      runIdentity: { runId: "broker-seam:goal:1" },
      trigger: "manual",
      classInput: {
        goalPlan: {
          goal: "screen the symbols",
          optionsFilter: { underlyingSymbols: ["AAPL"], minDte: 14, maxDte: 60 },
        },
      },
    };
    const { jobId } = await startGoalOptionsLegWorkflow(
      {} as Env,
      {
        runId: "broker-seam:goal:1",
        request: goalRequest,
        goalRunId: "goal-run-3960",
        userLogin: "tester",
        broker: { broker: "alpaca", mode: "live" },
      },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
    );
    expect(jobId).toBe(optionsScreenJobId("broker-seam:goal:1"));
    const definition = await stores.definitions.getDefinition(jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request as {
      classInput: { goalPlan: { goalRunId?: string } };
    };
    expect(stored.classInput.goalPlan.goalRunId).toBe("goal-run-3960");
    expect(decodeBrokerStageInput(stored, "broker-seam:goal:1")).toEqual({
      broker: "alpaca",
      mode: "live",
    });
  });

  it("an invalid input is refused synchronously, with no job defined", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      startStrategyScreenWorkflow(
        {} as Env,
        {
          runId: "broker-seam:strategy:bad",
          request: PANEL_REQUEST,
          userLogin: "tester",
          broker: { broker: "alpaca", mode: "PROD" } as unknown as BrokerStageInput,
        },
        { stores, runRecorder, startWorkflow: async () => ({ instanceId: "never" }) },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "stage_request_unrecognized" }),
    );
    const definition = await stores.definitions.getDefinition(
      strategyScreenJobId("broker-seam:strategy:bad"),
    );
    expect(definition).toBeNull();
  });

  it("without the input, the stored request carries no broker key (byte-identical for existing callers)", async () => {
    const { stores, runRecorder } = fakeStores();
    const { jobId } = await startStrategyScreenWorkflow(
      {} as Env,
      { runId: "broker-seam:strategy:plain", request: PANEL_REQUEST, userLogin: "tester" },
      { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
    );
    const definition = await stores.definitions.getDefinition(jobId);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(stored).toEqual(PANEL_REQUEST);
    expect(decodeBrokerStageInput(stored, "broker-seam:strategy:plain")).toBeUndefined();
  });
});

describe("end to end: both stage inputs on one run (#3960 + #4473)", () => {
  it("start → flow: a panel screen carrying the broker + universe inputs resolves both", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const env = {} as Env;
      let universeCalls = 0;
      const deps: OptionsWorkflowStepDeps = {
        ...optionsStepDepsForWorkflow(env, stores),
        universeDepsFor: async () => {
          universeCalls += 1;
          return { fetchListings: async () => [] };
        },
      };
      const flowDeps = hostFlowDeps(stores, runRecorder, deps);
      const runId = "broker-e2e:panel:1";
      const { jobId } = await startStrategyScreenWorkflow(
        env,
        {
          runId,
          request: PANEL_REQUEST,
          userLogin: "tester",
          broker: { broker: "alpaca", mode: "paper" },
          universe: { provider: "nasdaq" },
        },
        { stores, runRecorder, startWorkflow: async () => ({ instanceId: "wf-1" }) },
      );
      const definition = await stores.definitions.getDefinition(jobId);
      const stored = (definition?.rawConfig as { request?: unknown })?.request;
      expect(decodeBrokerStageInput(stored, runId)).toEqual({
        broker: "alpaca",
        mode: "paper",
      });
      expect(decodeUniverseDepsStageInput(stored, runId)).toEqual({ provider: "nasdaq" });
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
      expect(universeCalls).toBeGreaterThanOrEqual(1);
      const view = await readOptionsWorkflowRun({ stores, runRecorder }, jobId);
      expect(view.state).toBe("completed");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("a run with no broker input flows through the legacy path unchanged", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { stores, runRecorder } = fakeStores();
      const env = {} as Env;
      const flowDeps = hostFlowDeps(
        stores,
        runRecorder,
        optionsStepDepsForWorkflow(env, stores),
      );
      const runId = "broker-e2e:legacy:1";
      const jobId = strategyScreenJobId(runId);
      const control = new JobPipelineControl(flowDeps);
      await control.defineJob(
        strategyScreenJobDefinition(jobId, PANEL_REQUEST, "tester"),
      );
      const outcome = await runJobPipelineWorkflowFlow(flowDeps, recordingJournal().step, {
        jobId,
        trigger: "manual",
      });
      expect(outcome.state).toBe("completed");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});

describe("the #4450 gate stands unchanged (#3960)", () => {
  it("a non-residency-broker screen still routes to sync — the route stamps no input", () => {
    expect(
      manualScreenDispatchRoute({
        broker: "alpaca",
        filter: { underlyingSymbols: ["AAPL"] },
        env: { AGENT_DB: {}, JOB_PIPELINE_WORKFLOW: { create: () => {} } } as unknown as Env,
      }).route,
    ).toBe("sync");
    expect(
      manualScreenDispatchRoute({
        broker: "etrade",
        filter: {},
        env: { AGENT_DB: {}, JOB_PIPELINE_WORKFLOW: { create: () => {} } } as unknown as Env,
      }).route,
    ).toBe("sync");
    expect(
      manualScreenDispatchRoute({
        broker: "etrade",
        filter: { underlyingSymbols: ["AAPL"] },
        env: { AGENT_DB: {}, JOB_PIPELINE_WORKFLOW: { create: () => {} } } as unknown as Env,
      }).route,
    ).toBe("host");
  });
});
