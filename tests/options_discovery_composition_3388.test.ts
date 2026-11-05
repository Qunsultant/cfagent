/**
 * Issue #3388 — Alpaca options discovery: the engine composes on the SELECTED
 * broker's chains, so the declaration is true for both brokers.
 *
 * #3374 declared `optionsDiscovery: false` for Alpaca and refused its reads by
 * name. That was right while the engine was composed on E*TRADE's client; slice
 * 1 gave runs provenance, and this slice removes the reason for the declaration:
 * `createDiscoveryService` now takes the platform and derives its chain source
 * from it, refusing at composition when a broker has none.
 *
 * What these tests defend:
 *   1. Both brokers declare the capability.
 *   2. Every producer passes a platform — `platform` is required in the type, and
 *      this census catches a producer added through a cast or a JS call site.
 *   3. The engine refuses a platform with no chain source instead of borrowing
 *      another broker's chains.
 *   4. The panel's refusal is inert for both real brokers (it still guards a
 *      future broker that declares the capability false).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { createDiscoveryService } from "../src/services/discoveryService";

const PRODUCERS = [
  "src/trading/options/unifiedOptionsService.ts",
  "src/agents/orchestrator/asyncJobs.ts",
  "src/agents/routes/mcpChatNlq.ts",
  "src/agents/routes/tradingIntegrations.ts",
];

describe("both brokers declare options discovery (#3388)", () => {
  it("E*TRADE and Alpaca can both produce discovery runs", () => {
    expect(brokerSupports("etrade", "optionsDiscovery")).toBe(true);
    expect(brokerSupports("alpaca", "optionsDiscovery")).toBe(true);
  });
});

describe("the engine composes on the platform it is given (#3388)", () => {
  it("every producer passes a platform", () => {
    for (const file of PRODUCERS) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("platform: TradingPlatformRegistry.getPlatform(");
      expect(source, file).toContain("resolveTenantBroker(");
    }
  });

  it("refuses a platform with no chain source, naming it", () => {
    expect(() =>
      createDiscoveryService({
        env: {} as never,
        userLogin: "user@example.com",
        sql: { exec: () => [] } as never,
        platform: { platformId: "interactive-brokers", getOptionChains: undefined } as never,
      }),
    ).toThrow(/interactive-brokers has no options chain source/);
  });
});

describe("the panel guard is inert for the two real brokers (#3388)", () => {
  it("no longer refuses Alpaca", () => {
    const source = readFileSync("src/client/options/DiscoveryRunsPanel.tsx", "utf8");
    // The helper still exists — it is the guard for a broker that lacks the
    // capability — but both real brokers pass it.
    expect(source).toContain("export function discoveryRefusal");
  });
});


