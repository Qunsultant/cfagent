/**
 * Issue #4014 — options chains are served by a capable provider, and the
 * substitution is named.
 *
 * The PMCC incident: the tenant's data provider was Alpaca (no optionsChains
 * capability), so every live-chain options route refused and the copilot had
 * no chain to price against — even though E*TRADE, a capable provider, was
 * enabled. Chains are now served by a capable provider and the run record
 * carries `requestedDataProviderId`, so nothing is labelled with a provider
 * that did not serve it.
 */
import { describe, it, expect } from "vitest";
import {
  optionsChainsServingProvider,
  optionsFeedProviderStamp,
} from "../src/services/optionsProviderContext";

describe("Issue #4014 — options chain serving provider", () => {
  it("serves the selected provider untouched when it declares optionsChains", () => {
    for (const id of ["etrade", "public"]) {
      const serving = optionsChainsServingProvider(id);
      expect(serving).toEqual({
        servingProviderId: id,
        requestedDataProviderId: id,
        substituted: false,
      });
      expect(optionsFeedProviderStamp({ dataProviderId: id, brokerId: "alpaca" })).toEqual({
        dataProviderId: id,
        brokerId: "alpaca",
      });
    }
  });

  it("serves from a capable provider and keeps the selection visible otherwise", () => {
    for (const id of ["yahoo", "alpaca", "nasdaq", "bogus"]) {
      expect(optionsChainsServingProvider(id)).toEqual({
        servingProviderId: "etrade",
        requestedDataProviderId: id,
        substituted: true,
      });
      expect(optionsFeedProviderStamp({ dataProviderId: id, brokerId: "alpaca" })).toEqual({
        dataProviderId: "etrade",
        brokerId: "alpaca",
        requestedDataProviderId: id,
      });
    }
  });
});
