import { describe, expect, it } from "vitest";
import {
  getScreeningProviders,
  providerSupportsFilter,
  SCREENING_ASSET_CLASSES,
  SCREENING_PROVIDERS,
} from "../src/client/screeningAdapters";

describe("provider- and asset-class screening adapters", () => {
  it("registers the current E*TRADE, Yahoo and neutral stock-screening routes", () => {
    // Issue #3272: the neutral route joins as a first-class stock provider,
    // so a tenant on another broker is no longer routed to an E*TRADE path.
    expect(getScreeningProviders("stocks").map(({ id }) => id)).toEqual([
      "etrade",
      "yahoo-finance",
      "selected-broker",
    ]);
    expect(SCREENING_PROVIDERS.find(({ id }) => id === "etrade")?.endpointByAssetClass.stocks)
      .toBe("/api/etrade/screen");
  });

  it("models unsupported and planned asset classes as unavailable rather than routing them to another provider", () => {
    // S8 adaptation (disclosed): options left the planned list — the
    // one screening hub (ScreenersHub) now hosts the options research
    // surface, so the asset class is available. It still has NO
    // provider adapter (it is not a provider screen), pinned below at
    // equal strength: the exact planned list plus options' empty
    // provider set are both asserted, as before.
    const planned = SCREENING_ASSET_CLASSES.filter(({ available }) => !available);
    expect(planned.map(({ id }) => id)).toEqual(["forex", "futures", "commodities", "bonds"]);
    for (const { id } of planned) expect(getScreeningProviders(id)).toEqual([]);
    expect(SCREENING_ASSET_CLASSES.find(({ id }) => id === "options")?.available).toBe(true);
    expect(getScreeningProviders("options")).toEqual([]);
  });

  it("only exposes a provider for an asset class it declares support for", () => {
    for (const provider of SCREENING_PROVIDERS) {
      for (const [assetClass, endpoint] of Object.entries(provider.endpointByAssetClass)) {
        expect(provider.assetClasses).toContain(assetClass);
        expect(endpoint).toMatch(/^\/api\//);
      }
    }
  });

  it("only advertises stock filters implemented by each provider", () => {
    const [etrade, yahoo] = getScreeningProviders("stocks");
    expect(providerSupportsFilter(etrade, "stocks", "price-range")).toBe(true);
    expect(providerSupportsFilter(yahoo, "stocks", "trend")).toBe(true);
    // Issue #1007 adaptation (disclosed): the Yahoo provider previously
    // ran a second engine supporting only search+trend; it now runs
    // the SAME pipeline as the E*TRADE provider (Yahoo as a data-source
    // adapter), so it implements — and advertises — the full stock
    // filter set. The assertions below pin that parity at equal
    // strength (every hub filter checked, not just two).
    for (const filter of ["search", "limit", "exchange", "price-range", "trend"] as const) {
      expect(providerSupportsFilter(yahoo, "stocks", filter)).toBe(true);
      expect(providerSupportsFilter(yahoo, "stocks", filter)).toBe(
        providerSupportsFilter(etrade, "stocks", filter)
      );
    }
  });
});
