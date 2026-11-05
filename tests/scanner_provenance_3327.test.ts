/**
 * Issue #3327: scan history is the selected broker's evidence.
 *
 * The scan engine was already neutral (#3272); what was missing was provenance.
 * These tests defend:
 *   1. A run is stamped with the broker whose chains produced it, and the
 *      stamp survives the store (both adapters).
 *   2. Reads are scoped: listing for Alpaca never returns an E*TRADE run.
 *   3. A run saved before provenance existed reads as E*TRADE — what it was —
 *      and is therefore never shown as another broker's evidence.
 *   4. The catalogue says the capability is true for both brokers.
 */
import { describe, it, expect } from "vitest";

import { InMemoryScanRunStore } from "../src/data/inMemoryScanRunAdapter";
import { normalizeScanRunBroker } from "../src/data/scanRunPorts";
import { brokerSupports } from "../src/trading/brokerCatalog";
import type { OpportunityScanResult } from "../src/trading";

function result(overrides: Partial<OpportunityScanResult> = {}): OpportunityScanResult {
  return {
    scanned: 1,
    withTrades: 0,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix: [],
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 0, borderline: 0, noFit: 0 },
    borderline: [],
    gateParams: {} as any,
    profileRef: null,
    generatedAt: "2026-11-05T14:00:00.000Z",
    modelVersion: "test",
    coverage: {} as any,
    ...overrides,
  } as OpportunityScanResult;
}

describe("scan runs carry their broker (#3327)", () => {
  it("normalizes legacy and unknown values to E*TRADE", () => {
    expect(normalizeScanRunBroker(undefined)).toBe("etrade");
    expect(normalizeScanRunBroker(null)).toBe("etrade");
    expect(normalizeScanRunBroker("ALPACA")).toBe("alpaca");
    expect(normalizeScanRunBroker("ibkr")).toBe("etrade");
  });

  it("stamps the broker on save and reads it back", async () => {
    const store = new InMemoryScanRunStore();
    const saved = await store.save(result(), { userLogin: "user-1", broker: "alpaca" });
    expect(saved.broker).toBe("alpaca");
    const listed = await store.list({ userLogin: "user-1" });
    expect(listed[0].broker).toBe("alpaca");
  });

  it("lists only the selected broker's runs", async () => {
    const store = new InMemoryScanRunStore();
    await store.save(result(), { userLogin: "user-1", broker: "etrade" });
    await store.save(result({ generatedAt: "2026-11-05T15:00:00.000Z" }), { userLogin: "user-1", broker: "alpaca" });

    const alpaca = await store.list({ userLogin: "user-1", broker: "alpaca" });
    expect(alpaca).toHaveLength(1);
    expect(alpaca[0].broker).toBe("alpaca");

    const etrade = await store.list({ userLogin: "user-1", broker: "etrade" });
    expect(etrade).toHaveLength(1);
    expect(etrade[0].broker).toBe("etrade");
  });

  it("a run saved without provenance is E*TRADE's, and never Alpaca's", async () => {
    const store = new InMemoryScanRunStore();
    await store.save(result(), { userLogin: "user-1" });
    expect((await store.list({ userLogin: "user-1", broker: "etrade" }))).toHaveLength(1);
    expect((await store.list({ userLogin: "user-1", broker: "alpaca" }))).toHaveLength(0);
  });

  it("both brokers declare the scanner capability", () => {
    expect(brokerSupports("etrade", "optionsScanner")).toBe(true);
    expect(brokerSupports("alpaca", "optionsScanner")).toBe(true);
  });
});
