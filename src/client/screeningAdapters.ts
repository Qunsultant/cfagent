/**
 * Client screening adapters — DERIVED from the one server registry
 * (consolidation C1, issue #1201, epic #1151 R2).
 *
 * Before C1 this module hand-mirrored the server provider registry
 * (src/trading/screeningProvider.ts) with its own SCREENING_PROVIDERS
 * list — two sources describing the same providers, free to drift.
 * The provider list below is now derived from the server registry's
 * descriptor table (SCREENING_PROVIDER_DESCRIPTORS, imported through
 * the trading barrel — the #290 boundary surface): each client entry
 * is one endpoint variant of a registry provider, and carries the
 * registry provider id as provenance. A drift pin
 * (tests/consolidation_c1_execution_path.test.ts) fails if this module
 * declares provider endpoints by hand again.
 *
 * What stays client-owned: the hub's asset-class taxonomy
 * (SCREENING_ASSET_CLASSES) — presentation, not a provider registry —
 * and the pure helper functions over the derived list.
 */
import {
  SCREENING_PROVIDER_DESCRIPTORS,
  type ScreeningFilter,
} from "../trading";

export type { ScreeningFilter };

export type ScreeningAssetClass = "stocks" | "options" | "forex" | "futures" | "commodities" | "bonds";

export interface ScreeningProviderAdapter {
  id: string;
  label: string;
  kind: "broker-api" | "market-data-api" | "mcp";
  /** The server registry provider this entry is a variant of (C1 provenance). */
  registryProviderId: string;
  assetClasses: ScreeningAssetClass[];
  endpointByAssetClass: Partial<Record<ScreeningAssetClass, string>>;
  filtersByAssetClass: Partial<Record<ScreeningAssetClass, ScreeningFilter[]>>;
}

export const SCREENING_PROVIDERS: ScreeningProviderAdapter[] =
  SCREENING_PROVIDER_DESCRIPTORS.flatMap((descriptor) =>
    Object.entries(descriptor.clientEndpoints).flatMap(([assetClass, variants]) =>
      (variants ?? []).map((variant) => ({
        id: variant.id,
        label: variant.label,
        kind: variant.kind,
        registryProviderId: descriptor.id,
        assetClasses: [assetClass as ScreeningAssetClass],
        endpointByAssetClass: { [assetClass]: variant.endpoint },
        filtersByAssetClass: { [assetClass]: [...variant.filters] },
      }))
    )
  );

export const SCREENING_ASSET_CLASSES: Array<{
  id: ScreeningAssetClass;
  label: string;
  available: boolean;
}> = [
  { id: "stocks", label: "Stocks", available: true },
  // S8 (consolidation #958): options screening is hosted in the hub
  // (the OptionsResearchHost surface) — available, not PLANNED. It
  // has no provider adapter (it is not a provider screen), so
  // getScreeningProviders("options") stays empty by design — now by
  // derivation from the server descriptor table (C1): the options
  // provider declares no client endpoint variants.
  { id: "options", label: "Options", available: true },
  { id: "forex", label: "Forex", available: false },
  { id: "futures", label: "Futures", available: false },
  { id: "commodities", label: "Commodities", available: false },
  { id: "bonds", label: "Bonds", available: false },
];

export function getScreeningProviders(assetClass: ScreeningAssetClass): ScreeningProviderAdapter[] {
  return SCREENING_PROVIDERS.filter((provider) => provider.assetClasses.includes(assetClass));
}

/**
 * Issue #3525 S3 — the Stock Hub's initial screening-provider selection
 * follows the tenant's configured data provider instead of assuming one
 * brand. Tenant data-provider ids are registry ids (`yahoo`), while the
 * hub's selector variants carry their own ids (`yahoo-finance`); this
 * table is the only place that translation lives.
 *
 * Issue #4430 (S1a) — a tenant provider with no hub variant must NOT
 * fall back to the first available variant: that silent substitution
 * resolved to the E*TRADE endpoint for tenants whose configured broker
 * is not E*TRADE, and the broker gate refused the run with 409
 * FAILURE_BROKER_UNAVAILABLE. The resolver now returns "" (no
 * selection) for a provider with no hub variant, and the hub blocks
 * the run with the coded NO_SCREENING_PROVIDER_FOR_TENANT message
 * instead of posting anywhere. The selection is tenant-resolved only:
 * no broker, provider, or variant is ever substituted as a default —
 * not even the workflow-backed variant. The user may still choose it
 * explicitly (see YAHOO_FINANCE_VARIANT_ID), but it is never a default.
 */
const TENANT_PROVIDER_TO_VARIANT_ID: Readonly<Record<string, string>> = {
  etrade: "etrade",
  yahoo: "yahoo-finance",
};

/** Coded block when no hub variant exists for the tenant's configured provider (#4430). */
export const NO_SCREENING_PROVIDER_FOR_TENANT = "NO_SCREENING_PROVIDER_FOR_TENANT";

/**
 * The workflow-backed hub variant (#4430). This is the target of the
 * USER-INVOKED switch-to-Yahoo action after a broker-gate 409 (D2's
 * Yahoo testing option) — never a default: no resolver path returns
 * it unless the user chose it.
 */
export const YAHOO_FINANCE_VARIANT_ID = "yahoo-finance";

/**
 * Message for the coded no-provider block (#4430). Names the configured
 * data provider id as recorded — never a guessed brand — and states
 * that no screen was started.
 */
export function noScreeningProviderMessage(tenantDataProviderId: string): string {
  const configured = tenantDataProviderId ? `"${tenantDataProviderId}"` : "not configured";
  return (
    `${NO_SCREENING_PROVIDER_FOR_TENANT}: no screening provider is available for this tenant's ` +
    `configured data provider (${configured}). Choose a provider in Settings — no screen was started.`
  );
}

export function resolveInitialScreeningProviderId(
  tenantDataProviderId: string,
  providers: readonly ScreeningProviderAdapter[],
): string {
  if (providers.length === 0) return "";
  const mapped = TENANT_PROVIDER_TO_VARIANT_ID[tenantDataProviderId];
  if (mapped && providers.some((provider) => provider.id === mapped)) return mapped;
  if (providers.some((provider) => provider.id === tenantDataProviderId)) return tenantDataProviderId;
  // #4430: no hub variant for this tenant provider — no selection.
  // The hub blocks the run with NO_SCREENING_PROVIDER_FOR_TENANT
  // instead of silently falling back to the first variant.
  return "";
}

export function providerSupportsFilter(
  provider: ScreeningProviderAdapter | undefined,
  assetClass: ScreeningAssetClass,
  filter: ScreeningFilter,
): boolean {
  return provider?.filtersByAssetClass[assetClass]?.includes(filter) ?? false;
}
