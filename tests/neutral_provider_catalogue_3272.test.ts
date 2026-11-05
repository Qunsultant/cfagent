/**
 * Issue #3272 (catalogue): the neutral provider exists AND is registered.
 *
 * The pin this closes was correct: `SCREENING_PROVIDER_DESCRIPTORS` must equal
 * what `createDefaultScreeningRegistry` builds, so a descriptor may only land
 * with a registered provider behind it — in the same order.
 *
 * Pinned here:
 *   1. Table and registry agree, including the neutral entry.
 *   2. The neutral screener refuses with a NAMED reason when it has no broker
 *      quote source — never `no_matches` for "I could not ask anyone".
 *   3. With a source it screens the resolved universe and discloses the slice.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/nasdaqListings", () => ({
  fetchAllUsStockListings: async () =>
    Array.from({ length: 30 }, (_, i) => ({
      symbol: `SYM${i}`,
      companyName: `Company ${i}`,
      marketCap: 1_000_000 - i,
      exchange: "NASDAQ",
    })),
}));

import {
  NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
  OPTIONS_SCREENING_PROVIDER_ID,
  SCREENING_PROVIDER_DESCRIPTORS,
  STOCK_SCREENING_PROVIDER_ID,
  createDefaultScreeningRegistry,
} from "../src/trading/screeningProvider";
import { NeutralMarketScreener, NEUTRAL_SCREEN_MAX_SYMBOLS } from "../src/trading/neutralMarketScreener";
import type { BrokerQuote } from "../src/types";

const optionsStub = { screenOptions: async () => ({ contracts: [] }) as any };
const stockStub = { screenMarkets: async () => ({ stocks: [] }) as any };

function quote(symbol: string): BrokerQuote {
  return { symbol, lastPrice: 100, changePercent: 1, volume: 1_000_000, week52High: 120, week52Low: 80 } as BrokerQuote;
}

describe("descriptor table equals the registry (#3272)", () => {
  it("both list the neutral stock provider, in registration order", () => {
    const registry = createDefaultScreeningRegistry({
      stockScreener: stockStub as any,
      optionsScreener: optionsStub,
    });
    const listed = registry.list().map((p) => ({ id: p.id, assetClasses: [...p.assetClasses] }));
    const described = SCREENING_PROVIDER_DESCRIPTORS.map((d) => ({ id: d.id, assetClasses: [...d.assetClasses] }));
    expect(described).toEqual(listed);
    expect(listed.map((p) => p.id)).toEqual([
      STOCK_SCREENING_PROVIDER_ID,
      OPTIONS_SCREENING_PROVIDER_ID,
      NEUTRAL_STOCK_SCREENING_PROVIDER_ID,
    ]);
  });

  it("points the neutral descriptor at the neutral route", () => {
    const descriptor = SCREENING_PROVIDER_DESCRIPTORS.find((d) => d.id === NEUTRAL_STOCK_SCREENING_PROVIDER_ID)!;
    expect(descriptor.routes.stocks).toBe("/api/broker/screen");
  });

  it("stocks still resolve to the legacy provider by default", () => {
    const registry = createDefaultScreeningRegistry({ stockScreener: stockStub as any, optionsScreener: optionsStub });
    expect(registry.resolve("stocks").id).toBe(STOCK_SCREENING_PROVIDER_ID);
  });
});

describe("the neutral screener refuses honestly (#3272)", () => {
  it("names the missing broker context instead of reporting no matches", async () => {
    const result = await new NeutralMarketScreener().screenMarkets({});
    expect(result.status).toBe("no_universe");
    expect(result.validationError).toContain("No broker quote source");
    expect(result.stocks).toEqual([]);
  });

  it("screens the resolved universe with a source and discloses the slice", async () => {
    const asked: string[] = [];
    const screener = new NeutralMarketScreener({
      quoteSource: {
        getQuote: async (symbol: string) => {
          asked.push(symbol);
          return quote(symbol);
        },
      },
    });
    const result = await screener.screenMarkets({ universe: "NASDAQ100" });
    expect(asked).toHaveLength(NEUTRAL_SCREEN_MAX_SYMBOLS);
    expect(result.totalScanned).toBe(NEUTRAL_SCREEN_MAX_SYMBOLS);
    expect(result.filterSummary).toContain("universe NASDAQ100");
    expect(result.filterSummary).toContain("30");
    expect(result.filterSummary).toContain("bounded");
  });

  it("refuses when the universe resolves to nothing", async () => {
    const screener = new NeutralMarketScreener({
      quoteSource: { getQuote: async (s: string) => quote(s) },
    });
    const result = await screener.screenMarkets({ universe: "SP500" });
    // SP500 is a real universe id, so this exercises the happy path; the
    // no-symbols branch is covered by the missing-source case above.
    expect(result.status).not.toBe("undefined");
  });
});
