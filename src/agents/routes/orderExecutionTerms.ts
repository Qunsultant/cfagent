/**
 * Issue #4656 (matrix gap 5) — the execution terms every order route derives from
 * the STORED DRAFT, in one place.
 *
 * Both the neutral `/broker/order/execute` route and the legacy broker route
 * must agree on what the approved draft means:
 *  - `limitPrice` for LIMIT **and STOP_LIMIT** (issue #4654 stopped dropping it
 *    for the latter),
 *  - `stopPrice` for STOP / STOP_LIMIT, from the stored trigger with a fallback
 *    to the row's price for drafts written before #4654,
 *  - `timeInForce` from the row (issue #4656), absent on legacy drafts so the
 *    broker default applies exactly as it did before.
 *
 * Keeping the derivation here is also what keeps the legacy dispatcher inside
 * its 50 KB module target: it calls one function instead of repeating three
 * ternaries (the #359/#2943 constraint).
 */
import { normalizeTimeInForce, type NormalizedTimeInForce } from "../../trading";

/** The fields of a stored draft this derivation reads. */
export interface DraftTermsRecord {
  orderType?: unknown;
  price?: unknown;
  stopPrice?: unknown;
  timeInForce?: unknown;
}

export interface OrderExecutionTerms {
  orderType: string;
  limitPrice: number | undefined;
  stopPrice: number | undefined;
  timeInForce: NormalizedTimeInForce | undefined;
}

/** Derive the placement terms from a stored draft. Total over unknown drafts. */
export function deriveOrderExecutionTerms(record: DraftTermsRecord | null | undefined): OrderExecutionTerms {
  const orderType = typeof record?.orderType === "string" && record.orderType !== "" ? record.orderType : "MARKET";
  const price = typeof record?.price === "number" ? record.price : undefined;
  const pricedType = orderType === "LIMIT" || orderType === "STOP_LIMIT";
  const stopType = orderType === "STOP" || orderType === "STOP_LIMIT";
  return {
    orderType,
    limitPrice: pricedType ? price : undefined,
    stopPrice: stopType ? (typeof record?.stopPrice === "number" ? record.stopPrice : price) : undefined,
    timeInForce: normalizeTimeInForce(record?.timeInForce),
  };
}
