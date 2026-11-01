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
 *   brokerId: "etrade" | "alpaca" — the only brokers with a
 *     route implementation in this build.
 * Defaults are etrade / etrade, preserving the pre-existing
 * behaviour exactly. A store failure fails open to etrade /
 * etrade for broker-handler reads (a store outage must not
 * take down the surface that worked before); the settings
 * route itself fails closed with 503 when unbound, following
 * the auto-refresh route.
 * No silent fallback: a caller that needs a capability a
 * selected provider/broker does not declare must report the
 * coded unavailable outcome, never substitute E*TRADE.
 */
import { DATA_PROVIDER_IDS } from "../trading";
import type { TenantProviders } from "../data/commercialPorts";
import { DEFAULT_TENANT_PROVIDERS } from "../data/commercialPorts";
import { codedMessage } from "../outcomes/outcomeAspects";

export const BROKER_IDS = ["etrade", "alpaca"] as const;
export type BrokerId = (typeof BROKER_IDS)[number];

export const DATA_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  etrade: "E*TRADE",
  public: "Public.com",
  yahoo: "Yahoo Finance",
  nasdaq: "Nasdaq Listings",
  alpaca: "Alpaca",
};

export const BROKER_DISPLAY_NAMES: Record<string, string> = {
  etrade: "E*TRADE",
  alpaca: "Alpaca",
};

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

export async function resolveTenantBroker(env: unknown): Promise<BrokerId> {
  const providers = await resolveTenantProviders(env);
  return isBrokerId(providers.brokerId) ? providers.brokerId : "etrade";
}

/** Coded response for a broker surface the selected broker does not
 * implement. Never an E*TRADE error, never a silent fallback. */
export function brokerUnavailableResponse(brokerId: string): Response {
  return Response.json(
    { code: "FAILURE_BROKER_UNAVAILABLE", message: codedMessage("FAILURE_BROKER_UNAVAILABLE"), retryable: false, selectedBroker: brokerId },
    { status: 409 },
  );
}
