/** @vitest-environment jsdom */
/**
 * Issue #3292 (close-out): IV history is declared per broker.
 *
 * The series is E*TRADE's — collected from its option-chain snapshots by a
 * scheduled job. Alpaca has no IV-history endpoint, and deriving a series from
 * one snapshot would be a manufactured curve, so the panel refuses by name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";

describe("IV history is declared per broker (#3292)", () => {
  it("E*TRADE collects it", () => {
    expect(brokerSupports("etrade", "ivHistory")).toBe(true);
  });

  it("Alpaca declares it unsupported rather than synthesising a series", () => {
    expect(brokerSupports("alpaca", "ivHistory")).toBe(false);
  });

  it("the panel refuses before issuing the E*TRADE request", () => {
    const source = readFileSync("src/client/IvHistoryPanel.tsx", "utf8");
    const guard = source.indexOf("ivHistoryRefusal()");
    const fetchAt = source.indexOf('fetch("/api/etrade/options/iv-history"');
    expect(guard).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetchAt);
    expect(source).toContain("no series is synthesised in its place");
  });
});
