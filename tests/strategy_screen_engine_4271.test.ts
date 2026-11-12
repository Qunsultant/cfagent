/**
 * Issue #4271 (#3552 S1) — the strategy screen on the J1–J7 engine as a
 * first-class workflow: a dedicated strategy job definition
 * (strategyScreenJobDefinition, job id `strategy-screen:<runId>`) that
 * the strategy dispatch defines and runs, instead of riding the options
 * job. The job is the same eight-node tree as the options job (one
 * child per options stage, one `options.runStage` step each, sync
 * delivery) with a strategy identity — root kind "strategy-screen" —
 * so a strategy screen is visible as its own job in Workflow Runs with
 * its own pipeline record and run history. The stages, steps, and
 * execution are identical to the options dispatch; only the job
 * identity changes.
 *
 * These tests prove the job definition shape, that the strategy
 * dispatch defines and records the strategy job (durably, over SQL
 * stores), and that the shared panel/scan helpers define strategy jobs
 * too. The options job is unchanged (see options_screen_engine_4068).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import {
  optionsEngineStoresFromSql,
  OPTIONS_SCREEN_ROOT_STEP,
  OPTIONS_SCREEN_STEP,
  runOptionsPanelViaEngine,
  runOptionsScanViaEngine,
  runStrategyScreenViaEngine,
  strategyScreenJobDefinition,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  memoryStageStorage,
  type OptionsStagePort,
} from "../src/workflows/optionsScreenWorkflow";
import { OPTIONS_PIPELINE_STAGES, type OptionsPipelineStage } from "../src/workflows/stageRuntimeIds";
import type { StageClaimStore } from "../src/workflows/stageReportConsumer";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ScanRunStore } from "../src/data/scanRunPorts";
import type { ScanRequestTemplate, StrategyRequest } from "../src/trading";

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

function baseTemplate(): ScanRequestTemplate {
  const target = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  return {
    thesis: "bullish",
    targetDate: target,
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
  };
}

function baseStrategyRequest(): StrategyRequest {
  const target = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  return {
    symbol: "AAPL",
    thesis: "bullish",
    targetPrice: 105,
    targetDate: target,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    // The strategy engine iterates allowedStrategies when building
    // candidates (registry.resolveMany) — an absent list throws
    // "names is not iterable" in the view-structure builder.
    allowedStrategies: ["long_call"],
    minDte: 14,
    maxDte: 60,
  };
}

/** The node:sqlite DO-storage double (tests/feed_pipeline_host_3543 idiom). */
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

function stubPorts(order: string[] = []): {
  ports: Record<OptionsPipelineStage, OptionsStagePort>;
  calls: string[];
} {
  const calls: string[] = [];
  const ports = {} as Record<OptionsPipelineStage, OptionsStagePort>;
  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    ports[stageId] = {
      execute: async (input) => {
        calls.push(`execute:${stageId}`);
        order.push(stageId);
        return { stage: stageId, inputArtifactKeys: input.artifactKeys };
      },
      persist: async (_input, output) => {
        calls.push(`persist:${stageId}`);
        return [`strategy:${stageId}:${(output as { stage: string }).stage}`];
      },
    };
  }
  return { ports, calls };
}

function claimsWith(preclaimed: string[] = []): StageClaimStore {
  const claimed = new Set(preclaimed);
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

const REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "strategy-engine-test" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
    },
  },
};

describe("strategy screen on the J engine (#4271)", () => {
  it("defines one strategy job per run: 8 children, one options.runStage step each, sync delivery", () => {
    const jobId = strategyScreenJobId("strategy-test:1");
    expect(jobId).toBe("strategy-screen:strategy-test:1");
    const definition = strategyScreenJobDefinition(jobId) as {
      jobId: string;
      name: string;
      root: {
        kind: string;
        steps: Array<{ step: string }>;
        executionMode: { concurrency: string; pacing: string; delivery: string; shape: string };
        children: Array<{ kind: string; steps: Array<{ step: string; params: { stageId: string } }> }>;
      };
    };
    expect(definition.jobId).toBe(jobId);
    expect(definition.name).toBe(`Strategy screen ${jobId}`);
    expect(definition.root.kind).toBe("strategy-screen");
    // Issue #4066 (carried): the root carries the options.runRoot step,
    // which produces the dispatch request as the run's hand-off — without
    // it no stage has a persisted input and no stage operation can
    // execute (stage_input_missing).
    expect(definition.root.steps).toEqual([{ step: OPTIONS_SCREEN_ROOT_STEP }]);
    expect(definition.root.executionMode).toEqual({
      concurrency: "sequential",
      pacing: "batch",
      delivery: "sync",
      shape: "monolith",
    });
    expect(definition.root.children.map((child) => child.kind)).toEqual([
      ...OPTIONS_PIPELINE_STAGES,
    ]);
    for (const child of definition.root.children) {
      expect(child.steps).toEqual([{ step: OPTIONS_SCREEN_STEP, params: { stageId: child.kind } }]);
    }
  });

  it("rides the dispatch request on the job definition's raw config", () => {
    const jobId = strategyScreenJobId("strategy-test:2");
    const definition = strategyScreenJobDefinition(jobId, REQUEST) as {
      request?: unknown;
    };
    // Issue #4066 (carried): defineJob persists the whole rawConfig, so
    // a later per-stage control action can read the run's request back
    // out of the stored definition and rebuild the step's ports (S2).
    expect(definition.request).toEqual(REQUEST);
  });

  it("the strategy job is not the options job: same stages, different identity", () => {
    const jobId = strategyScreenJobId("strategy-test:3");
    const definition = strategyScreenJobDefinition(jobId) as {
      root: { kind: string; children: Array<{ kind: string }> };
    };
    expect(definition.root.kind).not.toBe("options-screen");
    expect(definition.root.kind).toBe("strategy-screen");
    expect(definition.root.children.map((child) => child.kind)).toEqual([
      ...OPTIONS_PIPELINE_STAGES,
    ]);
  });

  it("dispatches the eight stages through the engine and records the strategy job durably (SQL)", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const runId = "strategy-engine-sql:1";
    const order: string[] = [];
    const { ports } = stubPorts(order);
    const outcome = await runStrategyScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: memoryStageClaims(),
        queue: null,
        warn: () => undefined,
        engineStores,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(order).toEqual([...OPTIONS_PIPELINE_STAGES]);
    const jobId = strategyScreenJobId(runId);
    const latest = await engineStores.runRecorder.latestRun(jobId);
    expect(latest).toBeDefined();
    expect(latest?.jobId).toBe(jobId);
    expect(latest?.outcome).toBe("success");
    expect(latest?.triggeredBy).toBe("manual");
    const definition = await engineStores.stores.definitions.getDefinition(jobId);
    expect(definition?.jobId).toBe(jobId);
    expect(definition?.root.kind).toBe("strategy-screen");
    expect(definition?.root.children?.length).toBe(8);
    // The options job for the same run was never defined: the strategy
    // screen no longer rides it. (getDefinition returns null, not
    // undefined, for a missing definition.)
    const optionsDefinition = await engineStores.stores.definitions.getDefinition(
      `options-screen:${runId}`,
    );
    expect(optionsDefinition).toBeNull();
  });

  it("the panel helper defines a strategy job (not an options job)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const sql = new SqliteTestStorage();
      const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
      const result = await runOptionsPanelViaEngine(
        undefined,
        baseStrategyRequest(),
        {},
        "tester",
        undefined,
        engineStores,
      );
      expect(result).toBeDefined();
      // The engine over a two-contract fixture may rank nothing (the
      // #3186 panel test's discipline: the pin is the envelope shape +
      // the staged run, not a candidate) — the job assertion below is
      // the point of this test.
      expect(Array.isArray(result.ranked)).toBe(true);
      const definitions = await engineStores.stores.definitions.listDefinitions();
      const strategyJobs = definitions.filter(
        (definition) => (definition.root as { kind?: string }).kind === "strategy-screen",
      );
      expect(strategyJobs.length).toBe(1);
      expect(strategyJobs[0]?.jobId.startsWith("strategy-screen:")).toBe(true);
      const optionsJobs = definitions.filter(
        (definition) => (definition.root as { kind?: string }).kind === "options-screen",
      );
      expect(optionsJobs).toHaveLength(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the scan helper defines a strategy job (not an options job)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const sql = new SqliteTestStorage();
      const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
      const saved: Array<{ result: unknown; options: unknown }> = [];
      const scanRunStore = {
        save: async (result: unknown, options: unknown) => {
          saved.push({ result, options });
          return { id: "scan-test-4271" };
        },
      } as unknown as ScanRunStore;
      const result = await runOptionsScanViaEngine(undefined, ["AAPL"], baseTemplate(), {
        scanRunStore,
        userLogin: "tester",
        engineStores,
      });
      expect(result.persisted).toBe(true);
      expect(result.scanRunId).toBe("scan-test-4271");
      const definitions = await engineStores.stores.definitions.listDefinitions();
      const strategyJobs = definitions.filter(
        (definition) => (definition.root as { kind?: string }).kind === "strategy-screen",
      );
      expect(strategyJobs.length).toBe(1);
      expect(strategyJobs[0]?.jobId.startsWith("strategy-screen:")).toBe(true);
      const optionsJobs = definitions.filter(
        (definition) => (definition.root as { kind?: string }).kind === "options-screen",
      );
      expect(optionsJobs).toHaveLength(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
