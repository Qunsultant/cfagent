/**
 * Issue #270 — universe registry: selectors over the listings directory,
 * sharding set, and honest symbol resolution. No network.
 */
import { describe, it, expect } from "vitest";
import {
  UNIVERSES,
  shardableUniverses,
  resolveUniverse,
} from "../src/trading/universes";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";

function listing(
  symbol: string,
  companyName: string,
  marketCap = 1_000_000_000,
  exchange: any = "NASDAQ"
): NasdaqStockListing {
  return { symbol, companyName, exchange, lastPrice: 100, change: 0, changePercent: 0, marketCap };
}

function bigUniverse(n: number): NasdaqStockListing[] {
  return Array.from({ length: n }, (_, i) =>
    listing(`SYM${i}`, `Company ${i} Inc`, (n - i) * 1_000_000, i % 2 === 0 ? "NASDAQ" : "NYSE")
  );
}

describe("universe registry", () => {
  it("declares all expected universes", () => {
    for (const id of ["TECH", "NASDAQ100", "SP100", "SP500", "RUSSELL2000", "ETF", "LEV_ETF", "ALL"]) {
      expect(UNIVERSES[id as keyof typeof UNIVERSES]).toBeTruthy();
    }
  });

  it("shardable set excludes TECH and ALL", () => {
    const shards = shardableUniverses();
    expect(shards).toContain("NASDAQ100");
    expect(shards).toContain("SP500");
    expect(shards).not.toContain("TECH");
    expect(shards).not.toContain("ALL");
  });

});

describe("resolveUniverse", () => {
  it("NASDAQ100 returns top 100 Nasdaq by market cap", () => {
    const listings = bigUniverse(300);
    const res = resolveUniverse("NASDAQ100", listings);
    expect(res).toHaveLength(100);
    expect(res.every((l) => String(l.exchange).toUpperCase() === "NASDAQ")).toBe(true);
    // Market-cap descending.
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].marketCap!).toBeGreaterThanOrEqual(res[i].marketCap!);
    }
  });

  it("SP500 returns top 500 by market cap", () => {
    const res = resolveUniverse("SP500", bigUniverse(600));
    expect(res).toHaveLength(500);
  });

  it("RUSSELL2000 returns ranks 1001-3000", () => {
    const listings = bigUniverse(3200);
    const res = resolveUniverse("RUSSELL2000", listings);
    expect(res.length).toBeGreaterThan(0);
    expect(res.length).toBeLessThanOrEqual(2000);
    // First result should be rank 1001 (marketCap = (3200-1000)*1M).
    expect(res[0].marketCap).toBe(2200 * 1_000_000);
  });

  it("LEV_ETF resolves only leveraged ETF listings in the live directory", () => {
    const listings = [
      listing("TQQQ", "ProShares UltraPro QQQ"),
      listing("QQQ", "Invesco QQQ Trust ETF"),
      listing("AAPL", "Apple Inc"),
    ];
    const res = resolveUniverse("LEV_ETF", listings);
    expect(res.map((l) => l.symbol)).toEqual(["TQQQ"]);
    expect(resolveUniverse("LEV_ETF", [])).toEqual([]);
  });

  it('ALL refuses as "a shard plan is not resolvable for a single run" (#6032)', () => {
    expect(() => resolveUniverse("ALL", bigUniverse(100))).toThrow(/shard plan/);
  });

  it("ETF filter catches ETF markers", () => {
    const listings = [
      listing("AAPL", "Apple Inc"),
      listing("QQQ", "Invesco QQQ Trust ETF"),
      listing("TQQQ", "ProShares UltraPro QQQ"),
    ];
    const res = resolveUniverse("ETF", listings);
    expect(res.map((l) => l.symbol)).toContain("QQQ");
    expect(res.map((l) => l.symbol)).toContain("TQQQ");
    expect(res.map((l) => l.symbol)).not.toContain("AAPL");
  });
});
