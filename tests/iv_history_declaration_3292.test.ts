/** @vitest-environment jsdom */
/**
 * Issue #3292 (close-out): IV history is declared per broker.
 *
 * That issue recorded Alpaca as unsupported, because the series was E*TRADE's
 * and a one-snapshot curve would be manufactured. Issue #3326 supersedes the
 * Alpaca half: the collector stamps every observation with the broker whose
 * chain measured it, so each broker's series is its own. What survives from
 * #3292 is the requirement — a broker with no series is refused — or stated by
 * name, never answered with another broker's rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";

describe("IV history is declared per broker (#3292)", () => {
  it("E*TRADE collects it", () => {
    expect(brokerSupports("etrade", "ivHistory")).toBe(true);
  });

  it("Alpaca collects its own since #3326 — provenance, not synthesis", () => {
    expect(brokerSupports("alpaca", "ivHistory")).toBe(true);
  });

  it("the panel still refuses by name before issuing a request for a broker without the capability", () => {
    const source = readFileSync("src/client/IvHistoryPanel.tsx", "utf8");
    const guard = source.indexOf("ivHistoryRefusal()");
    const fetchAt = source.indexOf('fetch("/api/etrade/options/iv-history"');
    expect(guard).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetchAt);
    expect(source).toContain("no other broker's series is shown in its place");
  });

  it("the panel states an empty series instead of filling it", () => {
    const source = readFileSync("src/client/IvHistoryPanel.tsx", "utf8");
    expect(source).toContain("Nothing is backfilled or relabelled");
  });
});
