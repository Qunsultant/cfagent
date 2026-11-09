/**
 * Issue #15: IV history store + daily collector (Discovery epic #13).
 *
 * Pinned here:
 *  1. Math — computeIvStats on fixture series: exact rank/percentile
 *     values, the trailing-252 window (older observations count
 *     toward coverage but not the rank range), the warming-up
 *     boundary at 59/60, the coverage cap at 100, and the degenerate
 *     flat-series case (rank = neutral 50, percentile = 0).
 *  2. Derivation — deriveAtmIv reads the NEAREST eligible expiry,
 *     the nearest-to-spot strike within it, and averages call+put
 *     IVs (the scanner's usability rules: IV finite > 0, expiry in
 *     the future by the shared ceil-days convention).
 *  3. Stores — SqlIvHistoryStore (over a fake executor implementing
 *     the store's exact statements, the FakeScanSql precedent) and
 *     InMemoryIvHistoryStore behave identically, and a same-day
 *     rewrite is a no-op: FIRST WRITE WINS, on both stores.
 *  4. Collector — tracked names are curated ∪ watchlist (deduped,
 *     uppercased); a failed chain (throw, empty, no usable IV) yields
 *     a `failed` outcome with the reason and NO record; a rerun the
 *     same day reports `already_recorded` without refetching.
 *  5. Read entry — getIvHistoryEntry reports an unrecorded name as a
 *     warming-up state (not an error), and warming-up names still
 *     expose their computed rank/percentile.
 *  6. Service wiring — ScheduledTasksService.collectDailyIvHistory
 *     fails cleanly with no store configured, and with a store +
 *     screener test chains it records through the real data path.
 *
 * Fixture "history" is seeded only through the stores' real write
 * paths with explicit dates — the product never backfills, and
 * neither do these tests pretend otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryIvHistoryStore,
  SqlIvHistoryStore,
  computeIvStats,
  nyDateString,
  IV_STATS_WINDOW,
  type IvHistoryRecord,
  type IvHistoryStore,
  type IvSqlExecutor,
} from "../src/trading/options/ivHistoryStore";
import {
  collectIvHistory,
  deriveAtmIv,
  flattenWatchlistSymbols,
  getIvHistoryEntry,
  resolveTrackedSymbols,
  type AtmIvContract,
} from "../src/trading/options/ivCollector";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env, ETradeOptionChain } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rec(date: string, atmIv: number, symbol = "TEST"): IvHistoryRecord {
  return {
    symbol,
    date,
    atmIv,
    spot: 100,
    expiryDate: "2026-12-18",
    dte: 30,
    collectedAt: `${date}T22:15:00.000Z`,
  };
}

/** n consecutive YYYY-MM-DD dates starting at `start`. */
function dateSeries(start: string, n: number): string[] {
  const out: string[] = [];
  const base = Date.parse(`${start}T00:00:00.000Z`);
  for (let i = 0; i < n; i++) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function contract(partial: Partial<AtmIvContract>): AtmIvContract {
  return {
    strikePrice: 100,
    impliedVolatility: 0.3,
    expirationDate: "2026-10-16",
    optionType: "CALL",
    underlyingPrice: 100,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Fake SQL executor implementing SqlIvHistoryStore's exact statements
// ---------------------------------------------------------------------------

interface FakeIvRow {
  symbol: string;
  date: string;
  atm_iv: number;
  spot: number;
  expiry_date: string;
  dte: number;
  collected_at: string;
}

class FakeIvSql implements IvSqlExecutor {
  rows: FakeIvRow[] = [];

  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) return [];
    if (q.startsWith("INSERT OR IGNORE INTO mas_iv_history")) {
      const [symbol, date, atm_iv, spot, expiry_date, dte, collected_at] = params as [
        string, string, number, number, string, number, string,
      ];
      if (!this.rows.some((r) => r.symbol === symbol && r.date === date)) {
        this.rows.push({ symbol, date, atm_iv, spot, expiry_date, dte, collected_at });
      }
      return [];
    }
    if (q.startsWith("SELECT COUNT(*)")) {
      const [symbol] = params as [string];
      const mine = this.rows.filter((r) => r.symbol === symbol);
      const dates = mine.map((r) => r.date).sort();
      return [{
        count: mine.length,
        first_date: dates[0] ?? null,
        last_date: dates[dates.length - 1] ?? null,
      }];
    }
    if (q.startsWith("SELECT DISTINCT symbol")) {
      return [...new Set(this.rows.map((r) => r.symbol))].sort().map((symbol) => ({ symbol }));
    }
    if (q.includes("WHERE symbol = ? AND date = ?")) {
      const [symbol, date] = params as [string, string];
      return this.rows.filter((r) => r.symbol === symbol && r.date === date);
    }
    if (q.includes("FROM mas_iv_history WHERE symbol = ? ORDER BY date DESC")) {
      const [symbol, limit] = params as [string, number?];
      const mine = this.rows
        .filter((r) => r.symbol === symbol)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      return limit !== undefined ? mine.slice(0, limit) : mine;
    }
    throw new Error(`FakeIvSql: unhandled statement: ${q}`);
  }
}

function bothStores(): Array<[string, () => IvHistoryStore]> {
  return [
    ["SqlIvHistoryStore", () => new SqlIvHistoryStore(new FakeIvSql())],
    ["InMemoryIvHistoryStore", () => new InMemoryIvHistoryStore()],
  ];
}

// ---------------------------------------------------------------------------
// Collection day (America/New_York)
// ---------------------------------------------------------------------------

describe("nyDateString — the collection day is the New York date", () => {
  it("maps late-evening UTC to the same ET day and post-midnight ET to the next", () => {
    // 2026-10-17T03:30Z = Oct 16, 23:30 EDT
    expect(nyDateString(new Date("2026-10-17T03:30:00.000Z"))).toBe("2026-10-16");
    // 2026-10-17T05:30Z = Oct 17, 01:30 EDT
    expect(nyDateString(new Date("2026-10-17T05:30:00.000Z"))).toBe("2026-10-17");
    // Winter (EST, UTC-5): 2026-01-15T04:30Z = Jan 14, 23:30 EST
    expect(nyDateString(new Date("2026-01-15T04:30:00.000Z"))).toBe("2026-01-14");
  });
});

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe("computeIvStats — rank / percentile / coverage / warming-up", () => {
  it("computes exact rank and percentile for a known series (input order irrelevant)", () => {
    const dates = dateSeries("2026-01-01", 4);
    const records = [
      rec(dates[2], 0.2),
      rec(dates[0], 0.1),
      rec(dates[3], 0.3), // latest by date = current
      rec(dates[1], 0.4),
    ];
    const stats = computeIvStats(records);
    expect(stats.observations).toBe(4);
    expect(stats.latest?.atmIv).toBe(0.3);
    // min 0.10, max 0.40 → (0.30 − 0.10) / 0.30 = 66.67
    expect(stats.ivRank).toBeCloseTo(66.6667, 3);
    // strictly below 0.30: {0.10, 0.20} → 2/4 = 50
    expect(stats.ivPercentile).toBe(50);
    expect(stats.coveragePct).toBeCloseTo((4 / IV_STATS_WINDOW) * 100, 10);
    expect(stats.warmingUp).toBe(true);
  });

  it("an empty series reports nulls and warming-up, never invented values", () => {
    const stats = computeIvStats([]);
    expect(stats).toEqual({
      observations: 0,
      coveragePct: 0,
      warmingUp: true,
      latest: null,
      ivRank: null,
      ivPercentile: null,
    });
  });

  it("a flat series (max == min) reports the neutral rank 50 and percentile 0", () => {
    const records = dateSeries("2026-01-01", 5).map((d) => rec(d, 0.25));
    const stats = computeIvStats(records);
    expect(stats.ivRank).toBe(50);
    expect(stats.ivPercentile).toBe(0);
  });

  it("a single observation is rank 50 / percentile 0, still warming up", () => {
    const stats = computeIvStats([rec("2026-01-01", 0.42)]);
    expect(stats.ivRank).toBe(50);
    expect(stats.ivPercentile).toBe(0);
    expect(stats.warmingUp).toBe(true);
  });

  it("the warming-up boundary is exactly 60 observations", () => {
    const at59 = dateSeries("2026-01-01", 59).map((d, i) => rec(d, 0.1 + i * 0.001));
    const at60 = dateSeries("2026-01-01", 60).map((d, i) => rec(d, 0.1 + i * 0.001));
    expect(computeIvStats(at59).warmingUp).toBe(true);
    expect(computeIvStats(at60).warmingUp).toBe(false);
  });

  it("rank/percentile read the trailing 252 only; coverage caps at 100", () => {
    const dates = dateSeries("2025-01-01", 300);
    const records = dates.map((d, i) => {
      if (i === 0) return rec(d, 0.01); // ancient outlier — outside the window
      if (i === 299) return rec(d, 0.25); // current
      return rec(d, 0.2);
    });
    // Pad the window's max: one in-window observation at 0.30.
    records[298] = rec(dates[298], 0.3);
    const stats = computeIvStats(records);
    expect(stats.observations).toBe(300);
    expect(stats.coveragePct).toBe(100);
    // Window = last 252 (indices 48..299): min 0.20, max 0.30 →
    // rank = (0.25 − 0.20) / 0.10 = 50 (the 0.01 outlier must NOT count).
    expect(stats.ivRank).toBeCloseTo(50, 10);
    // Strictly below 0.25 in-window: the 0.20s = 250 of 252.
    expect(stats.ivPercentile).toBeCloseTo((250 / 252) * 100, 10);
    expect(stats.warmingUp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ATM IV derivation
// ---------------------------------------------------------------------------

describe("deriveAtmIv — nearest eligible expiry, nearest strike, call/put average", () => {
  const now = new Date("2026-10-15T15:00:00.000Z");

  it("averages the call and put IVs at the nearest strike of the nearest expiry", () => {
    const contracts: AtmIvContract[] = [
      contract({ strikePrice: 95, optionType: "CALL", impliedVolatility: 0.3 }),
      contract({ strikePrice: 95, optionType: "PUT", impliedVolatility: 0.32 }),
      contract({ strikePrice: 100, optionType: "CALL", impliedVolatility: 0.28 }),
      contract({ strikePrice: 100, optionType: "PUT", impliedVolatility: 0.3 }),
      contract({ strikePrice: 105, optionType: "CALL", impliedVolatility: 0.26 }),
      contract({ strikePrice: 105, optionType: "PUT", impliedVolatility: 0.28 }),
      // A farther expiry with a flashier ATM IV must not win.
      contract({ strikePrice: 100, optionType: "CALL", impliedVolatility: 0.5, expirationDate: "2026-11-20" }),
      contract({ strikePrice: 100, optionType: "PUT", impliedVolatility: 0.52, expirationDate: "2026-11-20" }),
    ];
    const derived = deriveAtmIv(contracts, now);
    expect(derived?.atmIv).toBeCloseTo(0.29, 10);
    expect(derived?.expiryDate).toBe("2026-10-16");
    expect(derived?.dte).toBe(1);
    expect(derived?.spot).toBe(100);
  });

  it("the nearest expiry wins even when a farther expiry's strike is closer to spot", () => {
    const contracts: AtmIvContract[] = [
      contract({ strikePrice: 90, optionType: "CALL", impliedVolatility: 0.4 }),
      contract({ strikePrice: 90, optionType: "PUT", impliedVolatility: 0.44 }),
      contract({ strikePrice: 110, optionType: "CALL", impliedVolatility: 0.36 }),
      contract({ strikePrice: 100, optionType: "CALL", impliedVolatility: 0.2, expirationDate: "2026-11-20" }),
    ];
    const derived = deriveAtmIv(contracts, now);
    expect(derived?.expiryDate).toBe("2026-10-16");
    // Equidistant strikes (90 vs 110 around spot 100) → lower strike wins.
    expect(derived?.atmIv).toBeCloseTo(0.42, 10);
  });

  it("uses a lone side's IV when only one side is quoted at the ATM strike", () => {
    const contracts: AtmIvContract[] = [
      contract({ strikePrice: 100, optionType: "CALL", impliedVolatility: 0.33 }),
      contract({ strikePrice: 95, optionType: "PUT", impliedVolatility: 0.31 }),
    ];
    expect(deriveAtmIv(contracts, now)?.atmIv).toBeCloseTo(0.33, 10);
  });

  it("skips an expiry dated today/past and IV-less contracts; null when nothing qualifies", () => {
    const stale = new Date("2026-10-16T15:00:00.000Z");
    const contracts: AtmIvContract[] = [
      contract({ strikePrice: 100, impliedVolatility: 0.9, expirationDate: "2026-10-16" }), // dated today → days ≤ 0
      contract({ strikePrice: 100, impliedVolatility: 0, expirationDate: "2026-11-20" }), // IV 0 → unusable
      contract({ strikePrice: 100, impliedVolatility: undefined, expirationDate: "2026-11-20" }),
    ];
    expect(deriveAtmIv(contracts, stale)).toBeNull();
    expect(deriveAtmIv([], now)).toBeNull();
    expect(deriveAtmIv([contract({ underlyingPrice: 0 })], now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stores — identical semantics, first write wins
// ---------------------------------------------------------------------------

describe("IvHistoryStore — both implementations", () => {
  for (const [name, makeStore] of bothStores()) {
    describe(name, () => {
      it("records once per (symbol, date): a same-day rewrite is a no-op and the first value stands", async () => {
        const store = makeStore();
        const first = rec("2026-10-15", 0.3, "AAPL");
        expect(await store.record(first)).toBe(true);
        expect(await store.record({ ...first, atmIv: 0.99, collectedAt: "2026-10-15T23:00:00.000Z" })).toBe(false);
        const stored = await store.get("AAPL", "2026-10-15");
        expect(stored?.atmIv).toBe(0.3);
        expect(stored?.collectedAt).toBe(first.collectedAt);
        // A different day is a different record.
        expect(await store.record(rec("2026-10-16", 0.31, "AAPL"))).toBe(true);
        expect((await store.coverage("AAPL")).observations).toBe(2);
      });

      it("normalizes symbols, lists newest-first with limit, and reports coverage span", async () => {
        const store = makeStore();
        await store.record(rec("2026-10-13", 0.2, "msft"));
        await store.record(rec("2026-10-15", 0.22, "MSFT"));
        await store.record(rec("2026-10-14", 0.21, "MSFT"));
        const series = await store.listSeries("MSFT");
        expect(series.map((r) => r.date)).toEqual(["2026-10-15", "2026-10-14", "2026-10-13"]);
        expect((await store.listSeries("MSFT", { limit: 2 })).map((r) => r.date)).toEqual(["2026-10-15", "2026-10-14"]);
        expect(await store.coverage("MSFT")).toEqual({
          observations: 3,
          firstDate: "2026-10-13",
          lastDate: "2026-10-15",
        });
        expect(await store.coverage("NOPE")).toEqual({ observations: 0, firstDate: null, lastDate: null });
        expect(await store.get("MSFT", "2026-10-14")).not.toBeNull();
        expect(await store.get("MSFT", "2026-10-12")).toBeNull();
      });

      it("lists every recorded symbol ascending", async () => {
        const store = makeStore();
        await store.record(rec("2026-10-15", 0.3, "NVDA"));
        await store.record(rec("2026-10-15", 0.3, "AAPL"));
        await store.record(rec("2026-10-14", 0.3, "NVDA"));
        expect(await store.listSymbols()).toEqual(["AAPL", "NVDA"]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Tracked names + collector
// ---------------------------------------------------------------------------

describe("resolveTrackedSymbols / flattenWatchlistSymbols", () => {
  it("unions curated and watchlist symbols, trimmed, uppercased, deduped, sorted", () => {
    expect(resolveTrackedSymbols(["AAPL", "msft"], ["MSFT", " nvda ", "", "AAPL"])).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
    ]);
  });

  it("flattens symbolsJson arrays and skips malformed watchlists", () => {
    expect(
      flattenWatchlistSymbols([
        { symbolsJson: '["AAPL","MSFT"]' },
        { symbolsJson: "not json" },
        { symbolsJson: '{"oops":true}' },
        { symbolsJson: '["NVDA", 42, null]' },
        {},
      ]),
    ).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});

describe("collectIvHistory — per-name outcomes, failures never fabricated", () => {
  const now = new Date("2026-10-15T15:00:00.000Z"); // NY date 2026-10-15
  const goodChain = () => ({
    contracts: [
      // Far expiry so the chain stays eligible across the two
      // collection days exercised by the rerun test.
      contract({ strikePrice: 100, optionType: "CALL", impliedVolatility: 0.28, expirationDate: "2026-11-20" }),
      contract({ strikePrice: 100, optionType: "PUT", impliedVolatility: 0.3, expirationDate: "2026-11-20" }),
    ] as any[],
  });

  function makeDeps(store: IvHistoryStore, fetchChain: any) {
    return {
      store,
      fetchChain,
      curatedSymbols: ["AAPL", "msft"],
      watchlistSymbols: ["MSFT", "NVDA", "BADCO", "EMPTYCO"],
      now,
    };
  }

  it("records good names, reports failures with reasons, and never aborts the batch", async () => {
    const store = new InMemoryIvHistoryStore();
    const fetchChain = vi.fn(async (symbol: string) => {
      if (symbol === "BADCO") throw new Error("E*TRADE chain request failed: 400 oauth_problem=token_expired");
      if (symbol === "EMPTYCO") return { contracts: [], error: "oauth_problem=token_expired" };
      return goodChain();
    });
    const report = await collectIvHistory(makeDeps(store, fetchChain));
    expect(report.date).toBe("2026-10-15");
    expect(report.outcomes.map((o) => o.symbol)).toEqual(["AAPL", "BADCO", "EMPTYCO", "MSFT", "NVDA"]);
    expect(report.recorded).toBe(3);
    expect(report.failed).toBe(2);
    const bad = report.outcomes.find((o) => o.symbol === "BADCO")!;
    expect(bad.status).toBe("failed");
    expect(bad.reason).toContain("oauth_problem");
    const empty = report.outcomes.find((o) => o.symbol === "EMPTYCO")!;
    expect(empty.status).toBe("failed");
    expect(empty.reason).toContain("oauth_problem");
    // The stored record carries the derived values for the day.
    const aapl = await store.get("AAPL", "2026-10-15");
    expect(aapl?.atmIv).toBeCloseTo(0.29, 10);
    expect(aapl?.expiryDate).toBe("2026-11-20");
    // Failed names have NO record — absence, not invention.
    expect(await store.get("BADCO", "2026-10-15")).toBeNull();
    expect(await store.get("EMPTYCO", "2026-10-15")).toBeNull();
  });

  it("a chain with contracts but no usable IV fails with a reason and writes nothing", async () => {
    const store = new InMemoryIvHistoryStore();
    const fetchChain = vi.fn(async () => ({
      contracts: [contract({ impliedVolatility: 0 })] as any[],
    }));
    const report = await collectIvHistory({
      store,
      fetchChain,
      curatedSymbols: ["ZZZZ"],
      watchlistSymbols: [],
      now,
    });
    expect(report.outcomes[0].status).toBe("failed");
    expect(report.outcomes[0].reason).toContain("no usable ATM IV");
    expect(await store.coverage("ZZZZ")).toEqual({ observations: 0, firstDate: null, lastDate: null });
  });

  it("a same-day rerun reports already_recorded and does not refetch recorded names", async () => {
    const store = new InMemoryIvHistoryStore();
    const fetchChain = vi.fn(async (_symbol: string) => goodChain());
    const deps = makeDeps(store, fetchChain);
    const first = await collectIvHistory(deps);
    expect(first.recorded).toBe(5);
    const callsAfterFirst = fetchChain.mock.calls.length;
    const second = await collectIvHistory(deps);
    expect(second.recorded).toBe(0);
    expect(second.alreadyRecorded).toBe(5);
    expect(second.failed).toBe(0);
    expect(fetchChain.mock.calls.length).toBe(callsAfterFirst);
    // The next NY day collects fresh records.
    const third = await collectIvHistory({ ...deps, now: new Date("2026-10-16T15:00:00.000Z") });
    expect(third.date).toBe("2026-10-16");
    expect(third.recorded).toBe(5);
    expect((await store.coverage("AAPL")).observations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Read entry (the route's per-symbol logic)
// ---------------------------------------------------------------------------

describe("getIvHistoryEntry — honest warming-up surface", () => {
  it("an unrecorded symbol is a warming-up state, not an error", async () => {
    const entry = await getIvHistoryEntry(new InMemoryIvHistoryStore(), "nope");
    expect(entry).toEqual({
      symbol: "NOPE",
      observations: 0,
      coveragePct: 0,
      warmingUp: true,
      latest: null,
      ivRank: null,
      ivPercentile: null,
    });
  });

  it("warming-up names still expose computed rank/percentile, qualified by the flag", async () => {
    const store = new InMemoryIvHistoryStore();
    for (const [i, d] of dateSeries("2026-09-01", 59).entries()) {
      await store.record(rec(d, 0.1 + (i % 10) * 0.01, "NVDA"));
    }
    const entry = await getIvHistoryEntry(store, "NVDA");
    expect(entry.observations).toBe(59);
    expect(entry.warmingUp).toBe(true);
    expect(entry.ivRank).not.toBeNull();
    expect(entry.ivPercentile).not.toBeNull();
    expect(entry.latest?.date).toBe("2026-10-29");
  });

  it("at 60 observations the entry leaves warming-up and reports the latest record", async () => {
    const store = new InMemoryIvHistoryStore();
    const dates = dateSeries("2026-09-01", 60);
    for (const [i, d] of dates.entries()) {
      await store.record({ ...rec(d, 0.2, "NVDA"), atmIv: i === 59 ? 0.44 : 0.2 });
    }
    const entry = await getIvHistoryEntry(store, "NVDA");
    expect(entry.warmingUp).toBe(false);
    expect(entry.latest).toEqual({
      date: dates[59],
      atmIv: 0.44,
      spot: 100,
      expiryDate: "2026-12-18",
      dte: 30,
    });
    expect(entry.ivRank).toBe(100); // latest is the window max
    expect(entry.coveragePct).toBeCloseTo((60 / IV_STATS_WINDOW) * 100, 10);
  });
});

// ---------------------------------------------------------------------------
// Service wiring
// ---------------------------------------------------------------------------

describe("ScheduledTasksService.collectDailyIvHistory", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("fails cleanly when no IV history store is configured", async () => {
    const orm = new DatabaseORM({ exec: () => [] } as any);
    const service = new ScheduledTasksService({} as Env, orm, "trader1");
    const result = await service.collectDailyIvHistory({ symbols: ["AAPL"] });
    expect(result.success).toBe(false);
    expect(result.taskType).toBe("options.iv_collection");
    expect(result.error).toContain("not configured");
  });

  it("records through the real screener data path and is idempotent within the day", async () => {
    const chain: ETradeOptionChain = {
      symbol: "AAPL",
      underlyingPrice: 100,
      quoteTime: Date.now(),
      selectedExpiry: { year: 2026, month: 11, day: 20 },
      pairs: [
        {
          call: {
            symbol: "AAPL", optionType: "CALL", strikePrice: 100,
            bid: 4.9, ask: 5.1, lastPrice: 5, volume: 800, openInterest: 2000,
            impliedVolatility: 0.3, delta: 0.52, gamma: 0.04, theta: -0.05, vega: 0.12, rho: 0.02,
          },
          put: {
            symbol: "AAPL", optionType: "PUT", strikePrice: 100,
            bid: 4.7, ask: 4.9, lastPrice: 4.8, volume: 700, openInterest: 1800,
            impliedVolatility: 0.32, delta: -0.48, gamma: 0.04, theta: -0.05, vega: 0.12, rho: -0.02,
          },
        },
      ],
    } as ETradeOptionChain;
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: chain });

    const orm = new DatabaseORM({ exec: () => [] } as any);
    const store = new InMemoryIvHistoryStore();
    const service = new ScheduledTasksService({ TENANT_BROKER_ID: "etrade" } as Env, orm, "trader1", undefined, store);

    const first = await service.collectDailyIvHistory({ symbols: ["AAPL"] });
    expect(first.success).toBe(true);
    expect(first.taskType).toBe("options.iv_collection");
    expect(first.data?.recorded).toBe(1);
    expect(first.data?.failed).toBe(0);
    const coverage = await store.coverage("AAPL");
    expect(coverage.observations).toBe(1);
    const stored = await store.get("AAPL", coverage.lastDate!);
    expect(stored?.atmIv).toBeCloseTo(0.31, 6); // (0.30 call + 0.32 put) / 2
    expect(stored?.expiryDate).toBe("2026-11-20");

    const second = await service.collectDailyIvHistory({ symbols: ["AAPL"] });
    expect(second.data?.recorded).toBe(0);
    expect(second.data?.alreadyRecorded).toBe(1);
  });
});
