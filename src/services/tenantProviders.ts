/**
 * Per-tenant data-provider / broker selection (slice 1 of the
 * provider/broker agnosticism programme; design in
 * workspace/provider-broker-agnostic/design.md).
 *
 * Two independent selections, stored per-tenant in D1
 * agent_tenant_settings (migration 0027), server-resolved via
 * resolveIaaaTenant, never from a client value:
 *   dataProviderId: one of DATA_PROVIDER_IDS (etrade, public,
 *     yahoo, nasdaq, alpaca)
 *   brokerId: "etrade" | "alpaca" | "public" — the brokers with a
 *     route implementation in this build (public since #3990).
 * Defaults are alpaca (data provider, #3990) / the platform default
 * broker (DEFAULT_TENANT_PROVIDERS.brokerId, commercialPorts.ts)
 * — issue #3812, owner rule on #3451; issue #3937 (user decision
 * 2026-11-10) makes that ONE default global: every surface resolves
 * the selected broker the same way, and a store failure fails open
 * to the platform default broker for broker-handler reads
 * (a store outage must not take down the surface that worked
 * before); the settings route itself fails closed with 503 when
 * unbound, following the auto-refresh route.
 * No silent fallback: a caller that needs a capability a
 * selected provider/broker does not declare must report the
 * coded unavailable outcome, never substitute E*TRADE.
 */
import { DATA_PROVIDER_IDS } from "../trading";
import type { TenantProviders } from "../data/commercialPorts";
import { DEFAULT_TENANT_PROVIDERS } from "../data/commercialPorts";
import { codedMessage } from "../outcomes/outcomeAspects";

export const BROKER_IDS = ["etrade", "alpaca", "public"] as const;
export type BrokerId = (typeof BROKER_IDS)[number];

/**
 * Issue #3751: the ONE provider-identity map — the home of record
 * for how a provider/broker is NAMED in UX text and messages.
 * Display name only (short name / docs URL were deferred by the
 * 2026-11-09 ruling: no consumer exists for them yet). Identity
 * is configuration, not literals: surfaces resolve names from
 * here (server) or from the identity this map produces on the
 * tenant-providers route (client), never from a local copy.
 * The names agree with the registry adapters' `name` fields and
 * BROKER_CATALOG's labels, with ONE documented divergence: the
 * alpaca adapter's registry name is "Alpaca Markets" while the
 * tenant-facing display name is "Alpaca" (both pinned as-is).
 */
export interface ProviderIdentity {
  readonly id: string;
  readonly displayName: string;
}

export const DATA_PROVIDER_IDENTITIES: Readonly<Record<string, ProviderIdentity>> = {
  etrade: { id: "etrade", displayName: "E*TRADE" },
  public: { id: "public", displayName: "Public.com" },
  yahoo: { id: "yahoo", displayName: "Yahoo Finance" },
  nasdaq: { id: "nasdaq", displayName: "Nasdaq Listings" },
  alpaca: { id: "alpaca", displayName: "Alpaca" },
};

export const BROKER_IDENTITIES: Readonly<Record<string, ProviderIdentity>> = {
  etrade: { id: "etrade", displayName: "E*TRADE" },
  alpaca: { id: "alpaca", displayName: "Alpaca" },
  public: { id: "public", displayName: "Public.com" },
};

/** Identity for a data-provider id; undefined for an unknown id (never a guessed brand). */
export function dataProviderIdentity(id: string): ProviderIdentity | undefined {
  return DATA_PROVIDER_IDENTITIES[id];
}

/** Identity for a broker id; undefined for an unknown id (never a guessed brand). */
export function brokerIdentity(id: string): ProviderIdentity | undefined {
  return BROKER_IDENTITIES[id];
}

function displayNamesOf(identities: Readonly<Record<string, ProviderIdentity>>): Record<string, string> {
  const names: Record<string, string> = {};
  for (const identity of Object.values(identities)) names[identity.id] = identity.displayName;
  return names;
}

/** Derived projection of DATA_PROVIDER_IDENTITIES (kept for existing consumers). */
export const DATA_PROVIDER_DISPLAY_NAMES: Record<string, string> = displayNamesOf(DATA_PROVIDER_IDENTITIES);

/** Derived projection of BROKER_IDENTITIES (kept for existing consumers). */
export const BROKER_DISPLAY_NAMES: Record<string, string> = displayNamesOf(BROKER_IDENTITIES);

export function isDataProviderId(value: unknown): value is string {
  return typeof value === "string" && (DATA_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isBrokerId(value: unknown): value is BrokerId {
  return typeof value === "string" && (BROKER_IDS as readonly string[]).includes(value);
}

export function normalizeTenantProviders(input: {
  dataProviderId?: unknown;
  brokerId?: unknown;
}): TenantProviders | null {
  if (!isDataProviderId(input.dataProviderId) || !isBrokerId(input.brokerId)) return null;
  return { dataProviderId: input.dataProviderId, brokerId: input.brokerId };
}

/** Server-side resolution for route handlers. Never throws. */
export async function resolveTenantProviders(env: unknown): Promise<TenantProviders> {
  try {
    const { createCommercialAdapter } = await import("../data/createCommercialPorts");
    const adapter = createCommercialAdapter(env as { AGENT_DB?: unknown });
    if (!adapter) return { ...DEFAULT_TENANT_PROVIDERS };
    const { resolveIaaaTenant } = await import("../security/iaaaGithubEndToEnd");
    const tenantId = resolveIaaaTenant(env as never);
    return await adapter.getTenantProviders(tenantId);
  } catch {
    return { ...DEFAULT_TENANT_PROVIDERS };
  }
}

/**
 * Issue #3812: the PRESENCE-AWARE selection — the stored broker, or the
 * explicit env override, or null when the tenant has selected nothing.
 * Callers that hand the provider to a downstream resolver (the
 * TradingAgent) use this so the downstream default applies to an absent
 * selection, instead of a platform default being forced into a call the
 * caller never made. A read failure is null (not a guessed broker).
 */
export async function resolveTenantBrokerSelection(env: unknown): Promise<BrokerId | null> {
  const envOverride =
    (env as Record<string, unknown> | null | undefined)?.TENANT_BROKER_ID ??
    (env as Record<string, unknown> | null | undefined)?.BROKER_ID;
  if (isBrokerId(envOverride)) return envOverride;
  try {
    const { createCommercialAdapter } = await import("../data/createCommercialPorts");
    const adapter = createCommercialAdapter(env as { AGENT_DB?: unknown });
    if (!adapter) return null;
    const { resolveIaaaTenant } = await import("../security/iaaaGithubEndToEnd");
    const stored = await adapter.getTenantBrokerSelection(resolveIaaaTenant(env as never));
    return isBrokerId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The concrete broker for any surface that needs one. Issue #3937
 * (user decision 2026-11-10) makes the platform default GLOBAL:
 * there is ONE "no selection" default — the platform default broker
 * (alpaca, in paper mode per #3451/#3857) — and every surface
 * (neutral routes, legacy E*TRADE surfaces, email, Slack, voice,
 * the E*TRADE options routes, the copilot resolver, the panels)
 * resolves the selected broker through this function, so they can
 * never disagree about which broker is selected again. A stored
 * selection always wins; an env override wins over the store
 * (resolveTenantBrokerSelection). This replaces the pre-#3937 legacy
 * etrade fallback (#3812), which kept TWO defaults deliberately so
 * legacy surfaces would not start calling Alpaca without a
 * credential. That rationale is answered by the named refusal: a
 * broker without a credential fails loudly with a coded outcome
 * (FAILURE_BROKER_UNAVAILABLE / the adapter's credential error),
 * never by substituting another broker's data. A read failure is
 * also the platform default: these surfaces already fail loudly
 * when the broker is unreachable.
 */
export async function resolveTenantBroker(env: unknown): Promise<BrokerId> {
  const stored = await resolveTenantBrokerSelection(env);
  // The default is declared as a plain string (TenantProviders is built
  // from DB rows), so the same guard as the stored selection applies:
  // a default that is not a known broker id falls back to the platform default.
  const fallback = DEFAULT_TENANT_PROVIDERS.brokerId;
  return stored ?? (isBrokerId(fallback) ? fallback : "alpaca");
}

/** Coded response for a broker surface the selected broker does not
 * implement. Never an E*TRADE error, never a silent fallback. */
export function brokerUnavailableResponse(brokerId: string): Response {
  return Response.json(
    { code: "FAILURE_BROKER_UNAVAILABLE", message: codedMessage("FAILURE_BROKER_UNAVAILABLE"), retryable: false, selectedBroker: brokerId },
    { status: 409 },
  );
}

/** Issue #3460 slice 3: the broker gate's named refusal when the
 * tenant broker selection cannot be read at all (no store bound, or
 * the store read failed). The gate cannot verify the tenant's broker,
 * so it fails closed with 503 instead of failing open to E*TRADE. */
export function brokerStoreUnavailableResponse(): Response {
  return Response.json(
    {
      code: "FAILURE_BROKER_STORE_UNAVAILABLE",
      message:
        "Broker selection store unavailable: the broker gate cannot verify the tenant's broker. Retry later; nothing was served from a default broker.",
      retryable: false,
    },
    { status: 503 },
  );
}
