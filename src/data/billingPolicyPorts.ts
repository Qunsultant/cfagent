/**
 * Issue #2202 (sub-issue of #2020, implementation of design
 * #2145) — externalized billing policy port.
 *
 * Billing policy is OPERATOR DATA, never code constants: the
 * billing service reads periods, dunning, grace, downgrade
 * timing, proration, and the repurchase-migration choice through
 * this port, and an operator changes any of them with no code
 * deploy. This module is the ADR 0002 R1 boundary: it imports
 * no store client, references no env binding, and writes no
 * SQL. Only the adapters (Drizzle D1, in-memory) touch a
 * store, and only the composition root
 * (createBillingPolicyPorts.ts) maps a Worker binding to an
 * adapter.
 *
 * Fail-closed contract: a missing policy row reads as the
 * seeded default below (the seed values are WRITE-time data
 * only, written into the store at schema-ensure time, exactly
 * like the price catalogue seeds — the service never reads
 * this constant at runtime except through the store merge).
 * An invalid stored value THROWS, never silently falls back
 * to a guessed policy. All seeded values are PROPOSED pending
 * owner approval, not an activation: the monetization flag
 * stays OFF and no live charge follows from this module.
 *
 * Dunning note (honest scope): the retry schedule here is
 * the LOCAL notice/grace policy (when access downgrades after
 * a failed renewal). Stripe's own provider-side automatic
 * collection retries are a separate dashboard setting and are
 * NOT configured by this slice — this slice never claims to
 * set them via API.
 *
 * Period note: billing periods are policy for plan/price
 * creation and are recorded in provider metadata at create
 * time. They are NOT enforced against legacy plan.periodDays
 * in this slice: a Stripe Price object carries its own
 * interval on the provider side, and the operator-mapped
 * price id (stripePriceByPlan) is the binding between a plan
 * and its provider interval. A plan with no mapped price id
 * refuses a Billing create (fail closed).
 */

/** Billing periods a plan may be offered on. */
export type BillingPeriod = "monthly" | "annual";

/** When access downgrades after cancellation / failure. */
export type DowngradeTiming = "period_end" | "immediate";

/** Stripe proration behaviours (verified against the Stripe API reference: none / create_prorations / always_invoice). */
export type ProrationBehavior = "none" | "create_prorations" | "always_invoice";

// Issue #3357: the ONLY import this pure port module takes — the outcome
// catalog resolver, which reads a static JSON catalog (no store client,
// no env binding, no SQL), so assert failures surface as typed,
// catalog-coded outcomes instead of raw throws.
import { BusinessError } from "../outcomes/outcomeAspects";

/** What happens to existing repurchase-based subscriptions when Billing activates. */
export type RepurchaseMigration = "grandfather" | "expire" | "migrate";

/** One delay, in whole days, in the dunning notice schedule. */
export type DunningRetryDelayDays = number;

export interface BillingPolicy {
  /** Default period for newly created provider subscriptions. */
  billingPeriodDefault: BillingPeriod;
  /** Periods an operator may offer. */
  billingPeriodsAllowed: BillingPeriod[];
  /** Notice/retry delays in days after a failed renewal, in order. */
  dunningRetryDelayDays: DunningRetryDelayDays[];
  /** Days of continued access after a renewal failure (past_due). */
  gracePeriodDays: number;
  /** Default downgrade timing; period_end matches cancel-at-period-end. */
  downgradeTiming: DowngradeTiming;
  /** Proration rule applied on provider subscription updates. */
  prorationBehavior: ProrationBehavior;
  /** Migration path for existing repurchase subscriptions. */
  repurchaseMigration: RepurchaseMigration;
  /** Operator mapping: local plan id -> Stripe Price id (price_*). Empty = fail closed. */
  stripePriceByPlan: Record<string, string>;
  /**
   * Issue #2781: operator mapping: local bundle id -> Stripe
   * Price id (price_*). Empty = fail closed: a bundle with no
   * mapped price id refuses mint and purchase with 503 (operator
   * configuration gap, not a client error), exactly like an
   * unmapped plan.
   */
  stripePriceByBundle: Record<string, string>;
  /**
   * Issue #2945: operator-attested fixed charge for cfpay channel
   * checkouts, in USD. The card takes no amount input, so the channel
   * is offered ONLY for catalogue products whose approved price exactly
   * equals this value. Null = the channel is not configured (mint
   * refuses 503). Never a code constant: an operator sets it through
   * the billing-policy route, and only an operator changes it.
   */
  cfpayChannelFixedPriceUSD: number | null;
  /**
   * Issue #3262: self-service top-up amount bounds, in USD. A top-up
   * mint refuses an amount outside [topUpMinUSD, topUpMaxUSD].
   * Operator data, never code constants: an operator sets them
   * through the billing-policy route (and the Billing servicing
   * surface), and only an operator changes them.
   */
  topUpMinUSD: number;
  /** Issue #3262: see topUpMinUSD. */
  topUpMaxUSD: number;
  /**
   * Issue #3357: annual discount, in whole percent, applied when an
   * annual plan price is derived from its monthly plan (monthly x 12
   * x (1 - discount)). PROPOSED seed 15. Operator-managed data, never
   * a hardcoded constant: an operator changes it through the
   * billing-policy route, and the next derivation uses the new value.
   */
  annualDiscountPct: number;
  /**
   * Issue #3246: upgrade-offer behavior rules, operator data
   * edited in the Billing servicing surface beside the top-up
   * bounds and annual discount. One JSON-valued policy key
   * (`offer_rules`); the whole block is replaced on update, the
   * same wholesale discipline as `stripePriceByPlan`.
   */
  offerRules: OfferRules;
}

/**
 * Issue #3246 — the offer-rules block. Every offer behavior is
 * operator-configurable with externalized defaults (Mars
 * 2026-11-12): the master switch, per-trigger toggles, the
 * dismissal cooldown, proposed/downgrade/pack visibility, and
 * the mention toggles. Rank is NOT a rule — it lives on the
 * product row (§3.3). `runsPacksEnabled` is read from slice 3
 * and inert until then.
 */
export interface OfferRules {
  /** Master switch; false => no offer is ever computed. */
  enabled: boolean;
  /** Per-trigger toggles; disabling a trigger suppresses that trigger's offer everywhere. */
  triggersEnabled: {
    manual402: boolean;
    skipNotice: boolean;
    trialEnd: boolean;
    quotaExhausted: boolean;
    /** The compare surface itself; false hides compare too. */
    ambient: boolean;
  };
  /** Dismissal cooldown in whole days, 1..365; seed 7 (PROPOSED). */
  dismissCooldownDays: number;
  /** True => effective PROPOSED versions render as unavailable (never buyable). */
  showProposed: boolean;
  /** False => no downgrade targets, platform-wide. */
  downgradesEnabled: boolean;
  /** False => no runs-pack offers (slice 3; inert until then). */
  runsPacksEnabled: boolean;
  /** Per-mention visibility toggles. */
  mentionsEnabled: {
    referral: boolean;
    freeAccess: boolean;
  };
}

/** PROPOSED seed offer rules, NOT owner-approved. All offers on, 7-day cooldown. */
export const PROPOSED_SEED_OFFER_RULES: OfferRules = {
  enabled: true,
  triggersEnabled: {
    manual402: true,
    skipNotice: true,
    trialEnd: true,
    quotaExhausted: true,
    ambient: true,
  },
  dismissCooldownDays: 7,
  showProposed: true,
  downgradesEnabled: true,
  runsPacksEnabled: true,
  mentionsEnabled: {
    referral: true,
    freeAccess: true,
  },
};

/**
 * PROPOSED seed policy, NOT owner-approved and NOT an
 * activation. Written into the store once, at schema-ensure
 * time (INSERT OR IGNORE), so an operator-edited value
 * survives re-ensure. The service reads the store, never
 * this constant, after seeding.
 */
export const PROPOSED_SEED_BILLING_POLICY: BillingPolicy = {
  billingPeriodDefault: "monthly",
  billingPeriodsAllowed: ["monthly", "annual"],
  dunningRetryDelayDays: [1, 3, 7],
  gracePeriodDays: 7,
  downgradeTiming: "period_end",
  prorationBehavior: "create_prorations",
  repurchaseMigration: "grandfather",
  stripePriceByPlan: {},
  // Issue #2781: no bundle price is mapped until an operator maps
  // one — an unmapped bundle refuses mint/purchase fail-closed.
  stripePriceByBundle: {},
  cfpayChannelFixedPriceUSD: null,
  // Issue #3262: owner-decided 2026-11-06 (min $1, max $500).
  // PROPOSED defaults, operator-editable via the Billing servicing
  // surface — never hardcoded, never silently an owner decision.
  topUpMinUSD: 1,
  topUpMaxUSD: 500,
  annualDiscountPct: 15,
  offerRules: PROPOSED_SEED_OFFER_RULES,
};

/** Storage keys for the policy table (one row per key). */
export const BILLING_POLICY_KEYS = {
  billingPeriodDefault: "billing_period_default",
  billingPeriodsAllowed: "billing_periods_allowed",
  dunningRetryDelayDays: "dunning_retry_schedule",
  gracePeriodDays: "grace_period_days",
  downgradeTiming: "downgrade_timing",
  prorationBehavior: "proration_behavior",
  repurchaseMigration: "repurchase_migration",
  stripePriceByPlan: "stripe_price_by_plan",
  stripePriceByBundle: "stripe_price_by_bundle",
  cfpayChannelFixedPriceUSD: "cfpay_channel_fixed_price_usd",
  topUpMinUSD: "top_up_min_usd",
  topUpMaxUSD: "top_up_max_usd",
  annualDiscountPct: "annual_discount_pct",
  offerRules: "offer_rules",
} as const;

export function assertBillingPeriod(value: unknown, field: string): BillingPeriod {
  if (value !== "monthly" && value !== "annual") {
    throw new Error(`${field} must be "monthly" or "annual".`);
  }
  return value;
}

export function assertBillingPeriodsAllowed(value: unknown): BillingPeriod[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("billingPeriodsAllowed must be a non-empty array.");
  }
  return value.map((v, i) => assertBillingPeriod(v, `billingPeriodsAllowed[${i}]`));
}

export function assertDunningRetryDelayDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("dunningRetryDelayDays must be a non-empty array of day counts.");
  }
  for (const v of value) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || Math.floor(v) !== v) {
      throw new Error("dunningRetryDelayDays entries must be non-negative whole days.");
    }
  }
  return [...(value as number[])];
}

export function assertGracePeriodDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error("gracePeriodDays must be a non-negative whole number of days.");
  }
  return n;
}

export function assertDowngradeTiming(value: unknown): DowngradeTiming {
  if (value !== "period_end" && value !== "immediate") {
    throw new Error('downgradeTiming must be "period_end" or "immediate".');
  }
  return value;
}

export function assertProrationBehavior(value: unknown): ProrationBehavior {
  if (value !== "none" && value !== "create_prorations" && value !== "always_invoice") {
    throw new Error('prorationBehavior must be "none", "create_prorations", or "always_invoice".');
  }
  return value;
}

export function assertRepurchaseMigration(value: unknown): RepurchaseMigration {
  if (value !== "grandfather" && value !== "expire" && value !== "migrate") {
    throw new Error('repurchaseMigration must be "grandfather", "expire", or "migrate".');
  }
  return value;
}

/**
 * Issue #3357: the annual discount, in whole percent. 0 means no discount;
 * 100 would price an annual plan at $0, which no plan may carry (assertPlan
 * requires a positive priceUSD) — the bound is still 0..100 here so the
 * policy itself never invents a price rule; derivation validates its result.
 * A rejected value throws a catalog-coded BusinessError, never a raw Error.
 */
export function assertAnnualDiscountPct(value: unknown): number {
  // A discount is a number, not a numeric-looking string and never
  // null/undefined: Number(null) is 0 and Number("15") is 15, so a
  // bare Number() coercion would silently accept both.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new BusinessError("FAILURE_ANNUAL_DISCOUNT_INVALID");
  }
  return value;
}

/**
 * Issue #3357: derive an annual plan price from its monthly plan price and
 * the operator-managed annual discount: monthly x 12 x (1 - discount).
 * Pinned by test: 49.99 at 15% -> 509.90; 59.99 at 15% -> 611.90.
 *
 * Money rule (tech-standards §8, corrected 2026-11-06): money is decimal
 * USD, rounded to cents at defined points — never accumulate unrounded
 * float results. The derivation is the defined rounding point: it runs
 * the multiplication in integer cents (monthly cents x 12 x (100 -
 * discount) / 100, rounded once to the nearest cent) and returns a
 * decimal USD value that is already exact to the cent. The monthly input
 * is a stored 2-decimal price, so Math.round(price * 100) is exact.
 */
export function annualPriceUSD(monthlyPriceUSD: number, discountPct: number): number {
  const discount = assertAnnualDiscountPct(discountPct);
  const monthlyCents = Math.round(monthlyPriceUSD * 100);
  const annualCents = Math.round((monthlyCents * 12 * (100 - discount)) / 100);
  return annualCents / 100;
}

/**
 * Issue #3246: validate the whole offer-rules block. The block is
 * replaced wholesale on update (the stripePriceByPlan discipline),
 * so a partial block is malformed — every field must be present,
 * booleans must be booleans, the cooldown must be a whole number
 * of days in 1..365, and unknown keys are rejected at every level.
 * A rejected value throws a catalog-coded BusinessError, never a
 * raw Error, so the billing-policy route renders the catalog 400.
 * A zero or negative cooldown is rejected — a zero cooldown would
 * make the dismiss button a lie.
 */
export function assertOfferRules(value: unknown): OfferRules {
  const invalid = (): BusinessError => new BusinessError("FAILURE_OFFER_RULES_INVALID");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  const allowed = new Set([
    "enabled",
    "triggersEnabled",
    "dismissCooldownDays",
    "showProposed",
    "downgradesEnabled",
    "runsPacksEnabled",
    "mentionsEnabled",
  ]);
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) throw invalid();
  }
  const isBool = (x: unknown): x is boolean => typeof x === "boolean";
  if (!isBool(v.enabled)) throw invalid();
  if (typeof v.triggersEnabled !== "object" || v.triggersEnabled === null || Array.isArray(v.triggersEnabled)) {
    throw invalid();
  }
  const triggers = v.triggersEnabled as Record<string, unknown>;
  const triggerKeys = ["manual402", "skipNotice", "trialEnd", "quotaExhausted", "ambient"];
  for (const k of Object.keys(triggers)) {
    if (!triggerKeys.includes(k)) throw invalid();
  }
  for (const k of triggerKeys) {
    if (!isBool(triggers[k])) throw invalid();
  }
  const cooldown = v.dismissCooldownDays;
  if (
    typeof cooldown !== "number" ||
    !Number.isFinite(cooldown) ||
    Math.floor(cooldown) !== cooldown ||
    cooldown < 1 ||
    cooldown > 365
  ) {
    throw invalid();
  }
  if (!isBool(v.showProposed) || !isBool(v.downgradesEnabled) || !isBool(v.runsPacksEnabled)) {
    throw invalid();
  }
  if (typeof v.mentionsEnabled !== "object" || v.mentionsEnabled === null || Array.isArray(v.mentionsEnabled)) {
    throw invalid();
  }
  const mentions = v.mentionsEnabled as Record<string, unknown>;
  for (const k of Object.keys(mentions)) {
    if (k !== "referral" && k !== "freeAccess") throw invalid();
  }
  if (!isBool(mentions.referral) || !isBool(mentions.freeAccess)) throw invalid();
  return {
    enabled: v.enabled,
    triggersEnabled: {
      manual402: triggers.manual402 as boolean,
      skipNotice: triggers.skipNotice as boolean,
      trialEnd: triggers.trialEnd as boolean,
      quotaExhausted: triggers.quotaExhausted as boolean,
      ambient: triggers.ambient as boolean,
    },
    dismissCooldownDays: cooldown,
    showProposed: v.showProposed,
    downgradesEnabled: v.downgradesEnabled,
    runsPacksEnabled: v.runsPacksEnabled,
    mentionsEnabled: {
      referral: mentions.referral as boolean,
      freeAccess: mentions.freeAccess as boolean,
    },
  };
}

/** Issue #2945: null (channel unconfigured) or a finite positive USD amount. */
export function assertCfpayChannelFixedPriceUSD(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("cfpayChannelFixedPriceUSD must be null or a finite positive number.");
  }
  return n;
}

/** Issue #3262: a finite positive USD bound. */
export function assertTopUpMinUSD(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("topUpMinUSD must be a finite positive number.");
  }
  return n;
}

/** Issue #3262: a finite positive USD bound. */
export function assertTopUpMaxUSD(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("topUpMaxUSD must be a finite positive number.");
  }
  return n;
}

export function assertStripePriceByPlan(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stripePriceByPlan must be an object mapping plan id to Stripe Price id.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`stripePriceByPlan[${k}] must be a non-empty Stripe Price id.`);
    }
    out[k] = v;
  }
  return out;
}

/** Issue #2781: same contract as assertStripePriceByPlan, keyed by bundle id. */
export function assertStripePriceByBundle(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stripePriceByBundle must be an object mapping bundle id to Stripe Price id.");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`stripePriceByBundle[${k}] must be a non-empty Stripe Price id.`);
    }
    out[k] = v;
  }
  return out;
}

/** Validate a full policy object (used when reading stored rows). */
export function assertBillingPolicy(value: unknown): BillingPolicy {
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) throw new Error("Billing policy must be an object.");
  const policy: BillingPolicy = {
    billingPeriodDefault: assertBillingPeriod(v.billingPeriodDefault, "billingPeriodDefault"),
    billingPeriodsAllowed: assertBillingPeriodsAllowed(v.billingPeriodsAllowed),
    dunningRetryDelayDays: assertDunningRetryDelayDays(v.dunningRetryDelayDays),
    gracePeriodDays: assertGracePeriodDays(v.gracePeriodDays),
    downgradeTiming: assertDowngradeTiming(v.downgradeTiming),
    prorationBehavior: assertProrationBehavior(v.prorationBehavior),
    repurchaseMigration: assertRepurchaseMigration(v.repurchaseMigration),
    stripePriceByPlan: assertStripePriceByPlan(v.stripePriceByPlan),
    stripePriceByBundle: assertStripePriceByBundle(v.stripePriceByBundle),
    cfpayChannelFixedPriceUSD: assertCfpayChannelFixedPriceUSD(v.cfpayChannelFixedPriceUSD),
    topUpMinUSD: assertTopUpMinUSD(v.topUpMinUSD),
    topUpMaxUSD: assertTopUpMaxUSD(v.topUpMaxUSD),
    annualDiscountPct: assertAnnualDiscountPct(v.annualDiscountPct),
    offerRules: assertOfferRules(v.offerRules),
  };
  // Issue #3262: the bounds must order — a min above the max is not a policy.
  if (policy.topUpMinUSD > policy.topUpMaxUSD) {
    throw new Error("topUpMinUSD must not exceed topUpMaxUSD.");
  }
  return policy;
}

/** Validate a partial policy update; unknown keys are rejected. */
export function assertBillingPolicyPartial(value: unknown): Partial<BillingPolicy> {
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || v === null) throw new Error("Billing policy update must be an object.");
  const allowed = new Set([
    "billingPeriodDefault",
    "billingPeriodsAllowed",
    "dunningRetryDelayDays",
    "gracePeriodDays",
    "downgradeTiming",
    "prorationBehavior",
    "repurchaseMigration",
    "stripePriceByPlan",
    "stripePriceByBundle",
    "cfpayChannelFixedPriceUSD",
    "topUpMinUSD",
    "topUpMaxUSD",
    "annualDiscountPct",
    "offerRules",
  ]);
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) throw new Error(`Unknown billing policy field: ${k}.`);
  }
  const out: Partial<BillingPolicy> = {};
  if (v.billingPeriodDefault !== undefined) out.billingPeriodDefault = assertBillingPeriod(v.billingPeriodDefault, "billingPeriodDefault");
  if (v.billingPeriodsAllowed !== undefined) out.billingPeriodsAllowed = assertBillingPeriodsAllowed(v.billingPeriodsAllowed);
  if (v.dunningRetryDelayDays !== undefined) out.dunningRetryDelayDays = assertDunningRetryDelayDays(v.dunningRetryDelayDays);
  if (v.gracePeriodDays !== undefined) out.gracePeriodDays = assertGracePeriodDays(v.gracePeriodDays);
  if (v.downgradeTiming !== undefined) out.downgradeTiming = assertDowngradeTiming(v.downgradeTiming);
  if (v.prorationBehavior !== undefined) out.prorationBehavior = assertProrationBehavior(v.prorationBehavior);
  if (v.repurchaseMigration !== undefined) out.repurchaseMigration = assertRepurchaseMigration(v.repurchaseMigration);
  if (v.stripePriceByPlan !== undefined) out.stripePriceByPlan = assertStripePriceByPlan(v.stripePriceByPlan);
  if (v.stripePriceByBundle !== undefined) out.stripePriceByBundle = assertStripePriceByBundle(v.stripePriceByBundle);
  if (v.cfpayChannelFixedPriceUSD !== undefined) out.cfpayChannelFixedPriceUSD = assertCfpayChannelFixedPriceUSD(v.cfpayChannelFixedPriceUSD);
  if (v.topUpMinUSD !== undefined) out.topUpMinUSD = assertTopUpMinUSD(v.topUpMinUSD);
  if (v.topUpMaxUSD !== undefined) out.topUpMaxUSD = assertTopUpMaxUSD(v.topUpMaxUSD);
  if (v.annualDiscountPct !== undefined) out.annualDiscountPct = assertAnnualDiscountPct(v.annualDiscountPct);
  if (v.offerRules !== undefined) out.offerRules = assertOfferRules(v.offerRules);
  return out;
}

/**
 * The billing-policy store surface. `getPolicy` returns the
 * stored policy merged over the seeded defaults (a missing
 * row reads as its seed value); `updatePolicy` validates and
 * persists only the fields given, so an operator changes one
 * value with no code deploy.
 */
export interface BillingPolicyStore {
  getPolicy(): Promise<BillingPolicy>;
  updatePolicy(partial: Partial<BillingPolicy>): Promise<BillingPolicy>;
}
