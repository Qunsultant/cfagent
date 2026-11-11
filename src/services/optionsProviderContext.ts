/**
 * Options Screener product programme slice 2 (issue #2598) — provider/broker
 * integration point, consumption side.
 *
 * This module is the pure plumbing the options surfaces consume: tenant
 * provider resolution with the provider design's fail-open fallback to
 * the platform defaults (#3812 for the broker, #3990 for the data
 * provider: alpaca / alpaca),
 * conditional surface gating points, a coded capability-unavailable
 * path, and provenance stamping of `dataProviderId`/`brokerId` onto a run
 * record's provenance object.
 *
 * It does NOT duplicate slice 1 (#2594 / PR #2597, merged on main as
 * 4c59daff): no D1 migration, no `GET/POST /api/tenant/settings/providers`
 * route, no client selectors, no broker-gate route, no catalog entry.
 * Provider ids come from the canonical registry vocabulary
 * (`src/trading/dataProviders/contract.ts`, imported here only via
 * the trading index, the sole public surface per the #290 boundary)
 * and broker ids from slice 1's
 * server module (`src/services/tenantProviders.ts`); the defaults are
 * slice 1's `DEFAULT_TENANT_PROVIDERS` values, pinned equal by test.
 * The outcome codes are resolved through the single outcome catalog
 * (`src/outcomes/outcomeAspects.ts`) by the gate, never redefined here:
 * `FAILURE_DATA_PROVIDER_UNAVAILABLE` already existed, and
 * `FAILURE_BROKER_UNAVAILABLE` landed with slice 1 — so unlike the
 * pre-merge slice-2 draft, `brokerSurfaceUnavailable` no longer carries
 * a `pendingCatalogEntry` descriptor; the code is real and resolvable.
 *
 * Capability matrix (provider design §3, grounded in
 * `src/trading/dataProviders/adapters.ts`, not wished): etrade and public
 * declare quotes + optionsChains; yahoo declares quotes + historicalBars +
 * fundamentals + news (#3932); nasdaq declares screenUniverse only;
 * alpaca declares quotes + historicalBars + optionsChains (#3990 — the
 * data adapter wires the repo's own Alpaca options read path) and does
 * NOT declare fundamentals (its getFundamentals throws — no live
 * source; ADR 0019: Yahoo covers fundamentals, never faked).
 * Yahoo options chains exist only through Yahoo's unofficial
 * v7/finance/options endpoint (cookie+crumb, ToS risk) and are NOT
 * wired — an explicit decision, not an oversight (#3990).
 * An unknown provider declares nothing: it never silently gains a capability
 * and never silently falls back to E*TRADE chains.
 *
 * The map below is a projection of the adapter declarations, not a
 * second source of truth: tests/data_provider_capabilities_3990.test.ts
 * constructs every adapter with defaults and asserts the map equals
 * the adapters' declared capabilities, capability by capability —
 * drift fails the test. Change the adapters; the map follows in the
 * same PR.
 *
 * Wiring (this slice, not the draft): the options feed gate
 * (`src/agents/routes/optionsProviderGate.ts`, delegated from
 * OrchestratorAgent immediately before the options delegation) enforces
 * the optionsChains capability on every live-chain options route; the
 * strategies/best-trade unified record already stamps provenance via
 * slice 1, and the contract-screen / unified canonical reports stamp
 * body.provenance in `src/agents/routes/etradeOptionsScreen.ts`.
 * The gate never substitutes another provider's feed: a tenant whose
 * selected provider lacks optionsChains gets the coded unavailable
 * response, and the E*TRADE-backed feed still serves etrade/public
 * selections — swapping that feed onto a registry-resolved adapter is a
 * later slice, because it would change strategy selection/content and
 * is deliberately out of this slice.
 */

import { DATA_PROVIDER_IDS, type DataProviderCapability } from "../trading";
import {
  BROKER_IDENTITIES,
  BROKER_IDS,
  DATA_PROVIDER_IDENTITIES,
  type BrokerId,
} from "./tenantProviders";
import { DEFAULT_TENANT_PROVIDERS } from "../data/commercialPorts";

// Issue #3812: the defaults are slice 1's values, derived — never a second
// hardcoded copy. The broker default is Alpaca in paper mode; the data
// provider default is Alpaca too since #3990 (one provider on both axes).
export const DEFAULT_DATA_PROVIDER_ID = DEFAULT_TENANT_PROVIDERS.dataProviderId;
export const DEFAULT_BROKER_ID = DEFAULT_TENANT_PROVIDERS.brokerId;

export type DataProviderId = (typeof DATA_PROVIDER_IDS)[number];
export type { BrokerId, DataProviderCapability };

const DATA_PROVIDER_CAPABILITIES: Record<DataProviderId, readonly DataProviderCapability[]> = {
  etrade: ["quotes", "optionsChains"],
  public: ["quotes", "optionsChains"],
  yahoo: ["quotes", "historicalBars", "fundamentals", "news"],
  nasdaq: ["screenUniverse"],
  alpaca: ["quotes", "historicalBars", "optionsChains"],
};

export interface TenantProviderContext {
  dataProviderId: DataProviderId;
  brokerId: BrokerId;
  /** True when the stored data-provider value was absent/unknown and the platform default was used. */
  dataProviderFellBack: boolean;
  /** True when the stored broker value was absent/unknown and the platform default was used. */
  brokerFellBack: boolean;
  /**
   * Issue #3751: the resolved data provider's display name, from the
   * one identity map in tenantProviders.ts. Resolved from the
   * RESOLVED id, so a fell-back field carries the default provider's
   * name — the defaults are real selections (#3812), and the
   * fellBack flag above keeps that visible rather than relabelling.
   */
  dataProviderDisplayName: string;
  /** Issue #3751: the resolved broker's display name (same rule as dataProviderDisplayName). */
  brokerDisplayName: string;
}

function normalizeId<T extends string>(value: unknown, known: readonly T[], fallback: T): { id: T; fellBack: boolean } {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if ((known as readonly string[]).includes(trimmed)) return { id: trimmed as T, fellBack: false };
  }
  return { id: fallback, fellBack: true };
}

/**
 * Resolve a tenant's provider/broker context from a stored settings row (or
 * its absence). Resolution fails OPEN to the platform defaults (#3812 for
 * the broker, #3990 for the data provider: alpaca / alpaca) — an absent row, a pre-migration
 * row, or a store read failure must not take down a surface that worked
 * before (provider design §1/§6).
 * This is resolution, not settings validation: the settings route itself
 * fails closed (503) when its store is unbound, per the auto-refresh pattern.
 * The `*FellBack` flags keep the fallback visible in provenance instead of
 * silently relabelling a tenant; the #3751 display names resolve from the
 * resolved ids through the one identity map, so a fell-back field names
 * the default provider whose data/brokerage the tenant actually gets.
 */
export function resolveTenantProviderContext(input?: {
  dataProviderId?: unknown;
  brokerId?: unknown;
} | null): TenantProviderContext {
  const data = normalizeId(input?.dataProviderId, DATA_PROVIDER_IDS, DEFAULT_DATA_PROVIDER_ID as DataProviderId);
  const broker = normalizeId(input?.brokerId, BROKER_IDS, DEFAULT_BROKER_ID as BrokerId);
  return {
    dataProviderId: data.id,
    brokerId: broker.id,
    dataProviderFellBack: data.fellBack,
    brokerFellBack: broker.fellBack,
    // The resolved ids are known ids by construction (normalizeId only
    // returns a vocabulary id or the default), so the identity lookup
    // cannot miss; the `?? id` guard keeps the type honest without ever
    // inventing a name for an unknown id.
    dataProviderDisplayName: DATA_PROVIDER_IDENTITIES[data.id]?.displayName ?? data.id,
    brokerDisplayName: BROKER_IDENTITIES[broker.id]?.displayName ?? broker.id,
  };
}

/** E*TRADE broker surfaces (trading hub, AccountPanels) render only for broker=etrade. */
export function showEtradeBrokerSurface(context: TenantProviderContext): boolean {
  return context.brokerId === "etrade";
}

/** Capability lookup over the declared matrix only. Unknown providers support nothing. */
export function dataProviderSupportsCapability(
  providerId: string,
  capability: DataProviderCapability,
): boolean {
  const caps = (DATA_PROVIDER_CAPABILITIES as Record<string, readonly DataProviderCapability[] | undefined>)[providerId];
  return caps !== undefined && caps.includes(capability);
}

/**
 * Issue #4014 — which provider actually serves an options chain.
 *
 * The capability matrix declares optionsChains for etrade/public only.
 * Refusing every chain read when the tenant's SELECTED provider lacks it left
 * the options screens (and the copilot) with no chain at all even though a
 * capable provider was enabled — the failure behind the PMCC incident.
 * Chains are served by a capable provider, and the substitution is NAMED:
 * `requestedDataProviderId` keeps the tenant's selection visible, so no chain
 * is ever labelled with a provider that did not serve it.
 */
export interface OptionsChainsServingProvider {
  servingProviderId: DataProviderId;
  requestedDataProviderId: string;
  substituted: boolean;
}

export function optionsChainsServingProvider(
  selectedDataProviderId: string,
): OptionsChainsServingProvider {
  if (dataProviderSupportsCapability(selectedDataProviderId, "optionsChains")) {
    return {
      servingProviderId: selectedDataProviderId as DataProviderId,
      requestedDataProviderId: selectedDataProviderId,
      substituted: false,
    };
  }
  return {
    servingProviderId: "etrade",
    requestedDataProviderId: selectedDataProviderId,
    substituted: true,
  };
}

/** Provenance fields for a chain-serving run record (#4014). */
export function optionsFeedProviderStamp(input: {
  dataProviderId: string;
  brokerId: string;
}): { dataProviderId: DataProviderId; brokerId: BrokerId; requestedDataProviderId?: string } {
  const serving = optionsChainsServingProvider(input.dataProviderId);
  return {
    dataProviderId: serving.servingProviderId,
    brokerId: input.brokerId as BrokerId,
    ...(serving.substituted ? { requestedDataProviderId: serving.requestedDataProviderId } : {}),
  };
}

export interface CapabilityUnavailable {
  /** Existing catalog code (already in src/outcomes/outcomeCatalog.json); never a new catalog. */
  code: "FAILURE_DATA_PROVIDER_UNAVAILABLE";
  providerId: string;
  capability: DataProviderCapability;
}

/**
 * Coded capability-unavailable path for data: returns null when the provider
 * declares the capability, otherwise the existing catalog code with the
 * provider and capability named. Never a silent fallback to another provider
 * and never invented data.
 */
export function dataCapabilityUnavailable(
  providerId: string,
  capability: DataProviderCapability,
): CapabilityUnavailable | null {
  if (dataProviderSupportsCapability(providerId, capability)) return null;
  return { code: "FAILURE_DATA_PROVIDER_UNAVAILABLE", providerId, capability };
}

export interface BrokerSurfaceUnavailable {
  /** Catalog code registered by slice 1 (#2594) in src/outcomes/outcomeCatalog.json. */
  code: "FAILURE_BROKER_UNAVAILABLE";
  brokerId: string;
  surface: string;
}

/**
 * Coded broker-unavailable path for broker surfaces: null when the selected
 * broker is etrade (the surface exists), otherwise the catalog code naming
 * the selected broker and the requested surface. The surface must render the
 * coded notice, never an E*TRADE error and never a silent fall-through.
 */
export function brokerSurfaceUnavailable(
  context: TenantProviderContext,
  surface: string,
): BrokerSurfaceUnavailable | null {
  if (context.brokerId === "etrade") return null;
  return { code: "FAILURE_BROKER_UNAVAILABLE", brokerId: context.brokerId, surface };
}

/**
 * Stamp provider/broker provenance onto a run record's provenance object
 * without touching any existing field. The unified record's provenance
 * (optionsServeRecord.ts `recordStrategyScreenRun`) carries executionMode,
 * syncAsync, interface, parallelism, submittedVia, deliveredVia, trigger,
 * scheduleId, goalId, asyncJobId, jobType, strategyMode — this helper only
 * adds `dataProviderId`/`brokerId` alongside them. The contract-screen and
 * unified canonical reports stamp the same two fields onto body.provenance,
 * which Run Details already reads as the provenance object.
 */
export function withProviderProvenance<T extends Record<string, unknown>>(
  provenance: T,
  context: TenantProviderContext,
): T & { dataProviderId: DataProviderId; brokerId: BrokerId } {
  return { ...provenance, dataProviderId: context.dataProviderId, brokerId: context.brokerId };
}
