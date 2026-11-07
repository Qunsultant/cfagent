/**
 * Issue #2208 (advances #2021; source #1076 A1–A3) — lifecycle
 * email service.
 *
 * Content is lifecycle/transactional ONLY: no marketing claims,
 * no price promises, no ads. Delivery transport is injected
 * (EmailSender): routes build it from the existing paths (cfpay
 * A2A email first, env.EMAIL fallback — the research-delivery
 * pattern), this module invents no transport.
 *
 * Rules, from #1076:
 * - A1 welcome: best-effort, NEVER blocking provisioning. A send
 *   failure is logged and reported as { sent: false }, never
 *   thrown — the caller (provisioning or its trigger route)
 *   proceeds regardless.
 * - A2 digest: opt-in, default OFF (see defaultPreferences);
 *   per-user per-day durable guard (at most one digest per day);
 *   skip-on-empty (an empty digest is never sent and never
 *   marks the day sent, so a later non-empty digest that day
 *   can still go out).
 * - A3 preferences + opt-out: per-user per-category toggles;
 *   digest opt-out is a single store write, so it is effective
 *   on the very next send check (same-day effect). The
 *   one-click unsubscribe token is signed (HMAC-SHA256) and is
 *   valid for DIGEST ONLY: a token scoped to anything else
 *   (including "security") is rejected, and security mail is
 *   non-suppressible — there is no code path that unsubscribes
 *   it. The token secret comes from the caller (a worker secret
 *   name, never a value in code); when no secret is configured,
 *   digests are sent WITHOUT an unsubscribe link rather than
 *   with an unsigned one.
 *
 * This module imports port types only — no store client, no
 * SQL, no env binding. A structural test pins that.
 */

import {
  digestDayKey,
  type LifecycleStore,
  type NotificationPreferences,
} from "../data/lifecyclePorts";
import type { StoreTier } from "../data/commercialPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/lifecycleEmail",
});

/** Minimal injected mail transport (cfpay A2A or env.EMAIL behind it). */
export interface EmailSender {
  send(input: { to: string; subject: string; body: string }): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Issue #2522 (slice 3, #2405 Phase 1.3): the tier-limited digest
 * cap. ONLY Subscribed receives the full digest; Free and
 * PayPerUse receive the first LIMITED_DIGEST_ITEM_CAP items plus
 * one factual cap line. PayPerUse → limited by the #1076 ads-edge
 * reasoning: a cent-scale one-off purchase must not confer an
 * ongoing benefit. This is a slice decision, recorded on #2522
 * for owner override — not a price, not a marketing claim.
 */
export const LIMITED_DIGEST_ITEM_CAP = 3;

export function buildWelcomeEmail(userId: string, tier: StoreTier = "Free"): { subject: string; body: string } {
  return {
    subject: "Welcome to the screener service",
    body: [
      `Hello ${userId},`,
      "",
      `Your current tier is ${tier}.`,
      "Your account has been provisioned. You can use the screener service with your current access.",
      "You can change your notification preferences at any time; digest mail is opt-in and off by default.",
      "Security mail about your account cannot be turned off.",
    ].join("\n"),
  };
}

export function buildDigestEmail(
  userId: string,
  items: string[],
  tier: StoreTier = "Free",
  unsubscribeUrl?: string,
): { subject: string; body: string } {
  const shown = tier === "Subscribed" ? items : items.slice(0, LIMITED_DIGEST_ITEM_CAP);
  const lines = [
    `Hello ${userId},`,
    "",
    "Your daily digest:",
    ...shown.map((item) => `- ${item}`),
  ];
  if (shown.length < items.length) {
    lines.push("", `Showing ${shown.length} of ${items.length} digest items for your current tier.`);
  }
  if (unsubscribeUrl) {
    lines.push("", `To stop digest mail only, use this link: ${unsubscribeUrl}`);
    lines.push("Security mail about your account is unaffected by that link.");
  }
  return { subject: "Your daily digest", body: lines.join("\n") };
}

/**
 * A1: welcome send that never throws. Callers proceed whether
 * this resolves sent or not — that is the "never blocking
 * provisioning" guarantee, tested with a throwing sender.
 */
export async function sendWelcomeBestEffort(input: {
  sender: EmailSender;
  email: string;
  userId: string;
  preferences?: NotificationPreferences;
  /** Effective tier for content selection; defaults to Free (limited). */
  tier?: StoreTier;
}): Promise<{ sent: boolean; reason?: string }> {
  try {
    if (input.preferences && !input.preferences.welcomeEnabled) {
      return { sent: false, reason: "welcome-opted-out" };
    }
    const { subject, body } = buildWelcomeEmail(input.userId, input.tier ?? "Free");
    const result = await input.sender.send({ to: input.email, subject, body });
    if (!result.ok) {
      structuredLog.error("sendWelcomeBestEffort.welcome_send_failed", {
        message: `[lifecycle] welcome send failed for ${input.userId}: ${result.error ?? "unknown error"}`,
        userId: input.userId,
        error: result.error ?? "unknown error",
      });
      return { sent: false, reason: "send-failed" };
    }
    return { sent: true };
  } catch (err: any) {
    structuredLog.error("sendWelcomeBestEffort.welcome_send_threw", {
      message: `[lifecycle] welcome send threw for ${input.userId}: ${err?.message ?? "unknown error"}`,
      userId: input.userId,
      error: err?.message ?? "unknown error",
    });
    return { sent: false, reason: "send-failed" };
  }
}

export type DigestSendResult =
  | { sent: true }
  | { sent: false; reason: "digest-opted-out" | "already-sent-today" | "empty-skipped" | "send-failed" };

/**
 * A2: the guarded digest send. Checks, in order: preference
 * (opt-in), per-day guard, skip-on-empty. The day is marked
 * sent ONLY after a successful send, so a failed send stays
 * retryable within the same day.
 */
export async function sendDailyDigest(input: {
  store: LifecycleStore;
  sender: EmailSender;
  userId: string;
  tenantId: string;
  email: string;
  items: string[];
  unsubscribeUrl?: string;
  nowMs?: number;
  /** Effective tier for content selection; defaults to Free (limited). */
  tier?: StoreTier;
}): Promise<DigestSendResult> {
  const nowMs = input.nowMs ?? Date.now();
  const preferences = await input.store.getPreferences(input.userId, input.tenantId);
  if (!preferences.digestEnabled) return { sent: false, reason: "digest-opted-out" };
  const day = digestDayKey(nowMs);
  if (await input.store.hasSentDigest(input.userId, day)) {
    return { sent: false, reason: "already-sent-today" };
  }
  if (input.items.length === 0) return { sent: false, reason: "empty-skipped" };
  const { subject, body } = buildDigestEmail(input.userId, input.items, input.tier ?? "Free", input.unsubscribeUrl);
  let result: { ok: boolean; error?: string };
  try {
    result = await input.sender.send({ to: input.email, subject, body });
  } catch (err: any) {
    structuredLog.error("sendDailyDigest.digest_send_threw", {
      message: `[lifecycle] digest send threw for ${input.userId}: ${err?.message ?? "unknown error"}`,
      userId: input.userId,
      error: err?.message ?? "unknown error",
    });
    return { sent: false, reason: "send-failed" };
  }
  if (!result.ok) {
    structuredLog.error("sendDailyDigest.digest_send_failed", {
      message: `[lifecycle] digest send failed for ${input.userId}: ${result.error ?? "unknown error"}`,
      userId: input.userId,
      error: result.error ?? "unknown error",
    });
    return { sent: false, reason: "send-failed" };
  }
  await input.store.markDigestSent(input.userId, day);
  return { sent: true };
}

// ----------------------------------------------------------------
// Signed one-click unsubscribe token (digest ONLY).
// Payload: { u: userId, t: tenantId, s: scope }. Scope MUST be
// "digest"; verify rejects anything else, so a digest token can
// never be repurposed for security mail (and no security-mail
// unsubscribe path exists at all).
// ----------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(signature);
}

export async function signUnsubscribeToken(
  secret: string,
  userId: string,
  tenantId: string,
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ u: userId, t: tenantId, s: "digest" })),
  );
  const signature = base64UrlEncode(await hmacSha256(secret, payload));
  return `${payload}.${signature}`;
}

export interface VerifiedUnsubscribeToken {
  userId: string;
  tenantId: string;
  scope: string;
}

/** Rejects bad signatures, malformed tokens, and any scope other than "digest". */
export async function verifyUnsubscribeToken(
  secret: string,
  token: string,
): Promise<VerifiedUnsubscribeToken> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Malformed unsubscribe token.");
  const expected = base64UrlEncode(await hmacSha256(secret, payload));
  if (signature.length !== expected.length) throw new Error("Invalid unsubscribe token.");
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) throw new Error("Invalid unsubscribe token.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new Error("Malformed unsubscribe token.");
  }
  const record = parsed as { u?: unknown; t?: unknown; s?: unknown };
  if (typeof record.u !== "string" || typeof record.t !== "string" || record.s !== "digest") {
    throw new Error("Unsubscribe tokens apply to digest mail only.");
  }
  return { userId: record.u, tenantId: record.t, scope: "digest" };
}

/**
 * Apply a verified token: digest off for that user, same-day
 * effect (the next sendDailyDigest check reads the new row).
 * Throws on any invalid or non-digest token — the caller maps
 * that to a 400, never to a silent preference change.
 */
export async function applyUnsubscribe(
  store: LifecycleStore,
  secret: string,
  token: string,
): Promise<NotificationPreferences> {
  const verified = await verifyUnsubscribeToken(secret, token);
  const existing = await store.getPreferences(verified.userId, verified.tenantId);
  return store.setPreferences({
    userId: verified.userId,
    tenantId: existing.tenantId,
    digestEnabled: false,
    welcomeEnabled: existing.welcomeEnabled,
  });
}
