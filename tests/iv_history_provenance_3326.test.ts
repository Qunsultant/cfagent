/**
 * Issue #3326: IV history has provenance.
 *
 * The store was keyed (symbol, date) with no record of which broker's chain
 * produced the observation, so "show Alpaca's series" could only have meant
 * relabelling E*TRADE rows. What these tests defend:
 *
 *   1. Every collected observation names its broker; a legacy row (no broker)
 *      reads as E*TRADE, because that is what produced it.
 *   2. One observation per (symbol, date) survives: a second broker on the same
 *      day reports already_recorded and does NOT rewrite provenance.
 *   3. Reads are scoped by broker — a series, coverage, and symbol list never
 *      mix two brokers.
 *   4. The declaration is true for both brokers, and the panel says an empty
 *      series is empty rather than filling it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { InMemoryIvHistoryStore } from "../src/data/inMemoryIvHistoryAdapter";
import { normalizeIvBroker } from "../src/data/ivHistoryPorts";
import { collectIvHistory, getIvHistoryEntry } from "../src/trading/options/ivCollector";
import { brokerSupports } from "../src/trading/brokerCatalog";

const NOW = new Date("2026-11-05T14:00:00Z");

function contract(strike: number, iv: number) {
  return {
    strikePrice: strike,
    impliedVolatility: iv,
    expirationDate: "2026-11-20",
    optionType: "CALL" as const,
    underlyingPrice: 100,
  } as any;
}

describe("the broker is part of the observation (#3326)", () => {
  it("normalizes unknown and legacy values to E*TRADE", () => {
    expect(normalizeIvBroker(undefined)).toBe("etrade");
    expect(normalizeIvBroker("")).toBe("etrade");
    expect(normalizeIvBroker("alpaca")).toBe("alpaca");
    expect(normalizeIvBroker("ALPACA")).toBe("alpaca");
    expect(normalizeIvBroker("ibkr")).toBe("etrade");
  });

  it("stamps every collected observation with the broker that read the chain", async () => {
    const store = new InMemoryIvHistoryStore();
    const report = await collectIvHistory({
      store,
      broker: "alpaca",
      fetchChain: async () => ({ contracts: [contract(100, 0.3)] }),
      curatedSymbols: ["AAPL"],
      watchlistSymbols: [],
      now: NOW,
    });
    expect(report.recorded).toBe(1);
    const record = await store.get("AAPL", report.date);
    expect(record?.broker).toBe("alpaca");
  });

  it("keeps one observation per day: a second broker does not rewrite provenance", async () => {
    const store = new InMemoryIvHistoryStore();
    await collectIvHistory({
      store,
      broker: "etrade",
      fetchChain: async () => ({ contracts: [contract(100, 0.28)] }),
      curatedSymbols: ["AAPL"],
      watchlistSymbols: [],
      now: NOW,
    });
    const second = await collectIvHistory({
      store,
      broker: "alpaca",
      fetchChain: async () => ({ contracts: [contract(100, 0.31)] }),
      curatedSymbols: ["AAPL"],
      watchlistSymbols: [],
      now: NOW,
    });
    expect(second.alreadyRecorded).toBe(1);
    expect(second.recorded).toBe(0);
    const record = await store.get("AAPL", second.date);
    expect(record?.broker).toBe("etrade");
    expect(record?.atmIv).toBeCloseTo(0.28, 6);
  });

  it("scopes series, coverage and symbol lists by broker", async () => {
    const store = new InMemoryIvHistoryStore();
    await store.record({ symbol: "AAPL", broker: "etrade", date: "2026-11-03", atmIv: 0.3, spot: 100, expiryDate: "2026-11-20", dte: 17, collectedAt: NOW.toISOString() });
    await store.record({ symbol: "AAPL", broker: "alpaca", date: "2026-11-04", atmIv: 0.32, spot: 101, expiryDate: "2026-11-20", dte: 16, collectedAt: NOW.toISOString() });
    await store.record({ symbol: "MSFT", broker: "alpaca", date: "2026-11-04", atmIv: 0.25, spot: 400, expiryDate: "2026-11-20", dte: 16, collectedAt: NOW.toISOString() });

    expect((await store.listSeries("AAPL", { broker: "alpaca" })).map((r) => r.date)).toEqual(["2026-11-04"]);
    expect((await store.listSeries("AAPL", { broker: "etrade" })).map((r) => r.date)).toEqual(["2026-11-03"]);
    expect(await store.listSeries("AAPL")).toHaveLength(2);
    expect((await store.coverage("AAPL", "alpaca")).observations).toBe(1);
    expect(await store.listSymbols({ broker: "alpaca" })).toEqual(["AAPL", "MSFT"]);
    expect(await store.listSymbols({ broker: "etrade" })).toEqual(["AAPL"]);
  });

  it("a legacy row reads as E*TRADE's, not as the selected broker's", async () => {
    const store = new InMemoryIvHistoryStore();
    // Written without provenance — exactly the pre-#3326 shape.
    await store.record({ symbol: "AAPL", date: "2026-11-03", atmIv: 0.3, spot: 100, expiryDate: "2026-11-20", dte: 17, collectedAt: NOW.toISOString() });
    const record = await store.get("AAPL", "2026-11-03");
    expect(record?.broker).toBe("etrade");
    expect((await store.listSeries("AAPL", { broker: "alpaca" })).length).toBe(0);
    expect((await store.listSeries("AAPL", { broker: "etrade" })).length).toBe(1);
  });

  it("the read entry is scoped to the broker, and an empty series is a state", async () => {
    const store = new InMemoryIvHistoryStore();
    await store.record({ symbol: "AAPL", broker: "etrade", date: "2026-11-03", atmIv: 0.3, spot: 100, expiryDate: "2026-11-20", dte: 17, collectedAt: NOW.toISOString() });

    const alpacaEntry = await getIvHistoryEntry(store, "AAPL", "alpaca");
    expect(alpacaEntry.observations).toBe(0);
    expect(alpacaEntry.latest).toBeNull();
    expect(alpacaEntry.warmingUp).toBe(true);

    const etradeEntry = await getIvHistoryEntry(store, "AAPL", "etrade");
    expect(etradeEntry.observations).toBe(1);
    expect(etradeEntry.latest?.atmIv).toBe(0.3);
  });

  it("both brokers declare the capability, and the panel does not fill an empty series", () => {
    expect(brokerSupports("alpaca", "ivHistory")).toBe(true);
    expect(brokerSupports("etrade", "ivHistory")).toBe(true);
    const panel = readFileSync("src/client/IvHistoryPanel.tsx", "utf8");
    expect(panel).toContain("data-iv-series-empty");
    expect(panel).toContain("Nothing is backfilled or relabelled");
  });
});
