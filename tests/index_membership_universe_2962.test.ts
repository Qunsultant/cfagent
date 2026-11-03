/**
 * #2962 — Extended index universe: S&P 400, Russell 3000, GICS sectors.
 * TDD Red first: every new key is asserted here before the port
 * knows it. No network: both adapters take injected fetchers, so
 * every fixture below is local text (same pattern as #1852).
 */
import { describe, expect, it } from "vitest";
import {
  createEtfHoldingsIndexMembershipAdapter,
  createIndexMembershipService,
  createWikipediaIndexMembershipAdapter,
  SECTOR_IDS,
  SECTOR_SPDR_ETF,
  sectorIdForGicsName,
  StaleIndexMembershipError,
  UnknownIndexError,
  type IndexId,
  type IndexMembershipPort,
} from "../src/trading/indexMembership";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { produceIndexListSnapshot } from "../src/services/indexListProducer";
import {
  indicesForRefreshOperation,
  INDEX_REFRESH_INDICES,
} from "../src/services/indexListJob";
import {
  requireFreshStored,
  resolveStoredIndexList,
} from "../src/services/indexListConsumer";

/** S&P 400 layout, verified live 2026-11-03: Symbol | Security | GICS Sector | GICS Sub-Industry | HQ | SEC filings. */
const SP400_HTML = `<table class="wikitable"><tbody>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>GICS Sub-Industry</th><th>Headquarters Location</th><th>SEC filings</th></tr>
<tr><td>AA</td><td>Alcoa</td><td>Materials</td><td>Aluminum</td><td>Pittsburgh, Pennsylvania</td><td>reports</td></tr>
<tr><td>FOO.B</td><td>Foo Class B</td><td>Financials</td><td>Asset Management</td><td>New York City, New York</td><td>reports</td></tr>
<tr><td>XOM2</td><td>Example Energy</td><td>Energy</td><td>Oil &amp; Gas</td><td>Houston, Texas</td><td>reports</td></tr>
</tbody></table>`;

/** S&P 500 layout (Symbol | Security | GICS Sector | …) with mixed sectors. */
const SP500_HTML = `<table class="wikitable"><tbody>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>GICS Sub-Industry</th></tr>
<tr><td>AAPL</td><td>Apple Inc.</td><td>Information Technology</td><td>Technology Hardware</td></tr>
<tr><td>XOM</td><td>Exxon Mobil</td><td>Energy</td><td>Integrated Oil &amp; Gas</td></tr>
<tr><td>CVX</td><td>Chevron</td><td>Energy</td><td>Integrated Oil &amp; Gas</td></tr>
<tr><td>JNJ</td><td>Johnson &amp; Johnson</td><td>Health Care</td><td>Pharmaceuticals</td></tr>
</tbody></table>`;

/** iShares-style CSVs for the Russell legs (different as-of dates, one overlap). */
const IWB_CSV = `iShares Russell 1000 ETF
Fund Holdings as of 2026-10-28
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
AAPL,Apple Inc.,Equity,Information Technology,NASDAQ,5.00
SHARED,Shared Corp.,Equity,Financials,NYSE,0.10
`;
const IWM_CSV = `iShares Russell 2000 ETF
Fund Holdings as of 2026-10-26
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
FROG,JFrog Ltd.,Equity,Information Technology,NASDAQ,0.40
SHARED,Shared Corp Small,Equity,Financials,NYSE,0.05
`;
const IWV_CSV = `iShares Russell 3000 ETF
Fund Holdings as of 2026-10-28
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
AAPL,Apple Inc.,Equity,Information Technology,NASDAQ,5.00
FROG,JFrog Ltd.,Equity,Information Technology,NASDAQ,0.40
EXTRA,Extra Corp.,Equity,Energy,NYSE,0.02
`;
const MDY_CSV = `SPDR S&P MidCap 400 ETF Trust
Fund Holdings as of 2026-10-27
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
AA,Alcoa,Equity,Materials,NYSE,0.50
`;
const XLE_CSV = `Select Sector SPDR Energy
Fund Holdings as of 2026-10-27
Ticker,Name,Asset Class,Sector,Exchange,Weight (%)
XOM,Exxon Mobil,Equity,Energy,NYSE,20.00
`;

const holdingsFetch = (files: Record<string, string>) => async (etf: string) => {
  const text = files[etf];
  if (text === undefined) throw new Error(`no fixture for ${etf}`);
  return text;
};

describe("sp400 wikipedia adapter (#2962)", () => {
  it("reads S&P 400 columns and normalizes class-share dots", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => SP400_HTML);
    const m = await port.getMembers("sp400");
    expect(m.symbols.map((s) => s.symbol)).toEqual(["AA", "FOO-B", "XOM2"]);
    expect(m.symbols[0].name).toBe("Alcoa");
    expect(m.symbols[0].sector).toBe("Materials");
    expect(m.derivedFromHoldings).toBe(false);
    expect(m.source).toContain("wikipedia");
  });
  it("refuses a header-only table instead of an empty list", async () => {
    const port = createWikipediaIndexMembershipAdapter(
      async () =>
        `<table><tbody><tr><th>Symbol</th><th>Security</th></tr></tbody></table>`,
    );
    // A header-only table is not a component table at all
    // (parseHtmlRows requires a data row), so the refusal
    // surfaces there — still a refusal, never an empty list.
    await expect(port.getMembers("sp400")).rejects.toThrow(
      /component table|no members/i,
    );
  });
});

describe("sector universes (#2962)", () => {
  it("the 11 GICS names map to 11 distinct sector keys", () => {
    const names = [
      "Energy",
      "Materials",
      "Industrials",
      "Consumer Discretionary",
      "Consumer Staples",
      "Health Care",
      "Financials",
      "Information Technology",
      "Communication Services",
      "Utilities",
      "Real Estate",
    ];
    const keys = names.map((n) => sectorIdForGicsName(n));
    expect(keys.every((k) => k !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(11);
    expect([...SECTOR_IDS].sort()).toEqual([...(keys as string[])].sort());
  });
  it("every sector key has a Select Sector SPDR cross-check ticker", () => {
    for (const key of SECTOR_IDS) {
      expect(SECTOR_SPDR_ETF[key]).toMatch(/^[A-Z]{3,4}$/);
    }
    expect(SECTOR_SPDR_ETF["sector-energy"]).toBe("XLE");
    expect(SECTOR_SPDR_ETF["sector-real-estate"]).toBe("XLRE");
  });
  it("sector-energy filters the S&P 500 table by its GICS Sector column", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => SP500_HTML);
    const m = await port.getMembers("sector-energy");
    expect(m.symbols.map((s) => s.symbol)).toEqual(["XOM", "CVX"]);
    expect(m.symbols[0].sector).toBe("Energy");
    expect(m.source).toContain("wikipedia");
    expect(m.sourceLabel).toMatch(/Energy/);
  });
  it("a sector with no rows in the table throws instead of an empty list", async () => {
    const port = createWikipediaIndexMembershipAdapter(async () => SP500_HTML);
    await expect(port.getMembers("sector-utilities")).rejects.toThrow(
      /no members/i,
    );
  });
  it("sector keys share one S&P 500 fetch per adapter instance", async () => {
    let calls = 0;
    const port = createWikipediaIndexMembershipAdapter(async () => {
      calls++;
      return SP500_HTML;
    });
    await port.getMembers("sector-energy");
    await port.getMembers("sector-health-care");
    expect(calls).toBe(1);
  });
  it("an unknown key throws UnknownIndexError instead of inventing members", async () => {
    const svc = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async () => SP500_HTML),
      holdings: createEtfHoldingsIndexMembershipAdapter(
        holdingsFetch({ IWB: IWB_CSV, IWM: IWM_CSV }),
      ),
    });
    // The service routes synchronously, so the refusal is a
    // sync throw, not a rejected promise.
    expect(() => svc.getMembers("sp600" as never)).toThrow(UnknownIndexError);
  });
});

describe("russell3000 union (#2962)", () => {
  const unionPort = () =>
    createEtfHoldingsIndexMembershipAdapter(
      holdingsFetch({ IWB: IWB_CSV, IWM: IWM_CSV }),
    );
  it("unions IWB + IWM, dedups, and dates the union at the older leg", async () => {
    const m = await unionPort().getMembers("russell3000");
    expect(m.symbols.map((s) => s.symbol).sort()).toEqual([
      "AAPL",
      "FROG",
      "SHARED",
    ]);
    expect(m.snapshotDate).toBe("2026-10-26");
    expect(m.source).toBe("iwb+iwm");
    expect(m.sourceLabel).toMatch(/IWB as of 2026-10-28/);
    expect(m.sourceLabel).toMatch(/IWM as of 2026-10-26/);
    expect(m.sourceLabel).toMatch(/NOT the official/i);
    expect(m.derivedFromHoldings).toBe(true);
  });
  it("an overlapping symbol keeps the Russell 1000 (IWB) record", async () => {
    const m = await unionPort().getMembers("russell3000");
    expect(m.symbols.find((s) => s.symbol === "SHARED")?.name).toBe(
      "Shared Corp.",
    );
  });
  it("a failing leg fails the whole union — no partial list", async () => {
    const port = createEtfHoldingsIndexMembershipAdapter(
      holdingsFetch({ IWB: IWB_CSV }),
    );
    await expect(port.getMembers("russell3000")).rejects.toThrow();
  });
  it("IWV cross-check reports set differences against the union", async () => {
    const svc = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async () => SP500_HTML),
      holdings: unionPort(),
    });
    const check = await svc.crossCheckRussell3000Union(IWV_CSV);
    expect(check.index).toBe("russell3000");
    expect(check.unionCount).toBe(3);
    expect(check.iwvCount).toBe(3);
    expect(check.onlyInUnion).toEqual(["SHARED"]);
    expect(check.onlyInIwv).toEqual(["EXTRA"]);
  });
});

describe("holdings single-ETF for new keys (#2962)", () => {
  it("sp400 resolves via MDY and sector-energy via XLE", async () => {
    const port = createEtfHoldingsIndexMembershipAdapter(
      holdingsFetch({ MDY: MDY_CSV, XLE: XLE_CSV }),
    );
    const sp400 = await port.getMembers("sp400");
    expect(sp400.symbols.map((s) => s.symbol)).toEqual(["AA"]);
    expect(sp400.source).toBe("mdy");
    const energy = await port.getMembers("sector-energy");
    expect(energy.symbols.map((s) => s.symbol)).toEqual(["XOM"]);
    expect(energy.source).toBe("xle");
  });
});

describe("cross-adapter conformance for sp400 (#2962)", () => {
  it("wikipedia table vs MDY holdings agree on the shared member", async () => {
    const svc = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async () => SP400_HTML),
      holdings: createEtfHoldingsIndexMembershipAdapter(
        holdingsFetch({ MDY: MDY_CSV }),
      ),
    });
    const check = await svc.crossCheck("sp400");
    expect(check.wikipediaCount).toBe(3);
    expect(check.holdingsCount).toBe(1);
    expect(check.onlyInWikipedia.sort()).toEqual(["FOO-B", "XOM2"]);
    expect(check.onlyInHoldings).toEqual([]);
  });
});

describe("service routing + staleness (#2962)", () => {
  const svc = () =>
    createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async (url) =>
        url.includes("S%26P_400") ? SP400_HTML : SP500_HTML,
      ),
      holdings: createEtfHoldingsIndexMembershipAdapter(
        holdingsFetch({ IWB: IWB_CSV, IWM: IWM_CSV }),
      ),
    });
  it("sp400 and sector keys route to Wikipedia; russell3000 routes to holdings", async () => {
    expect((await svc().getMembers("sp400")).source).toContain("wikipedia");
    expect((await svc().getMembers("sector-energy")).source).toContain(
      "wikipedia",
    );
    expect((await svc().getMembers("russell3000")).source).toBe("iwb+iwm");
  });
  it("requireFresh refuses a stale union under the holdings budget", async () => {
    const stalePort = createEtfHoldingsIndexMembershipAdapter(
      holdingsFetch({
        IWB: IWB_CSV.replaceAll("2026-10-28", "2020-01-01"),
        IWM: IWM_CSV.replaceAll("2026-10-26", "2020-01-01"),
      }),
    );
    const m = await stalePort.getMembers("russell3000");
    const service = createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async () => SP500_HTML),
      holdings: stalePort,
    });
    expect(() => service.requireFresh(m, 3)).toThrow(StaleIndexMembershipError);
  });
});

describe("stored layer for new keys (#2962)", () => {
  const makeService = (): IndexMembershipPort =>
    createIndexMembershipService({
      wikipedia: createWikipediaIndexMembershipAdapter(async (url) =>
        url.includes("S%26P_400") ? SP400_HTML : SP500_HTML,
      ),
      holdings: createEtfHoldingsIndexMembershipAdapter(
        holdingsFetch({ IWB: IWB_CSV, IWM: IWM_CSV }),
      ),
    });
  it("sp400 and russell3000 store, resolve fresh, and refuse stale", async () => {
    const store = new InMemoryIndexListStore();
    const service = makeService();
    const sp400 = await produceIndexListSnapshot({
      store,
      service,
      index: "sp400",
    });
    expect(sp400.memberCount).toBe(3);
    const r3000 = await produceIndexListSnapshot({
      store,
      service,
      index: "russell3000",
    });
    expect(r3000.memberCount).toBe(3);
    const resolved = await resolveStoredIndexList({
      store,
      index: "russell3000",
      now: "2026-10-28",
    });
    expect(resolved.status).toBe("hit");
    if (resolved.status === "hit") {
      expect(resolved.stale).toBe(false);
      expect(() =>
        requireFreshStored(resolved.membership, 3, "2026-11-15"),
      ).toThrow(StaleIndexMembershipError);
    }
    const missing = await resolveStoredIndexList({
      store,
      index: "sector-utilities",
    });
    expect(missing.status).toBe("missing");
  });
  it("refresh groups cover the new keys in their source families", () => {
    expect(indicesForRefreshOperation("index.refresh_wikipedia")).toEqual(
      expect.arrayContaining(["sp400", "sector-energy", "sector-utilities"]),
    );
    expect(indicesForRefreshOperation("index.refresh_holdings")).toEqual(
      expect.arrayContaining(["russell3000"]),
    );
    expect([...INDEX_REFRESH_INDICES.wikipedia].sort()).toEqual(
      [
        "dow",
        "nasdaq100",
        "sector-communication-services",
        "sector-consumer-discretionary",
        "sector-consumer-staples",
        "sector-energy",
        "sector-financials",
        "sector-health-care",
        "sector-industrials",
        "sector-information-technology",
        "sector-materials",
        "sector-real-estate",
        "sector-utilities",
        "sp100",
        "sp400",
        "sp500",
      ].sort(),
    );
    expect([...INDEX_REFRESH_INDICES.holdings].sort()).toEqual(
      ["russell1000", "russell2000", "russell3000"].sort(),
    );
  });
});
