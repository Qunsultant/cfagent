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
 *   2. Premium service descriptors (TRADING_PAID_SERVICES, #2405 slices
 *      1–4): the endpoint + product name for gated families. Descriptors
 *      carry NO price (#5609): the price is the approved catalogue price
 *      of the family's premium service (stock → stock-signals, options →
 *      options-scan), resolved from the catalogue entry the caller passes.
 *   3. Price catalogue approval state (src/data/priceCataloguePorts.ts,
 *      #2012 #2185/#2189 + #2547 approval): only an APPROVED catalogue price
 *      may be charged; a PROPOSED seed is never presented as chargeable.
 *   + Tier model (StoreTier, #2405 slice 3 #2522/#2526): Free | PayPerUse |
 *     Subscribed.
 *
 * Families are the price catalogue's PriceFamily union (stock | goal |
 * options | strategy). The premium families (options-scan, market-research,
 * stock-signals, #5609) are catalogue families, not catalog families: they
 * name the paid premium services whose approved prices the gated family
 * rows charge, and they never become per-run product rows themselves.
 * Market-research has no per-run family row — it is sold through its gate
 * only, priced by its own catalogue family.
 *
 * Price resolution order (never a guess, never a fallback to a seed):
 *   approved catalogue price (the premium entry for gated families, the
 *   family's own entry otherwise) → null (unpriced → unlisted with a
 *   named reason).
 *
 * Two deliberate distinctions, documented so they cannot be misread:
 *   - requirements.price means "a chargeable price exists for this FAMILY"
 *     (approved catalogue price). priceUSD means "the price charged for
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
  type PremiumPriceFamily,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";
import { VALID_TIERS, type StoreTier } from "./commercialPorts";
import { AGENT_CARDS } from "../a2a/agent-cards";
import { getAgentByClass } from "../agents/registry";
import { isKnownFeatureFlag, type FeatureFlag } from "../features/featureFlagPorts";
// Issue #4696 — created products are subscription-store rows: the
// builder below reads plan rows + product rows (both supplied by the
// caller; this module still reads no store itself).
import {
  DEFAULT_SEGMENT,
  FREE_PRODUCT_ID,
  resolveEffectiveVersion,
  type ProductRecord,
} from "./productPorts";
import {
  isPlanPriceApproved,
  type SubscriptionPlanRecord,
} from "./subscriptionPorts";

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

/**
 * #5609 (G-7): the premium catalogue family whose APPROVED price a
 * per-run family charges (null = the family's own catalogue entry).
 * Gated families sell their premium service, so their catalog price
 * is the premium price — never the per-run native-gate price for the
 * same family label.
 */
export const PREMIUM_FAMILY_FOR_PER_RUN: Record<PriceFamily, PremiumPriceFamily | null> = {
  stock: "stock-signals",
  options: "options-scan",
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
): { priceUSD: number | null; source: "catalogue-approved" | null } {
  // #5609 (G-7): the price is the APPROVED catalogue price of the
  // entry the caller resolved for this family — the premium
  // service's entry for gated families (stock → stock-signals,
  // options → options-scan), the family's own entry otherwise.
  // There is no gate price anymore: the gate table carries no
  // price. A PROPOSED-only or missing entry is unpriced (null),
  // never a fallback to a seed or to the per-run price.
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
  /**
   * Issue #4696 — null for created products: they are not
   * family-scoped (plans carry no family; subscription products
   * are not family-scoped). Family-keyed consumers must guard
   * the null (productAccess panel lookup, bundle member prices,
   * cfpay channel select) — never default it to a family.
   */
  family: PriceFamily | null;
  tier: ProductTier;
  canonicalName: string;
  servingAgent: string | null;
  gateEndpoint: string | null;
  /** Price charged for THIS tier; null unless PayPerUse with a chargeable price. */
  priceUSD: number | null;
  /**
   * Issue #4696 — "plan-approved": the price is the effective
   * version's APPROVED plan price, not a price-catalogue price.
   * Never "catalogue-approved" for a created row.
   */
  priceSource: "catalogue-approved" | "plan-approved" | null;
  /**
   * Issue #4696 — the effective version's period in days; null
   * for family rows (their price is per call, not per period).
   * Carried so the display can label a created row's price with
   * its period ("$1.00 / 30 days").
   */
  periodDays: number | null;
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
    // #5609 (G-7): the price comes from the premium entry for gated
    // families, the family's own entry otherwise — never the gate.
    const priceFamily = PREMIUM_FAMILY_FOR_PER_RUN[family] ?? family;
    const resolved = resolveProductPrice(family, byFamily.get(priceFamily) ?? null);
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
          periodDays: null,
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
          periodDays: null,
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
        periodDays: null,
        availability: listed ? "purchasable" : "unlisted",
        requirements,
        listed,
        unlistedReasons,
      });
    }
  }
  return rows;
}

/**
 * Issue #4696 — one catalog row per created SUBSCRIPTION product.
 *
 * Listing shape (decided for this slice; see the #4696 PR body):
 * one row per PRODUCT, not per version — the effective version for
 * the caller's segment only, resolved with the one resolver
 * (resolveEffectiveVersion), the same semantics GET /plans uses for
 * buyers. The catalog has no caller account, so the segment is the
 * default segment (the segment every existing row is backfilled
 * into). A product with no effective version is still a row,
 * unlisted with a named reason — the same always-present pattern
 * as the family rows — never silently omitted.
 *
 * Only subscription-kind products are wired here: plan rows ARE
 * subscription versions. per_run products already ARE the family
 * rows (a per_run product is a family, `prod-per-run-<family>`);
 * runs_pack products live in a different version store
 * (RunsPackAdapters) with a different purchase flow — their
 * wiring is a follow-on slice, not this one. prod-free (the
 * read-only baseline, no versions) is excluded by id.
 *
 * Listing rule (approved prices only): listed = an effective
 * version exists AND its price is APPROVED. The gate
 * requirements do NOT decide this: a created row has no serving
 * agent, no gate endpoint, and no metered receipt path — it is
 * sold through the Selling checkout, not a gate — so the
 * requirements below are honest values, not the listing rule.
 * The unlistedReasons are the source of truth for why a row is
 * not listed, exactly as for family rows.
 *
 * Pure derivation over caller-supplied rows: no store reads.
 */
export function createdProductId(productId: string): string {
  return `created:${productId}`;
}

export interface BuildCreatedProductRowsInput {
  /** All plan rows (active and deactivated — the resolver skips inactive ones). */
  plans: SubscriptionPlanRecord[];
  /** All product rows (every kind — non-subscription kinds are skipped). */
  products: ProductRecord[];
  nowMs: number;
  /** Segment whose effective version lists; default DEFAULT_SEGMENT. */
  segment?: string;
  /** Shared run-status surface present (AsyncJobsPanel/WorkflowRunsPanel). */
  runStatusSurfacePresent?: boolean;
}

export function buildCreatedProductRows(
  input: BuildCreatedProductRowsInput,
): ProductEntry[] {
  const segment = input.segment ?? DEFAULT_SEGMENT;
  const runStatusSurface = input.runStatusSurfacePresent ?? true;
  const plansByProduct = new Map<string, SubscriptionPlanRecord[]>();
  for (const plan of input.plans) {
    const list = plansByProduct.get(plan.productId) ?? [];
    list.push(plan);
    plansByProduct.set(plan.productId, list);
  }
  const ordered = [...input.products].sort(
    (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const rows: ProductEntry[] = [];
  for (const product of ordered) {
    if (product.kind !== "subscription") continue;
    if (product.id === FREE_PRODUCT_ID) continue;
    const versions = plansByProduct.get(product.id) ?? [];
    const requirements: ProductGateRequirements = {
      registryEntry: false,
      price: false,
      gateEndpoint: false,
      receiptPath: false,
      runStatusSurface,
    };
    const base = {
      id: createdProductId(product.id),
      family: null as PriceFamily | null,
      tier: "Subscribed" as ProductTier,
      canonicalName: product.name,
      servingAgent: null as string | null,
      gateEndpoint: null as string | null,
      requirements,
    };
    if (versions.length === 0) {
      rows.push({
        ...base,
        priceUSD: null,
        priceSource: null,
        periodDays: null,
        availability: "unlisted",
        listed: false,
        unlistedReasons: ["no versions yet — the product has no plan versions"],
      });
      continue;
    }
    const effective = resolveEffectiveVersion(versions, segment, input.nowMs);
    if (effective === null) {
      rows.push({
        ...base,
        priceUSD: null,
        priceSource: null,
        periodDays: null,
        availability: "unlisted",
        listed: false,
        unlistedReasons: [
          `no effective version for the ${segment} segment — no active version is currently effective`,
        ],
      });
      continue;
    }
    const approved = isPlanPriceApproved(effective);
    requirements.price = approved;
    rows.push({
      ...base,
      priceUSD: approved ? effective.priceUSD : null,
      priceSource: approved ? "plan-approved" : null,
      periodDays: effective.periodDays,
      availability: approved ? "purchasable" : "unlisted",
      listed: approved,
      unlistedReasons: approved ? [] : ["plan price not approved — only an approved plan price may be charged"],
    });
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

/**
 * Issue #2620 (slice 7) — product bundle configuration.
 *
 * Bundles are CONFIGURATION, never code forks: a bundle lists the
 * feature flags it shows under, states when it is shown, and
 * records who approved it and when. A bundle is not a product
 * family and never carries a price — pricing changes are out of
 * scope for the product-mix loop, and a bundle must never be used
 * to smuggle one in. No bundles exist yet: this is the type and
 * the validator only. The first bundle is approved per change
 * (naming product, change, and evidence) and lands as its own
 * issue/PR through the Merge Queue with its own §15.
 *
 * `showWhen` states the display condition in flag terms
 * (allFlagsOn / anyFlagOn, plus a human-readable note). An
 * explicitly OFF flag always wins over a bundle listing it —
 * the slice-1 inheritance rule (featureFlagPorts.ts) is not
 * overridden here.
 */
export interface ProductBundleShowWhen {
  /** Every one of these flags must be ON for the bundle to show. */
  allFlagsOn?: FeatureFlag[];
  /** At least one of these flags must be ON for the bundle to show. */
  anyFlagOn?: FeatureFlag[];
  /** Human-readable statement of when the bundle is shown. */
  note?: string;
}

export interface ProductBundleConfig {
  id: string;
  name: string;
  /** Feature flags listed in this bundle. */
  flags: FeatureFlag[];
  showWhen: ProductBundleShowWhen;
  /** Approver login/name; null until approved. */
  approvedBy: string | null;
  /** Approval timestamp (ISO); null until approved. */
  approvedAt: string | null;
  status: "proposed" | "approved" | "deprecated";
}

/** Validate a bundle config; [] means valid. */
export function validateProductBundleConfig(config: ProductBundleConfig): string[] {
  const errors: string[] = [];
  if (config.id.trim() === "") errors.push("bundle id must not be empty");
  if (config.name.trim() === "") errors.push("bundle name must not be empty");
  if (config.flags.length === 0) errors.push("bundle must list at least one flag");
  const seen = new Set<string>();
  for (const flag of config.flags) {
    if (!isKnownFeatureFlag(flag)) errors.push(`unknown flag: ${flag}`);
    if (seen.has(flag)) errors.push(`duplicate flag: ${flag}`);
    seen.add(flag);
  }
  const showWhen = config.showWhen;
  for (const flag of [...(showWhen.allFlagsOn ?? []), ...(showWhen.anyFlagOn ?? [])]) {
    if (!isKnownFeatureFlag(flag)) errors.push(`unknown flag in showWhen: ${flag}`);
  }
  const hasCondition =
    (showWhen.allFlagsOn?.length ?? 0) > 0 ||
    (showWhen.anyFlagOn?.length ?? 0) > 0 ||
    (showWhen.note?.trim() ?? "") !== "";
  if (!hasCondition) errors.push("showWhen must state a condition");
  if (config.approvedAt !== null && config.approvedBy === null) {
    errors.push("approvedAt is set but approvedBy is missing");
  }
  if (config.approvedBy !== null && config.approvedAt === null) {
    errors.push("approvedBy is set but approvedAt is missing");
  }
  if (config.status === "approved" && (config.approvedBy === null || config.approvedAt === null)) {
    errors.push("approved bundle requires approvedBy and approvedAt");
  }
  return errors;
}

/** True only for an approved bundle with approver and timestamp recorded. */
export function isBundleApproved(config: ProductBundleConfig): boolean {
  return (
    config.status === "approved" &&
    config.approvedBy !== null &&
    config.approvedAt !== null &&
    validateProductBundleConfig(config).length === 0
  );
}
