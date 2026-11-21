/**
 * #1852 — Index-membership provider port (TDD Red first).
 *
 * Pins: port conformance (both adapters, same shape), ticker
 * normalization, non-equity-row filtering, stale-snapshot
 * labelling/failure, and a small known index end-to-end into
 * acquireUniverse with mocked quotes. No network: both adapters take
 * injected fetchers, so every fixture below is local text.
 */
import { describe, expect, it } from "vitest";
import {
  createEtfHoldingsIndexMembershipAdapter,
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
  membersToListings,
  normalizeTicker,
  screenIndexMembers,
  StaleIndexMembershipError,
  stripTags,
  type IndexMembership,
} from "../src/trading/indexMembership";
import type { ETradeQuote } from "../src/types";

/** #5956 — the listings adapter is not exercised here; an unbound call throws by name. */
const unboundListings = {
  getMembers: async (): Promise<never> => {
    throw new Error(
      "listings adapter not bound — this test serves no listings-derived index",
    );
  },
};

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
MMKT,Money Market Fund,Money Market,Financials,NYSE,0.01
GKOS,Glaukos Corporation,Equity,Health Care,NYSE,0.35
`;

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

describe("ticker normalization (#1852)", () => {
  it("maps Wikipedia class-share dots to Yahoo dashes", () => {
    expect(normalizeTicker("BRK.B")).toBe("BRK-B");
    expect(normalizeTicker("BF.B")).toBe("BF-B");
    expect(normalizeTicker("MOG.A")).toBe("MOG-A");
  });
  it("trims, uppercases, and maps slashes", () => {
    expect(normalizeTicker("  brk.b ")).toBe("BRK-B");
    expect(normalizeTicker("BRK/B")).toBe("BRK-B");
  });
  it("rejects empty and garbage symbols", () => {
    expect(() => normalizeTicker("")).toThrow();
    expect(() => normalizeTicker("AAPL!")).toThrow();
  });
});

describe("cell sanitization (#1852, CodeQL 2 high alerts on v1)", () => {
  it("loops tag stripping so nested tags cannot survive one pass", () => {
    expect(stripTags("<<script>alert(1)</script>")).toBe("alert(1)");
    expect(stripTags("A <b>bold</b> name")).toBe("A bold name");
  });
  it("decodes entities exactly once (no double unescape)", () => {
    expect(stripTags("A &amp;nbsp; B")).toBe("A &nbsp; B");
    expect(stripTags("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(stripTags("A &lt;tag&gt; B")).toBe("A tag B");
  });
  it("strips footnote markers and residual angle brackets", () => {
    expect(stripTags("Acme Corp[12]")).toBe("Acme Corp");
    expect(stripTags("A < B")).toBe("A B");
  });
});

describe("port conformance: both adapters, same shape (#1852)", () => {
  const cases: Array<{
    name: string;
    port: {
      getMembers: (
        index: "dow" | "russell2000"
      ) => Promise<IndexMembership>;
    };
  }> = [
    {
      name: "wikipedia",
      port: createWikipediaIndexMembershipAdapter(async () => DOW_HTML),
    },
    {
      name: "holdings",
      port: createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV),
    },
  ];
  for (const c of cases) {
    it(`${c.name} returns { index, snapshotDate, symbols[] } with source labels`, async () => {
      const index = c.name === "wikipedia" ? "dow" : "russell2000";
      const m = await c.port.getMembers(index as never);
      expect(m.index).toBe(index);
      expect(typeof m.snapshotDate).toBe("string");
      expect(m.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(m.symbols)).toBe(true);
      expect(m.symbols.length).toBeGreaterThan(0);
      expect(typeof m.source).toBe("string");
      expect(typeof m.derivedFromHoldings).toBe("boolean");
      for (const s of m.symbols) {
        expect(s.symbol).toMatch(/^[A-Z0-9][A-Z0-9-]*$/);
      }
    });
  }
});

describe("wikipedia adapter (#1852)", () => {
  it("reads Dow columns and normalizes BRK.B", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => DOW_HTML);
    const m = await port.getMembers("dow");
    expect(m.symbols.map((s) => s.symbol)).toEqual([
      "AAPL",
      "BRK-B",
      "MMM",
    ]);
    expect(m.symbols[0].name).toBe("Apple Inc.");
    expect(m.symbols[0].sector).toBe("Information technology");
    expect(m.derivedFromHoldings).toBe(false);
    expect(m.source).toContain("wikipedia");
  });
  it("refuses an unknown index instead of inventing members", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => DOW_HTML);
    await expect(port.getMembers("russell2000" as never)).rejects.toThrow();
  });
});

describe("etf holdings adapter (#1852)", () => {
  it("keeps equities, drops cash/money-market rows, parses the as-of date", async () => {
    const port = createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV);
    const m = await port.getMembers("russell2000");
    expect(m.symbols.map((s) => s.symbol)).toEqual(["FROG", "GKOS"]);
    expect(m.snapshotDate).toBe("2026-10-26");
    expect(m.derivedFromHoldings).toBe(true);
    expect(m.source).toContain("iwm");
  });
  it("labels holdings-derived results as holdings-derived, never official", async () => {
    const port = createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV);
    const m = await port.getMembers("russell2000");
    expect(m.sourceLabel).toMatch(/holdings-derived/i);
    // It must say it is NOT the official list — never claim to be it.
    expect(m.sourceLabel).toMatch(/NOT the official/i);
  });
});

describe("staleness (#1852): labelled or refused, never silently served", () => {
  const stale: IndexMembership = {
    index: "dow",
    snapshotDate: "2020-01-01",
    symbols: [{ symbol: "AAPL", name: "Apple Inc." }],
    source: "wikipedia",
    sourceLabel: "Wikipedia (CC BY-SA)",
    derivedFromHoldings: false,
    stale: true,
  };
  it("flags an old snapshot as stale", () => {
    const svc = createIndexMembershipService({
      listings: unboundListings,
      wikipedia: createWikipediaIndexMembershipAdapter(async () => DOW_HTML),
      holdings: createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV),
    });
    expect(svc.isStale(stale, 10)).toBe(true);
    expect(svc.isStale({ ...stale, snapshotDate: "2099-01-01" }, 10)).toBe(
      false
    );
  });
  it("requireFresh throws StaleIndexMembershipError on a stale list", () => {
    const svc = createIndexMembershipService({
      listings: unboundListings,
      wikipedia: createWikipediaIndexMembershipAdapter(async () => DOW_HTML),
      holdings: createEtfHoldingsIndexMembershipAdapter(async () => IWM_CSV),
    });
    expect(() => svc.requireFresh(stale, 10)).toThrow(
      StaleIndexMembershipError
    );
  });
});

describe("index screen end-to-end with mocked quotes (#1852)", () => {
  it("Dow members flow into acquireUniverse + screenUniverse unchanged", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => DOW_HTML);
    const m = await port.getMembers("dow");
    expect(membersToListings(m).map((l) => l.symbol)).toEqual([
      "AAPL",
      "BRK-B",
      "MMM",
    ]);
    const result = await screenIndexMembers(port, "dow", {}, {
      fetchQuote: async (s: string) => mockQuote(s),
    });
    expect(result.stocks.map((s: { symbol: string }) => s.symbol)).toEqual([
      "AAPL",
      "BRK-B",
      "MMM",
    ]);
  });
});
