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
 * Defaults are etrade (data provider) / the platform default
 * broker (DEFAULT_TENANT_PROVIDERS.brokerId, commercialPorts.ts)
 * — issue #3812, owner rule on #3451. A store failure fails open
 * to etrade / the platform default broker for broker-handler reads
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
 * The concrete broker for a legacy surface. Issue #3812 keeps TWO defaults,
 * deliberately:
 * - the PLATFORM default (settings row, dynamic menu, copilot, TradingAgent
 *   baseline) is Alpaca in paper mode — `resolveTenantProviders` and the
 *   copilot resolver apply it;
 * - a LEGACY E*TRADE surface (email, Slack, voice, the E*TRADE options
 *   routes) keeps its pre-#3812 fallback when the tenant has stored NO
 *   selection, so those flows do not start calling Alpaca without a
 *   credential. A stored selection always wins.
 * A read failure is also the legacy fallback: these surfaces already
 * fail loudly when the broker is unreachable.
 */
export async function resolveTenantBroker(env: unknown): Promise<BrokerId> {
  const stored = await resolveTenantBrokerSelection(env);
  return stored ?? "etrade";
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
