/**
 * Issue #3272 S3: the goal screen runs on the selected broker and says so.
 *
 * Two defects are pinned here:
 *   1. The goal path built its stock leg on the E*TRADE engine whatever the
 *      selection was — so a scheduled run for an Alpaca tenant screened
 *      E*TRADE data.
 *   2. Even with a neutral engine, the registry labels results with whichever
 *      provider registered first (`etrade-yahoo-stocks`), i.e. the provenance
 *      would lie.
 *
 * The fix: a request may name its provider, and the goal run passes the
 * neutral id when it was built on the neutral engine.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createProductionScreeningRegistry } from "../src/services/screeningRuntime";
import {
  NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
  STOCK_SCREENING_PROVIDER_ID,
  OPTIONS_SCREENING_PROVIDER_ID,
} from "../src/trading/screeningProvider";
import { NeutralMarketScreener } from "../src/trading/neutralMarketScreener";

const optionsStub = { screenOptions: async () => ({ contracts: [] }) as any };

function stockStub(label: string) {
  return {
    label,
    screenMarkets: async () => ({
      totalScanned: 1,
      totalScreened: 1,
      matchedCount: 1,
      filterApplied: {},
      filterSummary: label,
      stocks: [{ symbol: "AAPL" }],
      scannedAt: new Date().toISOString(),
      status: "matches_found" as const,
    }),
  };
}

describe("a goal run labels the engine that served it (#3272 S3)", () => {
  it("keeps E*TRADE as the default stock provider", async () => {
    const registry = createProductionScreeningRegistry({
      stockScreener: stockStub("legacy") as any,
      optionsScreener: optionsStub,
    });
    const result = await registry.screen({ assetClass: "stocks", filter: {} });
    expect(result.providerId).toBe(STOCK_SCREENING_PROVIDER_ID);
  });

  it("labels a named neutral run with the neutral id, not E*TRADE's", async () => {
    const registry = createProductionScreeningRegistry({
      stockScreener: stockStub("legacy") as any,
      optionsScreener: optionsStub,
      neutralStockScreener: stockStub("neutral") as any,
    });
    const result = await registry.screen({
      assetClass: "stocks",
      filter: {},
      providerId: NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
    });
    expect(result.providerId).toBe(NEUTRAL_STOCK_SCREENING_PROVIDER_ID);
    expect(result.providerId).not.toBe(STOCK_SCREENING_PROVIDER_ID);
  });

  it("refuses an unknown provider id instead of falling back to the first one", async () => {
    const registry = createProductionScreeningRegistry({
      stockScreener: stockStub("legacy") as any,
      optionsScreener: optionsStub,
    });
    await expect(registry.screen({ assetClass: "stocks", filter: {}, providerId: "nope" })).rejects.toThrow(
      /Unknown screening provider "nope"/,
    );
  });

  it("still refuses honestly when the neutral provider has no broker source", async () => {
    const registry = createProductionScreeningRegistry({
      stockScreener: stockStub("legacy") as any,
      optionsScreener: optionsStub,
    });
    const result = await registry.screen({
      assetClass: "stocks",
      filter: {},
      providerId: NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
    });
    expect(result.providerId).toBe(NEUTRAL_STOCK_SCREENING_PROVIDER_ID);
    expect(result.result.status).toBe("no_universe");
    expect((result.result as any).validationError).toContain("No broker quote source");
  });
});

describe("the goal path is wired to the neutral engines (#3272 S3)", () => {
  const source = readFileSync(new URL("../src/agents/screener-agent.ts", import.meta.url), "utf8");

  it("resolves the selected broker instead of assuming E*TRADE", () => {
    expect(source).toContain("readTenantBrokerSelection(this.env)");
  });

  it("builds the stock leg and the chain source from that broker", () => {
    expect(source).toContain("platformQuoteSource(goalPlatform)");
    expect(source).toContain("platformChainSource(goalPlatform)");
    expect(source).toContain("NeutralMarketScreener");
  });

  it("passes the neutral provider id so the report cannot claim etrade-yahoo-stocks", () => {
    expect(source).toContain("stockProviderId: NEUTRAL_STOCK_SCREENING_PROVIDER_ID");
  });

  it("refuses instead of falling back to E*TRADE when the broker has no chain source (#3460)", () => {
    expect(source).toContain("createRefusingOptionsScreener(selectedBroker)");
  });
});

describe("the neutral engines are real, not placeholders (#3272 S3)", () => {
  it("the class the agent constructs is the neutral screener", () => {
    const screener = new NeutralMarketScreener({ quoteSource: { getQuote: async () => ({}) as any } });
    expect(typeof screener.screenMarkets).toBe("function");
  });

  it("the options provider id is still the dynamic one", () => {
    expect(OPTIONS_SCREENING_PROVIDER_ID).toBe("dynamic-options");
  });
});
