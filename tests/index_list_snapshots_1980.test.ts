/**
 * #1980 — Stored index-list snapshots + scheduled refresh on the
 * feed seam (follow-up to #1852). TDD Red first.
 *
 * Pins (no network, no hardcoded lists — every list comes from an
 * injected #1852 adapter over local fixtures):
 * - Port conformance: in-memory, DO-SQLite (node:sqlite executor),
 *   and D1 (fake D1Database) adapters share one semantics — one
 *   artifact per (index, snapshotDate) via latest(), keep-per-index
 *   prune, source + sourceLabel on every artifact.
 * - Producer honesty: a failed fetch is never stored; a zero-member
 *   result is refused, not stored; job results carry descriptors
 *   (counts), NOT symbol bytes.
 * - Refresh job: one artifact per index; partial names failures and
 *   completes; all-failed throws so the job reads failed.
 * - Consumer: stored Dow-30 list -> screener via opts.symbols with
 *   mocked quotes; stale lists refused (requireFresh) or flagged
 *   (withStalenessFlag), never silently served; missing lists fail
 *   loudly.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createEtfHoldingsIndexMembershipAdapter,
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
  StaleIndexMembershipError,
  type IndexId,
  type IndexMembershipPort,
} from "../src/trading/indexMembership";
import type { ETradeQuote } from "../src/types";
import type {
  IndexListStore,
} from "../src/data/indexListPorts";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { SqlIndexListStore } from "../src/data/doSqliteIndexListAdapter";
import { D1IndexListStore } from "../src/data/d1IndexListAdapter";
import { produceIndexListSnapshot } from "../src/services/indexListProducer";
import {
  executeIndexListRefreshJob,
  INDEX_REFRESH_INDICES,
} from "../src/services/indexListJob";
import {
  requireFreshStored,
  resolveStoredIndexList,
  screenStoredIndexList,
  withStalenessFlagStored,
} from "../src/services/indexListConsumer";

/** Minimal Wikipedia-style table: real Dow layout Company | Exchange | Symbol | ISIN | Sector. */
const DOW_HTML = `<table class="wikitable"><tbody>
<tr><th>Company</th><th>Exchange</th><th>Symbol</th><th>ISIN</th><th>Sector</th></tr>
<tr><td>Apple Inc.</td><td>NASDAQ</td><td>AAPL</td><td>US0378331005</td><td>Information technology</td></tr>
<tr><td>Berkshire Hathaway Inc.</td><td>NYSE</td><td>BRK.B</td><td>US0846701086</td><td>Financials</td></tr>
<tr><td>3M Company</td><td>NYSE</td><td>MMM</td><td>US88579Y1010</td><td>Conglomerate</td></tr>
</tbody></table>`;

/** iShares-style CSV: metadata rows, then a Ticker header row, then holdings. */
const IWM_CSV = `iShares Russell 2000 ETF
Fund Holdings as of 2026-10-26
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
FROG,JFrog Ltd.,Equity,Information Technology,NASDAQ,0.40
CASH,US Dollar Cash,Cash and/or Derivatives,,,
GKOS,Glaukos Corporation,Equity,Health Care,NYSE,0.35
`;

function makeService() {
  return createIndexMembershipService({
    wikipedia: createWikipediaIndexMembershipAdapter(async () => DOW_HTML, "2026-11-02"),
    holdings: createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV, "2026-11-02"),
  });
}

/** node:sqlite executor with the FeedSqlExecutor shape. */
function makeSqlExecutor() {
  const sqlite = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: unknown[]): Iterable<unknown> {
      const stmt = sqlite.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(params as never[])) as unknown[];
      }
      stmt.run(...(params as never[]));
      return [];
    },
  };
}

/** Minimal fake D1Database: supports exactly the statements the D1 adapter issues. */
function makeFakeD1() {
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              if (/^\s*CREATE TABLE/i.test(sql)) return { success: true };
              if (/^\s*INSERT INTO/i.test(sql)) {
                const [id, created_at, index_id, snapshot_date, source, source_label, derived, members_json] =
                  params as [string, string, string, string, string, string, number, string];
                rows.push({ id, created_at, index_id, snapshot_date, source, source_label, derived_from_holdings: derived, members_json });
              } else if (/^\s*DELETE FROM/i.test(sql)) {
                const [id] = params as [string];
                const at = rows.findIndex((r) => r.id === id);
                if (at !== -1) rows.splice(at, 1);
              }
              return { success: true };
            },
            first: async <T>() => {
              if (/ORDER BY created_at DESC, id DESC LIMIT 1/i.test(sql)) {
                const [index_id] = params as [string];
                const mine = rows
                  .filter((r) => r.index_id === index_id)
                  .sort((a, b) =>
                    a.created_at !== b.created_at
                      ? (a.created_at as string) < (b.created_at as string) ? 1 : -1
                      : (b.id as string).localeCompare(a.id as string),
                  );
                return (mine[0] ?? null) as T | null;
              }
              return null as T | null;
            },
            all: async () => {
              if (/SELECT id FROM/i.test(sql)) {
                const [index_id] = params as [string];
                const mine = rows
                  .filter((r) => r.index_id === index_id)
                  .sort((a, b) =>
                    a.created_at !== b.created_at
                      ? (a.created_at as string) < (b.created_at as string) ? 1 : -1
                      : (b.id as string).localeCompare(a.id as string),
                  );
                return { results: mine.map((r) => ({ id: r.id })) };
              }
              return { results: [] };
            },
          };
        },
        run: async () => ({ success: true }),
      };
    },
    _rows: rows,
  };
  return db;
}

function makeStores(): Array<{ name: string; store: IndexListStore }> {
  let seq = 0;
  const idFactory = () => `id-${++seq}`;
  return [
    { name: "in-memory", store: new InMemoryIndexListStore({ idFactory }) },
    { name: "do-sqlite", store: new SqlIndexListStore(makeSqlExecutor(), { idFactory }) },
    { name: "d1", store: new D1IndexListStore(makeFakeD1() as never, { idFactory }) },
  ];
}

function mockQuote(symbol: string): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Co.`,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 1000,
    open: 99,
    high: 101,
    low: 98,
  };
}

describe("index-list store conformance (#1980)", () => {
  for (const { name, store } of makeStores()) {
    it(`${name}: latest() returns the newest artifact per index with source + sourceLabel`, async () => {
      await store.store({
        index: "dow",
        snapshotDate: "2026-11-01",
        symbols: [{ symbol: "AAPL" }],
        source: "wikipedia",
        sourceLabel: "Wikipedia component table (CC BY-SA), fetched 2026-11-01",
        derivedFromHoldings: false,
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      const second = await store.store({
        index: "dow",
        snapshotDate: "2026-11-02",
        symbols: [{ symbol: "AAPL" }, { symbol: "MMM" }],
        source: "wikipedia",
        sourceLabel: "Wikipedia component table (CC BY-SA), fetched 2026-11-02",
        derivedFromHoldings: false,
        nowIso: "2026-11-02T00:00:00.000Z",
      });
      const latest = await store.latest("dow");
      expect(latest?.id).toBe(second.id);
      expect(latest?.snapshotDate).toBe("2026-11-02");
      expect(latest?.symbols.map((s) => s.symbol)).toEqual(["AAPL", "MMM"]);
      expect(latest?.source).toBe("wikipedia");
      expect(latest?.sourceLabel).toMatch(/CC BY-SA/);
      expect(await store.latest("sp500")).toBeUndefined();
    });
    it(`${name}: keep-per-index prune keeps only the newest rows`, async () => {
      const small = name === "in-memory"
        ? new InMemoryIndexListStore({ keepPerIndex: 2 })
        : name === "do-sqlite"
          ? new SqlIndexListStore(makeSqlExecutor(), { keepPerIndex: 2 })
          : new D1IndexListStore(makeFakeD1() as never, { keepPerIndex: 2 });
      for (let i = 1; i <= 4; i++) {
        await small.store({
          index: "sp500",
          snapshotDate: `2026-11-0${i}`,
          symbols: [{ symbol: "AAPL" }],
          source: "wikipedia",
          sourceLabel: `Wikipedia, fetched 2026-11-0${i}`,
          derivedFromHoldings: false,
          nowIso: `2026-11-0${i}T00:00:00.000Z`,
        });
      }
      const latest = await small.latest("sp500");
      expect(latest?.snapshotDate).toBe("2026-11-04");
    });
  }
});

describe("index-list producer honesty (#1980)", () => {
  it("stores a fetched list and returns a descriptor without symbol bytes", async () => {
    const store = new InMemoryIndexListStore();
    const descriptor = await produceIndexListSnapshot({
      store,
      service: makeService(),
      index: "dow",
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(descriptor.index).toBe("dow");
    expect(descriptor.snapshotDate).toBe("2026-11-02");
    expect(descriptor.source).toBe("wikipedia");
    expect(descriptor.memberCount).toBe(3);
    expect("symbols" in descriptor).toBe(false);
    const stored = await store.latest("dow");
    expect(stored?.symbols.map((s) => s.symbol)).toEqual(["AAPL", "BRK-B", "MMM"]);
  });
  it("a failed fetch is NEVER stored as an artifact", async () => {
    const store = new InMemoryIndexListStore();
    const failing: IndexMembershipPort = {
      async getMembers() {
        throw new Error("upstream down");
      },
    };
    await expect(
      produceIndexListSnapshot({ store, service: failing as never, index: "dow" }),
    ).rejects.toThrow("upstream down");
    expect(await store.latest("dow")).toBeUndefined();
  });
  it("a zero-member result is refused, not stored", async () => {
    const store = new InMemoryIndexListStore();
    const empty: IndexMembershipPort = {
      async getMembers(index: IndexId) {
        return {
          index,
          snapshotDate: "2026-11-02",
          symbols: [],
          source: "wikipedia",
          sourceLabel: "Wikipedia",
          derivedFromHoldings: false,
        };
      },
    };
    await expect(
      produceIndexListSnapshot({ store, service: empty as never, index: "dow" }),
    ).rejects.toThrow(/zero-member|no members/i);
    expect(await store.latest("dow")).toBeUndefined();
  });
});

describe("index-list refresh job (#1980)", () => {
  it("one artifact per index; a bad index fails without blocking the fed ones", async () => {
    const store = new InMemoryIndexListStore();
    const service = makeService();
    // The Dow fixture cannot parse as an S&P 500 table (its symbol
    // column holds company names for that layout), so sp500 fails
    // honestly while dow + russell2000 store — partial, named.
    const result = await executeIndexListRefreshJob({
      store,
      service,
      indices: ["dow", "russell2000", "sp500"],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(result.status).toBe("partial");
    expect(result.artifacts.map((a) => a.index).sort()).toEqual(["dow", "russell2000"]);
    expect(result.failures.map((f) => f.index)).toEqual(["sp500"]);
    expect(await store.latest("russell2000")).toBeDefined();
    expect(await store.latest("sp500")).toBeUndefined();
  });
  it("partial: failures named, fed indices still stored", async () => {
    const store = new InMemoryIndexListStore();
    const flaky = {
      async getMembers(index: IndexId) {
        if (index === "sp500") throw new Error("wiki timeout");
        return makeService().getMembers(index);
      },
    };
    const result = await executeIndexListRefreshJob({
      store,
      service: flaky as never,
      indices: ["dow", "sp500"],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(result.status).toBe("partial");
    expect(result.artifacts.map((a) => a.index)).toEqual(["dow"]);
    expect(result.failures.map((f) => f.index)).toEqual(["sp500"]);
    expect(result.reason).toMatch(/sp500/);
  });
  it("all-failed throws so the job reads failed", async () => {
    const store = new InMemoryIndexListStore();
    const failing: IndexMembershipPort = {
      async getMembers() {
        throw new Error("upstream down");
      },
    };
    await expect(
      executeIndexListRefreshJob({ store, service: failing as never, indices: ["dow", "sp500"] }),
    ).rejects.toThrow(/every index/i);
    expect(await store.latest("dow")).toBeUndefined();
  });
  it("refresh index groups cover all six indices", () => {
    expect([...INDEX_REFRESH_INDICES.wikipedia].sort()).toEqual(
      ["dow", "nasdaq100", "sp100", "sp500"],
    );
    expect([...INDEX_REFRESH_INDICES.holdings].sort()).toEqual(["russell1000", "russell2000"]);
  });
});

describe("stored-list consumer (#1980)", () => {
  it("resolves the latest stored list and screens Dow-30 end-to-end with mocked quotes", async () => {
    const store = new InMemoryIndexListStore();
    await produceIndexListSnapshot({
      store,
      service: makeService(),
      index: "dow",
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    const resolved = await resolveStoredIndexList({
      store,
      index: "dow",
      maxAgeDays: 10,
      now: "2026-11-05",
    });
    expect(resolved.status).toBe("hit");
    if (resolved.status === "hit") {
      expect(resolved.membership.symbols.map((s) => s.symbol)).toEqual(["AAPL", "BRK-B", "MMM"]);
      expect(resolved.stale).toBe(false);
    }
    const result = await screenStoredIndexList({
      store,
      index: "dow",
      maxAgeDays: 10,
      now: "2026-11-05",
      filter: {},
      quoteDeps: { fetchQuote: async (s: string) => mockQuote(s) },
    });
    expect(result.stocks.map((s: { symbol: string }) => s.symbol)).toEqual(["AAPL", "BRK-B", "MMM"]);
  });
  it("missing lists fail loudly, never silently", async () => {
    const store = new InMemoryIndexListStore();
    const resolved = await resolveStoredIndexList({ store, index: "dow", maxAgeDays: 10, now: "2026-11-05" });
    expect(resolved.status).toBe("missing");
    await expect(
      screenStoredIndexList({
        store,
        index: "dow",
        maxAgeDays: 10,
        now: "2026-11-05",
        filter: {},
        quoteDeps: { fetchQuote: async (s: string) => mockQuote(s) },
      }),
    ).rejects.toThrow(/no stored/i);
  });
  it("requireFresh refuses stale lists; withStalenessFlag flags them", async () => {
    const store = new InMemoryIndexListStore();
    await store.store({
      index: "dow",
      snapshotDate: "2020-01-01",
      symbols: [{ symbol: "AAPL" }],
      source: "wikipedia",
      sourceLabel: "Wikipedia component table (CC BY-SA), fetched 2020-01-01",
      derivedFromHoldings: false,
      nowIso: "2020-01-01T00:00:00.000Z",
    });
    expect(() =>
      requireFreshStored(
        { index: "dow", snapshotDate: "2020-01-01", symbols: [{ symbol: "AAPL" }], source: "wikipedia", sourceLabel: "Wikipedia", derivedFromHoldings: false },
        10,
        "2026-11-05",
      ),
    ).toThrow(StaleIndexMembershipError);
    const flagged = withStalenessFlagStored(
      { index: "dow", snapshotDate: "2020-01-01", symbols: [{ symbol: "AAPL" }], source: "wikipedia", sourceLabel: "Wikipedia", derivedFromHoldings: false },
      10,
      "2026-11-05",
    );
    expect(flagged.stale).toBe(true);
    const resolved = await resolveStoredIndexList({ store, index: "dow", maxAgeDays: 10, now: "2026-11-05" });
    expect(resolved.status).toBe("hit");
    if (resolved.status === "hit") expect(resolved.stale).toBe(true);
  });
});
