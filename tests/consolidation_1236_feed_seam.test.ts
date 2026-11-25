/**
 * Consolidation #1236 (feed seam): stored universe snapshot artifact +
 * producer + snapshot-input consumer + staleness rules, scoped to
 * scheduled strategy discovery.
 *
 * RED first: the feed modules do not exist yet. The store tests use a
 * statement-exact fake SQL executor (the FakeDiscoverySql precedent in
 * tests/scheduled_strategy_discovery.test.ts) so SQL drift fails loudly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SqlFeedSnapshotStore,
  resolveFeedSnapshotForSymbol,
  pickFeedLoadParams,
  type FeedSnapshotInput,
} from "../src/services/feedSnapshotStore";
import { produceFeedSnapshot } from "../src/services/feedSnapshotProducer";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { ETradeService } from "../src/services/etrade";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { InMemoryDiscoveryRunStore } from "../src/trading/options/discoveryRunStore";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import type { Env, ETradeOptionChain } from "../src/types";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";

const USER = "feed_tester";
const OTHER_USER = "other_trader";

const VALID_REQUEST: StrategyRequest = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 1,
  maxDte: 365,
  allowedStrategies: ["long_call", "long_put"],
  candidateLimit: 5,
};

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: { year: 2026, month: 11, day: 20 },
  pairs: [
    {
      call: {
        symbol: "NVDA", optionType: "CALL", strikePrice: 130,
        bid: 5.5, ask: 5.8, volume: 800, openInterest: 2000,
        impliedVolatility: 0.45, delta: 0.52, gamma: 0.04,
        theta: -0.05, vega: 0.12, rho: 0.02,
      },
      put: {
        symbol: "NVDA", optionType: "PUT", strikePrice: 130,
        bid: 5.4, ask: 5.7, volume: 600, openInterest: 1800,
        impliedVolatility: 0.45, delta: -0.48, gamma: 0.04,
        theta: -0.05, vega: 0.12, rho: -0.02,
      },
    },
  ],
} as ETradeOptionChain;

// Statement-exact fake SQL executor for SqlFeedSnapshotStore.
interface FakeFeedRow {
  id: string; created_at: string; user_login: string; symbol: string;
  as_of: string; data_source: string; snapshot_json: string; load_params_json: string;
}

class FakeFeedSql {
  rows: FakeFeedRow[] = [];
  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) return [];
    if (q.startsWith("INSERT INTO mas_feed_snapshots")) {
      const [id, created_at, user_login, symbol, as_of, data_source, snapshot_json, load_params_json] =
        params as [string, string, string, string, string, string, string, string];
      if (!this.rows.some((r) => r.id === id)) {
        this.rows.push({ id, created_at, user_login, symbol, as_of, data_source, snapshot_json, load_params_json });
      }
      return [];
    }
    // #4385 (#4282 P6b): the adapter's reads moved to the DO DML
    // catalogue's Repository entries, so the Repository's statement
    // shapes arrive here — SELECT * with the LIMIT inlined — instead
    // of the old explicit-column statements with a bound LIMIT.
    // The rows returned are unchanged (the same projection the old
    // branches returned); only the matched text changes.
    if (q.startsWith("SELECT * FROM mas_feed_snapshots WHERE user_login = ? AND symbol = ? ORDER BY created_at DESC, id DESC")) {
      const found = this.rows
        .filter((r) => r.user_login === params[0] && r.symbol === params[1])
        .sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : (a.id < b.id ? 1 : -1)));
      const limited = q.includes("LIMIT 1") ? found.slice(0, 1) : found;
      return limited.map((r) => ({ id: r.id, snapshot_json: r.snapshot_json, as_of: r.as_of, data_source: r.data_source, load_params_json: r.load_params_json, created_at: r.created_at }));
    }
    if (q.startsWith("SELECT * FROM mas_feed_snapshots WHERE user_login = ? AND id = ?")) {
      const found = this.rows.find((r) => r.user_login === params[0] && r.id === params[1]);
      return found ? [{ id: found.id, snapshot_json: found.snapshot_json, as_of: found.as_of, data_source: found.data_source, load_params_json: found.load_params_json, created_at: found.created_at }] : [];
    }
    // #4385: Repository.delete probes existence via findById
    // (SELECT * … WHERE id = ? LIMIT 1) before deleting.
    if (q.startsWith("SELECT * FROM mas_feed_snapshots WHERE id = ?")) {
      const found = this.rows.find((r) => r.id === params[0]);
      return found ? [{ ...found }] : [];
    }
    if (q.startsWith("DELETE FROM mas_feed_snapshots WHERE id = ?")) {
      this.rows = this.rows.filter((r) => r.id !== params[0]);
      return [];
    }
    throw new Error(`FakeFeedSql: unhandled statement: ${q}`);
  }
}

function cleanSnapshot(overrides: Partial<OptionsDataSnapshot> = {}): OptionsDataSnapshot {
  return {
    symbol: "NVDA",
    contracts: [],
    dataSource: "live",
    screen: {
      scannedAt: "2026-10-26T05:00:00.000Z",
      underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0,
      fetchErrors: [], warnings: [],
    },
    rejections: [],
    ...overrides,
  };
}

function makeEnv(): Env {
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
  } as unknown as Env;
}

function makeOrm() {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: { findMany: vi.fn(() => []) },
  } as any;
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
  DynamicOptionsScreener.setTestChainsFixture({ NVDA: NVDA_CHAIN });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
});

afterEach(() => {
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
  vi.unstubAllGlobals();
  DynamicOptionsScreener.clearTestChainsFixture();
});

// ---------------------------------------------------------------------
// 1. Artifact store
// ---------------------------------------------------------------------
describe("feed snapshot store (#1236)", () => {
  it("round-trips a stored snapshot by id", async () => {
    const sql = new FakeFeedSql();
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => "feed-1" });
    const snapshot = cleanSnapshot();
    const stored = store.store({
      userLogin: USER, symbol: "NVDA", snapshot,
      asOf: "2026-10-26T05:00:00.000Z", dataSource: "live",
      loadParams: { symbol: "NVDA" }, nowIso: "2026-10-26T05:00:01.000Z",
    });
    expect(stored.id).toBe("feed-1");
    expect(stored.asOf).toBe("2026-10-26T05:00:00.000Z");
    const read = store.byId(USER, "feed-1");
    expect(read?.snapshot).toEqual(snapshot);
    expect(read?.loadParams).toEqual({ symbol: "NVDA" });
  });

  it("latest wins by created_at and is tenant-scoped", async () => {
    const sql = new FakeFeedSql();
    let n = 0;
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => `feed-${++n}` });
    store.store({ userLogin: USER, symbol: "NVDA", snapshot: cleanSnapshot(), asOf: "2026-10-26T05:00:00.000Z", dataSource: "live", loadParams: {}, nowIso: "2026-10-26T05:00:01.000Z" });
    store.store({ userLogin: USER, symbol: "NVDA", snapshot: cleanSnapshot(), asOf: "2026-10-26T06:00:00.000Z", dataSource: "live", loadParams: {}, nowIso: "2026-10-26T06:00:01.000Z" });
    store.store({ userLogin: OTHER_USER, symbol: "NVDA", snapshot: cleanSnapshot(), asOf: "2026-10-26T07:00:00.000Z", dataSource: "live", loadParams: {}, nowIso: "2026-10-26T07:00:01.000Z" });
    expect(store.latest(USER, "NVDA")?.asOf).toBe("2026-10-26T06:00:00.000Z");
    expect(store.latest(OTHER_USER, "NVDA")?.asOf).toBe("2026-10-26T07:00:00.000Z");
    expect(store.latest(USER, "MSFT")).toBeUndefined();
    expect(store.byId(OTHER_USER, "feed-1")).toBeUndefined();
  });

  it("prunes to the latest 10 per (user, symbol)", async () => {
    const sql = new FakeFeedSql();
    let n = 0;
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => `feed-${++n}`, keepPerSymbol: 10 });
    for (let i = 0; i < 12; i++) {
      store.store({ userLogin: USER, symbol: "NVDA", snapshot: cleanSnapshot(), asOf: `2026-10-26T05:00:00.000Z`, dataSource: "live", loadParams: {}, nowIso: `2026-10-26T${String(i).padStart(2, "0")}:00:00.000Z` });
    }
    expect(sql.rows.filter((r) => r.user_login === USER && r.symbol === "NVDA")).toHaveLength(10);
    expect(store.byId(USER, "feed-1")).toBeUndefined();
    expect(store.byId(USER, "feed-12")).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// 2. Producer
// ---------------------------------------------------------------------
describe("feed snapshot producer (#1236)", () => {
  it("stores a clean snapshot and reports its descriptor", async () => {
    const sql = new FakeFeedSql();
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => "feed-9" });
    const snapshot = cleanSnapshot({ contracts: [] });
    const out = await produceFeedSnapshot({
      store, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => snapshot,
      loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowIso: "2026-10-26T05:00:02.000Z",
    });
    expect(out.artifactId).toBe("feed-9");
    expect(out.asOf).toBe("2026-10-26T05:00:00.000Z");
    expect(out.dataSource).toBe("live");
    expect(out.contractCount).toBe(0);
    expect(store.byId(USER, "feed-9")).not.toBeUndefined();
  });

  it("refuses a snapshot that never loaded (validationError) and stores nothing", async () => {
    const sql = new FakeFeedSql();
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => "feed-9" });
    await expect(produceFeedSnapshot({
      store, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => cleanSnapshot({ validationError: "demo disabled" }),
      loadParams: {}, nowIso: "2026-10-26T05:00:02.000Z",
    })).rejects.toThrow(/not stored/);
    expect(store.latest(USER, "NVDA")).toBeUndefined();
  });

  it("refuses zero contracts with fetch errors and stores nothing", async () => {
    const sql = new FakeFeedSql();
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => "feed-9" });
    await expect(produceFeedSnapshot({
      store, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => cleanSnapshot({
        screen: {
          scannedAt: "2026-10-26T05:00:00.000Z",
          underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0,
          fetchErrors: [{ symbol: "NVDA", reason: "chain fetch failed" }], warnings: [],
        },
      }),
      loadParams: {}, nowIso: "2026-10-26T05:00:02.000Z",
    })).rejects.toThrow(/not stored/);
    expect(store.latest(USER, "NVDA")).toBeUndefined();
  });

  it("falls back to store time for asOf when the screen carries no scannedAt", async () => {
    const sql = new FakeFeedSql();
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => "feed-9" });
    const snapshot = cleanSnapshot();
    delete (snapshot.screen as any).scannedAt;
    const out = await produceFeedSnapshot({
      store, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => snapshot,
      loadParams: {}, nowIso: "2026-10-26T05:00:02.000Z",
    });
    expect(out.asOf).toBe("2026-10-26T05:00:02.000Z");
  });
});

// ---------------------------------------------------------------------
// 3. Resolver + staleness rules
// ---------------------------------------------------------------------
describe("feed snapshot resolution + staleness (#1236)", () => {
  function seededStore() {
    const sql = new FakeFeedSql();
    let n = 0;
    const store = new SqlFeedSnapshotStore(sql, { idFactory: () => `feed-${++n}` });
    store.store({ userLogin: USER, symbol: "NVDA", snapshot: cleanSnapshot(), asOf: "2026-10-26T05:00:00.000Z", dataSource: "live", loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowIso: "2026-10-26T05:00:01.000Z" });
    return store;
  }
  const NOW = Date.parse("2026-10-26T05:30:00.000Z");

  it("resolves an artifacts-map id and reports fresh", () => {
    const store = seededStore();
    const input: FeedSnapshotInput = { artifacts: { NVDA: "feed-1" } };
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowMs: NOW });
    expect(res.status).toBe("hit");
    if (res.status === "hit") {
      expect(res.artifact.id).toBe("feed-1");
      expect(res.stale).toBe(false);
    }
  });

  it("reports missing for an unknown artifacts-map id", () => {
    const store = seededStore();
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { artifacts: { NVDA: "feed-nope" } }, requestFilters: {}, nowMs: NOW });
    expect(res.status).toBe("missing");
    if (res.status === "missing") expect(res.reason).toMatch(/feed-nope/);
  });

  it("resolves latest per symbol when latest is set", () => {
    const store = seededStore();
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true }, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowMs: NOW });
    expect(res.status).toBe("hit");
  });

  it("reports missing when no latest artifact exists", () => {
    const store = seededStore();
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "MSFT", input: { latest: true }, requestFilters: {}, nowMs: NOW });
    expect(res.status).toBe("missing");
    if (res.status === "missing") expect(res.reason).toMatch(/no stored artifact/);
  });

  it("marks stale when age exceeds maxAgeSeconds and fresh within it", () => {
    const store = seededStore();
    const stale = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true, maxAgeSeconds: 600 }, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowMs: NOW });
    expect(stale.status).toBe("hit");
    if (stale.status === "hit") expect(stale.stale).toBe(true);
    const fresh = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true, maxAgeSeconds: 3600 }, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowMs: NOW });
    if (fresh.status === "hit") expect(fresh.stale).toBe(false);
    const noMax = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true }, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowMs: NOW });
    if (noMax.status === "hit") expect(noMax.stale).toBe(false);
  });

  it("rejects a filter mismatch instead of silently running on the wrong chain", () => {
    const store = seededStore();
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true }, requestFilters: { symbol: "NVDA", minDte: 30, maxDte: 365 }, nowMs: NOW });
    expect(res.status).toBe("missing");
    if (res.status === "missing") expect(res.reason).toMatch(/filter mismatch/);
  });

  it("normalizes an absent dataMode to live on both sides", () => {
    const store = seededStore();
    const res = resolveFeedSnapshotForSymbol({ store, userLogin: USER, symbol: "NVDA", input: { latest: true }, requestFilters: { symbol: "NVDA", minDte: 1, maxDte: 365, dataMode: "live" }, nowMs: NOW });
    expect(res.status).toBe("hit");
  });

  it("picks only the defined filter fields off a request", () => {
    expect(pickFeedLoadParams({ symbol: "nvda", minDte: 1, thesis: "bullish" } as any)).toEqual({ symbol: "NVDA", minDte: 1 });
  });
});

// ---------------------------------------------------------------------
// 4. Schedule-surface pin
// ---------------------------------------------------------------------
describe("feed snapshotInput on discovery schedules (#1236)", () => {
  it("accepts snapshotInput on autonomousStrategyDiscovery and carries it through", () => {
    const built = buildSchedulePayload("autonomousStrategyDiscovery", {
      requests: [VALID_REQUEST],
      snapshotInput: { latest: true, maxAgeSeconds: 3600 },
    }, { userLogin: USER, trigger: "scheduled" });
    expect(built.ok).toBe(true);
    if (built.ok) expect((built.value as any).snapshotInput).toEqual({ latest: true, maxAgeSeconds: 3600 });
  });

  it("rejects a snapshotInput naming neither artifacts nor latest", () => {
    const built = buildSchedulePayload("autonomousStrategyDiscovery", {
      requests: [VALID_REQUEST],
      snapshotInput: {},
    }, { userLogin: USER, trigger: "scheduled" });
    expect(built.ok).toBe(false);
  });

  it("rejects snapshotInput on non-discovery callbacks (strict object)", () => {
    const built = buildSchedulePayload("autonomousMarketScreen", {
      universe: "NASDAQ100",
      snapshotInput: { latest: true },
    }, { userLogin: USER, trigger: "scheduled" });
    expect(built.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 5. Service consumer: snapshot-input mode on scheduled discovery
// ---------------------------------------------------------------------
describe("ScheduledTasksService snapshot-input discovery (#1236)", () => {
  async function produceNvdaArtifact(store: SqlFeedSnapshotStore, orm: any) {
    const etrade = new ETradeService(orm, makeEnv(), USER, "TEST");
    const agent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client));
    const snapshot = await agent.loadSnapshot({ symbol: "NVDA" });
    const out = await produceFeedSnapshot({
      store, userLogin: USER, symbol: "NVDA",
      loadSnapshot: async () => snapshot,
      loadParams: { symbol: "NVDA", minDte: 1, maxDte: 365 }, nowIso: "2026-10-26T05:00:02.000Z",
    });
    return out;
  }

  it("runs on a stored snapshot without live-loading (fixture cleared, fetch disabled)", async () => {
    const feedSql = new FakeFeedSql();
    const feedStore = new SqlFeedSnapshotStore(feedSql, { idFactory: () => "feed-live" });
    const orm = makeOrm();
    const { artifactId } = await produceNvdaArtifact(feedStore, orm);
    // Prove the bypass: live would now fail (no fixture, fetch throws).
    DynamicOptionsScreener.clearTestChainsFixture();
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-feed" });
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, runStore, undefined, undefined, undefined, feedStore);
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
      snapshotInput: { artifacts: { NVDA: artifactId } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    const stored = await runStore.get("run-feed", { userLogin: USER });
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
    expect(stored!.outcomes[0].snapshotInput).toMatchObject({ artifactId, stale: false });
    expect(stored!.outcomes[0].snapshot?.dataSource).toBe("live");
  });

  it("fails a symbol with a missing artifact and still completes the rest (partial)", async () => {
    const feedSql = new FakeFeedSql();
    const feedStore = new SqlFeedSnapshotStore(feedSql, { idFactory: () => "feed-live" });
    const orm = makeOrm();
    const { artifactId } = await produceNvdaArtifact(feedStore, orm);
    DynamicOptionsScreener.clearTestChainsFixture();
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-feed-partial" });
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, runStore, undefined, undefined, undefined, feedStore);
    const msftRequest: StrategyRequest = { ...VALID_REQUEST, symbol: "MSFT" };
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST, msftRequest],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
      snapshotInput: { artifacts: { NVDA: artifactId, MSFT: "feed-nope" } },
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("partial");
    expect(result.data?.failedCount).toBe(1);
    expect(result.data?.failures).toEqual([{ symbol: "MSFT", error: expect.stringContaining("feed snapshot") }]);
  });

  it("surfaces a stale artifact with its flag and audit event, never a silent live fallback", async () => {
    const feedSql = new FakeFeedSql();
    const feedStore = new SqlFeedSnapshotStore(feedSql, { idFactory: () => "feed-stale" });
    const orm = makeOrm();
    const oldSnapshot = cleanSnapshot({
      symbol: "ZZZZ",
      screen: {
        scannedAt: "2026-10-20T05:00:00.000Z",
        underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0,
        fetchErrors: [], warnings: [],
      },
    });
    const { artifactId } = await produceFeedSnapshot({
      store: feedStore, userLogin: USER, symbol: "ZZZZ",
      loadSnapshot: async () => oldSnapshot,
      loadParams: { symbol: "ZZZZ", minDte: 1, maxDte: 365 }, nowIso: "2026-10-20T05:00:02.000Z",
    });
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-feed-stale" });
    // #6102: the stale-artifact audit row lands in D1 now, via the
    // service's sync audit() helper — fire-and-forget — so the
    // service gets a fresh env carrying a fresh MockD1Database and
    // the row is polled for briefly instead of asserted as a race.
    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const service = new ScheduledTasksService({ ...makeEnv(), AGENT_DB: d1Mock }, orm, USER, undefined, undefined, runStore, undefined, undefined, undefined, feedStore);
    const zzzzRequest: StrategyRequest = { ...VALID_REQUEST, symbol: "ZZZZ" };
    const result = await service.autonomousStrategyDiscovery({
      requests: [zzzzRequest],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
      snapshotInput: { artifacts: { ZZZZ: artifactId }, maxAgeSeconds: 3600 },
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    const stored = await runStore.get("run-feed-stale", { userLogin: USER });
    expect(stored!.outcomes[0].snapshotInput).toMatchObject({ artifactId, stale: true });
    let staleEvents: Awaited<ReturnType<typeof d1Store.findMany>> = [];
    for (let i = 0; i < 50; i++) {
      staleEvents = await d1Store.findMany({ where: { type: "options.strategy_discovery_snapshot_stale" } });
      if (staleEvents.length === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(staleEvents).toHaveLength(1);
  });

  it("fails honestly when snapshotInput is named but no feed store is wired", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-feed-nostore" });
    const service = new ScheduledTasksService(makeEnv(), makeOrm(), USER, undefined, undefined, runStore);
    const result = await service.autonomousStrategyDiscovery({
      requests: [VALID_REQUEST],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
      snapshotInput: { latest: true },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/feed snapshot store/);
  });
});
