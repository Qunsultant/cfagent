/**
 * Issue #1998 (Phase 3): persisted gather for the goal stock leg.
 * The gather enriches acquired quotes (batch live quotes +
 * technicals batch), persists one mas_data_captures row per symbol,
 * and returns the READ-BACK rows — never the in-memory join.
 */
import { describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { createGoalGatherEnrichment } from "../src/services/goalGather";
import {
  canonicalJson,
  computeTechnicals,
  listCapturesByRun,
  sha256Hex,
  type YahooDailyBar,
} from "../src/trading";
import type { ETradeQuote } from "../src/types";

function mapBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    storage: {
      get: async <T,>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  };
}

function bars(count: number, start: number): YahooDailyBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i;
    return {
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      open: close - 0.5,
      high: close + 0.5,
      low: close - 1,
      close,
      volume: 1_000_000,
    };
  });
}

function listing(symbol: string): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Corp`,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 500_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-27T00:00:00.000Z",
  };
}

function served(
  symbol: string,
  source: string,
  fields: Partial<ETradeQuote> = {}
): ETradeQuote {
  return {
    ...listing(symbol),
    lastPrice: 150,
    change: 3,
    changePercent: 2,
    volume: 2_000_000,
    open: 147,
    high: 151,
    low: 146,
    source,
    quoteStatus: "LIVE",
    timestamp: "2026-10-27T00:00:00.000Z",
    ...fields,
  };
}

const ROUTES = [
  {
    capability: "quotes",
    primaryProviderId: "etrade",
    gapFillProviderId: "yahoo",
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    capability: "historicalBars",
    primaryProviderId: "yahoo",
    gapFillProviderId: null,
    minTier: "freemium",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
] as any;

function liveDeps() {
  return {
    fetchQuotes: vi.fn(async (symbols: string[]) =>
      symbols
        .map((s) => {
          if (s === "AAPL")
            return served("AAPL", "E*TRADE live", { week52High: 200, week52Low: 100 });
          if (s === "ODD") return served("ODD", "E*TRADE live", { week52High: 90, averageVolume: 9 });
          return null;
        })
        .filter(Boolean)
    ),
    fetchQuote: vi.fn(async () => {
      throw new Error("unused");
    }),
  } as any;
}

function yahooDeps() {
  return {
    fetchQuotes: vi.fn(async (symbols: string[]) =>
      symbols
        .map((s) => {
          if (s === "AAPL")
            return served("AAPL", "Yahoo Finance", { week52High: 999, week52Low: 50, averageVolume: 50_000_000 });
          if (s === "MSFT") return served("MSFT", "Yahoo Finance", { week52High: 300, averageVolume: 30_000_000 });
          return null;
        })
        .filter(Boolean)
    ),
    fetchQuote: vi.fn(async () => {
      throw new Error("unused");
    }),
  } as any;
}

function historyDeps() {
  return { fetchBars: async () => bars(30, 100) } as any;
}

describe("goal gather (#1998)", () => {
  it("persists one quotes row per served symbol and returns the read-back rows", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const sink = { write: vi.fn(), writeBatch: vi.fn() };
    const enrich = createGoalGatherEnrichment({
      sql: sql as never,
      blobStorage: storage as never,
      blobEnv: {},
      tenantId: "default",
      userLogin: "tester",
      runId: "goal-run-1",
      liveQuoteDeps: liveDeps(),
      yahooQuoteDeps: yahooDeps(),
      historyDeps: historyDeps(),
      routes: ROUTES,
      sink: sink as never,
    });

    const out = await enrich.enrich([listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("ODD")]);

    // Read-back: AAPL + ODD — rows come from the live side alone.
    // MSFT is Yahoo-only: never a row. ODD is live-only: stored with
    // live columns (#2056 refined: Yahoo complements columns, never rows).
    expect(out.enrichedQuotes.map((q) => q.symbol)).toEqual(["AAPL", "ODD"]);
    expect(out.runId).toBe("goal-run-1");
    // NVDA served by neither, MSFT by Yahoo only.
    expect(out.missingSymbols.sort()).toEqual(["MSFT", "NVDA"]);
    expect(out.missingFields.NVDA).toEqual(["quote"]);
    expect(out.missingFields.MSFT).toEqual(["quote:live"]);
    // No gap-filled members: Yahoo never adds rows.
    expect(out.gapFilledCount).toBe(0);

    const rows = listCapturesByRun(sql as never, "default", "goal-run-1");
    expect(rows.map((r) => r.providerId).sort()).toEqual(["etrade", "etrade"]);
    expect(rows.every((r) => r.capability === "quotes")).toBe(true);
    const aaplRow = rows.find((r) => (r.requestParams as any).symbol === "AAPL")!;
    expect((aaplRow.requestParams as any).gapFilled).toBe(false);
    expect((aaplRow.requestParams as any).yahooPresent).toBe(true);
    expect((aaplRow.requestParams as any).routeVersionHash).toBe(out.routeVersionHash);
    const oddRow = rows.find((r) => (r.requestParams as any).symbol === "ODD")!;
    expect((oddRow.requestParams as any).yahooPresent).toBe(false);

    // Recompute pin: stored RSI equals fresh computeTechnicals on the bars.
    const aapl = out.enrichedQuotes.find((q) => q.symbol === "AAPL")!;
    // Column union: live week52High wins over Yahoo's 999; Yahoo's
    // averageVolume fills the live row's gap.
    expect(aapl.week52High).toBe(200);
    expect(aapl.averageVolume).toBe(50_000_000);
    expect(aapl.rsi).toBe(computeTechnicals("AAPL", bars(30, 100)).rsi14);

    // #1743 stage event + Phase 5 slice 7 (#2000) miss event:
    // this run has missing symbols (MSFT Yahoo-only, NVDA
    // unserved), so the gather writes the stored event AND the
    // counts-only goal.gather.missed event. Partial miss: no
    // operator page (no alertText was passed).
    expect(sink.write).toHaveBeenCalledTimes(2);
    const event = sink.write.mock.calls[0][0];
    expect(event.type).toBe("goal.gather.stored");
    expect(event.runId).toBe("goal-run-1");
    expect(event.fields.stored).toBe(2);
    expect(event.fields.yahooComplemented).toBe(1);
    const missEvent = sink.write.mock.calls[1][0];
    expect(missEvent.type).toBe("goal.gather.missed");
    expect(missEvent.runId).toBe("goal-run-1");
    expect(missEvent.fields).toEqual({ requested: 4, stored: 2, missing: 2 });
  });

  it("route version hash is the run-time snapshot hash and changes with the routes", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const enrich = (routes: any) =>
      createGoalGatherEnrichment({
        sql: sql as never,
        blobStorage: storage as never,
        blobEnv: {},
        tenantId: "default",
        runId: "goal-run-2",
        liveQuoteDeps: liveDeps(),
        yahooQuoteDeps: yahooDeps(),
        historyDeps: historyDeps(),
        routes,
      });
    const expected = await sha256Hex(
      canonicalJson([
        {
          capability: "historicalBars",
          primaryProviderId: "yahoo",
          gapFillProviderId: null,
          minTier: "freemium",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        {
          capability: "quotes",
          primaryProviderId: "etrade",
          gapFillProviderId: "yahoo",
          minTier: "freemium",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ])
    );
    const out = await enrich(ROUTES).enrich([listing("AAPL")]);
    expect(out.routeVersionHash).toBe(expected);
    const moved = ROUTES.map((r: any) =>
      r.capability === "quotes" ? { ...r, updatedAt: "2026-10-02T00:00:00.000Z" } : r
    );
    const out2 = await enrich(moved).enrich([listing("AAPL")]);
    expect(out2.routeVersionHash).not.toBe(out.routeVersionHash);
  });

  it("a corrupt latest blob fails closed to missing, never to a stale row", async () => {
    const sql = new MockSqlStorage();
    const { store, storage } = mapBlobStorage();
    // This test needs MSFT stored, so both sides serve AAPL + MSFT here.
    const dual = (fields: Record<string, Partial<ETradeQuote>>) => ({
      fetchQuotes: vi.fn(async (symbols: string[]) =>
        symbols.map((s) => (fields[s] ? served(s, "LIVE", fields[s]) : null)).filter(Boolean)
      ),
      fetchQuote: vi.fn(async () => { throw new Error("unused"); }),
    }) as any;
    const enrich = createGoalGatherEnrichment({
      sql: sql as never,
      blobStorage: storage as never,
      blobEnv: {},
      tenantId: "default",
      runId: "goal-run-3",
      liveQuoteDeps: dual({ AAPL: {}, MSFT: {} }),
      yahooQuoteDeps: dual({ AAPL: {}, MSFT: {} }),
      historyDeps: historyDeps(),
      routes: ROUTES,
    });
    const first = await enrich.enrich([listing("AAPL"), listing("MSFT")]);
    expect(first.enrichedQuotes.map((q) => q.symbol)).toEqual(["AAPL", "MSFT"]);

    // Corrupt MSFT's latest blob, then re-enrich with a dead quote seam
    // (no new rows) so read-back must face the corrupt row.
    const rows = listCapturesByRun(sql as never, "default", "goal-run-3");
    const msft = rows.find((r) => (r.requestParams as any).symbol === "MSFT")!;
    store.set(msft.rawBlobRef!, {
      storedAt: new Date().toISOString(),
      base64: Buffer.from("not json").toString("base64"),
    });
    const dead = createGoalGatherEnrichment({
      sql: sql as never,
      blobStorage: storage as never,
      blobEnv: {},
      tenantId: "default",
      runId: "goal-run-3",
      liveQuoteDeps: { fetchQuotes: async () => { throw new Error("seam down"); } } as any,
      historyDeps: historyDeps(),
      routes: ROUTES,
    });
    const second = await dead.enrich([listing("AAPL"), listing("MSFT")]);
    expect(second.enrichedQuotes.map((q) => q.symbol)).toEqual(["AAPL"]);
    expect(second.missingSymbols).toContain("MSFT");
  });

  it("without history deps, RSI is missing but quote fields still enrich", async () => {
    const sql = new MockSqlStorage();
    const { storage } = mapBlobStorage();
    const enrich = createGoalGatherEnrichment({
      sql: sql as never,
      blobStorage: storage as never,
      blobEnv: {},
      tenantId: "default",
      runId: "goal-run-4",
      liveQuoteDeps: liveDeps(),
      yahooQuoteDeps: yahooDeps(),
      routes: ROUTES,
    });
    const out = await enrich.enrich([listing("AAPL")]);
    expect(out.enrichedQuotes.map((q) => q.symbol)).toEqual(["AAPL"]);
    expect(out.enrichedQuotes[0].week52High).toBe(200);
    expect(out.enrichedQuotes[0].rsi).toBeUndefined();
    expect(out.missingFields.AAPL).toContain("rsi");
  });
});
