/**
 * Issue #2185 (sub-issue of #2012) — composition root for the
 * price catalogue port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state (the layer
 * is safe to merge before the binding propagates everywhere):
 * `createPriceCatalogueAdapter` returns null and callers keep
 * their fail direction — fail-closed on money paths. A
 * present-but-unreadable store fails at the call site, where the
 * caller decides the direction.
 */
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
  type PriceCatalogueDb,
} from "./d1PriceCatalogueAdapter";
import type { PremiumPriceFamily, PriceCatalogue } from "./priceCataloguePorts";

/** Build the price catalogue adapter from Worker env, or null if unbound. */
export function createPriceCatalogueAdapter(env: { AGENT_DB?: unknown }): D1PriceCatalogueAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1PriceCatalogueAdapter(createD1PriceCatalogueDb(env.AGENT_DB as D1Database));
}

/**
 * #5609 (G-7): resolve the APPROVED price for one premium family
 * from Worker env. Null when the store is unbound, the family has
 * no effective version, or the effective version is PROPOSED-only —
 * every null is the caller's fail-closed signal, never a reason to
 * guess a price. The shared resolver so the premium HTTP routes,
 * the MCP paid tools, and the NLQ refusal all read the same price
 * from the same source.
 */
export async function getApprovedPremiumPrice(
  env: { AGENT_DB?: unknown },
  family: PremiumPriceFamily,
): Promise<number | null> {
  const catalogue = createPriceCatalogueAdapter(env);
  if (!catalogue) return null;
  return catalogue.getApprovedPrice(family);
}

export { ensurePriceCatalogueSchema };
export type { PriceCatalogue, PriceCatalogueDb };
