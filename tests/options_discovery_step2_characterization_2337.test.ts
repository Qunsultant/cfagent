// @vitest-environment node
/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) —
 * CHARACTERIZATION pins for the options/discovery store family,
 * written against the UNMODIFIED legacy stores before the port
 * cutover. They pin the current behaviour of the nine stores
 * through their existing public surfaces (the same import paths
 * the cutover turns into data-layer delegations/shims):
 *
 *  - scan runs + discovery runs + discovery setup runs: the
 *    issue #103 visibility rule (a scoped run is visible only to
 *    its login; legacy NULL-login rows to everyone; an unscoped
 *    caller sees only legacy rows — invisible ≡ absent),
 *    retention-on-write (365 days + 1000-row cap, enforced
 *    against the RUN's own clock, not the wall clock), newest-
 *    first listing, updatePdfKey's stamp/false discipline;
 *  - discovery setup runs: count reconciliation is enforced
 *    BEFORE the write — a rejected run stores nothing;
 *  - discovery alerts: dedupe + cap counting over (scope, day);
 *    the SQL store's UNIQUE backstop throws on a duplicate
 *    record. AS FOUND, the in-memory twin did not (the
 *    dispatcher check was its only guard); the port resolves
 *    that divergence — dedupe is a store-level invariant on
 *    every adapter (step-2 audit §2.4) — and the backstop
 *    describe below pins the resolved contract on both;
 *  - IV history: first-write-wins on (symbol, date), symbol
 *    normalization, newest-first series, coverage accounting,
 *    and the warming-up stats contract (computeIvStats);
 *  - strategy profiles: per-user case-insensitive trimmed name
 *    uniqueness, versioning, rename-clash discipline;
 *  - feed snapshots: keep-per-symbol pruning and the resolver's
 *    filter-match honesty (a mismatch is a MISSING outcome,
 *    never a silent live fallback);
 *  - unified schedules: the upsert round-trip behind pause/resume (#3123).
 *
 * These pins must be green before the cutover and green after
 * it, unchanged — that is what makes the cutover a behaviour-
 * preserving move rather than a rewrite.
 *
 * DOUBLES: the SQL stores run over a node:sqlite-backed
 * executor (real SQLite semantics — the step-0 proof double's
 * shape), because the shared MockSqlStorage cannot execute
 * this family's statements (the NOT IN (SELECT … LIMIT) cap
 * prune, MIN/MAX coverage aggregates, DISTINCT symbol lists,
 * the alerts UNIQUE constraint). MockSqlStorage round-trips
 * stay pinned by the pre-existing per-store suites.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  InMemoryScanRunStore,
  SqlScanRunStore,
  type ScanRunStore,
} from "../src/trading/options/scanRunStore";
import type { OpportunityScanResult } from "../src/trading/options/opportunityScanner";
import {
  InMemoryDiscoveryRunStore,
  SqlDiscoveryRunStore,
  type DiscoveryRunInput,
  type DiscoveryRunStore,
} from "../src/trading/options/discoveryRunStore";
import {
  InMemoryDiscoverySetupStore,
  SqlDiscoverySetupStore,
  type DiscoverySetupItem,
  type DiscoverySetupRunInput,
  type DiscoverySetupStore,
} from "../src/trading/options/discoverySetupStore";
import {
  InMemoryDiscoveryAlertStore,
  SqlDiscoveryAlertStore,
  type DiscoveryAlertStore,
} from "../src/trading/options/discoveryAlertStore";
import {
  InMemoryIvHistoryStore,
  SqlIvHistoryStore,
  computeIvStats,
  type IvHistoryRecord,
  type IvHistoryStore,
} from "../src/trading/options/ivHistoryStore";
import {
  InMemoryStrategyProfileStore,
  SqlStrategyProfileStore,
  type StrategyProfileStore,
} from "../src/trading/options/strategyProfileStore";
import type { StrategyProfileSpec } from "../src/trading/options/strategyProfile";
import {
  SqlFeedSnapshotStore,
  resolveFeedSnapshotForSymbol,
  type FeedSnapshotStoreOptions,
} from "../src/services/feedSnapshotStore";
import type { OptionsDataSnapshot } from "../src/trading";
import {
  SqlUnifiedScheduleStore,
} from "../src/data/doSqliteUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";

/* ------------------------------------------------------------------ */
/* Doubles + fixtures                                                  */
/* ------------------------------------------------------------------ */

/**
 * SqlStorage-shaped executor over node:sqlite (real semantics).
 * SELECT/PRAGMA return row arrays; writes return an empty array
 * (the stores read results only from SELECTs). transactionSync
 * implements the documented DO contract for completeness.
 */
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
  transactionSync<T>(closure: (txn: { sql: SqliteTestStorage }) => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure({ sql: this });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

function scanResult(generatedAt: string): OpportunityScanResult {
  return {
    generatedAt,
    mode: "per_name_best",
    modelVersion: "scan-v1",
    gate: { fit: 1, borderline: 0, noFit: 0 },
    coverage: { considered: 1, scanned: 1, truncated: 0, evaluated: 1, errors: 0 },
    profileRef: null,
    matrix: [],
  } as unknown as OpportunityScanResult;
}

function discoveryRunInput(overrides: Partial<DiscoveryRunInput> = {}): DiscoveryRunInput {
  return {
    createdAt: "2026-10-22T12:00:00.000Z",
    trigger: "scheduled",
    inputModel: "saved-request",
    requests: [{ symbol: "AAA" } as never],
    outcomes: [{ symbol: "AAA", status: "completed" }],
    status: "completed",
    ...overrides,
  };
}

function setupItem(symbol: string, score = 62): DiscoverySetupItem {
  return {
    kind: "setup",
    symbol,
    thesis: "bullish",
    ruleId: "trend-up",
    confidence: "MEDIUM",
    discoveryScore: score,
    gateBucket: "fit",
    targetPrice: 100,
    targetDate: "2026-11-20",
    firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
    evidence: `${symbol} evidence line`,
  } as DiscoverySetupItem;
}

function abstentionItem(symbol: string): DiscoverySetupItem {
  return {
    kind: "abstention",
    symbol,
    stage: "inference",
    reason: "no setup",
    nearMissSignals: [],
  } as DiscoverySetupItem;
}

function setupRunInput(overrides: Partial<DiscoverySetupRunInput> = {}): DiscoverySetupRunInput {
  const items = overrides.items ?? [setupItem("AAA")];
  return {
    createdAt: "2026-10-22T12:00:00.000Z",
    scopeKey: "schedule:morning-scan",
    source: "schedule",
    configHash: "cfg-abc",
    counts: {
      considered: items.length,
      setups: items.filter((i) => i.kind === "setup").length,
      abstentions: items.filter((i) => i.kind === "abstention").length,
      prescreenedOut: 0,
      errors: 0,
    },
    items,
    ...overrides,
  };
}

function ivRecord(symbol: string, date: string, atmIv: number): IvHistoryRecord {
  return {
    symbol,
    date,
    atmIv,
    spot: 100,
    expiryDate: "2026-11-20",
    dte: 30,
    collectedAt: `${date}T14:00:00.000Z`,
  };
}

const profileSpec: StrategyProfileSpec = { thesis: "bullish", maxPlannedLoss: 1000 };

function snapshot(symbol: string): OptionsDataSnapshot {
  return { symbol, screen: { scannedAt: "2026-10-22T12:00:00.000Z" } } as unknown as OptionsDataSnapshot;
}

function pausedRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "job-1",
    kind: "screen",
    state: "paused",
    callback: "scheduledOptionsScan",
    definition: {
      type: "cron",
      callback: "scheduledOptionsScan",
      payload: { userLogin: "op", symbols: ["AAA"] },
      cron: "0 9 * * 1-5",
    },
    alarmId: "job-1",
    pausedAt: "2026-10-22T12:00:00.000Z",
    createdAt: "2026-10-22T12:00:00.000Z",
    updatedAt: "2026-10-22T12:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Scan runs — #103 visibility, retention-on-write, updatePdfKey       */
/* ------------------------------------------------------------------ */

function scanRunSuite(label: string, makeStore: (opts?: object) => ScanRunStore) {
  describe(`#2337 characterization — scan runs (${label})`, () => {
    it("#103: a scoped run is visible only to its login; invisible reads as absent", async () => {
      const store = makeStore();
      const saved = await store.save(scanResult("2026-10-22T12:00:00.000Z"), { userLogin: "alice" });
      expect((await store.get(saved.id, { userLogin: "alice" }))?.id).toBe(saved.id);
      expect(await store.get(saved.id, { userLogin: "bob" })).toBeNull();
      expect(await store.get(saved.id)).toBeNull();
      expect((await store.list({ userLogin: "alice" })).map((r) => r.id)).toEqual([saved.id]);
      expect(await store.list({ userLogin: "bob" })).toHaveLength(0);
    });

    it("#103 legacy rule: an unscoped (NULL-login) run is visible to everyone, and an unscoped caller sees only legacy runs", async () => {
      const store = makeStore();
      const legacy = await store.save(scanResult("2026-10-22T12:00:00.000Z"));
      const scoped = await store.save(scanResult("2026-10-22T13:00:00.000Z"), { userLogin: "alice" });
      expect((await store.get(legacy.id, { userLogin: "bob" }))?.id).toBe(legacy.id);
      expect((await store.get(legacy.id))?.id).toBe(legacy.id);
      // Unscoped list: only the legacy run, even though the scoped
      // run is newer.
      expect((await store.list()).map((r) => r.id)).toEqual([legacy.id]);
      expect((await store.list({ userLogin: "alice" })).map((r) => r.id)).toEqual([scoped.id, legacy.id]);
    });

    it("retention-on-write runs on the run's own clock: a later save prunes rows older than 365 days before IT", async () => {
      const store = makeStore();
      const old = await store.save(scanResult("2024-01-01T00:00:00.000Z"));
      // Saving the old run does not prune itself (its own cutoff
      // is 2023-01-02).
      expect((await store.get(old.id))?.id).toBe(old.id);
      const fresh = await store.save(scanResult("2026-06-01T00:00:00.000Z"));
      // The fresh run's cutoff is 2025-06-01: the 2024 run is gone.
      expect(await store.get(old.id)).toBeNull();
      expect((await store.get(fresh.id))?.id).toBe(fresh.id);
    });

    it("the row cap prunes oldest first on save", async () => {
      const store = makeStore({ maxRows: 3 });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const saved = await store.save(scanResult(`2026-10-${20 + i}T12:00:00.000Z`));
        ids.push(saved.id);
      }
      const listed = await store.list({ limit: 25 });
      expect(listed.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
    });

    it("updatePdfKey stamps summary + result together and refuses unknown / invisible / blank", async () => {
      const store = makeStore();
      const saved = await store.save(scanResult("2026-10-22T12:00:00.000Z"), { userLogin: "alice" });
      expect(await store.updatePdfKey(saved.id, "reports/x.pdf", { userLogin: "bob" })).toBe(false);
      expect(await store.updatePdfKey(saved.id, "", { userLogin: "alice" })).toBe(false);
      expect(await store.updatePdfKey("no-such-id", "reports/x.pdf", { userLogin: "alice" })).toBe(false);
      expect(await store.updatePdfKey(saved.id, "reports/x.pdf", { userLogin: "alice" })).toBe(true);
      const got = await store.get(saved.id, { userLogin: "alice" });
      expect(got?.pdfKey).toBe("reports/x.pdf");
      expect(got?.result.pdfKey).toBe("reports/x.pdf");
      expect((await store.list({ userLogin: "alice" }))[0]?.pdfKey).toBe("reports/x.pdf");
    });

    it("prune reports the number of rows it deleted", async () => {
      const store = makeStore();
      await store.save(scanResult("2024-01-01T00:00:00.000Z"));
      await store.save(scanResult("2024-06-01T00:00:00.000Z"));
      const deleted = await store.prune(new Date("2026-01-01T00:00:00.000Z"));
      expect(deleted).toBe(2);
      expect(await store.list()).toHaveLength(0);
    });
  });
}

scanRunSuite("Sql store", (opts) => new SqlScanRunStore(new SqliteTestStorage() as never, opts));
scanRunSuite("in-memory store", (opts) => new InMemoryScanRunStore(opts));

/* ------------------------------------------------------------------ */
/* Discovery runs — derived counts, visibility, retention              */
/* ------------------------------------------------------------------ */

function discoveryRunSuite(label: string, makeStore: (opts?: object) => DiscoveryRunStore) {
  describe(`#2337 characterization — discovery runs (${label})`, () => {
    it("save derives counts from the outcomes: abstentions (status or no-view flag) count separately, never as completions or failures", async () => {
      const store = makeStore();
      const saved = await store.save(
        discoveryRunInput({
          outcomes: [
            { symbol: "AAA", status: "completed" },
            { symbol: "BBB", status: "failed", error: "chain failed" },
            { symbol: "CCC", status: "abstained", error: "cannot derive" },
            { symbol: "DDD", status: "completed", abstained: true },
          ],
        })
      );
      expect(saved.completedCount).toBe(1);
      expect(saved.failedCount).toBe(1);
      expect(saved.abstainedCount).toBe(2);
      expect(saved.requestCount).toBe(1);
      expect(saved.symbols).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    });

    it("no-view runs count constraint sets as their request count", async () => {
      const store = makeStore();
      const saved = await store.save(
        discoveryRunInput({
          inputModel: "no-view",
          requests: [],
          constraintSets: [
            { source: "no-view", request: { symbol: "AAA" } as never, expectedIvDirection: "unchanged" },
          ],
          outcomes: [{ symbol: "AAA", status: "completed", abstained: true }],
        })
      );
      expect(saved.requestCount).toBe(1);
      expect(saved.abstainedCount).toBe(1);
    });

    it("#103 visibility matches the scan store's rule", async () => {
      const store = makeStore();
      const scoped = await store.save(discoveryRunInput({ userLogin: "alice" }));
      const legacy = await store.save(
        discoveryRunInput({ createdAt: "2026-10-21T12:00:00.000Z" })
      );
      expect(await store.get(scoped.id, { userLogin: "bob" })).toBeNull();
      expect((await store.get(scoped.id, { userLogin: "alice" }))?.id).toBe(scoped.id);
      expect((await store.get(legacy.id, { userLogin: "bob" }))?.id).toBe(legacy.id);
      expect((await store.list()).map((r) => r.id)).toEqual([legacy.id]);
    });

    it("lists newest-first (createdAt desc, id desc on ties) and prunes on the run's own clock", async () => {
      const store = makeStore();
      const a = await store.save(discoveryRunInput({ createdAt: "2026-10-20T12:00:00.000Z" }));
      const b = await store.save(discoveryRunInput({ createdAt: "2026-10-22T12:00:00.000Z" }));
      expect((await store.list()).map((r) => r.id)).toEqual([b.id, a.id]);
      const old = await store.save(discoveryRunInput({ createdAt: "2024-01-01T00:00:00.000Z" }));
      expect((await store.get(old.id))?.id).toBe(old.id);
      await store.save(discoveryRunInput({ createdAt: "2026-06-01T00:00:00.000Z" }));
      expect(await store.get(old.id)).toBeNull();
    });
  });
}

discoveryRunSuite("Sql store", (opts) => new SqlDiscoveryRunStore(new SqliteTestStorage() as never, opts));
discoveryRunSuite("in-memory store", (opts) => new InMemoryDiscoveryRunStore(opts));

/* ------------------------------------------------------------------ */
/* Discovery setup runs — reconciliation before write, scope reads     */
/* ------------------------------------------------------------------ */

function discoverySetupSuite(label: string, makeStore: (opts?: object) => DiscoverySetupStore) {
  describe(`#2337 characterization — discovery setup runs (${label})`, () => {
    it("rejects a run whose counts do not reconcile — and stores nothing", async () => {
      const store = makeStore();
      const bad = setupRunInput({
        counts: { considered: 6, setups: 1, abstentions: 0, prescreenedOut: 0, errors: 0 },
      });
      await expect(store.save(bad)).rejects.toThrow(/reconcile|disagree/);
      expect(await store.list()).toHaveLength(0);
    });

    it("rejects counts that disagree with the items themselves", async () => {
      const store = makeStore();
      const bad = setupRunInput({
        items: [setupItem("AAA"), abstentionItem("BBB")],
        counts: { considered: 2, setups: 2, abstentions: 0, prescreenedOut: 0, errors: 0 },
      });
      await expect(store.save(bad)).rejects.toThrow(/disagree/);
      expect(await store.list()).toHaveLength(0);
    });

    it("stamps the model version and round-trips items verbatim", async () => {
      const store = makeStore();
      const saved = await store.save(setupRunInput());
      expect(saved.modelVersion).toBe("discovery-v1");
      const got = await store.get(saved.id);
      expect(got?.items[0]).toMatchObject({ kind: "setup", symbol: "AAA", discoveryScore: 62 });
      expect(got?.configHash).toBe("cfg-abc");
    });

    it("latestForScope returns the newest run of that scope only; #103 applies", async () => {
      let n = 0;
      const store = makeStore({ idFactory: () => `run-${++n}` });
      await store.save(setupRunInput({ createdAt: "2026-10-20T12:00:00.000Z" }));
      await store.save(setupRunInput({ createdAt: "2026-10-22T12:00:00.000Z", scopeKey: "nlq:adhoc" }));
      const third = await store.save(setupRunInput({ createdAt: "2026-10-21T12:00:00.000Z" }));
      expect((await store.latestForScope("schedule:morning-scan"))?.id).toBe(third.id);
      expect(await store.latestForScope("schedule:never-ran")).toBeNull();
      const scoped = await store.save(
        setupRunInput({ createdAt: "2026-10-23T12:00:00.000Z", userLogin: "venus" })
      );
      expect(await store.get(scoped.id, { userLogin: "someone-else" })).toBeNull();
      expect((await store.get(scoped.id, { userLogin: "venus" }))?.id).toBe(scoped.id);
    });
  });
}

discoverySetupSuite("Sql store", (opts) => new SqlDiscoverySetupStore(new SqliteTestStorage() as never, opts));
discoverySetupSuite("in-memory store", (opts) => new InMemoryDiscoverySetupStore(opts));

/* ------------------------------------------------------------------ */
/* Discovery alerts — dedupe + cap counting                            */
/* ------------------------------------------------------------------ */

function alertInput(symbol: string, day = "2026-10-22") {
  return {
    runId: "run-1",
    scopeKey: "sched:morning",
    symbol,
    thesis: "bullish" as const,
    discoveryScore: 85,
    day,
    evidence: `${symbol} evidence`,
    firedSignals: ["TREND_UP"] as never[],
    createdAt: `${day}T13:00:00.000Z`,
  };
}

function discoveryAlertSuite(label: string, makeStore: () => DiscoveryAlertStore) {
  describe(`#2337 characterization — discovery alerts (${label})`, () => {
    it("hasAlerted + countForDay key on (scope, symbol, thesis, day) / (scope, day)", async () => {
      const store = makeStore();
      expect(await store.hasAlerted("sched:morning", "AAA", "bullish", "2026-10-22")).toBe(false);
      await store.record(alertInput("AAA"));
      await store.record(alertInput("BBB"));
      await store.record(alertInput("CCC", "2026-10-23"));
      expect(await store.hasAlerted("sched:morning", "AAA", "bullish", "2026-10-22")).toBe(true);
      expect(await store.hasAlerted("sched:morning", "AAA", "bearish", "2026-10-22")).toBe(false);
      expect(await store.hasAlerted("sched:other", "AAA", "bullish", "2026-10-22")).toBe(false);
      expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(2);
      expect(await store.countForDay("sched:morning", "2026-10-23")).toBe(1);
      expect(await store.countForDay("sched:other", "2026-10-22")).toBe(0);
    });

    it("record stamps the disc_alert_ id prefix; list is newest-first and scoped", async () => {
      const store = makeStore();
      const first = await store.record(alertInput("AAA"));
      expect(first.id.startsWith("disc_alert_")).toBe(true);
      await store.record({ ...alertInput("BBB"), createdAt: "2026-10-22T14:00:00.000Z" });
      const listed = await store.list("sched:morning");
      expect(listed.map((r) => r.symbol)).toEqual(["BBB", "AAA"]);
      expect(await store.list("sched:other")).toHaveLength(0);
      expect((await store.list("sched:morning", { limit: 1 })).map((r) => r.symbol)).toEqual(["BBB"]);
    });
  });
}

discoveryAlertSuite("Sql store", () => new SqlDiscoveryAlertStore(new SqliteTestStorage() as never));
discoveryAlertSuite("in-memory store", () => new InMemoryDiscoveryAlertStore());

describe("#2337 characterization — discovery alerts dedupe backstop (port contract)", () => {
  it("the SQL store's UNIQUE constraint rejects a duplicate (scope, symbol, thesis, day) record", async () => {
    const store = new SqlDiscoveryAlertStore(new SqliteTestStorage() as never);
    await store.record(alertInput("AAA"));
    await expect(store.record(alertInput("AAA"))).rejects.toThrow();
    expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(1);
  });

  // AS FOUND (pre-port): the in-memory store ACCEPTED the
  // duplicate (countForDay 2) — the dispatcher's hasAlerted
  // check was its only guard. The port resolves the divergence
  // (step-2 audit §2.4): dedupe is a store-level invariant on
  // every adapter, so this test now pins the RESOLVED contract.
  it("the in-memory store rejects the duplicate too — dedupe is a store-level invariant at the port", async () => {
    const store = new InMemoryDiscoveryAlertStore();
    await store.record(alertInput("AAA"));
    await expect(store.record(alertInput("AAA"))).rejects.toThrow(/duplicate discovery alert/);
    expect(await store.countForDay("sched:morning", "2026-10-22")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* IV history — first-write-wins, normalization, warming-up stats      */
/* ------------------------------------------------------------------ */

function ivSuite(label: string, makeStore: () => IvHistoryStore) {
  describe(`#2337 characterization — IV history (${label})`, () => {
    it("first write wins: a same-day rerun is a no-op and the first values stand", async () => {
      const store = makeStore();
      expect(await store.record(ivRecord("AAPL", "2026-10-20", 0.3))).toBe(true);
      expect(await store.record(ivRecord("AAPL", "2026-10-20", 0.55))).toBe(false);
      expect((await store.get("AAPL", "2026-10-20"))?.atmIv).toBe(0.3);
    });

    it("symbols normalize (trim + uppercase) on write and read", async () => {
      const store = makeStore();
      await store.record(ivRecord(" aapl ", "2026-10-20", 0.3));
      expect((await store.get("AAPL", "2026-10-20"))?.symbol).toBe("AAPL");
      expect(await store.listSymbols()).toEqual(["AAPL"]);
    });

    it("listSeries is newest-first with an honoured limit; coverage reports count + span", async () => {
      const store = makeStore();
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
      expect(await store.coverage("NONE")).toEqual({
        observations: 0,
        firstDate: null,
        lastDate: null,
      });
      expect(await store.listSymbols()).toEqual(["AAPL", "MSFT"]);
    });
  });
}

ivSuite("Sql store", () => new SqlIvHistoryStore(new SqliteTestStorage() as never));
ivSuite("in-memory store", () => new InMemoryIvHistoryStore());

describe("#2337 characterization — IV warming-up stats (computeIvStats)", () => {
  it("an empty series reports nulls and warmingUp", () => {
    const stats = computeIvStats([]);
    expect(stats).toMatchObject({ observations: 0, warmingUp: true, latest: null, ivRank: null, ivPercentile: null });
  });

  it("below 60 observations the values are computed but flagged warming up", () => {
    const stats = computeIvStats([ivRecord("AAPL", "2026-10-20", 0.3), ivRecord("AAPL", "2026-10-21", 0.4)]);
    expect(stats.warmingUp).toBe(true);
    expect(stats.ivRank).toBe(100);
    expect(stats.ivPercentile).toBe(50);
  });

  it("a flat series reports the neutral rank 50; percentile counts strictly-below only", () => {
    const stats = computeIvStats([
      ivRecord("AAPL", "2026-10-19", 0.3),
      ivRecord("AAPL", "2026-10-20", 0.3),
      ivRecord("AAPL", "2026-10-21", 0.3),
    ]);
    expect(stats.ivRank).toBe(50);
    expect(stats.ivPercentile).toBe(0);
  });

  it("at 60 observations the series is no longer warming up", () => {
    const records: IvHistoryRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(ivRecord("AAPL", `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`, 0.2 + i * 0.001));
    }
    // Distinct dates matter; rebuild with unique days across months.
    const unique: IvHistoryRecord[] = [];
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 60; i++) {
      const d = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      unique.push(ivRecord("AAPL", d, 0.2 + i * 0.001));
    }
    void records;
    const stats = computeIvStats(unique);
    expect(stats.observations).toBe(60);
    expect(stats.warmingUp).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Strategy profiles — uniqueness, versioning                          */
/* ------------------------------------------------------------------ */

function profileSuite(label: string, makeStore: (opts?: object) => StrategyProfileStore) {
  describe(`#2337 characterization — strategy profiles (${label})`, () => {
    it("create stamps version 1; duplicate names (case-insensitive, trimmed) throw; another user may reuse the name", async () => {
      let n = 0;
      const store = makeStore({ idFactory: () => `p-${++n}`, now: () => new Date("2026-10-22T12:00:00.000Z") });
      const created = await store.create("alice", "  Momentum  ", profileSpec);
      expect(created).toMatchObject({ name: "Momentum", version: 1, userLogin: "alice" });
      await expect(store.create("alice", "momentum", profileSpec)).rejects.toThrow(/already exists/);
      await expect(store.create("alice", " MOMENTUM ", profileSpec)).rejects.toThrow(/already exists/);
      const other = await store.create("bob", "momentum", profileSpec);
      expect(other.userLogin).toBe("bob");
    });

    it("getByName is case-insensitive and trimmed; get is user-scoped", async () => {
      const store = makeStore();
      const created = await store.create("alice", "Momentum", profileSpec);
      expect((await store.getByName("alice", "  momentum "))?.id).toBe(created.id);
      expect(await store.getByName("alice", "nope")).toBeNull();
      expect(await store.get("bob", created.id)).toBeNull();
      expect((await store.get("alice", created.id))?.id).toBe(created.id);
    });

    it("update bumps the version, replaces the spec, and a rename clashing with a DIFFERENT profile throws", async () => {
      let clock = new Date("2026-10-22T12:00:00.000Z");
      const store = makeStore({ now: () => clock });
      const a = await store.create("alice", "Alpha", profileSpec);
      await store.create("alice", "Beta", profileSpec);
      clock = new Date("2026-10-23T12:00:00.000Z");
      const updated = await store.update("alice", a.id, { thesis: "bearish" });
      expect(updated).toMatchObject({ version: 2, name: "Alpha", thesis: "bearish" });
      expect(updated?.updatedAt).toBe("2026-10-23T12:00:00.000Z");
      expect(updated?.createdAt).toBe("2026-10-22T12:00:00.000Z");
      await expect(store.update("alice", a.id, profileSpec, " beta ")).rejects.toThrow(/already exists/);
      // Renaming to its OWN name (any case) is not a clash.
      const renamed = await store.update("alice", a.id, profileSpec, "ALPHA");
      expect(renamed?.name).toBe("ALPHA");
      expect(await store.update("alice", "missing-id", profileSpec)).toBeNull();
      expect(await store.update("bob", a.id, profileSpec)).toBeNull();
    });

    it("delete returns true once, false after; list is name-ascending", async () => {
      const store = makeStore();
      const a = await store.create("alice", "Charlie", profileSpec);
      await store.create("alice", "alpha", profileSpec);
      await store.create("alice", "Bravo", profileSpec);
      expect((await store.list("alice")).map((p) => p.name)).toEqual(["alpha", "Bravo", "Charlie"]);
      expect(await store.delete("alice", a.id)).toBe(true);
      expect(await store.delete("alice", a.id)).toBe(false);
      expect(await store.get("alice", a.id)).toBeNull();
      expect(await store.list("bob")).toHaveLength(0);
    });
  });
}

profileSuite("Sql store", (opts) => new SqlStrategyProfileStore(new SqliteTestStorage() as never, opts));
profileSuite("in-memory store", (opts) => new InMemoryStrategyProfileStore(opts));

/* ------------------------------------------------------------------ */
/* Feed snapshots — keep-per-symbol + resolver honesty                 */
/* ------------------------------------------------------------------ */

describe("#2337 characterization — feed snapshots", () => {
  function makeFeedStore(options?: FeedSnapshotStoreOptions) {
    let n = 0;
    return new SqlFeedSnapshotStore(new SqliteTestStorage() as never, {
      idFactory: () => `snap-${++n}`,
      ...options,
    });
  }

  it("store → latest returns the newest artifact; byId returns the artifact with its snapshot's symbol", () => {
    const store = makeFeedStore();
    const first = store.store({
      userLogin: "op",
      symbol: "aapl",
      snapshot: snapshot("AAPL"),
      asOf: "2026-10-22T12:00:00.000Z",
      dataSource: "live",
      loadParams: { symbol: "AAPL" },
      nowIso: "2026-10-22T12:00:00.000Z",
    });
    expect(first.symbol).toBe("AAPL");
    expect(store.latest("op", "AAPL")?.id).toBe(first.id);
    expect(store.byId("op", first.id)?.snapshot.symbol).toBe("AAPL");
    expect(store.latest("op", "MSFT")).toBeUndefined();
    expect(store.latest("other", "AAPL")).toBeUndefined();
    expect(store.byId("op", "missing")).toBeUndefined();
  });

  it("keep-per-symbol prunes older artifacts of the same (user, symbol) only", () => {
    const store = makeFeedStore({ keepPerSymbol: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        store.store({
          userLogin: "op",
          symbol: "AAPL",
          snapshot: snapshot("AAPL"),
          asOf: `2026-10-22T1${i}:00:00.000Z`,
          dataSource: "live",
          loadParams: {},
          nowIso: `2026-10-22T1${i}:00:00.000Z`,
        }).id
      );
    }
    expect(store.byId("op", ids[0])).toBeUndefined();
    expect(store.byId("op", ids[2])?.id).toBe(ids[2]);
    expect(store.latest("op", "AAPL")?.id).toBe(ids[2]);
  });

  it("the resolver: a hit with staleness judged only when maxAgeSeconds is given", () => {
    const store = makeFeedStore();
    const art = store.store({
      userLogin: "op",
      symbol: "AAPL",
      snapshot: snapshot("AAPL"),
      asOf: "2026-10-22T12:00:00.000Z",
      dataSource: "live",
      loadParams: { symbol: "AAPL", minDte: 7 },
      nowIso: "2026-10-22T12:00:00.000Z",
    });
    const hit = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "AAPL",
      input: { artifacts: { AAPL: art.id } },
      requestFilters: { symbol: "AAPL", minDte: 7 },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(hit.status).toBe("hit");
    const bounded = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "AAPL",
      input: { artifacts: { AAPL: art.id }, maxAgeSeconds: 60 },
      requestFilters: { symbol: "AAPL", minDte: 7 },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(bounded).toMatchObject({ status: "hit", stale: true });
  });

  it("the resolver: missing and filter-mismatched artifacts are explicit MISSING outcomes — never a silent live fallback", () => {
    const store = makeFeedStore();
    const art = store.store({
      userLogin: "op",
      symbol: "AAPL",
      snapshot: snapshot("AAPL"),
      asOf: "2026-10-22T12:00:00.000Z",
      dataSource: "live",
      loadParams: { symbol: "AAPL", minDte: 7 },
      nowIso: "2026-10-22T12:00:00.000Z",
    });
    const mismatch = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "AAPL",
      input: { artifacts: { AAPL: art.id } },
      requestFilters: { symbol: "AAPL", minDte: 21 },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(mismatch.status).toBe("missing");
    if (mismatch.status === "missing") expect(mismatch.reason).toContain("filter mismatch");
    const unnamed = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "MSFT",
      input: { artifacts: { AAPL: art.id } },
      requestFilters: { symbol: "MSFT" },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(unnamed.status).toBe("missing");
    const noInput = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "AAPL",
      input: {},
      requestFilters: { symbol: "AAPL" },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(noInput.status).toBe("missing");
    // dataMode absent ≡ "live" on both sides (not a mismatch).
    const liveMatch = resolveFeedSnapshotForSymbol({
      store,
      userLogin: "op",
      symbol: "AAPL",
      input: { latest: true },
      requestFilters: { symbol: "AAPL", minDte: 7, dataMode: "live" },
      nowMs: Date.parse("2026-10-22T12:30:00.000Z"),
    });
    expect(liveMatch.status).toBe("hit");
  });
});

/* ------------------------------------------------------------------ */
/* Paused schedules — upsert round-trip                                */
/* ------------------------------------------------------------------ */

describe("#2337 characterization — unified schedules (paused records)", () => {
  it("save → get round-trips the full definition (payload JSON, optional fields only when present)", () => {
    const store = new SqlUnifiedScheduleStore(new SqliteTestStorage() as never);
    store.save(pausedRecord());
    const got = store.get("job-1");
    expect(got).toEqual(pausedRecord());
    const bare = pausedRecord({
      id: "job-2",
      definition: {
        type: "interval",
        callback: "scheduledOptionsScan",
        payload: { userLogin: "op", symbols: ["AAA"] },
        intervalSeconds: 3600,
      },
    });
    store.save(bare);
    const gotBare = store.get("job-2");
    expect((gotBare?.definition as any).intervalSeconds).toBe(3600);
    expect(gotBare && "cron" in gotBare.definition).toBe(false);
  });

  it("save is an upsert: re-saving an id replaces the record (pause → update → resume reads the new definition)", () => {
    const store = new SqlUnifiedScheduleStore(new SqliteTestStorage() as never);
    store.save(pausedRecord());
    store.save(pausedRecord({
      definition: {
        type: "cron",
        callback: "scheduledOptionsScan",
        payload: { userLogin: "op", symbols: ["AAA"] },
        cron: "0 10 * * 1-5",
      },
      pausedAt: "2026-10-23T12:00:00.000Z",
    }));
    expect(store.list()).toHaveLength(1);
    expect((store.get("job-1")?.definition as any).cron).toBe("0 10 * * 1-5");
  });

  it("list is created_at ascending; remove returns true once", () => {
    const store = new SqlUnifiedScheduleStore(new SqliteTestStorage() as never);
    store.save(pausedRecord({ id: "job-b", createdAt: "2026-10-23T12:00:00.000Z", pausedAt: "2026-10-23T12:00:00.000Z" }));
    store.save(pausedRecord({ id: "job-a", createdAt: "2026-10-22T12:00:00.000Z", pausedAt: "2026-10-22T12:00:00.000Z" }));
    expect(store.list().map((r) => r.id)).toEqual(["job-a", "job-b"]);
    expect(store.remove("job-a")).toBe(true);
    expect(store.remove("job-a")).toBe(false);
    expect(store.get("job-a")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Control — the pins detect a lying store (pristine-control shape)    */
/* ------------------------------------------------------------------ */

describe("#2337 characterization — control (the pins go red against a sabotaged seam)", () => {
  it("a scan store that drops the saver's userLogin stamp fails the #103 pin", async () => {
    // The sabotage: save() persists WITHOUT the login stamp, so a
    // scoped run becomes legacy-visible — exactly the leak #103
    // forbids. The pin from the suite above must catch it.
    class LyingScanRunStore extends InMemoryScanRunStore {
      override async save(
        result: OpportunityScanResult,
        options: { userLogin?: string; id?: string } = {}
      ) {
        return super.save(result, { id: options.id });
      }
    }
    const store = new LyingScanRunStore();
    const saved = await store.save(scanResult("2026-10-22T12:00:00.000Z"), { userLogin: "alice" });
    let pinFailed = false;
    try {
      expect(await store.get(saved.id, { userLogin: "bob" })).toBeNull();
    } catch {
      pinFailed = true;
    }
    expect(pinFailed).toBe(true);
  });
});
