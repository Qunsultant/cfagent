/**
 * Issue #3169 (program #2218) — tenant delivery-channel gate.
 *
 * Pure gate + best-effort resolution. A tenant's channel
 * config decides, per channel, whether dispatch may proceed:
 *
 *  - An explicit operator disable refuses the channel at
 *    dispatch with a typed error; the sender is never
 *    attempted, and other channels still send.
 *  - Anything else permits: no row (all-enabled defaults),
 *    an enabled flag, or a channel with no push dispatch
 *    funnel (Copilot card, Docs — configuration only until a
 *    funnel exists for them).
 *
 * Resolution failure is NOT a refusal: when the store is
 * unbound, identity cannot be resolved, or the config cannot
 * be read, resolveTenantChannelGate returns null and the
 * caller keeps prior behavior. A refusal requires a
 * successfully-read explicit disable — delivery stays
 * best-effort (a store outage must not silently drop every
 * delivery, and must never fail the run).
 *
 * Session scoping always: the tenant comes from
 * resolvePlatformIdentity (the commercial account row for
 * the verified login), never from a client-supplied value.
 * A login with no account row has no tenant, so no gate.
 */
import { createCommercialAdapter } from "../data/createCommercialPorts";
import type { CommercialStore } from "../data/commercialPorts";
import { createSubscriptionAdapter } from "../data/createSubscriptionPorts";
import type { SubscriptionStore } from "../data/subscriptionPorts";
import { createTenantChannelAdapter } from "../data/createTenantChannelPorts";
import type { TenantChannelStore } from "../data/tenantChannelPorts";
import type { TenantChannelConfig, TenantChannelId } from "../data/tenantChannelPorts";
import { resolvePlatformIdentity } from "./platformIdentity";

/** The gate one dispatch call consults. */
export interface TenantChannelGate {
  tenantId: string;
  isEnabled(channel: TenantChannelId): boolean;
}

/** Build a gate from an already-read config. */
export function channelGateFromConfig(
  tenantId: string,
  config: TenantChannelConfig,
): TenantChannelGate {
  return {
    tenantId,
    isEnabled: (channel: TenantChannelId) => config[channel] === true,
  };
}

/** Typed refusal text for a disabled channel (one place, every funnel). */
export function channelDisabledError(channel: TenantChannelId, tenantId: string): string {
  return `Channel "${channel}" is disabled for tenant "${tenantId}" by tenant channel configuration.`;
}

/**
 * Map a push dispatch channel to the tenant channel it is
 * governed by. Voice is conversational, not a push transport,
 * so it maps to nothing and is never gated. Copilot card and
 * Docs never arrive here — no push funnel dispatches them.
 */
export function mapScreeningChannelToTenantChannel(
  channel: string,
): TenantChannelId | null {
  if (channel === "email" || channel === "slack" || channel === "webhook") return channel;
  return null;
}

/** Test seam / override for gate resolution (mirrors the route ctx idiom). */
export interface TenantChannelGateAdapters {
  commercial?: CommercialStore | null;
  subscriptions?: SubscriptionStore | null;
  channels?: TenantChannelStore | null;
}

/**
 * Resolve the gate for a verified login's tenant, or null when
 * no gate applies (unbound store, no account row / no tenant,
 * or any resolution failure — see the module header).
 */
export async function resolveTenantChannelGate(
  env: unknown,
  userLogin: string,
  adapters?: TenantChannelGateAdapters,
): Promise<TenantChannelGate | null> {
  try {
    const e = (env ?? {}) as { AGENT_DB?: unknown };
    const commercial = adapters?.commercial ?? createCommercialAdapter(e);
    const subscriptions = adapters?.subscriptions ?? createSubscriptionAdapter(e);
    const channels = adapters?.channels ?? createTenantChannelAdapter(e);
    if (!commercial || !subscriptions || !channels) return null;
    const identity = await resolvePlatformIdentity(
      { commercial, subscriptions },
      { userId: userLogin, nowMs: Date.now() },
    );
    if (!identity.tenantId) return null;
    const config = await channels.getTenantChannels(identity.tenantId);
    return channelGateFromConfig(identity.tenantId, config);
  } catch {
    return null;
  }
}
