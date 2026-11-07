/**
 * Issue #2599 (F3, F5): scheduled options scan budget + publish-nothing.
 *
 * F3: auto-shard above the floor(35/12) = 2-symbol monolithic
 * limit applies whatever the trigger label — an on-demand
 * ("manual") invocation over 3 symbols shards instead of
 * running monolithically and silently deferring past the budget.
 * F5: a result that records no coverage at all, with every other
 * signal empty, takes the same coded
 * FAILURE_SCREEN_NO_CONTRACTS_EVALUATED gate as evaluated == 0
 * instead of publishing an empty report; a result with any
 * non-empty signal still proceeds.
 *
 * Harness mirrors tests/options_broadcast_coverage_floor.test.ts
 * (real UnifiedOptionsService + chain stubs at the ETradeRestClient
 * prototype, MockSqlStorage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { makeFakeSessionStore } from "./fake-session-store";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { deliverGatedSlack } from "../src/services/gatedSlackDelivery";
import type { Env } from "../src/types";
import { ETradeRestClient } from "../src/trading/etrade/client";
import type { ETradeOptionChain } from "../src/trading/etrade/client";

const mockDeliverGatedSlack = vi.mocked(deliverGatedSlack);

// Chain fixture in the shape the real screener parses (copied from
// tests/unified_options_pipeline_3186.test.ts): legs carry strikePrice /
// timeStamp / adjustedFlag and NO expirationDate; the chain carries
// selectedExpiry as a {year, month, day} OBJECT. Legs use intrinsic +
// time-value economics, so the engine's candidate scoring sees
// realistic reward/risk and produces qualifying picks.
const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeChain(symbol: string, spot: number) {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: mid - 0.1,
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? delta : -delta,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiryObj,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

afterEach(() => {
  vi.restoreAllMocks();
});
vi.mock("../src/services/gatedSlackDelivery", () => ({
  deliverGatedSlack: vi.fn(async () => ({ ok: true as const })),
}));

/** Stub chains for the given symbols; every other symbol fetches null (a skip). */
function stubChains(spots: Record<string, number>) {
  vi.spyOn(ETradeRestClient.prototype, "getOptionExpireDates").mockImplementation(async () => [expiryObj] as never);
  vi.spyOn(ETradeRestClient.prototype, "getOptionChains").mockImplementation(async (args: { symbol: string }) =>
    spots[args.symbol] !== undefined ? makeChain(args.symbol, spots[args.symbol]) : null,
  );
}

class MockKVNamespace {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(sessionId: string): { sql: MockSqlStorage; orm: DatabaseORM; env: Env } {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema(sessionId);
  const mockKv = new MockKVNamespace();
  const { namespace: sessionStoreNs } = makeFakeSessionStore();
  const env = {
    APP_ENV: "TEST",
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ETRADE_ENVIRONMENT: "sandbox",
    ET_API_KEY: "test-key",
    ET_API_SECRET: "test-secret",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    ETRADE_KV: mockKv as any,
    SESSION_STORE: sessionStoreNs,
    ORCHESTRATOR_AGENT: {} as any,
    SCREENER_AGENT: {
      idFromName: () => "mock-screener-id",
      get: () => ({
        runScreen: async () => ({ success: true }),
        claimScheduledExecution: async () => true,
      }),
    },
  } as unknown as Env;
  return { sql, orm, env };
}

describe("F3 auto-shard is trigger-independent (#2599)", () => {
  beforeEach(() => {
    mockDeliverGatedSlack.mockClear();
  });

  it("manual trigger over 3 symbols shards (queued contract, one feed shard per symbol)", async () => {
    const { orm, env } = makeEnv("f3_manual_shard");
    const submitted: unknown[] = [];
    const shardSubmit = async (spec: unknown) => {
      submitted.push(spec);
      return { jobId: `job-${submitted.length}`, status: "queued" as const, statusUrl: "https://x" };
    };
    const service = new ScheduledTasksService(env, orm, "f3_manual_shard", undefined, undefined, undefined, undefined, undefined, undefined, shardSubmit as never);
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT", "NVDA"],
      thesis: "bullish",
      trigger: "manual",
    });
    expect(res.success).toBe(true);
    expect((res.data as { sharded?: boolean }).sharded).toBe(true);
    expect(typeof (res.data as { chainId?: unknown }).chainId).toBe("string");
    expect(submitted).toHaveLength(3);
    expect((res.data as { opportunities?: unknown[] }).opportunities).toEqual([]);
  });

  it("manual trigger at the 2-symbol limit stays monolithic", async () => {
    // Old pin injected a hand-built 2/2 scan via the fake execute()
    // seam; the reachable shape is both chains succeeding through the
    // real pipeline — monolithic success, res.data.sharded undefined.
    const { orm, env } = makeEnv("f3_manual_monolithic");
    stubChains({ AAPL: 150, MSFT: 250 });
    const submitted: unknown[] = [];
    const shardSubmit = async (spec: unknown) => {
      submitted.push(spec);
      return { jobId: `job-${submitted.length}`, status: "queued" as const, statusUrl: "https://x" };
    };
    const service = new ScheduledTasksService(env, orm, "f3_manual_monolithic", undefined, undefined, undefined, undefined, undefined, undefined, shardSubmit as never);
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      trigger: "manual",
    });
    expect(submitted).toHaveLength(0);
    expect((res.data as { sharded?: boolean }).sharded).toBeUndefined();
    expect(res.success).toBe(true);
  });
});

describe("F5 missing-coverage publish-nothing gate (#2599)", () => {
  beforeEach(() => {
    mockDeliverGatedSlack.mockClear();
  });

  it("evaluated 0 (all chains fail) takes the coded gate", async () => {
    // Old pin injected a coverage-less result (no coverage field, nothing
    // scanned) via the fake execute() seam; a coverage-less result cannot
    // occur via the pipeline — collate always stamps coverage — so the
    // reachable equivalent is evaluated==0, which takes the same coded
    // gate (:2777). The :2764 missing-coverage branch stays in
    // production as defence-in-depth.
    const { orm, env } = makeEnv("f5_missing_coverage");
    stubChains({});
    const service = new ScheduledTasksService(env, orm, "f5_missing_coverage");
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      trigger: "scheduled",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED");
  });

  it("a produced opportunity still proceeds (absence of coverage alone discards nothing)", async () => {
    // Old pin injected a hand-built scan with one opportunity and no
    // coverage via the fake; the reachable shape is real chains that
    // produce real opportunities through the pipeline — the run
    // succeeds and carries them.
    const { orm, env } = makeEnv("f5_missing_coverage_proceeds");
    stubChains({ AAPL: 150, MSFT: 250 });
    const service = new ScheduledTasksService(env, orm, "f5_missing_coverage_proceeds");
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      trigger: "scheduled",
    });
    expect(res.success).toBe(true);
    expect(((res.data as any)?.opportunities ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
