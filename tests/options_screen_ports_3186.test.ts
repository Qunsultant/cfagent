/**
 * Issue #3186 step 3b - production ports: the eight stage ports over
 * the REAL engines (plannerPort, DynamicOptionsScreener.fetchChains /
 * evaluateContracts / aggregateScreenResult, assessSagaTradeRisk,
 * recordUnifiedOptionsRun), with DO-storage checkpoint artifacts
 * (the stock pipeline's artifact discipline: the artifact is persisted
 * before its boundary publishes) and caller-supplied shapeReport /
 * deliver (goal leg vs route delivery differ; the port interface is
 * uniform, the implementation is the caller's).
 *
 * CORRECTION (verified 2026-11-04): the plain options screen's
 * canonical write is mas_reports via recordUnifiedOptionsRun, NOT
 * mas_opportunity_scans via ScanRunStore.save - that store holds
 * STRATEGY/discovery runs (nlqOptionsStrategy.ts:1213). The step-1
 * pin note saying otherwise was wrong for the plain screen.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { runOptionsScreenWorkflow } from "../src/workflows/optionsScreenWorkflow";
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import type { PlannerInput } from "../src/workflows/blocks/plannerPort";

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

const FILTER = { underlyingSymbols: ["AAPL"] };

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

function request(runId: string, extra: Record<string, unknown> = {}): PlannerInput {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: { request: { filter: FILTER } },
    ...extra,
  } as PlannerInput;
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("options production ports (#3186 step 3b)", () => {
  it("the full pipeline reproduces screenOptions exactly", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const storage = memoryStorage();
    const recorded: Array<Record<string, unknown>> = [];
    const ports = createOptionsScreenPorts({
      screener,
      storage,
      canonical: {
        storeCanonicalReport: (input: Record<string, unknown>) => {
          recorded.push(input);
          return { reportId: `report-${recorded.length}`, created: true };
        },
      },
      shapeReport: async ({ canonical }) => ({ terminal: "completed", report: canonical }),
      deliver: async () => ({ terminal: "completed", deliveryState: "delivered" }),
    });
    const sent: Array<{ stageId: string }> = [];
    const result = await runOptionsScreenWorkflow(
      { runId: "run-ports-1", userLogin: "owner@example.com", request: request("run-ports-1") },
      {
        stages: ports,
        claims: {
          has: () => false,
          add: () => undefined,
        },
        queue: {
          send: async (body: unknown) => {
            sent.push(body as { stageId: string });
          },
        },
      },
    );
    expect(result.outcome).toBe("completed");
    expect(sent.map((message) => message.stageId)).toEqual([
      "plan", "chainFetch", "enrich", "screen", "risk", "persistCanonicalResults", "shapeReport", "deliver",
    ]);
    const screenArtifact = await storage.get<{ result: Record<string, unknown> }>(
      optionsArtifactKey("run-ports-1", "screen"),
    );
    const viaScreen = await screener.screenOptions(FILTER);
    const { scannedAt: _a, ...screenResult } = screenArtifact?.result ?? {};
    const { scannedAt: _b, ...directResult } = viaScreen as unknown as Record<string, unknown>;
    // The port stamps dataSource "live" (the route stamped it after
    // the screen); the engine leaves it undefined.
    expect(screenResult).toEqual({ ...directResult, dataSource: "live" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.runId).toBe("run-ports-1");
    // recordUnifiedOptionsRun nests the trigger in the row body.
    expect((recorded[0]?.body as { trigger?: string } | undefined)?.trigger).toBe("manual");
    expect(recorded[0]?.userLogin).toBe("owner@example.com");
    const riskArtifact = await storage.get<{ assessment: { status: string } }>(
      optionsArtifactKey("run-ports-1", "risk"),
    );
    expect(riskArtifact?.assessment.status).toBe("unassessed");
  });

  it("chainFetch fails closed when the plan artifact is missing", async () => {
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage: memoryStorage(),
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await expect(
      ports["chainFetch"].execute({
        runId: "run-ports-2",
        userLogin: "owner@example.com",
        stageId: "chainFetch",
        artifactKeys: [],
        request: request("run-ports-2"),
      }),
    ).rejects.toThrow(/plan artifact missing/);
  });

  it("plan fails closed on an invalid filter", async () => {
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage: memoryStorage(),
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await expect(
      ports["plan"].execute({
        runId: "run-ports-3",
        userLogin: "owner@example.com",
        stageId: "plan",
        artifactKeys: [],
        request: request("run-ports-3", {
          classInput: { request: { filter: { underlyingSymbols: ["AAPL"], minDelta: "high" } } },
        }),
      }),
    ).rejects.toThrow(/options plan: invalid filter/);
  });

  it("risk fails the run closed on a violation (non-matching intent)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    const expiry = expiryAtDte(30);
    const expirationDate = `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
    const req = request("run-ports-4", {
      classInput: {
        request: { filter: FILTER },
        tradeIntent: {
          kind: "options",
          symbol: "AAPL",
          optionLegs: [{ side: "BUY", optionType: "CALL", strike: 999, expirationDate, quantity: 1 }],
        },
        riskLimits: { maxPlannedLoss: 100, minRewardRisk: 1 },
      },
    });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-ports-4", userLogin: "owner@example.com", request: req },
      {
        stages: ports,
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    );
    expect(result.outcome).toBe("failed");
    expect(result.failedStage).toBe("risk");
    expect(result.reason).toContain("risk_violation");
  });

  it("screen throws when nothing could be fetched (error status, #1963)", async () => {
    const storage = memoryStorage();
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    await storage.put(optionsArtifactKey("run-ports-5", "chainFetch"), {
      chains: [],
      fetchErrors: [{ symbol: "AAPL", reason: "auth dead" }],
      symbols: ["AAPL"],
      filter: FILTER,
      warnings: [],
    });
    await storage.put(optionsArtifactKey("run-ports-5", "enrich"), {
      outcomes: {
        passedContracts: [],
        rejections: [],
        rejectionCount: 0,
        totalContractsEvaluated: 0,
      },
    });
    await expect(
      ports["screen"].execute({
        runId: "run-ports-5",
        userLogin: "owner@example.com",
        stageId: "screen",
        artifactKeys: [optionsArtifactKey("run-ports-5", "enrich")],
        request: request("run-ports-5"),
      }),
    ).rejects.toThrow(/no chains could be fetched/);
  });

  it("the canonical write is idempotent by runId (created:false on retry)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    const seen = new Set<string>();
    const ports = createOptionsScreenPorts({
      screener: new DynamicOptionsScreener(),
      storage,
      canonical: {
        storeCanonicalReport: (input: Record<string, unknown>) => {
          const runId = String((input as { runId?: unknown }).runId ?? "");
          const created = !seen.has(runId);
          seen.add(runId);
          return { reportId: `report-${runId}`, created };
        },
      },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    const input = {
      runId: "run-ports-6",
      userLogin: "owner@example.com",
      stageId: "persistCanonicalResults",
      artifactKeys: [optionsArtifactKey("run-ports-6", "risk")],
      request: request("run-ports-6"),
    };
    await storage.put(optionsArtifactKey("run-ports-6", "screen"), {
      result: await new DynamicOptionsScreener().screenOptions(FILTER),
    });
    await storage.put(optionsArtifactKey("run-ports-6", "risk"), {
      assessment: { status: "unassessed", reason: "no trade intent" },
    });
    const first = (await ports["persistCanonicalResults"].execute(input)) as { created: boolean };
    const second = (await ports["persistCanonicalResults"].execute(input)) as { created: boolean };
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("demo fallback substitutes calibrated chains for an empty live screen when the gate is on", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const storage = memoryStorage();
    // minVolume 200 rejects the fixture (vol 100) but admits the
    // calibrated chains (vol ~1500 at the money).
    const filter = { underlyingSymbols: ["AAPL"], minVolume: 200 };
    const ports = createOptionsScreenPorts({
      screener,
      storage,
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
      demoFallback: true,
    });
    const result = await runOptionsScreenWorkflow(
      {
        runId: "run-ports-demo",
        userLogin: "owner@example.com",
        request: request("run-ports-demo", { classInput: { request: { filter } } }),
      },
      { stages: ports, claims: { has: () => false, add: () => undefined }, queue: null },
    );
    expect(result.outcome).toBe("completed");
    const screenArtifact = await storage.get<{ result: Record<string, unknown> }>(
      optionsArtifactKey("run-ports-demo", "screen"),
    );
    expect((screenArtifact?.result["contracts"] as unknown[]).length).toBeGreaterThan(0);
    expect(screenArtifact?.result["dataSource"]).toBe("calibrated-demo");
  });

  it("demo fallback off keeps the empty live screen", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const storage = memoryStorage();
    const filter = { underlyingSymbols: ["AAPL"], minVolume: 200 };
    const ports = createOptionsScreenPorts({
      screener,
      storage,
      canonical: { storeCanonicalReport: () => ({ reportId: "r", created: true }) },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
    });
    const result = await runOptionsScreenWorkflow(
      {
        runId: "run-ports-nodemo",
        userLogin: "owner@example.com",
        request: request("run-ports-nodemo", { classInput: { request: { filter } } }),
      },
      { stages: ports, claims: { has: () => false, add: () => undefined }, queue: null },
    );
    expect(result.outcome).toBe("completed");
    const screenArtifact = await storage.get<{ result: Record<string, unknown> }>(
      optionsArtifactKey("run-ports-nodemo", "screen"),
    );
    expect((screenArtifact?.result["contracts"] as unknown[]).length).toBe(0);
    expect(screenArtifact?.result["dataSource"]).toBe("live");
  });

  it("a supplied record builder shapes the canonical row", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const storage = memoryStorage();
    const recorded: Array<Record<string, unknown>> = [];
    const ports = createOptionsScreenPorts({
      screener,
      storage,
      canonical: {
        storeCanonicalReport: (input: Record<string, unknown>) => {
          recorded.push(input);
          return { reportId: "r", created: true };
        },
      },
      shapeReport: async () => ({}),
      deliver: async () => ({}),
      record: async ({ runId, userLogin }) => ({
        runId,
        generationId: runId,
        title: "Options contract screen — AAPL",
        source: "options_scanner",
        summary: "custom",
        trigger: "manual",
        userLogin,
      }),
    });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-ports-record", userLogin: "owner@example.com", request: request("run-ports-record") },
      { stages: ports, claims: { has: () => false, add: () => undefined }, queue: null },
    );
    expect(result.outcome).toBe("completed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.title).toBe("Options contract screen — AAPL");
    expect(recorded[0]?.source).toBe("options_scanner");
  });
});
