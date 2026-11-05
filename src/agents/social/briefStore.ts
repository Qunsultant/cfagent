/**
 * #1077 Phase 5b slice 2 — the durable social brief store.
 *
 * The brief is the day's human- or NLQ-provided post content. It is
 * the ONLY content the social goal may publish: the executor never
 * invents text, and a missing brief means noBrief (the goal stays
 * due and retries next tick).
 *
 * Storage follows the durableStores pattern exactly, over the same
 * SESSION_STORE binding and "social" namespace:
 * - ONLY op get/put (never op list — SessionStore refuses list for
 *   non-E*TRADE namespaces). One key per date, no index to maintain.
 * - Values are JSON strings: { text }. A value that is not valid
 *   JSON or fails the shape guard reads as ABSENT (never a minted
 *   brief); the next provision overwrites it (self-healing).
 * - A transport failure (failed fetch, non-2xx, reply {error})
 *   THROWS, so callers record the error and leave the goal due
 *   instead of silently publishing nothing — or stale content.
 *
 * Overwrite semantics: the most recent provision wins for that
 * date. A brief stored for a past date never affects past firings;
 * onCron reads only the firing date's brief.
 */

import { zonedDateParts } from "../../schedule";
import type { DoNamespaceLike } from "../../data/durableKv";
import { socialStoreOp, type SessionStoreStub } from "./durableStores";

/** NLQ query cap, shared with the NLQ webhook (server.ts): briefs longer than this are refused, not truncated. */
export const SOCIAL_BRIEF_MAX_CHARS = 4000;

export function briefKey(date: string): string {
  return `social-brief:${date}`;
}

/** YYYY-MM-DD with real month/day ranges. A key is just a namespaced string, so this guards junk, not existence. */
export function isBriefDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * The brief date for a firing: the wall-clock date in the zone,
 * shifted by dayOffset (0 = the firing day, 1 = the next day — the
 * NLQ "for tomorrow" form). Pure; the executor and the NLQ planner
 * share this so plan-time and fire-time dates cannot disagree.
 */
export function resolveBriefDate(nowMs: number, timeZone: string, dayOffset: 0 | 1): string {
  const parts = zonedDateParts(nowMs, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + dayOffset * 86400000);
  return shifted.toISOString().slice(0, 10);
}

export interface SocialBriefStore {
  /** The stored brief text, or null when absent, corrupt, or malformed-date. Transport failure throws. */
  getBrief(date: string): Promise<string | null>;
  /** Overwrites any existing brief for the date. Throws on a bad date, empty/whitespace text, over-long text, or transport failure. */
  putBrief(date: string, text: string): Promise<void>;
}

function parseBrief(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string"
      ? (value as { text: string }).text
      : null;
  } catch {
    return null;
  }
}

export function createSessionStoreSocialBriefStore(stub: SessionStoreStub): SocialBriefStore {
  return {
    async getBrief(date: string) {
      if (!isBriefDate(date)) return null;
      const reply = await socialStoreOp(stub, "get", briefKey(date));
      return parseBrief(reply.value);
    },
    async putBrief(date: string, text: string) {
      if (!isBriefDate(date)) throw new Error(`social brief: invalid date "${date}" (expected YYYY-MM-DD)`);
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("social brief: text must be a non-empty string");
      }
      if (text.length > SOCIAL_BRIEF_MAX_CHARS) {
        throw new Error(`social brief: text must be ${SOCIAL_BRIEF_MAX_CHARS} characters or fewer`);
      }
      await socialStoreOp(stub, "put", briefKey(date), JSON.stringify({ text }));
    },
  };
}

/**
 * Resolve a brief store from a Worker Env namespace. Returns null
 * when the namespace is absent, so callers fail closed instead of
 * silently writing to nowhere. Same "kv" instance and "social"
 * namespace as the draft/approval stores.
 */
export function createSocialBriefStoreFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
): SocialBriefStore | null {
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName("kv")) as SessionStoreStub;
  return createSessionStoreSocialBriefStore(stub);
}
