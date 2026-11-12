/**
 * Issue #3246 (sub-issue of #3241) — composition root for the
 * offer-suppression port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createOfferSuppressionAdapter` returns null. The offer routes
 * treat a null suppression port as a 503 (never a silent
 * unsuppressed offer): dismissal state is entitlement-surface
 * state, and an offer computed without it could show a dismissed
 * offer. The service itself takes the port as an input and fails
 * closed when it is absent for an interruptive trigger.
 */
import {
  createD1OfferSuppressionDb,
  D1OfferSuppressionAdapter,
  ensureOfferSuppressionSchema,
  type OfferSuppressionDb,
} from "./d1OfferSuppressionAdapter";
import type { OfferSuppressionPort } from "./offerSuppressionPorts";

/** Build the offer-suppression adapter from Worker env, or null if unbound. */
export function createOfferSuppressionAdapter(env: { AGENT_DB?: unknown }): D1OfferSuppressionAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1OfferSuppressionAdapter(createD1OfferSuppressionDb(env.AGENT_DB as D1Database));
}

export { ensureOfferSuppressionSchema };
export type { OfferSuppressionDb, OfferSuppressionPort };
