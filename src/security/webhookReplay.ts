/**
 * Inbound webhook replay protection and emailTo domain allowlist.
 *
 * P0 items from docs/Assessment.md via issue #143. (The outbound SSRF
 * guard, issue #240, already landed in PR #242 as
 * `assertSafeOutboundWebhookUrl` in ./webhookSecurity.ts — it is not
 * duplicated here.)
 *
 * REPLAY: inbound signature verification (HMAC-SHA256, constant-time,
 * fail-closed, 5-minute timestamp windows) already exists in
 * ./webhookSecurity.ts, but nothing stopped a REPLAYED, still-valid
 * delivery from being processed twice (e.g. a TradingView alert re-POSTed
 * inside the window would draft a second order). This module records a
 * provider-derived nonce per processed event in durable storage and
 * rejects duplicates. The nonce prefers a semantic event identity when
 * the provider supplies one (E*TRADE orderId:eventType:timestamp) and
 * falls back to SHA-256(provider | signature | raw body) otherwise.
 */

import type { DatabaseORM } from "../orm";
import type { ScheduleWebhookFollowupBody } from "../api/ingressSchemas";
import { canonicalJson } from "../services/scheduleDedupe";
import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** Nonce lifetime in durable storage: 24h, well beyond any timestamp window. */
export const WEBHOOK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** TradingView alerts carry no stable provider event id: hash the signed body. */
export async function deriveTradingViewNonce(signature: string | null, rawBody: string): Promise<string> {
  return "tv:" + (await sha256Hex(`tradingview|${signature ?? ""}|${rawBody}`));
}

/** E*TRADE broker notifications: prefer the semantic identity, hash otherwise. */
export async function deriveETradeNonce(
  payload: { orderId?: string; eventType: string; timestamp?: string },
  signature: string | null,
  rawBody: string
): Promise<string> {
  if (payload.orderId && payload.timestamp) {
    return `etrade:${payload.orderId}:${payload.eventType}:${payload.timestamp}`;
  }
  return "etrade:" + (await sha256Hex(`etrade|${signature ?? ""}|${rawBody}`));
}

/** NLQ webhook: the query + recipient + provider timestamp identify a delivery. */
export async function deriveNlqNonce(
  query: string,
  emailTo: string | undefined,
  timestamp: string
): Promise<string> {
  return "nlq:" + (await sha256Hex(`nlq|${query}|${emailTo ?? ""}|${timestamp}`));
}

/** Schedule webhook (#3311): no stable provider event id — hash the signed body. */
export async function deriveScheduleWebhookNonce(
  signature: string | null,
  rawBody: string
): Promise<string> {
  return "schedule-webhook:" + (await sha256Hex(`schedule-webhook|${signature ?? ""}|${rawBody}`));
}

// ---------------------------------------------------------------------------
// #4223 — persistent schedule-webhook idempotency keys
// ---------------------------------------------------------------------------

/**
 * Durable schedule-webhook idempotency retention: 30 days, longer than
 * the 24h edge nonce TTL (WEBHOOK_REPLAY_TTL_MS) so a delivery
 * re-sent after the edge nonce expires is still recognised as a
 * duplicate. The edge nonce guards the 5-minute signature window;
 * this key guards the whole retry horizon.
 */
export const SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the durable idempotency TTL from an operator override
 * (env SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS, milliseconds). Any
 * missing, blank, non-numeric, non-finite, or non-positive value
 * fails safe to the 30-day default — a bad override must never
 * shorten the guard to nothing or break the claim.
 */
export function resolveScheduleWebhookIdempotencyTtlMs(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS;
  }
  return SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS;
}

/**
 * Derive the durable idempotency key for one parsed webhook delivery.
 * The key is the SHA-256 of the canonical JSON of the whole parsed
 * body (keys sorted by the reused `canonicalJson`, so the same
 * delivery re-serialized with a different key order maps to the same
 * key), namespaced by the `schedule-webhook-idem:` prefix so it can
 * never collide with an edge nonce (`schedule-webhook:`). Any field
 * that changes the delivery — timestamp, workflow, capability,
 * outcome, channel — changes the key; the same delivery re-sent
 * verbatim claims the same key.
 */
export async function deriveScheduleWebhookIdempotencyKey(
  body: ScheduleWebhookFollowupBody,
): Promise<string> {
  return "schedule-webhook-idem:" + (await sha256Hex(`schedule-webhook-idem|${canonicalJson(body)}`));
}

/**
 * Durable nonce-claim store. `claim` returns true when the nonce was
 * already claimed and has not expired — i.e. the event is a REPLAY and
 * must be rejected. Implementations:
 * - OrmReplayStore: Durable-Object SQLite via DatabaseORM (production).
 * - MemoryReplayStore: isolate-scoped fallback for contexts without an
 *   ORM (e.g. the edge /nlq/webhook route in the Worker); the HMAC +
 *   timestamp window remain the primary control there.
 */
export interface ReplayStore {
  claim(nonce: string, source: string, ttlMs?: number): Promise<boolean>;
  /**
   * #4223: remove every expired claim and report how many were
   * removed. Retention hygiene — spent keys must not accumulate
   * forever. Source-agnostic: any expired row goes, whatever
   * claimed it.
   */
  pruneExpired(): Promise<number>;
}

export class OrmReplayStore implements ReplayStore {
  constructor(private orm: DatabaseORM) {}

  async claim(nonce: string, source: string, ttlMs: number = WEBHOOK_REPLAY_TTL_MS): Promise<boolean> {
    const now = Date.now();
    const row = this.orm.webhookReplay.findOne({ nonce });
    if (row && Date.parse(row.expiresAt) > now) {
      return true; // already processed and still within TTL: replay
    }
    const createdAt = new Date(now).toISOString();
    this.orm.webhookReplay.upsert({
      nonce,
      source,
      createdAt,
      expiresAt: new Date(now + ttlMs).toISOString(),
    });
    // Opportunistic hygiene: only when the table grows large (tests and
    // low-traffic deployments never hit this).
    const recent = this.orm.webhookReplay.findMany({ limit: 5000 });
    if (recent.length >= 5000) {
      for (const r of recent) {
        if (Date.parse(r.expiresAt) <= now) this.orm.webhookReplay.delete(r.nonce);
      }
    }
    return false;
  }

  async pruneExpired(): Promise<number> {
    // One Repository call, not a template: the port's where language
    // (expiresAt <= now, ISO strings order chronologically) deletes
    // every spent row in one pass, whatever source claimed it.
    return this.orm.webhookReplay.deleteWhere({ expiresAt: { $lte: new Date().toISOString() } });
  }
}

export class MemoryReplayStore implements ReplayStore {
  private claimed = new Map<string, number>();

  async claim(nonce: string, _source: string, ttlMs: number = WEBHOOK_REPLAY_TTL_MS): Promise<boolean> {
    const now = Date.now();
    const expires = this.claimed.get(nonce);
    if (expires !== undefined && expires > now) return true;
    this.claimed.set(nonce, now + ttlMs);
    if (this.claimed.size > 1000) {
      for (const [k, v] of this.claimed) if (v <= now) this.claimed.delete(k);
    }
    return false;
  }

  async pruneExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.claimed) {
      if (v <= now) {
        this.claimed.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}

let sharedMemoryStore: MemoryReplayStore | null = null;
/** Process-wide fallback store for code paths without an ORM. */
export function sharedMemoryReplayStore(): MemoryReplayStore {
  if (!sharedMemoryStore) sharedMemoryStore = new MemoryReplayStore();
  return sharedMemoryStore;
}

// ---------------------------------------------------------------------------
// emailTo domain allowlist (issue #143 P0)
// ---------------------------------------------------------------------------

const EMAIL_FORMAT_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
let warnedAllowlistUnset = false;

/**
 * Issue #4435 — format-only email check, for caller-supplied
 * contacts that are NOT outbound notification recipients (a
 * checkout receipt email is any customer address, so the
 * EMAIL_TO_ALLOWED_DOMAINS allowlist must never gate it).
 * validateEmailRecipient stays the outbound-recipient check.
 */
export function isValidEmailFormat(email: string): boolean {
  return EMAIL_FORMAT_RE.test(email.trim());
}

export type EmailRecipientCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validates an outbound email recipient for webhook-triggered email paths.
 * Format is always enforced. When EMAIL_TO_ALLOWED_DOMAINS is set
 * (comma-separated, e.g. "example.com,corp.org"), the recipient's domain
 * must be listed; when unset, current behavior is preserved (format check
 * only) with a one-time warning so the missing allowlist is visible in
 * logs rather than silently assumed.
 */
export function validateEmailRecipient(
  email: string,
  allowedDomainsCsv?: string,
  // #3515 S3 batch 8 — optional observability sink for the one-time
  // allowlist-unset warning (the d1QueryLogger precedent); absent,
  // the structured console fallback (never an empty-env sink, #5587).
  sink?: ObservabilitySink,
): EmailRecipientCheck {
  const addr = email.trim();
  if (!EMAIL_FORMAT_RE.test(addr)) return { ok: false, reason: "Invalid email address format." };
  if (!allowedDomainsCsv || !allowedDomainsCsv.trim()) {
    if (!warnedAllowlistUnset) {
      warnedAllowlistUnset = true;
      createStructuredLogger(sink ?? new ConsoleObservabilitySink(), {
        component: "security/webhookReplay",
      }).warn("webhookReplay.email_allowlist_unset", {
        message:
          "[webhookReplay] EMAIL_TO_ALLOWED_DOMAINS is not set; emailTo recipients are format-validated only (no domain allowlist).",
      });
    }
    return { ok: true };
  }
  const domain = addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();
  const allowed = allowedDomainsCsv
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(domain)) {
    return { ok: false, reason: `Email domain "${domain}" is not in the EMAIL_TO_ALLOWED_DOMAINS allowlist.` };
  }
  return { ok: true };
}
