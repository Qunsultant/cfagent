/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — conformance
 * suite for the options/discovery ports. One suite per port,
 * run against EVERY adapter with identical semantics:
 *
 *  - scan runs / discovery runs / setup runs / profiles /
 *    paused schedules: DO-SQLite adapter bare (sequential),
 *    DO-SQLite adapter composed through the composition root
 *    with the transaction runner registered (the production
 *    shape), and the in-memory adapter;
 *  - discovery alerts: DO-SQLite + in-memory (dedupe is a
 *    store-level invariant on both — the port contract);
 *  - IV history: DO-SQLite + in-memory + D1 (Drizzle over a
 *    node:sqlite-backed mock D1), plus the CUTOVER pins: since
 *    the R-2 cutover the env-aware build defaults to the D1
 *    adapter whenever AGENT_DB is bound (the flag is the
 *    rollback lever), and a cold D1 store reads as the honest
 *    warming-up state;
 *  - feed snapshots: DO-SQLite + in-memory (new twin);
 *  - structural pins: migration 0020 registered exactly once
 *    (14 still absent, gate G-3), 0020 DDL ↔ Drizzle parity,
 *    port modules import no store client, the nine legacy
 *    modules are re-export shims naming the data layer.
 *
 * The transaction-wrapped path is exercised by registering
 * the aspect-backed runner (the same registration src/server
 * .ts performs) and composing through createOptionsDiscovery
 * Ports over a node:sqlite storage double whose
 * transactionSync has real BEGIN/COMMIT/ROLLBACK semantics.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createOptionsDiscoveryPorts,
  buildOptionsDiscoveryPorts,
  ivHistoryD1Enabled,
} from "../src/data/createOptionsDiscoveryPorts";
import {
  registerTransactionRunner,
} from "../src/data/transactionRunnerProvider";
import { aspectTransactionRunner } from "../src/data/transactionRunner";
import type { ScanRunStore } from "../src/data/scanRunPorts";
import { SqlScanRunStore } from "../src/data/doSqliteScanRunAdapter";
import { InMemoryScanRunStore } from "../src/data/inMemoryScanRunAdapter";
import type { DiscoveryRunStore } from "../src/data/discoveryRunPorts";
import { SqlDiscoveryRunStore } from "../src/data/doSqliteDiscoveryRunAdapter";
import { InMemoryDiscoveryRunStore } from "../src/data/inMemoryDiscoveryRunAdapter";
import type { DiscoverySetupStore } from "../src/data/discoverySetupPorts";
import { SqlDiscoverySetupStore } from "../src/data/doSqliteDiscoverySetupAdapter";
import { InMemoryDiscoverySetupStore } from "../src/data/inMemoryDiscoverySetupAdapter";
import type {
  DiscoveryAlertStore,
} from "../src/data/discoveryAlertPorts";
import { SqlDiscoveryAlertStore } from "../src/data/doSqliteDiscoveryAlertAdapter";
import { InMemoryDiscoveryAlertStore } from "../src/data/inMemoryDiscoveryAlertAdapter";
import type { IvHistoryStore } from "../src/data/ivHistoryPorts";
import { computeIvStats } from "../src/data/ivHistoryPorts";
import { getIvHistoryEntry } from "../src/trading/options/ivCollector";
import { SqlIvHistoryStore } from "../src/data/doSqliteIvHistoryAdapter";
import { InMemoryIvHistoryStore } from "../src/data/inMemoryIvHistoryAdapter";
import {
  createD1IvHistoryDb,
  D1IvHistoryStore,
  ensureIvHistorySchema,
} from "../src/data/d1IvHistoryAdapter";
import type { StrategyProfileStore } from "../src/data/strategyProfilePorts";
import { SqlStrategyProfileStore } from "../src/data/doSqliteStrategyProfileAdapter";
import { InMemoryStrategyProfileStore } from "../src/data/inMemoryStrategyProfileAdapter";
import type {
  FeedSnapshotStore,
} from "../src/data/feedSnapshotPorts";
import { resolveFeedSnapshotForSymbol } from "../src/data/feedSnapshotPorts";
import { SqlFeedSnapshotStore } from "../src/data/doSqliteFeedSnapshotAdapter";
import { InMemoryFeedSnapshotStore } from "../src/data/inMemoryFeedSnapshotAdapter";
import {
  ALL_MIGRATIONS,
  MIGRATION_0020_IV_HISTORY,
  MIGRATION_0045_IV_HISTORY_BROKER,
} from "../src/data/migrationRunner";
import { agentIvHistory } from "../src/data/drizzleSchema";
import type { StrategyProfileSpec } from "../src/trading/options/strategyProfile";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";

beforeAll(() => {
  registerTransactionRunner(aspectTransactionRunner);
});
afterAll(() => {
  // The registry is process-global; other suites in this
  // worker must not inherit the registration.
  registerTransactionRunner(undefined as never);
});

/* ------------------------------------------------------------------ */
/* Storage doubles (the characterization file's shapes)                */
/* ------------------------------------------------------------------ */

/**
 * Storage double doubling as its own executor: `sql` is the
 * storage's own handle (this), and `transactionSync` invokes
 * its closure with NO argument — the real facade's shape, as
 * observed by #2348 and implemented by the aspect after #2455
 * (the pre-fix double passed a `{ sql }` argument; corrected
 * here, semantics unchanged).
 */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
  transactionSync<T>(closure: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/** A storage double whose exec throws on statements matching a marker. */
class FlakyTestStorage extends SqliteTestStorage {
  constructor(private readonly failOn: string) {
    super();
  }
  override exec(query: string, ...params: unknown[]): unknown[] {
    if (query.includes(this.failOn)) {
      throw new Error(`injected failure on ${this.failOn}`);
    }
    return super.exec(query, ...params);
  }
}

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function scanResult(generatedAt: string, symbol = "AAPL"): never {
  return {
    generatedAt,
    mode: "live",
    modelVersion: "opp-v1",
    gate: { passed: true },
    coverage: { requested: 1, scanned: 1, withQuotes: 1, symbols: [symbol] },
    opportunities: [],
    abstentions: [],
  } as never;
}

function profileSpec(): StrategyProfileSpec {
  return {
    strategies: ["iron-condor"],
    minDte: 20,
    maxDte: 45,
    targetDelta: 0.16,
    minProbabilityOfProfit: 0.6,
    minAnnualizedReturn: 0.2,
    minCredit: 0.5,
    maxLegSpreadPct: 0.1,
    minVolume: 100,
    minOpenInterest: 500,
    maxCapitalPerTrade: 5000,
    riskCaps: { maxCapitalPerName: 10000 },
  } as StrategyProfileSpec;
}

function snapshot(symbol: string, scannedAt: string): OptionsDataSnapshot {
  return {
    symbol,
    screen: {
      symbol,
      scannedAt,
      contracts: [],
      source: "live",
      meta: { totalContracts: 0, filteredContracts: 0, tradableContracts: 0 },
    },
    chain: null,
    quotes: {},
    greeksCoverage: { total: 0, withAllGreeks: 0, complete: true },
    underlyingPrice: 200,
    priceSource: "live",
    fromCache: false,
  } as unknown as OptionsDataSnapshot;
}

/* ------------------------------------------------------------------ */
/* Scan runs                                                           */
/* ------------------------------------------------------------------ */

function scanRunSuite(label: string, makeStore: () => ScanRunStore) {
  describe(`conformance scanRuns — ${label}`, () => {
    it("save/get/list honour #103 visibility incl. the legacy-NULL rule", async () => {
      const store = makeStore();
      await store.save(scanResult("2026-10-22T14:00:00.000Z"), { id: "legacy" });
      await store.save(scanResult("2026-10-22T15:00:00.000Z"), { id: "alice-run", userLogin: "alice" });
      expect((await store.list({ userLogin: "alice" })).map((r) => r.id)).toEqual(["alice-run", "legacy"]);
      expect((await store.list({ userLogin: "bob" })).map((r) => r.id)).toEqual(["legacy"]);
      expect((await store.list()).map((r) => r.id)).toEqual(["legacy"]);
      expect(await store.get("alice-run", { userLogin: "bob" })).toBeNull();
      expect((await store.get("alice-run", { userLogin: "alice" }))?.id).toBe("alice-run");
    });

    it("retention on write prunes by the run's own clock and the row cap", async () => {
      const store = makeStore();
      await store.save(scanResult("2025-01-01T00:00:00.000Z"), { id: "ancient" });
      await store.save(scanResult("2026-10-22T14:00:00.000Z"), { id: "fresh" });
      expect((await store.list({ limit: 50 })).map((r) => r.id)).toEqual(["fresh"]);
      expect(await store.prune(new Date("2026-10-22T14:00:00.000Z"))).toBe(0);
    });

    it("updatePdfKey stamps both copies and respects visibility", async () => {
      const store = makeStore();
      await store.save(scanResult("2026-10-22T14:00:00.000Z"), { id: "r1", userLogin: "alice" });
      expect(await store.updatePdfKey("r1", "reports/r1.pdf", { userLogin: "bob" })).toBe(false);
      expect(await store.updatePdfKey("r1", "reports/r1.pdf", { userLogin: "alice" })).toBe(true);
      const got = await store.get("r1", { userLogin: "alice" });
      expect(got?.pdfKey).toBe("reports/r1.pdf");
      expect((got?.result as { pdfKey?: string }).pdfKey).toBe("reports/r1.pdf");
      expect(await store.updatePdfKey("r1", "")).toBe(false);
    });
  });
}

scanRunSuite("DO adapter (bare)", () => new SqlScanRunStore(new SqliteTestStorage() as never));
scanRunSuite("DO adapter (composed, tx-wrapped)", () => {
  const storage = new SqliteTestStorage();
  return createOptionsDiscoveryPorts({ sql: storage as never, storage: storage as never }).scanRuns;
});
scanRunSuite("in-memory adapter", () => new InMemoryScanRunStore());

describe("conformance scanRuns — transaction unit semantics", () => {
  it("a prune failure inside save rolls the INSERT back (wrapped) but not bare", async () => {
    const wrappedStorage = new FlakyTestStorage("DELETE FROM mas_opportunity_scans");
    const wrapped = createOptionsDiscoveryPorts({
      sql: wrappedStorage as never,
      storage: wrappedStorage as never,
    }).scanRuns;
    await expect(
      wrapped.save(scanResult("2026-10-22T14:00:00.000Z"), { id: "tx-run" }),
    ).rejects.toThrow(/injected failure/);
    expect(await wrapped.get("tx-run")).toBeNull();

    const bareStorage = new FlakyTestStorage("DELETE FROM mas_opportunity_scans");
    const bare = new SqlScanRunStore(bareStorage as never);
    await expect(
      bare.save(scanResult("2026-10-22T14:00:00.000Z"), { id: "bare-run" }),
    ).rejects.toThrow(/injected failure/);
    // Sequential application: the INSERT landed before the prune threw.
    expect((await bare.get("bare-run"))?.id).toBe("bare-run");
  });
});

/* ------------------------------------------------------------------ */
/* Discovery runs                                                      */
/* ------------------------------------------------------------------ */

function discoveryRunInput(createdAt: string, userLogin?: string): never {
  return {
    createdAt,
    trigger: "scheduled",
    inputModel: "saved-request",
    requests: [{ symbol: "AAA" }],
    outcomes: [
      { symbol: "AAA", status: "completed" },
      { symbol: "BBB", status: "abstained", error: "cannot derive" },
      { symbol: "CCC", status: "failed", error: "chain failed" },
    ],
    status: "completed",
    ...(userLogin !== undefined ? { userLogin } : {}),
  } as never;
}

function discoveryRunSuite(label: string, makeStore: () => DiscoveryRunStore) {
  describe(`conformance discoveryRuns — ${label}`, () => {
    it("counts are derived from outcomes; visibility matches the scan rule", async () => {
      const store = makeStore();
      const run = await store.save(discoveryRunInput("2026-10-22T14:00:00.000Z", "alice"));
      expect(run.completedCount).toBe(1);
      expect(run.abstainedCount).toBe(1);
      expect(run.failedCount).toBe(1);
      expect(run.symbols).toEqual(["AAA", "BBB", "CCC"]);
      const legacy = await store.save(discoveryRunInput("2026-10-22T15:00:00.000Z"));
      expect((await store.list({ userLogin: "bob" })).map((r) => r.id)).toEqual([legacy.id]);
      expect(await store.get(run.id, { userLogin: "bob" })).toBeNull();
      expect((await store.get(run.id, { userLogin: "alice" }))?.outcomes).toHaveLength(3);
    });
  });
}

discoveryRunSuite("DO adapter (bare)", () => new SqlDiscoveryRunStore(new SqliteTestStorage() as never));
discoveryRunSuite("DO adapter (composed, tx-wrapped)", () => {
  const storage = new SqliteTestStorage();
  return createOptionsDiscoveryPorts({ sql: storage as never, storage: storage as never }).discoveryRuns;
});
discoveryRunSuite("in-memory adapter", () => new InMemoryDiscoveryRunStore());

/* ------------------------------------------------------------------ */
/* Discovery setup runs                                                */
/* ------------------------------------------------------------------ */

function setupItem(symbol: string): never {
  return {
    kind: "setup",
    symbol,
    thesis: "bullish",
    ruleId: "trend-up",
    confidence: "MEDIUM",
    discoveryScore: 62,
    gateBucket: "fit",
    targetPrice: 100,
    targetDate: "2026-11-20",
    firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
    evidence: `${symbol} evidence line`,
  } as never;
}

function abstentionItem(symbol: string): never {
  return {
    kind: "abstention",
    symbol,
    stage: "inference",
    reason: "no setup",
    nearMissSignals: [],
  } as never;
}

function setupInput(createdAt: string): never {
  const items = [setupItem("AAA"), abstentionItem("BBB")];
  return {
    createdAt,
    scopeKey: "schedule:morning-scan",
    source: "schedule",
    configHash: "cfg-abc",
    userLogin: "alice",
    counts: { considered: 2, setups: 1, abstentions: 1, prescreenedOut: 0, errors: 0 },
    items,
  } as never;
}

function discoverySetupSuite(label: string, makeStore: () => DiscoverySetupStore) {
  describe(`conformance discoverySetupRuns — ${label}`, () => {
    it("an unreconciled run is rejected before any write", async () => {
      const store = makeStore();
      const bad = setupInput("2026-10-22T14:00:00.000Z") as unknown as { counts: { considered: number } };
      bad.counts.considered = 5;
      await expect(store.save(bad as never)).rejects.toThrow(/rejected/);
      expect(await store.list({ limit: 10 })).toEqual([]);
    });

    it("save + latestForScope + visibility round-trip", async () => {
      const store = makeStore();
      await store.save(setupInput("2026-10-22T14:00:00.000Z"));
      await store.save(setupInput("2026-10-22T16:00:00.000Z"));
      const latest = await store.latestForScope("schedule:morning-scan", { userLogin: "alice" });
      expect(latest?.createdAt).toBe("2026-10-22T16:00:00.000Z");
      expect(await store.latestForScope("schedule:morning-scan", { userLogin: "bob" })).toBeNull();
    });
  });
}

discoverySetupSuite("DO adapter (bare)", () => new SqlDiscoverySetupStore(new SqliteTestStorage() as never));
discoverySetupSuite("DO adapter (composed, tx-wrapped)", () => {
  const storage = new SqliteTestStorage();
  return createOptionsDiscoveryPorts({ sql: storage as never, storage: storage as never }).discoverySetupRuns;
});
discoverySetupSuite("in-memory adapter", () => new InMemoryDiscoverySetupStore());

/* ------------------------------------------------------------------ */
/* Discovery alerts                                                    */
/* ------------------------------------------------------------------ */

function alertInput(symbol = "AAPL"): never {
  return {
    runId: "run-1",
    scopeKey: "sched:morning",
    symbol,
    thesis: "bullish",
    discoveryScore: 85,
    day: "2026-10-22",
    evidence: `${symbol} evidence`,
    firedSignals: ["TREND_UP"],
    createdAt: "2026-10-22T13:00:00.000Z",
  } as never;
}

function discoveryAlertSuite(label: string, makeStore: () => DiscoveryAlertStore) {
  describe(`conformance discoveryAlerts — ${label}`, () => {
    it("dedupe is a store-level invariant: a duplicate record rejects", async () => {
      const store = makeStore();
      await store.record(alertInput());
      await expect(store.record(alertInput())).rejects.toThrow();
      expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(1);
    });

    it("hasAlerted + countForDay count records per (scope, day)", async () => {
      const store = makeStore();
      await store.record(alertInput("AAA"));
      await store.record(alertInput("BBB"));
      expect(await store.hasAlerted("sched:morning", "AAA", "bullish" as never, "2026-10-22")).toBe(true);
      expect(await store.hasAlerted("sched:morning", "CCC", "bullish" as never, "2026-10-22")).toBe(false);
      expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(2);
      expect(await store.countForDay("sched:morning", "2026-10-23")).toBe(0);
    });
  });
}

discoveryAlertSuite("DO adapter", () => new SqlDiscoveryAlertStore(new SqliteTestStorage() as never));
discoveryAlertSuite("in-memory adapter", () => new InMemoryDiscoveryAlertStore());

/* ------------------------------------------------------------------ */
/* IV history (+ cutover gate)                                         */
/* ------------------------------------------------------------------ */

function ivRecord(symbol: string, date: string, atmIv: number): never {
  return {
    symbol,
    date,
    atmIv,
    spot: 200,
    expiryDate: "2026-11-20",
    dte: 30,
    collectedAt: `${date}T14:00:00.000Z`,
  } as never;
}

function ivSuite(label: string, makeStore: () => Promise<IvHistoryStore> | IvHistoryStore) {
  describe(`conformance ivHistory — ${label}`, () => {
    it("first-write-wins is reported; symbols normalize", async () => {
      const store = await makeStore();
      expect(await store.record(ivRecord("AAPL", "2026-10-20", 0.3))).toBe(true);
      expect(await store.record(ivRecord("AAPL", "2026-10-20", 0.55))).toBe(false);
      expect((await store.get("aapl", "2026-10-20"))?.atmIv).toBe(0.3);
      await store.record(ivRecord(" aapl ", "2026-10-21", 0.31));
      expect(await store.listSymbols()).toEqual(["AAPL"]);
    });

    it("listSeries is newest-first with an honoured limit; coverage spans the series", async () => {
      const store = await makeStore();
      await store.record(ivRecord("AAPL", "2026-10-19", 0.28));
      await store.record(ivRecord("AAPL", "2026-10-21", 0.34));
      await store.record(ivRecord("AAPL", "2026-10-20", 0.3));
      await store.record(ivRecord("MSFT", "2026-10-20", 0.22));
      expect((await store.listSeries("AAPL")).map((r) => r.date)).toEqual([
        "2026-10-21",
        "2026-10-20",
        "2026-10-19",
      ]);
      expect((await store.listSeries("AAPL", { limit: 2 })).map((r) => r.date)).toEqual([
        "2026-10-21",
        "2026-10-20",
      ]);
      expect(await store.coverage("AAPL")).toEqual({
        observations: 3,
        firstDate: "2026-10-19",
        lastDate: "2026-10-21",
      });
      expect(await store.coverage("NVDA")).toEqual({
        observations: 0,
        firstDate: null,
        lastDate: null,
      });
      expect(await store.listSymbols()).toEqual(["AAPL", "MSFT"]);
    });

    it("the warming-up stats contract holds over the stored series", async () => {
      const store = await makeStore();
      await store.record(ivRecord("AAPL", "2026-10-20", 0.3));
      await store.record(ivRecord("AAPL", "2026-10-21", 0.34));
      const stats = computeIvStats(await store.listSeries("AAPL"), new Date("2026-10-21T15:00:00.000Z"));
      expect(stats.observations).toBe(2);
      expect(stats.warmingUp).toBe(true);
      expect(stats.latest?.atmIv).toBe(0.34);
    });
  });
}

ivSuite("DO adapter", () => new SqlIvHistoryStore(new SqliteTestStorage() as never));
ivSuite("in-memory adapter", () => new InMemoryIvHistoryStore());
ivSuite("D1 adapter", async () => {
  const mock = new MockD1Database();
  const db = createD1IvHistoryDb(mock as never);
  await ensureIvHistorySchema(db);
  return new D1IvHistoryStore(db);
});

describe("conformance ivHistory — CUTOVER GATE (R-2)", () => {
  // §7 PIN INVERSIONS — the #2337 cutover slice executes the
  // R-2 ruling recorded on the issue. Step 2 pinned "the flag
  // defaults OFF / the builder defaults to DO" because the
  // cutover waited on that ruling; the ruling accepts a
  // warming-up restart (D1 starts empty, no backfill, the
  // DO-side series are abandoned), so the pins below now state
  // the post-cutover contract. Each inverted assertion is
  // marked INVERTED; assertions whose expectation survived the
  // cutover are unmarked.
  it("the env flag is a rollback lever: D1 selected unless explicitly \"false\"", () => {
    // INVERTED (step 2: "the env flag defaults OFF" — an unset
    // flag meant DO; post-cutover an unset flag means D1).
    expect(ivHistoryD1Enabled({})).toBe(true);
    expect(ivHistoryD1Enabled({ IV_HISTORY_D1_ENABLED: "false" })).toBe(false);
    expect(ivHistoryD1Enabled({ IV_HISTORY_D1_ENABLED: "true" })).toBe(true);
  });

  it("the sync composition root composes the DO adapter unconditionally", () => {
    const storage = new SqliteTestStorage();
    const ports = createOptionsDiscoveryPorts({ sql: storage as never, storage: storage as never });
    expect(ports.ivHistory).toBeInstanceOf(SqlIvHistoryStore);
  });

  it("the env builder defaults to D1 when AGENT_DB is bound; \"false\" or an absent binding keeps DO", async () => {
    const storage = new SqliteTestStorage();
    // INVERTED (step 2: unflagged + bound composed DO; the
    // post-cutover default for a bound environment is D1).
    const unflagged = await buildOptionsDiscoveryPorts(
      { AGENT_DB: new MockD1Database() },
      { sql: storage as never, storage: storage as never },
    );
    expect(unflagged.ivHistory).toBeInstanceOf(D1IvHistoryStore);
    // NEW with the cutover: the rollback lever at the builder
    // level — an explicit "false" is honoured even when the
    // binding is present.
    const optedOut = await buildOptionsDiscoveryPorts(
      { IV_HISTORY_D1_ENABLED: "false", AGENT_DB: new MockD1Database() },
      { sql: storage as never, storage: storage as never },
    );
    expect(optedOut.ivHistory).toBeInstanceOf(SqlIvHistoryStore);
    const flaggedNoDb = await buildOptionsDiscoveryPorts(
      { IV_HISTORY_D1_ENABLED: "true" },
      { sql: storage as never, storage: storage as never },
    );
    expect(flaggedNoDb.ivHistory).toBeInstanceOf(SqlIvHistoryStore);
    const flagged = await buildOptionsDiscoveryPorts(
      { IV_HISTORY_D1_ENABLED: "true", AGENT_DB: new MockD1Database() },
      { sql: storage as never, storage: storage as never },
    );
    expect(flagged.ivHistory).toBeInstanceOf(D1IvHistoryStore);
  });

  it("cold D1 (the warming-up restart): the read path reports the honest empty state, never fabricated data", async () => {
    const ports = await buildOptionsDiscoveryPorts(
      { AGENT_DB: new MockD1Database() },
      { sql: new SqliteTestStorage() as never, storage: new SqliteTestStorage() as never },
    );
    expect(ports.ivHistory).toBeInstanceOf(D1IvHistoryStore);
    // The route's own single-symbol read logic (the
    // /etrade/options/iv-history handler's getIvHistoryEntry)
    // over the composed, still-empty D1 store: a name with no
    // records is a state — observations 0, warmingUp true,
    // latest/rank/percentile null — never an error, never a
    // flat-filled series, never the abandoned DO data.
    const entry = await getIvHistoryEntry(ports.ivHistory, "AAPL");
    expect(entry).toEqual({
      symbol: "AAPL",
      observations: 0,
      coveragePct: 0,
      warmingUp: true,
      latest: null,
      ivRank: null,
      ivPercentile: null,
    });
    expect(await ports.ivHistory.coverage("AAPL")).toEqual({
      observations: 0,
      firstDate: null,
      lastDate: null,
    });
    expect(await ports.ivHistory.listSeries("AAPL")).toEqual([]);
  });

  it("post-cutover, a write through the composed port lands in the D1 table (the collector's store)", async () => {
    const mock = new MockD1Database();
    const doStorage = new SqliteTestStorage();
    const ports = await buildOptionsDiscoveryPorts(
      { AGENT_DB: mock },
      { sql: doStorage as never, storage: doStorage as never },
    );
    // The collector writes through exactly this composed port
    // (ScheduledTasksService's ivHistoryStore). The write must
    // land in D1's agent_iv_history — and nowhere else.
    expect(await ports.ivHistory.record(ivRecord("AAPL", "2026-10-22", 0.3))).toBe(true);
    const rows = mock.sqlite
      .prepare("SELECT symbol, date, atm_iv FROM agent_iv_history")
      .all() as Array<{ symbol: string; date: string; atm_iv: number }>;
    expect(rows).toEqual([{ symbol: "AAPL", date: "2026-10-22", atm_iv: 0.3 }]);
    // The DO store the sync root would have composed stays
    // empty: no dual-write, no silent shadow copy.
    const doStore = new SqlIvHistoryStore(doStorage as never);
    expect(await doStore.listSeries("AAPL")).toEqual([]);
    // And the composed read sees the freshly collected day,
    // still honestly flagged warming-up (1 < 60 observations).
    const entry = await getIvHistoryEntry(ports.ivHistory, "AAPL");
    expect(entry.observations).toBe(1);
    expect(entry.warmingUp).toBe(true);
    expect(entry.latest?.atmIv).toBe(0.3);
  });
});

/* ------------------------------------------------------------------ */
/* Strategy profiles                                                   */
/* ------------------------------------------------------------------ */

function profileSuite(
  label: string,
  makeStore: () => StrategyProfileStore,
) {
  describe(`conformance strategyProfiles — ${label}`, () => {
    it("create enforces per-user case-insensitive trimmed name uniqueness", async () => {
      const store = makeStore();
      const created = await store.create("alice", "  Income Wheel ", profileSpec());
      expect(created.name).toBe("Income Wheel");
      expect(created.version).toBe(1);
      await expect(store.create("alice", "income wheel", profileSpec())).rejects.toThrow(
        /already exists/,
      );
      // A different user may hold the same name.
      await store.create("bob", "Income Wheel", profileSpec());
    });

    it("update bumps the version, rename clashes reject, delete verifies", async () => {
      const store = makeStore();
      const a = await store.create("alice", "Alpha", profileSpec());
      await store.create("alice", "Beta", profileSpec());
      const updated = await store.update("alice", a.id, profileSpec());
      expect(updated?.version).toBe(2);
      await expect(store.update("alice", a.id, profileSpec(), " beta ")).rejects.toThrow(
        /already exists/,
      );
      expect(await store.update("alice", "missing-id", profileSpec())).toBeNull();
      expect(await store.delete("alice", a.id)).toBe(true);
      expect(await store.delete("alice", a.id)).toBe(false);
      expect(await store.get("alice", a.id)).toBeNull();
    });

    it("list is per-user and name-ordered", async () => {
      const store = makeStore();
      await store.create("alice", "Zeta", profileSpec());
      await store.create("alice", "alpha", profileSpec());
      await store.create("bob", "Mid", profileSpec());
      expect((await store.list("alice")).map((p) => p.name)).toEqual(["alpha", "Zeta"]);
      expect((await store.getByName("alice", " ALPHA "))?.name).toBe("alpha");
    });
  });
}

profileSuite("DO adapter (bare)", () =>
  new SqlStrategyProfileStore(new SqliteTestStorage() as never, {
    now: () => new Date("2026-10-22T14:00:00.000Z"),
  }),
);
profileSuite("DO adapter (composed, tx-wrapped)", () => {
  const storage = new SqliteTestStorage();
  return createOptionsDiscoveryPorts({ sql: storage as never, storage: storage as never })
    .strategyProfiles;
});
profileSuite("in-memory adapter", () =>
  new InMemoryStrategyProfileStore({
    now: () => new Date("2026-10-22T14:00:00.000Z"),
  }),
);

describe("conformance strategyProfiles — D-E.2 affected-row verification (R-3)", () => {
  it("an UPDATE that silently lands on no row now throws instead of reporting success", async () => {
    const storage = new SqliteTestStorage();
    const honest = new SqlStrategyProfileStore(storage as never, {
      now: () => new Date("2026-10-22T14:00:00.000Z"),
    });
    const created = await honest.create("alice", "Alpha", profileSpec());
    // A store over an executor that swallows UPDATE statements:
    // the legacy code returned a "successful" profile; the port
    // adapter verifies by read-back and throws.
    const swallowing = {
      exec(query: string, ...params: unknown[]) {
        if (/^\s*UPDATE/i.test(query)) return [];
        return storage.exec(query, ...params);
      },
    };
    const store = new SqlStrategyProfileStore(swallowing as never, {
      now: () => new Date("2026-10-22T15:00:00.000Z"),
    });
    await expect(store.update("alice", created.id, profileSpec())).rejects.toThrow(
      /write verification failed/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Feed snapshots                                                      */
/* ------------------------------------------------------------------ */

function feedSuite(label: string, makeStore: () => FeedSnapshotStore) {
  describe(`conformance feedSnapshots — ${label}`, () => {
    it("store/latest/byId round-trip with tenant scoping", () => {
      const store = makeStore();
      const a = store.store({
        userLogin: "alice",
        symbol: "aapl",
        snapshot: snapshot("AAPL", "2026-10-22T13:00:00.000Z"),
        asOf: "2026-10-22T13:00:00.000Z",
        dataSource: "etrade-live",
        loadParams: { minDte: 7 },
        nowIso: "2026-10-22T13:00:00.000Z",
      });
      expect(a.symbol).toBe("AAPL");
      expect(store.latest("alice", "AAPL")?.id).toBe(a.id);
      expect(store.latest("bob", "AAPL")).toBeUndefined();
      expect(store.byId("alice", a.id)?.id).toBe(a.id);
      expect(store.byId("bob", a.id)).toBeUndefined();
    });

    it("latest returns the newest artifact", () => {
      const store = makeStore();
      for (let i = 1; i <= 3; i++) {
        store.store({
          userLogin: "alice",
          symbol: "AAPL",
          snapshot: snapshot("AAPL", `2026-10-22T1${i}:00:00.000Z`),
          asOf: `2026-10-22T1${i}:00:00.000Z`,
          dataSource: "etrade-live",
          loadParams: {},
          nowIso: `2026-10-22T1${i}:00:00.000Z`,
        });
      }
      expect(store.latest("alice", "AAPL")?.asOf).toBe("2026-10-22T13:00:00.000Z");
    });

    it("the resolver hits, and a filter mismatch is missing (never a silent fallback)", () => {
      const store = makeStore();
      store.store({
        userLogin: "alice",
        symbol: "AAPL",
        snapshot: snapshot("AAPL", "2026-10-22T13:00:00.000Z"),
        asOf: "2026-10-22T13:00:00.000Z",
        dataSource: "etrade-live",
        loadParams: { minDte: 7 },
        nowIso: "2026-10-22T13:00:00.000Z",
      });
      const hit = resolveFeedSnapshotForSymbol({
        store,
        userLogin: "alice",
        symbol: "AAPL",
        input: { latest: true },
        requestFilters: { minDte: 7 },
        nowMs: Date.parse("2026-10-22T13:05:00.000Z"),
      });
      expect(hit.status).toBe("hit");
      const mismatch = resolveFeedSnapshotForSymbol({
        store,
        userLogin: "alice",
        symbol: "AAPL",
        input: { latest: true },
        requestFilters: { minDte: 30 },
        nowMs: Date.parse("2026-10-22T13:05:00.000Z"),
      });
      expect(mismatch.status).toBe("missing");
      if (mismatch.status === "missing") {
        expect(mismatch.reason).toMatch(/filter mismatch/);
      }
    });
  });
}

feedSuite("DO adapter", () => new SqlFeedSnapshotStore(new SqliteTestStorage() as never));
feedSuite("in-memory adapter", () => new InMemoryFeedSnapshotStore());

describe("conformance feedSnapshots — composed (tx-wrapped) store (#2455)", () => {
  it("a store through the ports composition actually persists", () => {
    // The composed store routes its write through the
    // transaction runner's wrap. Against the pre-fix aspect the
    // wrap never executed against a facade-shaped storage, so
    // the write silently never landed; after #2455 it persists.
    const storage = new SqliteTestStorage();
    const store = createOptionsDiscoveryPorts({
      sql: storage as never,
      storage: storage as never,
    }).feedSnapshots;
    const stored = store.store({
      userLogin: "alice",
      symbol: "aapl",
      snapshot: snapshot("AAPL", "2026-10-22T13:00:00.000Z"),
      asOf: "2026-10-22T13:00:00.000Z",
      dataSource: "etrade-live",
      loadParams: { minDte: 7 },
      nowIso: "2026-10-22T13:00:00.000Z",
    });
    expect(store.latest("alice", "AAPL")?.id).toBe(stored.id);
    expect(store.byId("alice", stored.id)?.id).toBe(stored.id);
    expect(store.latest("bob", "AAPL")).toBeUndefined();
  });
});

describe("conformance feedSnapshots — keep-per-symbol prune (both adapters)", () => {
  it("only the newest keepPerSymbol artifacts survive a store", () => {
    const stores: FeedSnapshotStore[] = [
      new SqlFeedSnapshotStore(new SqliteTestStorage() as never, { keepPerSymbol: 2 }),
      new InMemoryFeedSnapshotStore({ keepPerSymbol: 2 }),
    ];
    for (const store of stores) {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        ids.push(
          store.store({
            userLogin: "alice",
            symbol: "AAPL",
            snapshot: snapshot("AAPL", `2026-10-22T1${i}:00:00.000Z`),
            asOf: `2026-10-22T1${i}:00:00.000Z`,
            dataSource: "etrade-live",
            loadParams: {},
            nowIso: `2026-10-22T1${i}:00:00.000Z`,
          }).id,
        );
      }
      expect(store.byId("alice", ids[0])).toBeUndefined();
      expect(store.byId("alice", ids[1])?.id).toBe(ids[1]);
      expect(store.byId("alice", ids[2])?.id).toBe(ids[2]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Paused schedules — RETIRED (#3123)                                  */
/* ------------------------------------------------------------------ */
/* Issue #3121 Phase 2 (#3123): the paused-schedule port is retired
 * by deprecation rename (src/data/pausedSchedulePorts.deprecated.ts
 * and friends); pause is a record state in the unified store. The
 * conformance for the unified store — save/get/list/remove,
 * listByKind/listByState, clearPaused, across the DO-SQLite and
 * in-memory adapters — lives in tests/schedule-3121-3123-parity.test.ts
 * (3123-P01…P12). This block is intentionally gone, not moved: the
 * port it pinned no longer exists in the factory. */

/* ------------------------------------------------------------------ */
/* Structural pins                                                     */
/* ------------------------------------------------------------------ */

describe("#2337 structural pins", () => {
  it("migration 0020 is registered exactly once; the 14 gap remains (gate G-3)", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.filter((v) => v === 20)).toHaveLength(1);
    expect(versions).toContain(14); // claimed by #2296 (billing, #2202)
    expect(MIGRATION_0020_IV_HISTORY.version).toBe(20);
  });

  it("migration 0020 DDL and the Drizzle schema agree on columns", () => {
    const rawColumns = getTableConfig(agentIvHistory).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const block = MIGRATION_0020_IV_HISTORY.sql
      .split("CREATE TABLE IF NOT EXISTS agent_iv_history (")[1]
      .split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)]
      .map((m) => m[1])
      .filter((name) => name !== "PRIMARY");
    // Issue #3326: provenance is added by migration 0045, not by editing 0020
    // (which is already applied everywhere). The pin therefore compares the
    // schema against 0020 + every later ALTER of this table — still one DDL
    // authority per statement, and no drift between mapping and DDL.
    const alteredColumns = [MIGRATION_0045_IV_HISTORY_BROKER.sql]
      .flatMap((statement) => [...statement.matchAll(/ADD COLUMN (\w+)/g)].map((m) => m[1]));
    expect(ddlColumns.sort()).toEqual(schemaColumns.filter((c) => !alteredColumns.includes(c)).sort());
    expect(alteredColumns.every((c) => schemaColumns.includes(c))).toBe(true);
  });

  it("port modules import no store client (types only across the boundary)", () => {
    for (const file of [
      "src/data/scanRunPorts.ts",
      "src/data/discoveryRunPorts.ts",
      "src/data/discoverySetupPorts.ts",
      "src/data/discoveryAlertPorts.ts",
      "src/data/ivHistoryPorts.ts",
      "src/data/strategyProfilePorts.ts",
      "src/data/feedSnapshotPorts.ts",
      "src/data/pausedSchedulePorts.deprecated.ts",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["']drizzle-orm/);
      expect(text, file).not.toMatch(/from\s+["']\.\.\/orm["']/);
      expect(text, file).not.toMatch(/D1Database/);
      expect(text, file).not.toMatch(/node:sqlite/);
      // The transaction aspect may be named in types only.
      for (const line of text.split("\n")) {
        if (line.includes("transactionAspect")) {
          expect(line, `${file}: ${line}`).toMatch(/import type|^\s*\*/);
        }
      }
    }
  });

  it("the nine legacy modules are re-export shims naming the data layer (no deletions, §22)", () => {
    const shims: Array<[string, string]> = [
      ["src/trading/options/scanRunStore.ts", "../../data/scanRunPorts"],
      ["src/trading/options/discoveryRunStore.ts", "../../data/discoveryRunPorts"],
      ["src/trading/options/discoverySetupStore.ts", "../../data/discoverySetupPorts"],
      ["src/trading/options/discoveryAlertStore.ts", "../../data/discoveryAlertPorts"],
      ["src/trading/options/ivHistoryStore.ts", "../../data/ivHistoryPorts"],
      ["src/trading/options/strategyProfileStore.ts", "../../data/strategyProfilePorts"],
      ["src/services/feedSnapshotStore.ts", "../data/feedSnapshotPorts"],
      ["src/services/scheduleManagement.deprecated.ts", "../data/pausedSchedulePorts.deprecated"],
      ["src/enrichment/enrichmentStore.ts", "../data/doSqliteEnrichmentAdapter"],
    ];
    for (const [file, needle] of shims) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain(needle);
      expect(text, file).toContain("#2337");
    }
  });
});
