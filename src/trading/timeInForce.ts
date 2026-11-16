/**
 * Issue #4656 (matrix gap 5) — the canonical time-in-force vocabulary, in ONE
 * place, shared by the routes and the platform seams.
 *
 * The ticket's vocabulary (`config/orderCapabilities.ts`: DAY/GTC/IOC/FOK) is the
 * user-facing one; the wire wants a lowercase token on `PlaceOrderParams` /
 * `OrderPreviewParams`, and each platform maps it onto its own term at its own
 * seam. What must never happen is a surface inventing its own token, or a route
 * forwarding an unvalidated string to a broker that then substitutes a default.
 *
 * Fail closed: an absent value stays absent (the broker default applies, which
 * is what every pre-#4656 caller gets), and an unrecognised value is rejected —
 * never coerced to `day`.
 */
export type NormalizedTimeInForce = "day" | "gtc" | "ioc" | "fok" | "opg" | "cls";

/** Every value the canonical vocabulary accepts, in display order. */
export const TIME_IN_FORCE_VALUES: readonly NormalizedTimeInForce[] = ["day", "gtc", "ioc", "fok", "opg", "cls"];

/**
 * Issue #4671 (matrix gap 17) — the auction half of the vocabulary. An auction
 * order is NOT a separate order type: it is a market or limit order whose
 * time-in-force names an exchange auction (the broker's wire model). The four
 * abbreviations therefore DERIVE from (type, tif), never from a second table:
 * market+opg = MOO, market+cls = MOC, limit+opg = LOO, limit+cls = LOC.
 *
 * Only a broker whose capability table lists these values may be sent one; a
 * broker that cannot is refused by name through the one order-type registry
 * (`session_timed`), never silently downgraded to a day order.
 */
export const AUCTION_TIME_IN_FORCE: readonly NormalizedTimeInForce[] = ["opg", "cls"];

/** True when this value names an exchange auction rather than a session term. */
export function isAuctionTimeInForce(value: unknown): value is "opg" | "cls" {
  return value === "opg" || value === "cls";
}

/**
 * Normalize a caller's time-in-force to the canonical token.
 * Returns undefined for an absent value (default applies) and for any value
 * outside the vocabulary — the caller decides whether that is a 400 (the route)
 * or a named refusal (a broker that cannot honour it).
 */
export function normalizeTimeInForce(value: unknown): NormalizedTimeInForce | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase() as NormalizedTimeInForce;
  return TIME_IN_FORCE_VALUES.includes(normalized) ? normalized : undefined;
}

/** True when a caller supplied a time-in-force at all (absent is not invalid). */
export function hasTimeInForce(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
