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
 * (mocked UnifiedOptionsService + Slack delivery, MockSqlStorage).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { UnifiedOptionsService } from "../src/trading";
import { deliverScreenerToSlackA2A } from "../src/services/screenerSlackDelivery";
import type { Env } from "../src/types";

const mockDeliverA2A = vi.mocked(deliverScreenerToSlackA2A);

vi.mock("../src/trading", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    UnifiedOptionsService: class FakeUnifiedOptionsService {
      static scan: any = null;
      constructor(..._args: unknown[]) {}
      async execute() {
        return FakeUnifiedOptionsService.scan;
      }
    },
  };
});

vi.mock("../src/services/screenerSlackDelivery", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deliverScreenerToSlackA2A: vi.fn(async () => ({ ok: true as const })),
  };
});

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
    SEARCH_AGENT: {} as any,
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

const baseScan = (data: Record<string, unknown>) => ({
  success: true,
  summary: "scan",
  data,
  toSlack: () => "success text",
  toEmailText: () => "",
  toEmailHtml: () => "",
  toWebhook: () => ({}),
});

describe("F3 auto-shard is trigger-independent (#2599)", () => {
  beforeEach(() => {
    mockDeliverA2A.mockClear();
    (UnifiedOptionsService as any).scan = null;
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
    const { orm, env } = makeEnv("f3_manual_monolithic");
    (UnifiedOptionsService as any).scan = baseScan({
      scanned: 2,
      coverage: { evaluated: 2, considered: 2, errors: 0, truncated: 0 },
      opportunities: [],
      withTrades: 0,
      scanRunId: "test-run-f3",
    });
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
    mockDeliverA2A.mockClear();
    (UnifiedOptionsService as any).scan = null;
  });

  it("no coverage + nothing scanned + no trades + no opportunities takes the coded gate", async () => {
    const { orm, env } = makeEnv("f5_missing_coverage");
    (UnifiedOptionsService as any).scan = baseScan({
      scanned: 0,
      withTrades: 0,
      opportunities: [],
    });
    const service = new ScheduledTasksService(env, orm, "f5_missing_coverage");
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      trigger: "scheduled",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED");
  });

  it("no coverage but a produced opportunity still proceeds (absence of coverage alone discards nothing)", async () => {
    const { orm, env } = makeEnv("f5_missing_coverage_proceeds");
    (UnifiedOptionsService as any).scan = baseScan({
      scanned: 1,
      withTrades: 1,
      opportunities: [{ symbol: "AAPL" }],
      scanRunId: "test-run-f5",
    });
    const service = new ScheduledTasksService(env, orm, "f5_missing_coverage_proceeds");
    const res = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      trigger: "scheduled",
    });
    expect(res.success).toBe(true);
  });
});
