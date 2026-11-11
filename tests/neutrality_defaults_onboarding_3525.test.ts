/**
 * Issue #3525 S3 — broker/provider neutrality, defaults & onboarding.
 *
 * Pins:
 * - FirstRunScreen's connect step renders the SELECTED broker's catalogue
 *   label (the #3371 decision's label) instead of hardcoding one brand in
 *   its user-facing strings; the E*TRADE OAuth wiring underneath is
 *   integration and stays.
 * - StockHub's initial screening-provider selection resolves from the
 *   tenant's configured data provider (registry id -> hub variant id)
 *   instead of assuming "etrade"; a tenant provider with no hub variant
 *   falls back to the first available variant.
 * - Deferred defaults are pinned UNCHANGED: the tenant-providers
 *   fail-to-legacy fallback (a documented safety contract), the order
 *   ticket's E*TRADE preview copy (it names the broker that actually
 *   previews/submits — provenance, and its wiring is E*TRADE-only), and
 *   the data-bearing saved-trades localStorage key.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  getScreeningProviders,
  resolveInitialScreeningProviderId,
} from "../src/client/screeningAdapters";
import { firstRunBrokerStep } from "../src/client/firstRunBrokerStep";
import { DEFAULT_TENANT_PROVIDERS_STATE } from "../src/client/tenantProviders";

const read = (p: string) => readFileSync(p, "utf8");

describe("neutrality S3 — first-run connect step names the selected broker", () => {
  const src = read("src/client/FirstRunScreen.tsx");
  it("connect button and copy render the catalogue label, not a hardcoded brand", () => {
    expect(src).toContain("Connect {brokerStep.label}");
    expect(src).toContain("{brokerStep.label} account is connected");
    expect(src).not.toMatch(/>\s*Connect E\*TRADE\s*</);
    expect(src).not.toContain("E*TRADE account is connected.");
  });
  it("the label the wizard renders is the catalogue label for the decided broker (decision passthrough)", () => {
    const oauth = firstRunBrokerStep({ broker: "etrade", label: "E*TRADE", credentialKind: "oauth" });
    expect(oauth.label).toBe("E*TRADE");
    expect(oauth.connectsInWizard).toBe(true);
    const keyPair = firstRunBrokerStep({ broker: "alpaca", label: "Alpaca", credentialKind: "api_key_pair" });
    expect(keyPair.label).toBe("Alpaca");
    expect(keyPair.connectsInWizard).toBe(false);
  });
  it("E*TRADE OAuth integration wiring is untouched (status poll + OAuth start)", () => {
    expect(src).toContain("fetchETradeStatus()");
    expect(src).toContain("startETradeOAuth()");
  });
});

describe("neutrality S3 — StockHub default follows the tenant's configured provider", () => {
  const variants = getScreeningProviders("stocks");
  it("the hub offers the expected stock variants", () => {
    expect(variants.map((v) => v.id)).toEqual(["etrade", "yahoo-finance", "selected-broker"]);
  });
  it("tenant etrade resolves to the etrade variant (unchanged for the default tenant)", () => {
    expect(resolveInitialScreeningProviderId("etrade", variants)).toBe("etrade");
  });
  it("tenant yahoo resolves to the yahoo-finance variant (registry id -> variant id)", () => {
    expect(resolveInitialScreeningProviderId("yahoo", variants)).toBe("yahoo-finance");
  });
  it("a tenant provider with no hub variant falls back to the first variant", () => {
    expect(resolveInitialScreeningProviderId("alpaca", variants)).toBe("etrade");
    expect(resolveInitialScreeningProviderId("nasdaq", variants)).toBe("etrade");
    expect(resolveInitialScreeningProviderId("", variants)).toBe("etrade");
  });
  it("no variants resolves to the empty selection the correction effect already handles", () => {
    expect(resolveInitialScreeningProviderId("etrade", [])).toBe("");
  });
  it("StockHub wires the resolver to the tenant state instead of a hardcoded brand", () => {
    const src = read("src/client/StockHub.tsx");
    expect(src).toContain("resolveInitialScreeningProviderId(readTenantProvidersState().dataProviderId, providers)");
    expect(src).not.toContain('useState("etrade")');
  });
});

describe("neutrality S3 — deferred defaults pinned", () => {
  it("tenant-providers default broker is Alpaca in paper mode (#3812); the data provider is Alpaca too (#3990)", () => {
    // Issue #3812 (owner rule on #3451): the platform default broker is
    // Alpaca; paper is the mode default (TEST), so no stored selection
    // means Alpaca in paper mode on every surface, including this mirror.
    // Issue #3990: the data default is Alpaca as well (one provider on
    // both axes; the reason is on the server default).
    expect(DEFAULT_TENANT_PROVIDERS_STATE).toEqual({ dataProviderId: "alpaca", brokerId: "alpaca" });
  });
  it("order ticket copy names the selected broker (provenance, #3669)", () => {
    const src = read("src/client/OrderTicketPanel.tsx");
    expect(src).toContain("Request {brokerLabel}’s preview");
  });
  it("data-bearing saved-trades localStorage key is unchanged", () => {
    const src = read("src/client/options/StrategyDiscoveryPanel.tsx");
    expect(src).toContain('"etrade_saved_options_trades"');
  });
});
