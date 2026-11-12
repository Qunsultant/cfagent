/**
 * Issue #4066 — phase 2: Options Copilot onto the engine-routed workflow.
 *
 * Outcome 1: the copilot's screening paths (NLQ options actions, the
 * run_options_strategy_screen mesh door) drive the engine-routed
 * workflow and produce one durable pipeline record per run.
 * Outcome 2: the paid surfaces reach the workflow through the engine
 * (their gates are pinned by the agentic-payments + trading-agent +
 * screening-execution-unification suites; here the paid entry's engine
 * result is pinned equal to the manual engine run's — one pipeline).
 * Outcome 3: per-stage chat control works on an options stage from
 * the copilot turn (run / re-run / stop / resume / cancel, pinned
 * meanings), with failures surfaced as named refusals (stage + reason).
 * Outcome 4 (identity) is a record on the issue, not code.
 *
 * The fakes sit only at binding seams: the chain fixture
 * (DynamicOptionsScreener.setTestChainsFixture) stands in for live
 * broker chains; the E*TRADE service is the structural fake the NLQ
 * action itself accepts; the DO storage is the node:sqlite double
 * from the #4068 suite. The engine, the ports, the control plane,
 * and the door are all real.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import {
  optionsEngineStoresFromSql,
  optionsScreenJobId,
  runOptionsPlainScreenViaEngine,
  runOptionsScreenViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../src/workflows/optionsScreenWorkflow";
import {
  createOptionsScreenPorts,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import {
  createScannerScreenPorts,
  createStrategyScreenAgents,
  createStrategyScreenPorts,
} from "../src/workflows/strategyScreenPorts";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { runOptionsStrategyScreenViaDoor } from "../src/agents/orchestrator/meshOptionsStrategyDoor";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ScanRequestTemplate } from "../src/trading";

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
          // The strategy engine rejects legs without implied
          // volatility ("incomplete or unsupported contract data").
          impliedVolatility: 0.25,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
          impliedVolatility: 0.25,
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

/**
 * One host DO's storage: the blob handle (stage artifacts) + the raw
 * SQLite handle (engine stores), the shape the production DO storage
 * carries — the control reads .sql off the same object the legs'
 * pipelineStorage is.
 */
function makeDoStorage(): {
  sql: SqlStorage;
  storage: OptionsStageStorage & { sql: SqlStorage };
} {
  const sql = new SqliteTestStorage() as unknown as SqlStorage;
  const blob = memoryStageStorage();
  return { sql, storage: { ...blob, sql } };
}

function fakeEtrade() {
  return {
    client: undefined,
    fetchQuoteRemote: async () => ({ lastPrice: 100 }),
    getWatchlists: async () => [],
    screenMarketsAsync: async () => ({ stocks: [] }),
  };
}

const MANUAL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "control-manual:1" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

const PANEL_REQUEST = {
  assetClass: "options",
  runIdentity: { runId: "control-panel:1" },
  trigger: "manual",
  classInput: {
    strategyRequest: {
      symbol: "AAPL",
      thesis: "bullish",
      targetPrice: 105,
      // The real engine requires the full viewed request: target
      // date + IV direction + the wanted strategy list (resolveMany
      // iterates allowedStrategies — undefined throws "names is not
      // iterable"). The #3186 fixture used fake agents and omitted them.
      targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      expectedIvDirection: "unchanged",
      minDte: 21,
      maxDte: 60,
      maxPlannedLoss: 5000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
    },
    riskProfile: "balanced",
    alternatives: 3,
  },
};

function scanRequest(runId: string) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      scan: { symbols: ["AAPL"], template: baseTemplate(), options: {} },
      requestRecord: {
        symbols: ["AAPL"],
        targetDate: baseTemplate().targetDate,
        thesis: "bullish",
      },
      broker: "etrade",
    },
  };
}

async function dispatchManual(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
) {
  const request = {
    ...MANUAL_REQUEST,
    runIdentity: { runId },
  };
  const outcome = await runOptionsScreenViaEngine(
    { runId, userLogin: "tester", request },
    {
      stages: createOptionsScreenPorts({
        screener: new DynamicOptionsScreener(undefined),
        storage,
        shapeReport: async ({ screen }) => screen,
        deliver: async () => ({
          terminal: "completed",
          deliveryState: "deferred-to-caller",
        }),
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql),
    },
  );
  return outcome;
}

async function dispatchPanel(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
) {
  const request = {
    ...PANEL_REQUEST,
    runIdentity: { runId },
  };
  const outcome = await runOptionsScreenViaEngine(
    { runId, userLogin: "tester", request },
    {
      stages: createStrategyScreenPorts({
        agents: createStrategyScreenAgents(undefined),
        storage,
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql),
    },
  );
  return outcome;
}

async function dispatchScan(
  sql: SqlStorage,
  storage: OptionsStageStorage,
  runId: string,
) {
  const outcome = await runOptionsScreenViaEngine(
    { runId, userLogin: "tester", request: scanRequest(runId) },
    {
      stages: createScannerScreenPorts({
        agents: createStrategyScreenAgents(undefined),
        storage,
      }),
      claims: memoryStageClaims(),
      queue: null,
      engineStores: optionsEngineStoresFromSql(sql),
    },
  );
  return outcome;
}

async function expectControlError(
  promise: Promise<unknown>,
  code: string,
): Promise<OptionsStageControlError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OptionsStageControlError);
    expect((error as OptionsStageControlError).code).toBe(code);
    return error as OptionsStageControlError;
  }
  throw new Error(`expected a control refusal with code ${code}, but the call succeeded`);
}

describe("options copilot stage control (#4066)", () => {
  it("reruns a completed stage of a durable manual-shape run (fresh claims, same artifacts)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-manual:1";
      const outcome = await dispatchManual(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      const before = await storage.get(`options:${runId}:screen`);
      expect(before).toBeDefined();

      const result = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(result.runId).toBe(runId);
      expect(result.jobId).toBe(optionsScreenJobId(runId));
      expect(result.stage).toBe("screen");
      expect(result.operation).toBe("rerun");
      expect(result.state).toBe("completed");
      expect(result.requestShape).toBe("manual");
      expect(result.stageUnits.some((u) => u.status === "completed")).toBe(true);
      // The re-run re-read the chainFetch artifact and re-wrote the
      // screen artifact — same keys, same shape.
      const after = await storage.get(`options:${runId}:screen`);
      expect(after).toBeDefined();
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("runs a stage and recovers a failed stage once its input exists", async () => {
    // No fixture and no chain source: chainFetch completes partial
    // (0 chains, fetch errors) and the SCREEN stage throws "no chains
    // could be fetched", so the run fails at screen.
    const { sql, storage } = makeDoStorage();
    const runId = "control-manual:failed";
    const outcome = await dispatchManual(sql, storage, runId);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.failedStage).toBe("screen");

    // The fixture appears; re-running screen alone still fails — the
    // re-run reads the persisted chainFetch artifact (0 chains +
    // fetch errors), never live data. Recovery re-runs the pipeline
    // in order: chainFetch, then enrich, then screen.
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const stale = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(stale.state).toBe("failed");
      const refetch = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "chainFetch",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(refetch.state).toBe("completed");
      const reenrich = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "enrich",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(reenrich.state).toBe("completed");
      const recovered = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(recovered.state).toBe("completed");
      expect(recovered.stageUnits.some((u) => u.status === "completed")).toBe(true);
      const screenArtifact = await storage.get<{ result?: { contracts?: unknown[] } }>(
        `options:${runId}:screen`,
      );
      expect(screenArtifact?.result?.contracts?.length).toBeGreaterThan(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("stop/cancel on a completed run refuse with the engine's named codes", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-manual:2";
      const outcome = await dispatchManual(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      const stopped = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "stop",
          userLogin: "tester",
        }),
        "stage_not_stoppable",
      );
      expect(stopped.message).toContain(runId);
      await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "cancel",
          userLogin: "tester",
        }),
        "stage_not_cancellable",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an unknown stage refuses stage_vocabulary_unknown — display stages too", async () => {
    const { sql, storage } = makeDoStorage();
    const runId = "control-manual:3";
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      expect((await dispatchManual(sql, storage, runId)).outcome).toBe("completed");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
    for (const stage of ["feed", "store", "serve", "not_a_stage"]) {
      const error = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage,
          operation: "run",
          userLogin: "tester",
        }),
        "stage_vocabulary_unknown",
      );
      expect(error.message).toContain(stage);
    }
    // "deliver" is both a display stage and execution stage 8, so it
    // IS addressable — it refuses only for the manual shape's
    // unbuildable ports (see below), never for vocabulary.
  });

  it("an unknown run refuses job_not_found by name", async () => {
    const { sql, storage } = makeDoStorage();
    const error = await expectControlError(
      controlOptionsStage({
        sql,
        storage,
        runId: "control-manual:never-dispatched",
        stage: "screen",
        operation: "run",
        userLogin: "tester",
      }),
      "job_not_found",
    );
    expect(error.message).toContain("control-manual:never-dispatched");
  });

  it("a run dispatched before #4066 (no stored request) refuses stage_request_missing", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-manual:pre-4066";
      const outcome = await dispatchManual(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      // Simulate a pre-#4066 definition: the run completed, but the
      // stored definition carries no dispatch request (the request
      // rode only the step deps then, not the definition).
      const stores = optionsEngineStoresFromSql(sql);
      const jobId = optionsScreenJobId(runId);
      const definition = await stores.stores.definitions.getDefinition(jobId);
      expect(definition).toBeDefined();
      const rawConfig = { ...(definition!.rawConfig as Record<string, unknown>) };
      delete rawConfig.request;
      await stores.stores.definitions.saveDefinition({ ...definition!, rawConfig });
      const error = await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "stage_request_missing",
      );
      expect(error.message).toContain(runId);
      // Stop needs no request, so it reaches the engine instead —
      // the refusal is the engine's, not a missing-request refusal.
      await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "stop",
          userLogin: "tester",
        }),
        "stage_not_stoppable",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("an in-memory run refuses job_not_found — no durable record in this DO", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      // Dispatched over in-memory engine stores (the paid-screen
      // shape): nothing durable exists for the control to address.
      const runId = "control-manual:in-memory";
      const outcome = await runOptionsScreenViaEngine(
        { runId, userLogin: "tester", request: { ...MANUAL_REQUEST, runIdentity: { runId } } },
        {
          stages: createOptionsScreenPorts({
            screener: new DynamicOptionsScreener(undefined),
            storage: memoryStageStorage(),
            shapeReport: async ({ screen }) => screen,
            deliver: async () => ({
              terminal: "completed",
              deliveryState: "deferred-to-caller",
            }),
          }),
          claims: memoryStageClaims(),
          queue: null,
        },
      );
      expect(outcome.outcome).toBe("completed");
      const { sql, storage } = makeDoStorage();
      await expectControlError(
        controlOptionsStage({
          sql,
          storage,
          runId,
          stage: "screen",
          operation: "rerun",
          userLogin: "tester",
        }),
        "job_not_found",
      );
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("manual shapeReport/deliver refuse stage_port_unavailable (no ScreenerAgent in a turn)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-manual:4";
      expect((await dispatchManual(sql, storage, runId)).outcome).toBe("completed");
      for (const stage of ["shapeReport", "deliver"]) {
        const error = await expectControlError(
          controlOptionsStage({
            sql,
            storage,
            runId,
            stage,
            operation: "rerun",
            userLogin: "tester",
          }),
          "stage_port_unavailable",
        );
        expect(error.message).toContain(stage);
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("panel shape: all eight stages are controllable, including shapeReport/deliver", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-panel:1";
      const outcome = await dispatchPanel(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      for (const stage of ["shapeReport", "deliver"] as const) {
        const result = await controlOptionsStage({
          sql,
          storage,
          runId,
          stage,
          operation: "rerun",
          userLogin: "tester",
        });
        expect(result.state).toBe("completed");
        expect(result.requestShape).toBe("panel");
      }
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("scan shape: a stage reruns through the rebuilt scanner ports", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const runId = "control-scan:1";
      const outcome = await dispatchScan(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      const result = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(result.state).toBe("completed");
      expect(result.requestShape).toBe("scan");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the NLQ panel leg drives the engine and records durably — the run is then controllable", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const res = await runOptionsStrategyAction(
        fakeEtrade() as never,
        "options_strategies",
        {
          request: {
            symbol: "AAPL",
            thesis: "bullish",
            targetPrice: 105,
            targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
            expectedIvDirection: "unchanged",
            minDte: 21,
            maxDte: 60,
            maxPlannedLoss: 5000,
            minRewardRisk: 0.1,
            allowedStrategies: ["long_call"],
          },
          riskProfile: "balanced",
          strategyFilter: {},
          targetPriceInferred: false,
          thesisInferred: false,
        } as never,
        {
          engineSql: sql,
          pipelineStorage: storage,
          userLogin: "tester",
        },
      );
      expect(res.status).toBe("ranked_candidates");
      expect(res.count).toBeGreaterThan(0);
      // One pipeline record: the job definition is durable in the
      // host DO, and it carries the dispatch request.
      const stores = optionsEngineStoresFromSql(sql);
      const definitions = await stores.stores.definitions.listDefinitions();
      const panelJob = definitions.find((d) => d.jobId.startsWith("options-screen:nlq-panel:"));
      expect(panelJob).toBeDefined();
      const definition = await stores.stores.definitions.getDefinition(panelJob!.jobId);
      const request = (definition?.rawConfig as { request?: unknown } | undefined)?.request as
        | { classInput?: { strategyRequest?: { symbol?: string } } }
        | undefined;
      expect(request?.classInput?.strategyRequest?.symbol).toBe("AAPL");
      // …and the run is controllable from the turn.
      const runId = panelJob!.jobId.slice("options-screen:".length);
      const controlled = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(controlled.state).toBe("completed");
      expect(controlled.requestShape).toBe("panel");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the mesh door drives the engine and records durably — the run is then controllable", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const { sql, storage } = makeDoStorage();
      const result = await runOptionsStrategyScreenViaDoor(
        {
          env: {} as never,
          orm: {} as never,
          storage: storage as never,
          createEtradeService: () => fakeEtrade() as never,
          resolveUniverseSymbols: async () => ["AAPL"],
        } as never,
        "tester",
        {
          universe: "NASDAQ100",
          maxLoss: 500,
          minRewardRisk: 0.1,
        } as never,
      );
      expect(result.status).toBe("ranked_opportunities");
      expect(result.count).toBeGreaterThan(0);
      const stores = optionsEngineStoresFromSql(sql);
      const definitions = await stores.stores.definitions.listDefinitions();
      const scanJob = definitions.find((d) => d.jobId.startsWith("options-screen:nlq-scan:"));
      expect(scanJob).toBeDefined();
      const runId = scanJob!.jobId.slice("options-screen:".length);
      const controlled = await controlOptionsStage({
        sql,
        storage,
        runId,
        stage: "screen",
        operation: "rerun",
        userLogin: "tester",
      });
      expect(controlled.state).toBe("completed");
      expect(controlled.requestShape).toBe("scan");
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the paid-screen engine entry returns the same screen result as the manual engine run (one pipeline)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const paid = await runOptionsPlainScreenViaEngine(
        undefined,
        { underlyingSymbols: ["AAPL"] },
        "tester",
      );
      expect(paid.contracts.length).toBeGreaterThan(0);
      const { sql, storage } = makeDoStorage();
      const runId = "control-manual:paid-parity";
      const outcome = await dispatchManual(sql, storage, runId);
      expect(outcome.outcome).toBe("completed");
      const manual = await storage.get<{ result?: { contracts?: unknown[] } }>(
        `options:${runId}:screen`,
      );
      expect(manual?.result?.contracts?.length).toBe(paid.contracts.length);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the stage-control command is registered with the mcp:write scope", () => {
    expect(McpToolFactory.getTool("options_copilot_stage_control")).toBeDefined();
    expect(MCP_TOOL_SCOPES.options_copilot_stage_control).toBe("mcp:write");
  });
});
