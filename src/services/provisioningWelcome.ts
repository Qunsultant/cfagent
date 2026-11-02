/**
 * Issue #2661 (monetization Phase 2.6) — welcome trigger on provisioning.
 *
 * The slice 2.4 welcome route (POST /payments/agentic/commercial/
 * lifecycle/welcome) is the trigger surface "until an email-bearing
 * provisioning path exists" — no provisioning path carried a grantee
 * email. This module IS that path's send side: after a successful
 * membership grant that captured a grantee email, the grant route
 * calls this helper best-effort. It never throws and never fails
 * the grant: a missing transport, an unreadable tier store, or a
 * failed send is reported as { sent: false, reason }, exactly like
 * the welcome route's own contract (best-effort about the SEND;
 * tier selection never guesses — an unreadable tier store skips
 * the send with "tier-unavailable" instead of sending on an
 * unknown tier, per #2522).
 *
 * Sender selection reuses the existing delivery paths (cfpay A2A
 * email first, env.EMAIL fallback — the research-delivery pattern);
 * this module invents no transport. Tier resolution mirrors the
 * welcome route: unbound stores read as Free (no rows can exist
 * without a store); present-but-failing stores throw, and the
 * caller maps that to "tier-unavailable".
 *
 * On a successful send with a tenant, the address is recorded via
 * setSubscriberEmail (same as the welcome route) so the scheduled
 * digest pass can reach this subscriber; persistence never changes
 * the send result. Digest sends themselves stay opt-in-gated, so
 * recording the address alone never causes mail.
 */

import { cfpaySendEmail, getCfpayConfig } from "./cfpayA2A";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../data/createCommercialPorts";
import {
  createSubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../data/createSubscriptionPorts";
import { resolveEffectiveTier } from "../data/subscriptionPorts";
import type { StoreTier } from "../data/commercialPorts";
import {
  createLifecycleAdapter,
  ensureLifecycleSchema,
} from "../data/createLifecyclePorts";
import { sendWelcomeBestEffort, type EmailSender } from "./lifecycleEmail";

export interface ProvisioningWelcomeResult {
  /** A send was attempted (sender present and tier resolved). */
  attempted: boolean;
  sent: boolean;
  reason?: string;
}

type UnknownEnv = Record<string, unknown>;

function buildSender(env: UnknownEnv): EmailSender | null {
  const cfpay = getCfpayConfig(env);
  if (cfpay) {
    return {
      send: async ({ to, subject, body }) => {
        const r = await cfpaySendEmail(cfpay, to, subject, body);
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? "cfpay email failed" };
      },
    };
  }
  const emailBinding = env["EMAIL"] as
    | { send?: (input: { from: string; to: string; subject: string; text: string }) => Promise<unknown> }
    | undefined;
  if (emailBinding && typeof emailBinding.send === "function") {
    const localSend = emailBinding.send;
    return {
      send: async ({ to, subject, body }) => {
        try {
          await localSend({ from: "noreply", to, subject, text: body });
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "email send failed" };
        }
      },
    };
  }
  return null;
}

async function resolveTier(env: UnknownEnv, userId: string): Promise<StoreTier> {
  const store = createCommercialAdapter(env as { AGENT_DB?: unknown });
  const subs = createSubscriptionAdapter(env as { AGENT_DB?: unknown });
  if (!store || !subs) return "Free";
  await ensureCommercialSchema(store.db);
  await ensureSubscriptionSchema(subs.db);
  const account = await store.getAccount(userId);
  const subscriptions = await subs.listSubscriptions(userId);
  return resolveEffectiveTier(account, subscriptions, Date.now());
}

/**
 * Best-effort welcome send for a newly provisioned principal.
 * Never throws: every failure mode is a { sent: false, reason }.
 */
export async function sendProvisioningWelcome(
  env: unknown,
  input: { userId: string; email: string; tenantId?: string },
): Promise<ProvisioningWelcomeResult> {
  try {
    const envRecord = env as UnknownEnv;
    const sender = buildSender(envRecord);
    if (!sender) {
      return { attempted: false, sent: false, reason: "no-email-transport" };
    }
    let tier: StoreTier;
    try {
      tier = await resolveTier(envRecord, input.userId);
    } catch {
      return { attempted: false, sent: false, reason: "tier-unavailable" };
    }
    const lifecycle = createLifecycleAdapter(env as { AGENT_DB?: unknown });
    let preferences;
    if (lifecycle && input.tenantId) {
      try {
        await ensureLifecycleSchema(lifecycle.db);
        preferences = await lifecycle.getPreferences(input.userId, input.tenantId);
      } catch {
        preferences = undefined;
      }
    }
    const result = await sendWelcomeBestEffort({
      sender,
      email: input.email,
      userId: input.userId,
      preferences,
      tier,
    });
    if (result.sent && lifecycle && input.tenantId) {
      await lifecycle.setSubscriberEmail(input.userId, input.tenantId, input.email).catch(() => {});
    }
    return { attempted: true, sent: result.sent, reason: result.reason };
  } catch {
    return { attempted: true, sent: false, reason: "send-failed" };
  }
}
