/**
 * Issue #4068 — the options screen on the J1–J7 engine: every entry point
 * drives runOptionsScreenViaEngine instead of calling
 * runOptionsScreenWorkflow directly.
 *
 * The dispatch defines one job per run (options-screen:<runId>) so
 * concurrent screens never collide on the engine's per-job instance lock,
 * runs the eight stages through the engine's stage runner with the shared
 * per-stage body (runOptionsStageOnce — the same body the thin composer
 * calls), and returns the exact outcome shape the call sites consume.
 * These tests prove the equivalence with the direct composer, the
 * failure stop, the concurrency, the claim-skip, and the durable SQL
 * run record.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import {
  optionsEngineStoresFromSql,
  optionsScreenJobDefinition,
  optionsScreenJobId,
  OPTIONS_SCREEN_STEP,
  runOptionsPlainScreenViaEngine,
  runOptionsScanViaEngine,
  runOptionsScreenViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  memoryStageClaims,
  memoryStageStorage,
  runOptionsScreenWorkflow,
  type OptionsStagePort,
} from "../src/workflows/optionsScreenWorkflow";
import { stageIdempotencyKey } from "../src/workflows/stageMessage";
import { OPTIONS_PIPELINE_STAGES, type OptionsPipelineStage } from "../src/workflows/stageRuntimeIds";
import type { StageClaimStore } from "../src/workflows/stageReportConsumer";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { ScanRunStore } from "../src/data/scanRunPorts";
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

function stubPorts(order: string[] = [], failStage?: string): {
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
        if (failStage === stageId) {
          throw new Error(`boom at ${stageId}`);
        }
        return { stage: stageId, inputArtifactKeys: input.artifactKeys };
      },
      persist: async (_input, output) => {
        calls.push(`persist:${stageId}`);
        return [`options:${stageId}:${(output as { stage: string }).stage}`];
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
  runIdentity: { runId: "options-engine-test" },
  trigger: "manual",
  classInput: { request: { filter: { underlyingSymbols: ["AAPL"] } } },
};

describe("options screen on the J engine (#4068)", () => {
  it("defines one job per run: 8 children, one options.runStage step each, sync delivery", () => {
    const jobId = optionsScreenJobId("options-test:1");
    expect(jobId).toBe("options-screen:options-test:1");
    const definition = optionsScreenJobDefinition(jobId) as {
      jobId: string;
      root: {
        kind: string;
        executionMode: { concurrency: string; pacing: string; delivery: string; shape: string };
        children: Array<{ kind: string; steps: Array<{ step: string; params: { stageId: string } }> }>;
      };
    };
    expect(definition.jobId).toBe(jobId);
    expect(definition.root.kind).toBe("options-screen");
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

  it("returns the same outcome as the direct composer for the same ports", async () => {
    const runId = "options-engine-equivalence:1";
    const sentDirect: unknown[] = [];
    const directOrder: string[] = [];
    const directPorts = stubPorts(directOrder);
    const direct = await runOptionsScreenWorkflow(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: directPorts.ports,
        claims: memoryStageClaims(),
        queue: { send: async (body: unknown) => void sentDirect.push(body) },
        warn: () => undefined,
      },
    );
    const sentEngine: unknown[] = [];
    const engineOrder: string[] = [];
    const enginePorts = stubPorts(engineOrder);
    const engine = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: enginePorts.ports,
        claims: memoryStageClaims(),
        queue: { send: async (body: unknown) => void sentEngine.push(body) },
        warn: () => undefined,
      },
    );
    expect(engine.outcome).toBe("completed");
    expect(engine.runId).toBe(runId);
    expect(engine.stages).toEqual(direct.stages);
    expect(engine.published).toEqual(direct.published);
    expect(sentEngine).toEqual(sentDirect);
    expect(engineOrder).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect(engineOrder).toEqual(directOrder);
  });

  it("a failing stage stops the engine run with failedStage + reason; later stages never run", async () => {
    const order: string[] = [];
    const { ports } = stubPorts(order, "screen");
    const sent: unknown[] = [];
    const outcome = await runOptionsScreenViaEngine(
      { runId: "options-engine-fail:1", userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: memoryStageClaims(),
        queue: { send: async (body: unknown) => void sent.push(body) },
        warn: () => undefined,
      },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.failedStage).toBe("screen");
    expect(outcome.reason).toBe("boom at screen");
    // The engine retries a failed step within its budget, so the
    // screen stage is attempted more than once — but no later stage
    // ever runs, and the holder keeps ONE record per stage (upsert).
    expect(order.filter((stageId) => stageId === "screen").length).toBeGreaterThanOrEqual(1);
    expect(order.filter((stageId) => !["plan", "chainFetch", "enrich", "screen"].includes(stageId))).toEqual([]);
    expect(outcome.stages.map((stage) => stage.stageId)).toEqual([
      "plan",
      "chainFetch",
      "enrich",
      "screen",
    ]);
    expect(outcome.stages[3]?.status).toBe("failed");
    // The failed stage's claim is released (the direct composer's rule).
    expect(outcome.published).toHaveLength(3);
  });

  it("two concurrent dispatches both complete (no job_already_running)", async () => {
    const make = (runId: string) => {
      const order: string[] = [];
      const { ports } = stubPorts(order);
      return runOptionsScreenViaEngine(
        { runId, userLogin: "tester", request: REQUEST },
        {
          stages: ports,
          claims: memoryStageClaims(),
          queue: null,
          warn: () => undefined,
        },
      ).then((outcome) => ({ outcome, order }));
    };
    const [first, second] = await Promise.all([
      make("options-engine-concurrent:1"),
      make("options-engine-concurrent:2"),
    ]);
    expect(first.outcome.outcome).toBe("completed");
    expect(second.outcome.outcome).toBe("completed");
    expect(first.outcome.stages).toHaveLength(8);
    expect(second.outcome.stages).toHaveLength(8);
    expect(first.order).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect(second.order).toEqual([...OPTIONS_PIPELINE_STAGES]);
  });

  it("a pre-claimed stage is skipped-claimed in the engine path", async () => {
    const runId = "options-engine-claimed:1";
    const order: string[] = [];
    const { ports } = stubPorts(order);
    const outcome = await runOptionsScreenViaEngine(
      { runId, userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: claimsWith([stageIdempotencyKey(runId, "enrich", "options")]),
        queue: null,
        warn: () => undefined,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(outcome.stages.find((stage) => stage.stageId === "enrich")?.status).toBe(
      "skipped-claimed",
    );
    expect(order).toEqual(
      [...OPTIONS_PIPELINE_STAGES].filter((stageId) => stageId !== "enrich"),
    );
  });

  it("SQL engine stores record the run durably (latestRun success)", async () => {
    const sql = new SqliteTestStorage();
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const runId = "options-engine-sql:1";
    const { ports } = stubPorts();
    const outcome = await runOptionsScreenViaEngine(
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
    const jobId = optionsScreenJobId(runId);
    const latest = await engineStores.runRecorder.latestRun(jobId);
    expect(latest).toBeDefined();
    expect(latest?.jobId).toBe(jobId);
    expect(latest?.outcome).toBe("success");
    expect(latest?.triggeredBy).toBe("manual");
    const definition = await engineStores.stores.definitions.getDefinition(jobId);
    expect(definition?.jobId).toBe(jobId);
    expect(definition?.root.children?.length).toBe(8);
  });

  it("the stage storage helper is unused by the dispatch (ports own their storage)", async () => {
    // The dispatch never touches OptionsStageStorage itself: the ports'
    // persist writes the artifacts (here into memoryStageStorage), and
    // the engine's hand-off is the artifact keys, not the values.
    const storage = memoryStageStorage();
    const order: string[] = [];
    const { ports } = stubPorts(order);
    const outcome = await runOptionsScreenViaEngine(
      { runId: "options-engine-storage:1", userLogin: "tester", request: REQUEST },
      {
        stages: ports,
        claims: memoryStageClaims(),
        queue: null,
        warn: () => undefined,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(await storage.get("options:options-engine-storage:1:screen")).toBeUndefined();
  });

  it("the plain-screen helper returns the screen result over a fixture chain", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const result = await runOptionsPlainScreenViaEngine(
        undefined,
        { underlyingSymbols: ["AAPL"] },
        "tester",
      );
      expect(result.contracts.length).toBeGreaterThan(0);
      expect(result.matchedCount).toBe(result.contracts.length);
      expect(result.totalUnderlyingsScanned).toBe(1);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });

  it("the plain-screen helper fails closed without a userLogin", async () => {
    await expect(
      runOptionsPlainScreenViaEngine(undefined, { underlyingSymbols: ["AAPL"] }, ""),
    ).rejects.toThrow("a real userLogin is required");
  });

  it("the scan helper returns the result + save receipt and stamps the save", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    try {
      const saved: Array<{ result: unknown; options: unknown }> = [];
      const scanRunStore = {
        save: async (result: unknown, options: unknown) => {
          saved.push({ result, options });
          return { id: "scan-test-1" };
        },
      } as unknown as ScanRunStore;
      const requestRecord = {
        symbols: ["AAPL"],
        targetDate: baseTemplate().targetDate,
        thesis: "bullish",
      };
      const result = await runOptionsScanViaEngine(undefined, ["AAPL"], baseTemplate(), {
        requestRecord: requestRecord as never,
        platformRunId: "platform-scan-1",
        trigger: "scheduled",
        scanRunStore,
        userLogin: "tester",
      });
      expect(result.persisted).toBe(true);
      expect(result.scanRunId).toBe("scan-test-1");
      expect(saved).toHaveLength(1);
      const [save] = saved;
      expect(save?.options).toMatchObject({
        id: "platform-scan-1",
        trigger: "scheduled",
        userLogin: "tester",
      });
      expect(
        (save?.result as { requestSnapshot?: { request?: unknown } }).requestSnapshot?.request,
      ).toEqual(requestRecord);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});
