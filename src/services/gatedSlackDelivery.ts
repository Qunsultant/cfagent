/**
 * Issue #3177 (program #2218) — one gated Slack dispatch for the direct
 * publishers that bypassed the delivery funnels (#3169 remainder).
 *
 * Every direct `deliverScreenerToSlackA2A` call site routes through
 * `deliverGatedSlack`:
 *
 *  - Content deliveries and run-scoped failure notices pass the run
 *    owner's verified login: an explicitly disabled Slack for that
 *    login's tenant is refused with the typed error and the master
 *    sender is NEVER attempted; a null gate (unbound store, no account
 *    row, resolution failure) keeps prior behavior (fail-open, #3169).
 *  - System alerts (E*TRADE auth/reconnect) pass no login: the gate
 *    is never consulted, the alert keeps its exact text and dedupe,
 *    and only the transport is consolidated.
 *
 * The send itself always goes through the master sender
 * (`deliverScreenerToSlack`: A2A first, direct fallback), so a site
 * that used to send nothing when cfpay was unconfigured now falls
 * back to direct Slack instead of dropping the delivery silently.
 * Channel resolution lives here: explicit channel, then
 * SCREENER_SLACK_CHANNEL, then SLACK_CHANNEL. An undefined channel
 * passes through untouched so the direct leg's SLACK_CHANNEL_ID
 * fallback still applies.
 *
 * Failure policy is the callers' existing warn-and-continue: a gate
 * refusal is just another `{ ok: false, error }` — this helper never
 * throws for a refusal or a failed send, and a throwing gate
 * resolution is treated as a null gate (fail-open).
 */
import { channelDisabledError, resolveTenantChannelGate } from "./tenantChannelGate";
import { deliverScreenerToSlack, type ScreenerSlackDelivery } from "./screenerSlackDelivery";

export interface GatedSlackDelivery extends ScreenerSlackDelivery {
  /**
   * Verified login of the run owner. Omitted, blank, or null (system
   * alerts) means ungated: the gate is never consulted.
   */
  userLogin?: string | null;
}

export async function deliverGatedSlack(
  env: unknown,
  delivery: GatedSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const login = typeof delivery.userLogin === "string" ? delivery.userLogin.trim() : "";
  if (login) {
    let gate: Awaited<ReturnType<typeof resolveTenantChannelGate>> = null;
    try {
      gate = await resolveTenantChannelGate(env, login);
    } catch {
      // Fail-open (#3169 rule): a gate that cannot be resolved must
      // never drop a delivery. resolveTenantChannelGate already
      // returns null on failure; this guards the contract itself.
      gate = null;
    }
    if (gate && !gate.isEnabled("slack")) {
      return { ok: false, error: channelDisabledError("slack", gate.tenantId) };
    }
  }
  const e = env as Record<string, unknown>;
  const resolvedChannel =
    delivery.channel ||
    (typeof e.SCREENER_SLACK_CHANNEL === "string" ? e.SCREENER_SLACK_CHANNEL : undefined) ||
    (typeof e.SLACK_CHANNEL === "string" ? e.SLACK_CHANNEL : undefined);
  const sent = await deliverScreenerToSlack(env, {
    text: delivery.text,
    ...(resolvedChannel ? { channel: resolvedChannel } : {}),
    ...(delivery.pdf ? { pdf: delivery.pdf } : {}),
    ...(delivery.files ? { files: delivery.files } : {}),
  });
  // Normalize to the helper's contract: callers check ok/error only
  // (the funnel idiom); the transport method stays internal.
  return { ok: sent.ok, ...(sent.error ? { error: sent.error } : {}) };
}
