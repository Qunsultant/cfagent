/**
 * Options Screener product programme slice 2 (issue #2598) — provider/broker
 * integration-point plumbing, consumption side. Pins:
 * - tenant resolution fails OPEN to etrade/etrade (legacy behaviour) and
 *   flags the fallback instead of silently relabelling the tenant;
 * - the module reuses slice 1's canonical ids and defaults (registry
 *   vocabulary + tenantProviders broker ids + DEFAULT_TENANT_PROVIDERS),
 *   never a second source of truth;
 * - E*TRADE broker surfaces show only for broker=etrade, never for alpaca;
 * - capability matrix matches the provider design §3 / adapters.ts:
 *   etrade + public declare optionsChains, yahoo / alpaca / nasdaq do not;
 * - capability-unavailable is coded (existing FAILURE_DATA_PROVIDER_UNAVAILABLE),
 *   never a silent fallback to another provider and never invented data;
 * - broker-unavailable names the real FAILURE_BROKER_UNAVAILABLE catalog
 *   code slice 1 registered (no pending-descriptor: that code is live);
 * - provenance stamping adds dataProviderId/brokerId and preserves every
 *   existing provenance field.
 * NOT pinned here (slice 1 owns them, not duplicated): D1 migration,
 * settings route, client selectors, broker-gate delegation, catalog entry.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_BROKER_ID,
  DEFAULT_DATA_PROVIDER_ID,
  brokerSurfaceUnavailable,
  dataCapabilityUnavailable,
  dataProviderSupportsCapability,
  resolveTenantProviderContext,
  showEtradeBrokerSurface,
  withProviderProvenance,
} from "../src/services/optionsProviderContext";
import { DATA_PROVIDER_IDS } from "../src/trading/dataProviders/contract";
import { BROKER_IDS } from "../src/services/tenantProviders";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";

describe("options product slice 2 provider context", () => {
  it("reuses slice 1's canonical ids and defaults, never a second copy", () => {
    expect(DEFAULT_DATA_PROVIDER_ID).toBe(DEFAULT_TENANT_PROVIDERS.dataProviderId);
    expect(DEFAULT_BROKER_ID).toBe(DEFAULT_TENANT_PROVIDERS.brokerId);
    expect([...DATA_PROVIDER_IDS].sort()).toEqual(["alpaca", "etrade", "nasdaq", "public", "yahoo"]);
    expect([...BROKER_IDS].sort()).toEqual(["alpaca", "etrade"]);
  });

  it("defaults to etrade/etrade and flags the fallback on absent input", () => {
    for (const input of [undefined, null, {}]) {
      const ctx = resolveTenantProviderContext(input as never);
      expect(ctx.dataProviderId).toBe(DEFAULT_DATA_PROVIDER_ID);
      expect(ctx.brokerId).toBe(DEFAULT_BROKER_ID);
      expect(ctx.dataProviderFellBack).toBe(true);
      expect(ctx.brokerFellBack).toBe(true);
    }
  });

  it("preserves explicit known selections without a fallback flag", () => {
    const ctx = resolveTenantProviderContext({ dataProviderId: "public", brokerId: "alpaca" });
    expect(ctx).toEqual({
      dataProviderId: "public",
      brokerId: "alpaca",
      dataProviderFellBack: false,
      brokerFellBack: false,
    });
  });

  it("falls back per field, not wholesale, on unknown values", () => {
    const ctx = resolveTenantProviderContext({ dataProviderId: "bogus-provider", brokerId: "alpaca" });
    expect(ctx.dataProviderId).toBe("etrade");
    expect(ctx.dataProviderFellBack).toBe(true);
    expect(ctx.brokerId).toBe("alpaca");
    expect(ctx.brokerFellBack).toBe(false);
  });

  it("shows E*TRADE broker surfaces only for broker=etrade", () => {
    expect(showEtradeBrokerSurface(resolveTenantProviderContext({ brokerId: "etrade" }))).toBe(true);
    expect(showEtradeBrokerSurface(resolveTenantProviderContext({ brokerId: "alpaca" }))).toBe(false);
    // A broker change never silently re-enables E*TRADE surfaces.
    expect(brokerSurfaceUnavailable(resolveTenantProviderContext({ brokerId: "alpaca" }), "AccountPanels")).toEqual({
      code: "FAILURE_BROKER_UNAVAILABLE",
      brokerId: "alpaca",
      surface: "AccountPanels",
    });
    expect(brokerSurfaceUnavailable(resolveTenantProviderContext({ brokerId: "etrade" }), "AccountPanels")).toBeNull();
  });

  it("names a broker code the single catalog actually resolves", () => {
    expect(resolveOutcome("FAILURE_BROKER_UNAVAILABLE").resolved).toBe(true);
    expect(resolveOutcome("FAILURE_DATA_PROVIDER_UNAVAILABLE").resolved).toBe(true);
  });

  it("declares optionsChains only for etrade and public", () => {
    expect(dataProviderSupportsCapability("etrade", "optionsChains")).toBe(true);
    expect(dataProviderSupportsCapability("public", "optionsChains")).toBe(true);
    for (const p of ["yahoo", "alpaca", "nasdaq"]) {
      expect(dataProviderSupportsCapability(p, "optionsChains")).toBe(false);
    }
    // Yahoo cannot fix options chains: it declares quotes/bars/fundamentals only.
    expect(dataProviderSupportsCapability("yahoo", "quotes")).toBe(true);
    expect(dataProviderSupportsCapability("yahoo", "historicalBars")).toBe(true);
    expect(dataProviderSupportsCapability("yahoo", "fundamentals")).toBe(true);
    expect(dataProviderSupportsCapability("nasdaq", "screenUniverse")).toBe(true);
    // News is declared by no adapter.
    for (const p of DATA_PROVIDER_IDS) {
      expect(dataProviderSupportsCapability(p, "news")).toBe(false);
    }
    // Unknown providers declare nothing: no invented capability.
    expect(dataProviderSupportsCapability("bogus", "quotes")).toBe(false);
    expect(dataProviderSupportsCapability("bogus", "optionsChains")).toBe(false);
  });

  it("returns the existing coded path, never a silent fallback, for missing capabilities", () => {
    expect(dataCapabilityUnavailable("yahoo", "optionsChains")).toEqual({
      code: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
      providerId: "yahoo",
      capability: "optionsChains",
    });
    expect(dataCapabilityUnavailable("etrade", "optionsChains")).toBeNull();
    expect(dataCapabilityUnavailable("bogus", "quotes")).toEqual({
      code: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
      providerId: "bogus",
      capability: "quotes",
    });
  });

  it("stamps provider/broker provenance while preserving existing fields", () => {
    const provenance = {
      executionMode: "online",
      syncAsync: "sync",
      interface: "ui",
      parallelism: "sequential",
      submittedVia: "ui — POST /trading/options/strategies",
      deliveredVia: null,
      trigger: "manual",
      strategyMode: "thesis",
    };
    const stamped = withProviderProvenance(
      provenance,
      resolveTenantProviderContext({ dataProviderId: "public", brokerId: "alpaca" }),
    );
    expect(stamped.dataProviderId).toBe("public");
    expect(stamped.brokerId).toBe("alpaca");
    for (const [k, v] of Object.entries(provenance)) {
      expect((stamped as Record<string, unknown>)[k]).toBe(v);
    }
    // Stamping never mutates the original provenance object.
    expect("dataProviderId" in provenance).toBe(false);
  });
});
