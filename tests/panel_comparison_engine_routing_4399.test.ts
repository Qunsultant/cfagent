/**
 * Issue #4399 (sub-issue of #4276) — the panel comparison route
 * threads with the engine comparison job, the #4276 pattern: POST
 * /trading/options/comparison dispatches through runComparisonViaEngine
 * when the host DO's SQL handle is available, so a panel comparison
 * has a durable pipeline record (`comparison:<runId>`) and per-stage
 * control addresses it (refusing execution ops by name — a
 * single-step job has no stage ports). The route's response shape is
 * unchanged, and without a SQL handle the core executes directly
 * (the #4069 accepted-absent discipline), exactly as the NLQ leg.
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the DO storage is the node:sqlite double
 * from the #4068/#4276 suites. The engine, the ports, the control
 * plane, and the route are all real. The comparison core
 * (runProductionComparison) is mocked at the runner seam: the real
 * core needs a live LLM gateway, so the engine-path tests prove
 * dispatch + record + control around it, and the C5 suite pins the
 * core's semantics (the live-LLM end-to-end is #4402).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "../src/orm";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading";
import { handleEtradeOptionsRoutes } from "../src/agents/routes/etradeOptions";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import {
  comparisonJobId,
  optionsEngineStoresFromSql,
} from "../src/workflows/optionsScreenEngine";
import { memoryStageStorage } from "../src/workflows/optionsScreenWorkflow";
import {
  controlOptionsStage,
  OptionsStageControlError,
} from "../src/workflows/optionsStageControl";
import type { ProductionComparisonResult } from "../src/services/comparisonRunner";
import type { StrategyRequest } from "../src/trading";

// The comparison core (runProductionComparison) needs a live LLM
// gateway, so the route tests mock it at the seam: the mock records
// the args it received and returns a canned result, proving dispatch
// + record + control around the core. The C5 suite pins the core.
const { mockRunProductionComparison } = vi.hoisted(() => ({
  mockRunProductionComparison: vi.fn(),
}));
vi.mock("../src/services/comparisonRunner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/comparisonRunner")>();
  return { ...actual, runProductionComparison: mockRunProductionComparison };
});

const USER = "route_tester";

/** The node:sqlite DO-storage double (tests/strategy_entry_routing_4273 idiom). */
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

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string, spot: number): ETradeOptionChain {
  const pairs = [spot - 5, spot, spot + 5].map((strike) => ({
    call: {
      symbol, optionType: "CALL", strikePrice: strike,
      bid: 5.5, ask: 5.8, volume: 800, openInterest: 2000,
      impliedVolatility: 0.45, delta: 0.52, gamma: 0.04,
      theta: -0.05, vega: 0.12, rho: 0.02,
    },
    put: {
      symbol, optionType: "PUT", strikePrice: strike,
      bid: 5.4, ask: 5.7, volume: 600, openInterest: 1800,
      impliedVolatility: 0.45, delta: -0.48, gamma: 0.04,
      theta: -0.05, vega: 0.12, rho: -0.02,
    },
  }));
  return {
    symbol,
    underlyingPrice: spot,
    quoteTime: Date.now(),
    selectedExpiry: expiryAtDte(35),
    pairs,
  } as ETradeOptionChain;
}

const COMPARISON_REQUEST: StrategyRequest = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 260,
  targetDate: "2026-11-20",
  expectedIvDirection: "unchanged",
  allowedStrategies: ["iron_condor"],
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 7,
  maxDte: 90,
};

function cannedComparisonResult(runId: string | undefined): ProductionComparisonResult {
  const arm = (ids: string[]) => ({
    attrition: { generated: ids.length + 1, gatePassed: ids.length, priced: ids.length, falsified: ids.length, ranked: ids.length },
    ranked: ids.map((id, i) => ({ id, structure: "iron_condor", label: `Iron condor ${id}`, status: "qualified", score: 10 - i })),
  });
  return {
    artifact: {
      runId: runId ?? "cmp-direct",
      arms: { llm: arm(["llm-1", "llm-2"]), quant: arm(["q-1"]), hybrid: arm(["h-1", "h-2", "h-3"]) },
      overlap: { sharedStructures: ["iron_condor"], armUnique: { llm: [], quant: [], hybrid: [] } },
      stats: { armRankedCounts: { llm: 2, quant: 1, hybrid: 3 }, sharedStructureCount: 1 },
    },
    generationNotes: { model: "test-model", citedCount: 4, droppedCount: 1, llmGenerated: 2, llmBuilderLimitations: [], skippedReason: null },
  } as unknown as ProductionComparisonResult;
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
  throw new Error(`expected control error ${code}, but the call succeeded`);
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
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
  mockRunProductionComparison.mockReset();
  mockRunProductionComparison.mockImplementation(async (deps: { runId?: string }) =>
    cannedComparisonResult(deps.runId),
  );
  DynamicOptionsScreener.setTestChainsFixture({ NVDA: makeChain("NVDA", 260) });
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
  vi.unstubAllGlobals();
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
});

function makeRouteCtx(sql: SqliteTestStorage | null) {
  const storage = sql ? { sql } : {};
  return {
    env: {},
    getOrm: () => ({} as never),
    agentCtx: { storage } as never,
    ensureTables: () => (sql ?? new SqliteTestStorage()) as unknown as SqlStorage,
    requestedEnv: "TEST" as const,
    getScreenerAgent: () => {
      throw new Error("getScreenerAgent unused by the comparison route");
    },
  } as never;
}

async function postComparison(ctx: ReturnType<typeof makeRouteCtx>) {
  const request = new Request("http://test/api/trading/options/comparison", {
    method: "POST",
    headers: { "x-user-login": USER, "content-type": "application/json" },
    body: JSON.stringify(COMPARISON_REQUEST),
  });
  const response = await handleEtradeOptionsRoutes(
    request,
    new URL(request.url),
    "/trading/options/comparison",
    "session-1",
    ctx,
  );
  expect(response).not.toBeNull();
  return response!;
}

describe("panel comparison route engine threading (#4399)", () => {
  it("dispatches through the engine comparison job with a durable record, response shape unchanged", async () => {
    const sql = new SqliteTestStorage();
    const response = await postComparison(makeRouteCtx(sql));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The route's response shape, unchanged: the same envelope the
    // direct path returned, with the artifact carrying the run id.
    // (snapshotError is a literal field of the envelope, but JSON
    // drops it when the snapshot has no validation error — the
    // fixture snapshot has none — so the wire shape has 8 keys.)
    expect(Object.keys(body).sort()).toEqual(
      ["artifact", "contractRejections", "dataSource", "generationNotes", "screen", "status", "symbol", "timestamp"].sort(),
    );
    expect(body.status).toBe("compared");
    expect(body.symbol).toBe("NVDA");
    const artifact = body.artifact as { runId?: string };
    expect(artifact.runId).toMatch(/^cmp-/);
    expect(mockRunProductionComparison).toHaveBeenCalledTimes(1);

    // The core ran under the minted run id — the same id the engine
    // job carries, so the artifact and the job record are one run.
    const coreArgs = mockRunProductionComparison.mock.calls[0][0] as { runId?: string };
    expect(coreArgs.runId).toBe(artifact.runId);

    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const definitions = await engineStores.stores.definitions.listDefinitions();
    const comparisonJobs = definitions.filter(
      (definition) => (definition.root as { kind?: string }).kind === "comparison",
    );
    expect(comparisonJobs).toHaveLength(1);
    expect(comparisonJobs[0]!.jobId).toBe(`comparison:${coreArgs.runId}`);
    const latest = await engineStores.runRecorder.latestRun(comparisonJobs[0]!.jobId);
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("success");

    // The dispatch request rides the definition, so control can
    // decode the run's shape from the stored record.
    const rawConfig = comparisonJobs[0]!.rawConfig as {
      request?: { classInput?: { comparisonRequest?: { request?: { symbol?: string } } } };
    };
    expect(rawConfig.request?.classInput?.comparisonRequest?.request?.symbol).toBe("NVDA");
  });

  it("without a SQL handle the core executes directly (accepted-absent, #4069)", async () => {
    const response = await postComparison(makeRouteCtx(null));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("compared");
    expect(mockRunProductionComparison).toHaveBeenCalledTimes(1);
    const coreArgs = mockRunProductionComparison.mock.calls[0][0] as { runId?: string };
    expect(coreArgs.runId).toBeUndefined();
    expect((body.artifact as { runId?: string }).runId).toBe("cmp-direct");
  });

  it("the engine path preserves the comparison core's inputs (same inputs, same artifact modulo the run id)", async () => {
    const sql = new SqliteTestStorage();
    const directResponse = await postComparison(makeRouteCtx(null));
    expect(directResponse.status).toBe(200);
    const directArgs = mockRunProductionComparison.mock.calls[0][0] as Record<string, unknown>;
    const directBody = (await directResponse.json()) as Record<string, unknown>;

    const engineResponse = await postComparison(makeRouteCtx(sql));
    expect(engineResponse.status).toBe(200);
    const engineArgs = mockRunProductionComparison.mock.calls[1][0] as Record<string, unknown>;
    const engineBody = (await engineResponse.json()) as Record<string, unknown>;

    const { runId: _directRunId, ...directRest } = directArgs;
    const { runId: engineRunId, ...engineRest } = engineArgs;
    expect(engineRunId).toMatch(/^cmp-/);
    // The snapshot's scannedAt is a per-run wall-clock stamp, so it
    // is normalized before comparing; the build/rank/screen fns are
    // fresh closures per run, so they are compared by presence, not
    // by reference. The pin is that the core's DATA inputs are
    // identical across the two paths.
    const normalize = (args: Record<string, unknown>) => {
      const { buildFn, rankFn, screenFn, ...rest } = args;
      expect(buildFn).toEqual(expect.any(Function));
      expect(rankFn).toEqual(expect.any(Function));
      expect(screenFn).toEqual(expect.any(Function));
      const snapshot = rest.snapshot as { screen?: Record<string, unknown> };
      return {
        ...rest,
        snapshot: { ...snapshot, screen: { ...snapshot.screen, scannedAt: "normalized" } },
      };
    };
    expect(normalize(engineRest)).toEqual(normalize(directRest));
    expect({ ...(engineBody.artifact as Record<string, unknown>), runId: "normalized" }).toEqual({
      ...(directBody.artifact as Record<string, unknown>),
      runId: "normalized",
    });
    // The envelopes match modulo the run id, the timestamp, and
    // the snapshot screen's per-run scannedAt stamp.
    const { artifact: _eArtifact, timestamp: _eTs, screen: eScreen, ...engineEnvelope } = engineBody;
    const { artifact: _dArtifact, timestamp: _dTs, screen: dScreen, ...directEnvelope } = directBody;
    expect(engineEnvelope).toEqual(directEnvelope);
    expect({ ...(eScreen as Record<string, unknown>), scannedAt: "normalized" }).toEqual({
      ...(dScreen as Record<string, unknown>),
      scannedAt: "normalized",
    });
  });

  it("control resolves the route's comparison run and refuses execution ops by name", async () => {
    const sql = new SqliteTestStorage();
    const response = await postComparison(makeRouteCtx(sql));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const runId = (body.artifact as { runId: string }).runId;
    const refused = await expectControlError(
      controlOptionsStage({
        sql: sql as unknown as SqlStorage,
        storage: { ...memoryStageStorage(), sql: sql as unknown as SqlStorage },
        runId,
        stage: "screen",
        operation: "run",
        userLogin: USER,
      }),
      "stage_port_unavailable",
    );
    expect(refused.message).toContain(runId);
    expect(refused.message).toContain("comparison");
  });

  it("a core failure on the engine path surfaces the original error verbatim and records a failed run", async () => {
    const sql = new SqliteTestStorage();
    mockRunProductionComparison.mockRejectedValue(new Error("core exploded"));
    const response = await postComparison(makeRouteCtx(sql));
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("core exploded");
    const engineStores = optionsEngineStoresFromSql(sql as unknown as SqlStorage);
    const definitions = await engineStores.stores.definitions.listDefinitions();
    expect(definitions).toHaveLength(1);
    const latest = await engineStores.runRecorder.latestRun(definitions[0]!.jobId);
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("failure");
    expect(definitions[0]!.jobId.startsWith("comparison:")).toBe(true);
  });
});
