/**
 * Issue #2695 (Platform Phase 4, program #2468) — marketing.
 *
 * Read-only catalog route, mirroring src/agents/meshRegistryRoute.ts:
 * pure handler over injected dependencies, no store reads of its own.
 * The server passes the price-catalogue-adapter-bound listPrices;
 * a null or throwing listPrices fails closed with 503 (a read route
 * never auto-migrates a schema).
 *
 * Issue #4696 — the catalog also lists operator-created products:
 * the server passes the subscription-store listPlans (all rows) and
 * the product-store listProducts; a null or throwing reader fails
 * closed with 503, exactly like the price catalogue — a silently
 * incomplete catalog (created rows dropped) would be a lie about
 * what the operator sells. The created rows append after the 12
 * family rows; the family derivation is untouched.
 *
 * Decision order: 401 (no session) → 405 (non-GET) → 503
 * (catalogue unavailable) → 503 (created products unavailable) →
 * 200 (catalog display rows derived from the Phase 2 catalog +
 * Phase 3 access records + created-product rows).
 */
import { buildCreatedProductRows, buildProductCatalog, type ProductEntry } from "../data/productCatalogue";
import { unauthorizedJson } from "../server/routes/apiRefusals";
import { resolveProductAccess } from "../data/productAccess";
import { buildCatalogDisplay } from "../data/productMarketing";
import type { PriceEntry } from "../data/priceCataloguePorts";
import type { SubscriptionPlanRecord } from "../data/subscriptionPorts";
import type { ProductRecord } from "../data/productPorts";

export interface ProductCatalogRouteInput {
  /** Wired session, or null when unauthenticated. */
  session: unknown;
  method: string;
  listPrices: (() => Promise<PriceEntry[]>) | null;
  /** Issue #4696 — all plan rows (active and deactivated); null = unavailable → 503. */
  listPlans: (() => Promise<SubscriptionPlanRecord[]>) | null;
  /** Issue #4696 — all product rows; null = unavailable → 503. */
  listProducts: (() => Promise<ProductRecord[]>) | null;
}

export async function handleProductCatalogRoute(
  input: ProductCatalogRouteInput,
): Promise<Response> {
  if (!input.session) {
    return unauthorizedJson();
  }
  if (input.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  if (input.listPrices === null) {
    return new Response("price catalogue unavailable", { status: 503 });
  }
  if (input.listPlans == null || input.listProducts == null) {
    return new Response("created products unavailable", { status: 503 });
  }
  let prices: PriceEntry[];
  try {
    prices = await input.listPrices();
  } catch {
    return new Response("price catalogue unavailable", { status: 503 });
  }
  let created: ProductEntry[];
  try {
    created = buildCreatedProductRows({
      plans: await input.listPlans(),
      products: await input.listProducts(),
      nowMs: Date.now(),
    });
  } catch {
    return new Response("created products unavailable", { status: 503 });
  }
  const entries = [...buildProductCatalog(prices), ...created];
  const access = entries.map((entry) => resolveProductAccess(entry, prices));
  const products = buildCatalogDisplay(entries, access);
  return new Response(JSON.stringify({ products }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
