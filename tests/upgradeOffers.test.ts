// @vitest-environment node
/**
 * Issue #3246 (slice 1, sub-issue of #3241) — upgrade-offer
 * derivation: the pure resolveOffer service over fake ports.
 *
 * Pins the §2.3 eligibility matrix (first failure wins), the
 * §3.3 ladder (D-1: ranked-before-unranked, rank ascending,
 * includedRuns ASCENDING, priceUSD ascending — more runs sort
 * higher), the §3.2 target split (approved higher / downgrade /
 * PROPOSED unavailable), the §2.4 payload shape, the annual
 * option, the referral mention, and the audit-only
 * parseOfferContext. The gate is untouched: the coverage mirror
 * reads the gate's order (grant+quota, Free allowance,
 * Subscribed+included-runs, credits>=approved price) without
 * consuming anything.
 */
import { describe, expect, it } from "vitest";
import {
  PROPOSED_SEED_BILLING_POLICY,
  type BillingPolicy,
  type OfferRules,
} from "../src/data/billingPolicyPorts";
import type { CommercialAccountRecord, CommercialStore } from "../src/data/commercialPorts";
import type { FreeRunCounter } from "../src/data/freeRunCounterPorts";
import type { ApprovedFreeQuota } from "../src/data/approvedFreeQuotaPorts";
import type { ReferralCreditPort } from "../src/data/lifecyclePorts";
import type { OfferSuppressionPort } from "../src/data/offerSuppressionPorts";
import type { PriceCatalogue, PriceEntry } from "../src/data/priceCataloguePorts";
import type { ProductRecord, ProductStore } from "../src/data/productPorts";
import type { SubscriptionPlanRecord, SubscriptionStore } from "../src/data/subscriptionPorts";
import type { BillingPolicyStore } from "../src/data/billingPolicyPorts";
import {
  parseOfferContext,
  resolveOffer,
  type ResolveOfferPorts,
} from "../src/services/upgradeOffers";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAY_MS = 86400000;

function seedRules(overrides: Partial<OfferRules> = {}): OfferRules {
  return { ...PROPOSED_SEED_BILLING_POLICY.offerRules, ...overrides };
}

function seedPolicy(rules: OfferRules): BillingPolicy {
  return { ...PROPOSED_SEED_BILLING_POLICY, offerRules: rules };
}

function makeAccount(overrides: Partial<CommercialAccountRecord> = {}): CommercialAccountRecord {
  return {
    id: "u1",
    tenantId: "t1",
    tier: "Free",
    tierSource: null,
    creditsUSD: 0,
    includedRuns: 0,
    unlimitedFreeGrant: null,
    segment: "default",
    updatedAtMs: NOW,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: "prod-basic",
    name: "Basic",
    kind: "subscription",
    description: null,
    rank: 2,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function makePlan(overrides: Partial<SubscriptionPlanRecord> = {}): SubscriptionPlanRecord {
  return {
    id: "plan-basic-v1",
    name: "Basic",
    priceUSD: 49.99,
    periodDays: 30,
    includedRuns: 20,
    trialDays: null,
    approvalStatus: "approved",
    approvedBy: "op1",
    approvedAtMs: NOW - 1000,
    active: true,
    createdAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    productId: "prod-basic",
    segment: "default",
    version: 1,
    effectiveFromMs: NOW - 1000,
    effectiveToMs: null,
    billingPeriod: "monthly",
    featuresJson: null,
    stripePriceId: null,
    ...overrides,
  };
}

function makeCatalogueEntry(overrides: Partial<PriceEntry> = {}): PriceEntry {
  return {
    id: "cat-stock-default-v1",
    family: "stock",
    priceUSD: 0.02,
    updatedAtMs: NOW - 1000,
    approvalStatus: "approved",
    approvedBy: "op1",
    approvedAtMs: NOW - 1000,
    productId: "prod-per-run-stock",
    segment: "default",
    version: 1,
    effectiveFromMs: NOW - 1000,
    effectiveToMs: null,
    ...overrides,
  };
}

interface FakeState {
  account: CommercialAccountRecord | null;
  subscriptions: Array<Record<string, unknown>>;
  heldPlan: SubscriptionPlanRecord | null;
  plans: SubscriptionPlanRecord[];
  products: ProductRecord[];
  catalogueEntry: PriceEntry | null;
  policy: BillingPolicy;
  suppression: { login: string; trigger: string; suppressedUntilMs: number; dismissedAtMs: number } | null;
  allowance: number | null;
  freeUsed: number;
  quotaSettings: { windowKind: "month"; atLimitAction: "upgrade_or_buy_credits" | "stop" } | null;
  quotaCap: number | null;
  quotaUsed: number;
  referral: {
    rules: { earnAmountUSD: number; vestingDelayMs: number };
    redeemable: number;
    earnings: Array<{ amountUSD: number }>;
    attribution: { referrerUserId: string } | null;
  } | null;
  referralThrows: boolean;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    account: makeAccount(),
    subscriptions: [],
    heldPlan: null,
    plans: [makePlan()],
    products: [makeProduct({ id: "prod-free", name: "Free", rank: 1 }), makeProduct()],
    catalogueEntry: makeCatalogueEntry(),
    policy: seedPolicy(seedRules()),
    suppression: null,
    allowance: null,
    freeUsed: 0,
    quotaSettings: null,
    quotaCap: null,
    quotaUsed: 0,
    referral: null,
    referralThrows: false,
    ...overrides,
  };
}

function fakePorts(state: FakeState, overrides: Partial<ResolveOfferPorts> = {}): ResolveOfferPorts {
  const referral: ReferralCreditPort | null =
    state.referral === null && !state.referralThrows
      ? null
      : ({
          getRules: async () => {
            if (state.referralThrows) throw new Error("referral store down");
            return state.referral!.rules;
          },
          redeemableBalance: async () => {
            if (state.referralThrows) throw new Error("referral store down");
            return state.referral!.redeemable;
          },
          listEarnings: async () => {
            if (state.referralThrows) throw new Error("referral store down");
            return state.referral!.earnings;
          },
          getAttribution: async () => {
            if (state.referralThrows) throw new Error("referral store down");
            return state.referral!.attribution;
          },
        } as unknown as ReferralCreditPort);
  return {
    store: { getAccount: async () => state.account } as unknown as CommercialStore,
    subs: {
      listSubscriptions: async () => state.subscriptions,
      getPlan: async () => state.heldPlan,
      listPlans: async () => state.plans,
    } as unknown as SubscriptionStore,
    products: { listProducts: async () => state.products } as unknown as ProductStore,
    catalogue: { getEffectiveEntry: async () => state.catalogueEntry } as unknown as PriceCatalogue,
    policy: { getPolicy: async () => state.policy } as unknown as BillingPolicyStore,
    suppressions: {
      getSuppression: async () => state.suppression,
    } as unknown as OfferSuppressionPort,
    freeRunCounter: {
      getAllowance: async () => state.allowance,
      getUsed: async () => state.freeUsed,
    } as unknown as FreeRunCounter,
    quota: {
      getSettings: async () => state.quotaSettings,
      getCap: async () => state.quotaCap,
      getUsed: async () => state.quotaUsed,
    } as unknown as ApprovedFreeQuota,
    referral,
    ...overrides,
  };
}

async function offer(
  state: FakeState,
  overrides: {
    trigger?: "manual_402" | "skip_notice" | "trial_end" | "quota_exhausted" | "ambient";
    family?: string;
    monetizationEnabled?: boolean;
    topUpAvailable?: boolean;
    ports?: Partial<ResolveOfferPorts>;
    nowMs?: number;
  } = {},
) {
  return resolveOffer({
    login: "u1",
    trigger: overrides.trigger ?? "manual_402",
    // An explicitly-passed `family: undefined` means "no family" (the
    // ambient/missing-family cases); an absent key means stock.
    family: "family" in overrides ? overrides.family : "stock",
    nowMs: overrides.nowMs ?? NOW,
    monetizationEnabled: overrides.monetizationEnabled ?? true,
    topUpAvailable: overrides.topUpAvailable ?? true,
    ports: fakePorts(state, overrides.ports),
  });
}

const GRANT = { grantedBy: "op1", reason: "Owner-approved pilot account", expiresAtMs: null };

describe("resolveOffer input validation (#3246 §5.1)", () => {
  it("throws without a verified login", async () => {
    const state = baseState();
    await expect(
      resolveOffer({
        login: "  ",
        trigger: "manual_402",
        family: "stock",
        nowMs: NOW,
        monetizationEnabled: true,
        topUpAvailable: true,
        ports: fakePorts(state),
      }),
    ).rejects.toThrow(/verified login/);
  });

  it("throws on an unknown trigger", async () => {
    const state = baseState();
    await expect(
      resolveOffer({
        login: "u1",
        trigger: "bogus" as never,
        family: "stock",
        nowMs: NOW,
        monetizationEnabled: true,
        topUpAvailable: true,
        ports: fakePorts(state),
      }),
    ).rejects.toThrow();
  });

  it("throws when family is missing on an interruptive trigger", async () => {
    const state = baseState();
    await expect(offer(state, { family: undefined })).rejects.toThrow(/family is required/);
  });

  it("allows a missing family on ambient", async () => {
    const payload = await offer(baseState(), { trigger: "ambient", family: undefined });
    expect(payload.eligible).toBe(true);
    expect(payload.family).toBeUndefined();
    expect(payload.perRun).toBeNull();
  });

  it("throws FAILURE_OFFER_UNAVAILABLE when a required port is unbound", async () => {
    const state = baseState();
    await expect(offer(state, { ports: { store: null } })).rejects.toMatchObject({
      code: "FAILURE_OFFER_UNAVAILABLE",
    });
    await expect(offer(state, { ports: { catalogue: null } })).rejects.toMatchObject({
      code: "FAILURE_OFFER_UNAVAILABLE",
    });
  });

  it("throws FAILURE_OFFER_UNAVAILABLE when suppressions are unbound on an interruptive trigger", async () => {
    const state = baseState();
    await expect(offer(state, { ports: { suppressions: null } })).rejects.toMatchObject({
      code: "FAILURE_OFFER_UNAVAILABLE",
    });
    // Ambient never reads suppressions: unbound is fine.
    const ambient = await offer(state, { trigger: "ambient", ports: { suppressions: null } });
    expect(ambient.eligible).toBe(true);
  });
});

describe("resolveOffer eligibility rules 1–2 (#3246 §2.3)", () => {
  it("flag OFF disables the offer", async () => {
    const payload = await offer(baseState(), { monetizationEnabled: false });
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_DISABLED");
    expect(payload.targets).toEqual([]);
    expect(payload.perRun).toBeNull();
    expect(payload.topUp).toBeNull();
  });

  it("master switch off disables the offer", async () => {
    const state = baseState({ policy: seedPolicy(seedRules({ enabled: false })) });
    const payload = await offer(state);
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_DISABLED");
  });

  it("a disabled trigger toggle disables only that trigger", async () => {
    const state = baseState({
      policy: seedPolicy(seedRules({ triggersEnabled: { manual402: false, skipNotice: true, trialEnd: true, quotaExhausted: true, ambient: true } })),
    });
    expect((await offer(state)).reasonCode).toBe("FAILURE_OFFER_DISABLED");
    expect((await offer(state, { trigger: "skip_notice" })).eligible).toBe(true);
  });

  it("rule 1 wins over rule 2 (first failure wins)", async () => {
    const state = baseState({ policy: seedPolicy(seedRules({ enabled: false })) });
    const payload = await offer(state, { monetizationEnabled: false });
    expect(payload.reasonCode).toBe("FAILURE_OFFER_DISABLED");
  });
});

describe("resolveOffer suppression rule 3 (#3246 §2.3/§4.4)", () => {
  it("an active suppression hides the offer", async () => {
    const state = baseState({
      suppression: { login: "u1", trigger: "manual_402", suppressedUntilMs: NOW + DAY_MS, dismissedAtMs: NOW - 1000 },
    });
    const payload = await offer(state);
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_SUPPRESSED");
  });

  it("an expired suppression does not hide the offer", async () => {
    const state = baseState({
      suppression: { login: "u1", trigger: "manual_402", suppressedUntilMs: NOW - 1, dismissedAtMs: NOW - 8 * DAY_MS },
    });
    expect((await offer(state)).eligible).toBe(true);
  });

  it("ambient ignores suppressions", async () => {
    const state = baseState({
      suppression: { login: "u1", trigger: "ambient", suppressedUntilMs: NOW + DAY_MS, dismissedAtMs: NOW - 1000 },
    });
    expect((await offer(state, { trigger: "ambient" })).eligible).toBe(true);
  });
});

describe("resolveOffer coverage mirror rule 4 (#3246 §2.3)", () => {
  it("grant + quota room = coverage, no offer", async () => {
    const state = baseState({
      account: makeAccount({ unlimitedFreeGrant: GRANT }),
      quotaSettings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
      quotaCap: 10,
      quotaUsed: 3,
    });
    const payload = await offer(state);
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
  });

  it("grant + quota at cap + upgrade action = offer (the gate refuses, the offer may show)", async () => {
    const state = baseState({
      account: makeAccount({ unlimitedFreeGrant: GRANT }),
      quotaSettings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
      quotaCap: 10,
      quotaUsed: 10,
    });
    expect((await offer(state)).eligible).toBe(true);
  });

  it("grant + quota unconfigured = grant fall-through coverage, no offer", async () => {
    const state = baseState({ account: makeAccount({ unlimitedFreeGrant: GRANT }) });
    const payload = await offer(state);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
  });

  it("an expired grant confers no coverage", async () => {
    const state = baseState({
      account: makeAccount({ unlimitedFreeGrant: { ...GRANT, expiresAtMs: NOW - 1 } }),
    });
    expect((await offer(state)).eligible).toBe(true);
  });

  it("Free allowance left = coverage; exhausted = offer", async () => {
    const withRoom = baseState({ allowance: 10, freeUsed: 3 });
    expect((await offer(withRoom)).reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
    const exhausted = baseState({ allowance: 10, freeUsed: 10 });
    expect((await offer(exhausted)).eligible).toBe(true);
    // The payload carries the remaining count when the counter is bound.
    expect((await offer(withRoom)).current.freeRunsRemaining).toBe(7);
  });

  it("Subscribed + included runs left = coverage", async () => {
    const held = makePlan();
    const state = baseState({
      account: makeAccount({ tier: "Subscribed", tierSource: "subscription", includedRuns: 5 }),
      subscriptions: [{ planId: held.id, periodEndMs: NOW + DAY_MS, providerSubscriptionId: null }],
      heldPlan: held,
    });
    expect((await offer(state)).reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
  });

  it("credits >= approved price = coverage; below = offer; PROPOSED price is no yardstick", async () => {
    const rich = baseState({ account: makeAccount({ creditsUSD: 0.02 }) });
    expect((await offer(rich)).reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
    const poor = baseState({ account: makeAccount({ creditsUSD: 0.01 }) });
    expect((await offer(poor)).eligible).toBe(true);
    const proposed = baseState({
      account: makeAccount({ creditsUSD: 100 }),
      catalogueEntry: makeCatalogueEntry({ approvalStatus: "proposed", approvedBy: null, approvedAtMs: null }),
    });
    // A PROPOSED price never counts as coverage: the gate fails closed on it.
    expect((await offer(proposed)).eligible).toBe(true);
    expect((await offer(proposed)).perRun).toBeNull();
  });

  it("ambient relaxes the coverage rule entirely", async () => {
    const state = baseState({ account: makeAccount({ creditsUSD: 100 }) });
    expect((await offer(state, { trigger: "ambient" })).eligible).toBe(true);
  });

  it("a missing account row reads as implicit Free with no coverage", async () => {
    const state = baseState({ account: null });
    const payload = await offer(state);
    expect(payload.eligible).toBe(true);
    expect(payload.current.effectiveTier).toBe("Free");
    expect(payload.current.segment).toBe("default");
  });
});

describe("resolveOffer rules 5–6 (#3246 §2.3)", () => {
  it("no targets + no top-up = NO_TARGET; top-up available keeps the offer eligible", async () => {
    const state = baseState({ plans: [], products: [makeProduct({ id: "prod-free", name: "Free", rank: 1 })] });
    expect((await offer(state, { topUpAvailable: false })).reasonCode).toBe("FAILURE_OFFER_NO_TARGET");
    const withTopUp = await offer(state, { topUpAvailable: true });
    expect(withTopUp.eligible).toBe(true);
    expect(withTopUp.targets).toEqual([]);
    expect(withTopUp.topUp).toEqual({ minUSD: 1, maxUSD: 500 });
  });

  it("rule 6: quota_exhausted + at-limit stop = DISABLED, after the other rules", async () => {
    const state = baseState({
      account: makeAccount({ unlimitedFreeGrant: GRANT }),
      quotaSettings: { windowKind: "month", atLimitAction: "stop" },
      quotaCap: 10,
      quotaUsed: 10,
    });
    const payload = await offer(state, { trigger: "quota_exhausted" });
    expect(payload.reasonCode).toBe("FAILURE_OFFER_DISABLED");
    // The same state on another trigger still offers (rule 6 is quota_exhausted-only).
    expect((await offer(state, { trigger: "manual_402" })).eligible).toBe(true);
  });
});

describe("resolveOffer ladder and targets (#3246 §3.2/§3.3, D-1)", () => {
  function ladderState() {
    const held = makePlan({ id: "plan-basic-v1", productId: "prod-basic", priceUSD: 49.99, includedRuns: 20 });
    return baseState({
      account: makeAccount({ tier: "Subscribed", tierSource: "subscription", includedRuns: 0 }),
      subscriptions: [{ planId: held.id, periodEndMs: NOW + DAY_MS, providerSubscriptionId: null }],
      heldPlan: held,
      products: [
        makeProduct({ id: "prod-free", name: "Free", rank: 1 }),
        makeProduct({ id: "prod-basic", name: "Basic", rank: 2 }),
        makeProduct({ id: "prod-premium", name: "Premium", rank: 3 }),
        makeProduct({ id: "prod-cheap", name: "Cheap", rank: 2 }),
        makeProduct({ id: "prod-unranked", name: "Unranked", rank: null }),
        makeProduct({ id: "prod-per-run-stock", name: "Per-run stock", kind: "per_run", rank: null }),
      ],
      plans: [
        held,
        makePlan({ id: "plan-premium-v1", name: "Premium", productId: "prod-premium", priceUSD: 59.99, includedRuns: 30 }),
        makePlan({ id: "plan-cheap-v1", name: "Cheap", productId: "prod-cheap", priceUSD: 29.99, includedRuns: 10 }),
        makePlan({ id: "plan-unranked-v1", name: "Unranked", productId: "prod-unranked", priceUSD: 9.99, includedRuns: 5 }),
      ],
    });
  }

  it("targets are approved versions ranking strictly higher, nearest first, exactly one recommended", async () => {
    const payload = await offer(ladderState());
    expect(payload.eligible).toBe(true);
    // Rank 3 Premium (nearest step up) before the unranked product (loud misplacement: last).
    expect(payload.targets.map((t) => t.productId)).toEqual(["prod-premium", "prod-unranked"]);
    expect(payload.targets[0].recommended).toBe(true);
    expect(payload.targets[1].recommended).toBe(false);
    // The per-run product is never a subscription target.
    expect(payload.targets.some((t) => t.productId === "prod-per-run-stock")).toBe(false);
    // The held product itself is the current column, never a target.
    expect(payload.targets.some((t) => t.productId === "prod-basic")).toBe(false);
  });

  it("more runs sort higher within a rank (D-1: includedRuns ascending)", async () => {
    const state = ladderState();
    state.plans.push(
      makePlan({ id: "plan-basic-plus-v1", name: "Basic Plus", productId: "prod-cheap", priceUSD: 39.99, includedRuns: 25, effectiveFromMs: NOW - 500, version: 2 }),
    );
    // prod-cheap's effective version is now the 25-run one: same rank as held, more runs → a target.
    const payload = await offer(state);
    expect(payload.targets.map((t) => t.productId)).toEqual(["prod-cheap", "prod-premium", "prod-unranked"]);
    expect(payload.targets[0].recommended).toBe(true);
  });

  it("downgradeTargets populate on ambient only, cheaper-or-fewer first", async () => {
    const interruptive = await offer(ladderState());
    expect(interruptive.downgradeTargets).toEqual([]);
    const ambient = await offer(ladderState(), { trigger: "ambient" });
    expect(ambient.downgradeTargets.map((t) => t.productId)).toEqual(["prod-cheap"]);
    expect(ambient.downgradeTargets[0].buyable).toBe(true);
  });

  it("a Billing-managed held row disables the downgrade buy action, never the upgrade", async () => {
    const state = ladderState();
    state.subscriptions = [{ planId: "plan-basic-v1", periodEndMs: NOW + DAY_MS, providerSubscriptionId: "sub_123" }];
    const ambient = await offer(state, { trigger: "ambient" });
    expect(ambient.downgradeTargets[0]).toMatchObject({ buyable: false, unavailableReason: "billing_managed" });
    expect(ambient.targets.every((t) => t.buyable)).toBe(true);
    expect(ambient.current.heldPlan?.billingManaged).toBe(true);
  });

  it("downgradesEnabled false empties downgradeTargets on ambient", async () => {
    const state = ladderState();
    state.policy = seedPolicy(seedRules({ downgradesEnabled: false }));
    const ambient = await offer(state, { trigger: "ambient" });
    expect(ambient.downgradeTargets).toEqual([]);
  });

  it("PROPOSED versions render as unavailableTargets when showProposed, hidden otherwise", async () => {
    const state = ladderState();
    state.plans.push(
      makePlan({ id: "plan-future-v1", name: "Future", productId: "prod-premium", priceUSD: 99.99, includedRuns: 50, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null, effectiveFromMs: NOW - 500, version: 2 }),
    );
    const shown = await offer(state);
    expect(shown.unavailableTargets.map((t) => t.versionId)).toEqual(["plan-future-v1"]);
    expect(shown.unavailableTargets[0]).toMatchObject({ buyable: false, unavailableReason: "proposed", approvalStatus: "proposed" });
    expect(shown.targets.some((t) => t.versionId === "plan-future-v1")).toBe(false);
    state.policy = seedPolicy(seedRules({ showProposed: false }));
    expect((await offer(state)).unavailableTargets).toEqual([]);
  });

  it("the current side carries the held version's grandfathered price and period end", async () => {
    const payload = await offer(ladderState());
    expect(payload.current.heldPlan).toMatchObject({
      planId: "plan-basic-v1",
      productId: "prod-basic",
      heldPriceUSD: 49.99,
      billingPeriod: "monthly",
      includedRuns: 20,
      periodEndMs: NOW + DAY_MS,
      billingManaged: false,
    });
    expect(payload.current.packRunsRemaining).toBe(0);
    expect(payload.runsPacks).toEqual([]);
  });

  it("an unresolvable held plan reads as no held plan (the floor key applies)", async () => {
    const state = ladderState();
    state.heldPlan = null;
    const payload = await offer(state);
    expect(payload.current.heldPlan).toBeNull();
    expect(payload.targets.map((t) => t.productId)).toContain("prod-basic");
  });
});

describe("resolveOffer annual option (#3246 §2.4)", () => {
  it("populates annualOption only when the primary is monthly and an annual version is effective", async () => {
    const state = baseState({
      plans: [
        makePlan({ id: "plan-basic-monthly", effectiveFromMs: NOW - 1000, version: 2, billingPeriod: "monthly", priceUSD: 49.99 }),
        makePlan({ id: "plan-basic-annual", effectiveFromMs: NOW - 2000, version: 1, billingPeriod: "annual", priceUSD: 509.9, periodDays: 365 }),
      ],
    });
    const payload = await offer(state);
    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0].annualOption).toEqual({
      versionId: "plan-basic-annual",
      priceUSD: 509.9,
      savingsVsMonthlyUSD: 89.98,
    });
  });

  it("no annualOption when the primary is annual", async () => {
    const state = baseState({
      plans: [
        makePlan({ id: "plan-basic-annual", effectiveFromMs: NOW - 1000, version: 2, billingPeriod: "annual", priceUSD: 509.9, periodDays: 365 }),
        makePlan({ id: "plan-basic-monthly", effectiveFromMs: NOW - 2000, version: 1, billingPeriod: "monthly", priceUSD: 49.99 }),
      ],
    });
    const payload = await offer(state);
    expect(payload.targets[0].billingPeriod).toBe("annual");
    expect(payload.targets[0].annualOption).toBeUndefined();
  });

  it("features parse from featuresJson; malformed JSON reads as none", async () => {
    const state = baseState({
      plans: [makePlan({ featuresJson: JSON.stringify(["20 runs", "Priority"]) })],
    });
    expect((await offer(state)).targets[0].features).toEqual(["20 runs", "Priority"]);
    state.plans = [makePlan({ featuresJson: "{not json" })];
    expect((await offer(state)).targets[0].features).toEqual([]);
  });
});

describe("resolveOffer mentions (#3246 §3.8)", () => {
  it("renders the referral mention from rules + balance + earnings + attribution", async () => {
    const state = baseState({
      referral: {
        rules: { earnAmountUSD: 5, vestingDelayMs: 7 * DAY_MS },
        redeemable: 5,
        earnings: [{ amountUSD: 10 }, { amountUSD: 5 }],
        attribution: { referrerUserId: "ref1" },
      },
    });
    const payload = await offer(state);
    expect(payload.mentions.referral).toEqual({
      redeemableUSD: 5,
      totalEarnedUSD: 15,
      earnAmountUSD: 5,
      vestingDelayMs: 7 * DAY_MS,
      attributedReferrer: "ref1",
    });
    expect(payload.mentions.freeAccess).toBeNull();
  });

  it("no referral state renders no mention; the toggle or an unbound port hides it", async () => {
    const empty = baseState({
      referral: { rules: { earnAmountUSD: 5, vestingDelayMs: 7 * DAY_MS }, redeemable: 0, earnings: [], attribution: null },
    });
    expect((await offer(empty)).mentions.referral).toBeNull();
    const toggledOff = baseState({
      policy: seedPolicy(seedRules({ mentionsEnabled: { referral: false, freeAccess: true } })),
      referral: { rules: { earnAmountUSD: 5, vestingDelayMs: 7 * DAY_MS }, redeemable: 5, earnings: [], attribution: null },
    });
    expect((await offer(toggledOff)).mentions.referral).toBeNull();
    expect((await offer(baseState())).mentions.referral).toBeNull();
  });

  it("a referral-store failure degrades the mention, never the offer", async () => {
    const state = baseState({ referralThrows: true });
    const payload = await offer(state);
    expect(payload.eligible).toBe(true);
    expect(payload.mentions.referral).toBeNull();
  });

  it("ineligible payloads carry no mentions", async () => {
    const state = baseState({
      policy: seedPolicy(seedRules({ enabled: false })),
      referral: { rules: { earnAmountUSD: 5, vestingDelayMs: 7 * DAY_MS }, redeemable: 5, earnings: [], attribution: null },
    });
    const payload = await offer(state);
    expect(payload.mentions).toEqual({ referral: null, freeAccess: null });
  });
});

describe("parseOfferContext (#3246 §4.3)", () => {
  it("accepts a well-formed context with and without shownAtMs", () => {
    expect(parseOfferContext({ trigger: "manual_402" })).toEqual({ trigger: "manual_402" });
    expect(parseOfferContext({ trigger: "ambient", shownAtMs: NOW })).toEqual({ trigger: "ambient", shownAtMs: NOW });
  });

  it("reads a malformed context as absent", () => {
    expect(parseOfferContext(undefined)).toBeNull();
    expect(parseOfferContext(null)).toBeNull();
    expect(parseOfferContext("manual_402")).toBeNull();
    expect(parseOfferContext([])).toBeNull();
    expect(parseOfferContext({})).toBeNull();
    expect(parseOfferContext({ trigger: "bogus" })).toBeNull();
    expect(parseOfferContext({ trigger: "manual_402", shownAtMs: "soon" })).toBeNull();
    expect(parseOfferContext({ trigger: "manual_402", shownAtMs: NaN })).toBeNull();
  });
});
