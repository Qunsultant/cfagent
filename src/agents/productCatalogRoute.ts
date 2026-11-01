/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 *
 * Read-only catalog route, mirroring src/agents/meshRegistryRoute.ts:
 * pure handler over injected dependencies, no store reads of its own.
 * The server passes the price-catalogue-adapter-bound listPrices;
 * a null or throwing listPrices fails closed with 503 (a read route
 * never auto-migrates a schema).
 *
 * Decision order: 401 (no session) → 405 (non-GET) → 503
 * (catalogue unavailable) → 200 (catalog display rows derived
 * from the Phase 2 catalog + Phase 3 access records).
 */
import { buildProductCatalog } from "../data/productCatalogue";
import { resolveProductAccess } from "../data/productAccess";
import { buildCatalogDisplay } from "../data/productMarketing";
import type { PriceEntry } from "../data/priceCataloguePorts";

export interface ProductCatalogRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  listPrices: (() => Promise<PriceEntry[]>) | null;
}

export async function handleProductCatalogRoute(
  input: ProductCatalogRouteInput,
): Promise<Response> {
  if (!input.session) {
    return new Response("unauthorized", { status: 401 });
  }
  if (input.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  if (input.listPrices === null) {
    return new Response("price catalogue unavailable", { status: 503 });
  }
  let prices: PriceEntry[];
  try {
    prices = await input.listPrices();
  } catch {
    return new Response("price catalogue unavailable", { status: 503 });
  }
  const entries = buildProductCatalog(prices);
  const access = entries.map((entry) => resolveProductAccess(entry, prices));
  const products = buildCatalogDisplay(entries, access);
  return new Response(JSON.stringify({ products }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
