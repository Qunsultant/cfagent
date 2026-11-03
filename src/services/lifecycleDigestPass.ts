/**
 * Issue #2659 (monetization Phase 2.4) — the scheduled digest pass.
 *
 * The pass is deliberately thin: it enumerates digest-enabled
 * subscribers from the lifecycle store and delegates every
 * per-user send to sendDailyDigest (lifecycleEmail), so the
 * opt-in re-check, per-day guard, skip-on-empty, and slice-3
 * tier cap are inherited, not re-implemented. The pass adds
 * only: subscriber enumeration (with the recorded address),
 * the once-per-UTC-day marker, per-user failure containment,
 * and an honest summary for the audit trail.
 *
 * Failure semantics (the pass never throws per-user):
 * - no-email-on-file: the subscriber has no recorded address.
 *   The pass never guesses an address and never attempts a send.
 * - digest-opted-out / already-sent-today / empty-skipped:
 *   inherited from sendDailyDigest (send-time re-check).
 * - tier-unavailable / items-failed / send-failed: the pass
 *   continues with the remaining subscribers.
 * A store failure in enumeration DOES throw: the trigger route
 * then writes no day marker, so the next tick retries (per-user
 * day guards make the retry idempotent).
 *
 * Content is an explicit seam: items come from the caller's
 * itemsProvider. Since #2981 the run-due route supplies the
 * digest content provider for scheduled sends (operator
 * itemsByUser still wins per subscriber); a subscriber with no
 * windowed reports honestly skips — nothing here invents
 * digest content. The unsubscribe link is likewise
 * optional: the scheduled path has no trustworthy public origin
 * (the tick is a cron event, not a user-facing request), so the
 * trigger route omits it; opt-out remains via the preferences
 * panel (#2471) and the unsubscribe route. A caller with a real
 * origin may pass unsubscribeUrlFor; a failing builder falls
 * back to no link (decoration only — the unsubscribe route
 * stays the authoritative path).
 */
import {
  digestDayKey,
  type LifecycleStore,
} from "../data/lifecyclePorts";
import type { StoreTier } from "../data/commercialPorts";
import {
  sendDailyDigest,
  type EmailSender,
} from "./lifecycleEmail";

export type DigestPassUserReason =
  | "digest-opted-out"
  | "already-sent-today"
  | "empty-skipped"
  | "send-failed"
  | "no-email-on-file"
  | "tier-unavailable"
  | "items-failed";

export type DigestPassUserResult =
  | { userId: string; tenantId: string; sent: true }
  | { userId: string; tenantId: string; sent: false; reason: DigestPassUserReason };

export interface DigestPassSummary {
  day: string;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  results: DigestPassUserResult[];
}

export interface DigestPassInput {
  store: LifecycleStore;
  sender: EmailSender;
  tierResolver: (userId: string) => Promise<StoreTier>;
  itemsProvider: (userId: string, tenantId: string) => Promise<string[]>;
  unsubscribeUrlFor?: (userId: string, tenantId: string) => Promise<string | undefined>;
  /** Test seam; defaults to Date.now(). */
  nowMs?: number;
}

const SKIPPED_REASONS: ReadonlySet<DigestPassUserReason> = new Set([
  "digest-opted-out",
  "already-sent-today",
  "empty-skipped",
  "no-email-on-file",
]);

/**
 * The once-per-day gate: fire when the last pass day differs
 * from today's UTC date. No hour or weekday gate — the tick's
 * own 30-minute cadence decides when within the day the pass runs.
 */
export function shouldFireDigestPass(
  now: Date,
  lastPassDay: string | null,
): { fire: true; dateKey: string } | { fire: false; dateKey: string; reason: "already-ran-today" } {
  const dateKey = digestDayKey(now.getTime());
  if (lastPassDay === dateKey) return { fire: false, dateKey, reason: "already-ran-today" };
  return { fire: true, dateKey };
}

export async function sendDueDigests(input: DigestPassInput): Promise<DigestPassSummary> {
  const nowMs = input.nowMs ?? Date.now();
  const day = digestDayKey(nowMs);
  const subscribers = await input.store.listDigestSubscribers();
  const results: DigestPassUserResult[] = [];
  for (const sub of subscribers) {
    // Never attempt a send without a recorded address.
    if (!sub.email) {
      results.push({ userId: sub.userId, tenantId: sub.tenantId, sent: false, reason: "no-email-on-file" });
      continue;
    }
    let tier: StoreTier;
    try {
      tier = await input.tierResolver(sub.userId);
    } catch {
      results.push({ userId: sub.userId, tenantId: sub.tenantId, sent: false, reason: "tier-unavailable" });
      continue;
    }
    let items: string[];
    try {
      items = await input.itemsProvider(sub.userId, sub.tenantId);
    } catch {
      results.push({ userId: sub.userId, tenantId: sub.tenantId, sent: false, reason: "items-failed" });
      continue;
    }
    let unsubscribeUrl: string | undefined;
    if (input.unsubscribeUrlFor) {
      try {
        unsubscribeUrl = await input.unsubscribeUrlFor(sub.userId, sub.tenantId);
      } catch {
        unsubscribeUrl = undefined;
      }
    }
    const outcome = await sendDailyDigest({
      store: input.store,
      sender: input.sender,
      userId: sub.userId,
      tenantId: sub.tenantId,
      email: sub.email,
      tier,
      items,
      unsubscribeUrl,
      nowMs,
    });
    if (outcome.sent) {
      results.push({ userId: sub.userId, tenantId: sub.tenantId, sent: true });
    } else {
      results.push({ userId: sub.userId, tenantId: sub.tenantId, sent: false, reason: outcome.reason });
    }
  }
  return {
    day,
    attempted: results.length,
    sent: results.filter((r) => r.sent).length,
    skipped: results.filter((r) => !r.sent && SKIPPED_REASONS.has(r.reason)).length,
    failed: results.filter((r) => !r.sent && !SKIPPED_REASONS.has(r.reason)).length,
    results,
  };
}
