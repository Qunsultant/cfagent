/**
 * Issue #3246 (sub-issue of #3241) — offer-dismissal suppression
 * port.
 *
 * Dismissal is REQUIRED in v1 (Mars Q5): dismissing an offer
 * suppresses THAT trigger for THAT login until the operator
 * cooldown expires. This module is the ADR 0002 R1 boundary for
 * that state: it imports no store client, references no env
 * binding, and writes no SQL. Only the adapters (Drizzle D1,
 * in-memory) touch a store, and only the composition root
 * (createOfferSuppressionPorts.ts) maps a Worker binding to an
 * adapter.
 *
 * Shape of the data (D1, migration 0062): agent_offer_suppressions,
 * one row per (login, trigger): the instant the suppression lifts
 * (suppressed_until_ms) and the instant it was written
 * (dismissed_at_ms). Suppression is NOT per-family: the user
 * dismissed the OFFER, not the family — a dismissal suppresses
 * the trigger across families. Suppression is keyed by the
 * verified session login and is tenant-agnostic within the login.
 *
 * Expiry is judged by the READER (the offer service), not the
 * port: getSuppression returns the stored row verbatim, and the
 * service treats a row whose suppressedUntilMs has passed as
 * absent. Expired rows are inert; no deletion sweeper exists in
 * v1 — a retention sweep is a follow-up slice, the same precedent
 * as the quota counts and free-run counter rows.
 *
 * The ambient trigger is never suppressed: the user explicitly
 * opened the compare surface, so dismissal never hides it. The
 * dismiss route rejects `ambient` (400); the port itself stores
 * whatever trigger it is given, and the service never consults
 * a suppression for `ambient`.
 */

/** The five offer triggers (#3246 §2.2). */
export type OfferTrigger = "manual_402" | "skip_notice" | "trial_end" | "quota_exhausted" | "ambient";

/** All offer triggers, in design order. */
export const OFFER_TRIGGERS: readonly OfferTrigger[] = [
  "manual_402",
  "skip_notice",
  "trial_end",
  "quota_exhausted",
  "ambient",
];

/** The interruptive triggers — the ones dismissal can suppress. */
export const INTERRUPTIVE_OFFER_TRIGGERS: readonly OfferTrigger[] = [
  "manual_402",
  "skip_notice",
  "trial_end",
  "quota_exhausted",
];

/** Validate an offer trigger value; a plain Error (routes map it to their 400 shape). */
export function assertOfferTrigger(value: unknown): OfferTrigger {
  if (typeof value === "string" && (OFFER_TRIGGERS as readonly string[]).includes(value)) {
    return value as OfferTrigger;
  }
  throw new Error(`Unknown offer trigger: ${typeof value === "string" ? value : typeof value}.`);
}

/** One stored suppression row. */
export interface OfferSuppression {
  login: string;
  trigger: OfferTrigger;
  suppressedUntilMs: number;
  dismissedAtMs: number;
}

/** Validate a suppression write. Server-computed values only — the route never trusts client timestamps. */
export function assertOfferSuppressionInput(input: {
  login: unknown;
  trigger: unknown;
  suppressedUntilMs: unknown;
  dismissedAtMs: unknown;
}): OfferSuppression {
  const login = typeof input.login === "string" ? input.login.trim() : "";
  if (!login) throw new Error("Offer suppression login must be a non-empty string.");
  const trigger = assertOfferTrigger(input.trigger);
  const suppressedUntilMs = input.suppressedUntilMs;
  const dismissedAtMs = input.dismissedAtMs;
  if (
    typeof suppressedUntilMs !== "number" ||
    !Number.isInteger(suppressedUntilMs) ||
    suppressedUntilMs < 0 ||
    typeof dismissedAtMs !== "number" ||
    !Number.isInteger(dismissedAtMs) ||
    dismissedAtMs < 0
  ) {
    throw new Error("Offer suppression timestamps must be non-negative whole epoch-ms.");
  }
  return { login, trigger, suppressedUntilMs, dismissedAtMs };
}

/**
 * The offer-suppression store surface. `getSuppression` returns
 * the stored row or null (no row); `setSuppression` upserts —
 * re-dismissing an already-suppressed trigger re-arms from the
 * new dismissedAtMs, never from the previous suppressedUntilMs.
 */
export interface OfferSuppressionPort {
  getSuppression(login: string, trigger: OfferTrigger): Promise<OfferSuppression | null>;
  setSuppression(input: {
    login: string;
    trigger: OfferTrigger;
    suppressedUntilMs: number;
    dismissedAtMs: number;
  }): Promise<OfferSuppression>;
}
