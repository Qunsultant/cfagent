/**
 * #2640 (Platform Phase 2, program #2468) — product catalog.
 *
 * One code-derived product catalog: families × tiers × prices, registered
 * into the mesh registry (G0), published on the agent card with a VERIFIED
 * A2A wire path, and gated by an onboarding checklist. This module is PURE
 * DERIVATION — it reads no store, opens no session, and creates no table,
 * flag, cron, or queue — so its #1819 rows-read impact is zero.
 *
 * Sources (exactly three, plus the tier model — no hand-maintained list):
 *   1. Mesh registry (src/agents/registry.ts, #2225 S1 #2325): serving-agent
 *      registration. READ ONLY here; the registry file is mesh-owned.
 *   2. Gate triple (TRADING_PAID_SERVICES, #2405 slices 1–4): the operative
 *      per-run price + endpoint + product name for gated families.
 *   3. Price catalogue approval state (src/data/priceCataloguePorts.ts,
 *      #2012 #2185/#2189 + #2547 approval): only an APPROVED catalogue price
 *      may be charged; a PROPOSED seed is never presented as chargeable.
 *   + Tier model (StoreTier, #2405 slice 3 #2522/#2526): Free | PayPerUse |
 *     Subscribed.
 *
 * Families are the price catalogue's PriceFamily union (stock | goal |
 * options | strategy). The gate's MARKET_RESEARCH service ($0.10) is a
 * gate-sold paid service WITHOUT a price-catalogue family, so it is
 * outside this family catalog by construction — not dropped, not renamed:
 * its price, gate, metering, and receipt path are unchanged from slices
 * 1–4, and it stays sold through the gate. If a research family is ever
 * defined in the price catalogue, the machinery below lists it with no
 * gate-logic change.
 *
 * Price resolution order (never a guess, never a fallback to a seed):
 *   gate price (where a gated endpoint exists) → approved catalogue price →
 *   null (unpriced → unlisted with a named reason).
 *
 * Two deliberate distinctions, documented so they cannot be misread:
 *   - requirements.price means "a chargeable price exists for this FAMILY"
 *     (gate or approved catalogue). priceUSD means "the price charged for
 *     THIS TIER" — null unless PayPerUse with a chargeable price, because
 *     no subscription price has been asserted (owner decision, #1076) and
 *     Free has no price. A Subscribed row can therefore show all wiring
 *     requirements true while priceUSD stays null: the only blocker is
 *     entitlement policy, not wiring.
 *   - requirements.runStatusSurface is a SHARED-surface fact, not per-product
 *     data: AsyncJobsPanel / WorkflowRunsPanel serve every product. It is
 *     an explicit input (default true) so the gate genuinely evaluates it —
 *     pass false and every PayPerUse listing blocks — rather than a hidden
 *     constant. If a product ever needs its own run surface, the caller
 *     must supply that product's fact here.
 *   - requirements.receiptPath is satisfied by a gated endpoint because
 *     slice 2 meters exactly one usage_event per gated fulfillment (category
 *     = paid service id) and slice 4's receipt surface reads those rows
 *     back. A family with no gated endpoint has no metered receipt path.
 *
 * Product → serving-agent mapping (the one join this module owns, with
 * rationale; Phase 3 resolves serving-agent primacy per product):
 *   stock → screener (screener.run_screen runs stock screens),
 *   goal → screener (screener.run_goal_screen runs goal screens),
 *   options → trading (trading card declares options-screening),
 *   strategy → none (no serving card exists; strategy stays unlisted).
 * Known ambiguity, recorded not hidden: stock-screening is claimed by BOTH
 * the screener and trading cards; screener is primary because run_screen
 * is the screen runner. The drift test pins this mapping so silent
 * divergence fails CI.
 *
 * "Purchasable" here means gate-passing (registry entry + price + gate
 * endpoint + receipt path + run-status surface), NOT activated checkout.
 * Checkout activation is #2468 Phase 5 over #2405/#2012 rails. Subscribed
 * included-run bypass is #2405 Phase 2 — a different program phase — and
 * stays deferred. Trading stays approval-gated and never monetized; nothing
 * in this module moves funds.
 */

import { TRADING_PAID_SERVICES } from "../services/agenticPayments";
import {
  PRICE_FAMILIES,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";
import { VALID_TIERS, type StoreTier } from "./commercialPorts";
import { AGENT_CARDS } from "../a2a/agent-cards";
import { getAgentByClass } from "../agents/registry";

export type ProductTier = StoreTier;
export type ProductAvailability =
  | "purchasable"
  | "entitlement-pending"
  | "ungated-discovery"
  | "unlisted";

export function productId(family: PriceFamily, tier: ProductTier): string {
  return `${family}:${tier}`;
}

/** Join keys only (no prices, no names): family → gate service key. */
export const FAMILY_GATE_KEY: Record<
  PriceFamily,
  keyof typeof TRADING_PAID_SERVICES | null
> = {
  stock: "STOCK_SIGNALS",
  options: "OPTIONS_SCREENER",
  goal: null,
  strategy: null,
};

/** Product → serving agent card name (null = no serving card exists). */
export const PRODUCT_SERVING_AGENTS: Record<PriceFamily, string | null> = {
  stock: "screener",
  goal: "screener",
  options: "trading",
  strategy: null,
};

/** Serving card name → mesh registry class (registry-entry check). */
const SERVING_AGENT_CLASS: Record<string, string> = {
  screener: "ScreenerAgent",
  trading: "TradingAgent",
};

export function resolveProductPrice(
  family: PriceFamily,
  catalogueEntry: PriceEntry | null,
): { priceUSD: number | null; source: "gate" | "catalogue-approved" | null } {
  const gateKey = FAMILY_GATE_KEY[family];
  if (gateKey) {
    return {
      priceUSD: TRADING_PAID_SERVICES[gateKey].priceUSD,
      source: "gate",
    };
  }
  if (catalogueEntry && catalogueEntry.approvalStatus === "approved") {
    return { priceUSD: catalogueEntry.priceUSD, source: "catalogue-approved" };
  }
  return { priceUSD: null, source: null };
}

/**
 * The naming registry: one canonical name per product. Gated families take
 * the gate's product name (single source — the gate, not invented copy).
 * Ungated families have no gate name; their name is the provisional
 * family × tier label, never marketing copy presented as approved.
 */
export function canonicalProductName(
  family: PriceFamily,
  tier: ProductTier,
): string {
  const gateKey = FAMILY_GATE_KEY[family];
  if (gateKey) {
    return TRADING_PAID_SERVICES[gateKey].name;
  }
  return `${family} × ${tier}`;
}

export interface ProductGateRequirements {
  registryEntry: boolean;
  price: boolean;
  gateEndpoint: boolean;
  receiptPath: boolean;
  runStatusSurface: boolean;
}

export interface ProductEntry {
  id: string;
  family: PriceFamily;
  tier: ProductTier;
  canonicalName: string;
  servingAgent: string | null;
  gateEndpoint: string | null;
  /** Price charged for THIS tier; null unless PayPerUse with a chargeable price. */
  priceUSD: number | null;
  priceSource: "gate" | "catalogue-approved" | null;
  availability: ProductAvailability;
  requirements: ProductGateRequirements;
  listed: boolean;
  unlistedReasons: string[];
}

export interface BuildCatalogOptions {
  /** Shared run-status surface present (AsyncJobsPanel/WorkflowRunsPanel). */
  runStatusSurfacePresent?: boolean;
}

export function buildProductCatalog(
  catalogueEntries: PriceEntry[],
  options?: BuildCatalogOptions,
): ProductEntry[] {
  const runStatusSurface = options?.runStatusSurfacePresent ?? true;
  const byFamily = new Map(catalogueEntries.map((e) => [e.family, e]));
  const rows: ProductEntry[] = [];
  for (const family of PRICE_FAMILIES) {
    const gateKey = FAMILY_GATE_KEY[family];
    const gate = gateKey ? TRADING_PAID_SERVICES[gateKey] : null;
    const resolved = resolveProductPrice(family, byFamily.get(family) ?? null);
    const servingAgent = PRODUCT_SERVING_AGENTS[family];
    const card =
      servingAgent !== null
        ? AGENT_CARDS.find((c) => c.name === servingAgent)
        : undefined;
    const registryEntry =
      servingAgent !== null &&
      card !== undefined &&
      getAgentByClass(SERVING_AGENT_CLASS[servingAgent] ?? "") !== undefined;
    const requirements: ProductGateRequirements = {
      registryEntry,
      price: resolved.priceUSD !== null,
      gateEndpoint: gate !== null,
      receiptPath: gate !== null,
      runStatusSurface,
    };
    for (const tier of VALID_TIERS) {
      const id = productId(family, tier);
      const canonicalName = canonicalProductName(family, tier);
      if (tier === "Subscribed") {
        rows.push({
          id,
          family,
          tier,
          canonicalName,
          servingAgent,
          gateEndpoint: gate ? gate.resource : null,
          priceUSD: null,
          priceSource: null,
          availability: "entitlement-pending",
          requirements,
          listed: false,
          unlistedReasons: [
            "Subscribed entitlement pending #2405 Phase 2 — no subscription price asserted",
          ],
        });
        continue;
      }
      if (tier === "Free") {
        rows.push({
          id,
          family,
          tier,
          canonicalName,
          servingAgent,
          gateEndpoint: gate ? gate.resource : null,
          priceUSD: null,
          priceSource: null,
          availability: "ungated-discovery",
          requirements,
          listed: false,
          unlistedReasons: [
            "Free tier is ungated discovery, not a purchasable product",
          ],
        });
        continue;
      }
      const unlistedReasons: string[] = [];
      if (!requirements.registryEntry) {
        unlistedReasons.push(
          servingAgent === null
            ? "missing serving card"
            : "serving agent not registered in the mesh registry",
        );
      }
      if (!requirements.price) {
        unlistedReasons.push("missing approved price");
      }
      if (!requirements.gateEndpoint) {
        unlistedReasons.push("missing gate endpoint");
      }
      if (!requirements.receiptPath) {
        unlistedReasons.push("missing metered receipt path");
      }
      if (!requirements.runStatusSurface) {
        unlistedReasons.push("missing run-status surface");
      }
      const listed = unlistedReasons.length === 0;
      rows.push({
        id,
        family,
        tier,
        canonicalName,
        servingAgent,
        gateEndpoint: gate ? gate.resource : null,
        priceUSD: resolved.priceUSD,
        priceSource: resolved.source,
        availability: listed ? "purchasable" : "unlisted",
        requirements,
        listed,
        unlistedReasons,
      });
    }
  }
  return rows;
}

export function listedProducts(catalog: ProductEntry[]): ProductEntry[] {
  return catalog.filter((p) => p.listed);
}

export function getProduct(
  catalog: ProductEntry[],
  id: string,
): ProductEntry | undefined {
  return catalog.find((p) => p.id === id);
}
