// @vitest-environment node
/**
 * Issue #3246 (slice 3, sub-issue of #3241) — runs packs in
 * upgrade-offer derivation: the pure resolveOffer service over
 * fake ports (the tests/upgradeOffers.test.ts pattern, with pack
 * state added).
 *
 * Pins §3.7 (the runsPacks list: approved effective versions
 * only, segment-scoped, gated by runsPacksEnabled, cheapest
 * first), the rule-4 pack coverage mirror (balance + approved
 * price = coverage; balance + PROPOSED price = no coverage,
 * NQ7), rule 5 with packs as a purchasable action, the real
 * packRunsRemaining balance read, and §3.4 currentPriceUSD on
 * the held plan.
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
import type {
  RunsPackBalancePort,
  RunsPackVersion,
  RunsPackVersionStore,
} from "../src/data/runsPackPorts";
import {
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

function makePackVersion(overrides: Partial<RunsPackVersion> = {}): RunsPackVersion {
  return {
    id: "packver-10",
    productId: "prod-pack-10",
    version: 1,
    segment: "default",
    runs: 10,
    priceUSD: 4.99,
    approvalStatus: "approved",
    approvedBy: "op1",
    approvedAtMs: NOW - 1000,
    active: true,
    effectiveFromMs: NOW - 1000,
    effectiveToMs: null,
    createdAtMs: NOW - 1000,
    updatedAtMs: NOW - 1000,
    ...overrides,
  };
}

function packProduct(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return makeProduct({
    id: "prod-pack-10",
    name: "Pack of 10",
    kind: "runs_pack",
    rank: null,
    ...overrides,
  });
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
  packVersions: RunsPackVersion[];
  packBalance: number;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    account: makeAccount(),
    subscriptions: [],
    heldPlan: null,
    plans: [makePlan()],
    products: [
      makeProduct({ id: "prod-free", name: "Free", rank: 1 }),
      makeProduct(),
      packProduct(),
    ],
    catalogueEntry: makeCatalogueEntry(),
    policy: seedPolicy(seedRules()),
    suppression: null,
    allowance: null,
    freeUsed: 0,
    quotaSettings: null,
    quotaCap: null,
    quotaUsed: 0,
    packVersions: [makePackVersion()],
    packBalance: 0,
    ...overrides,
  };
}

function fakePorts(state: FakeState, overrides: Partial<ResolveOfferPorts> = {}): ResolveOfferPorts {
  const runsPack =
    "runsPack" in overrides
      ? overrides.runsPack
      : {
          versions: {
            listVersions: async (productId: string, segment?: string) =>
              state.packVersions.filter(
                (v) => v.productId === productId && (segment === undefined || v.segment === segment),
              ),
            getVersion: async (id: string) => state.packVersions.find((v) => v.id === id) ?? null,
          } as unknown as RunsPackVersionStore,
          balance: {
            getBalance: async () => state.packBalance,
          } as unknown as RunsPackBalancePort,
        };
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
    referral: null as unknown as ReferralCreditPort,
    runsPack,
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
    family: "family" in overrides ? overrides.family : "stock",
    nowMs: overrides.nowMs ?? NOW,
    monetizationEnabled: overrides.monetizationEnabled ?? true,
    topUpAvailable: overrides.topUpAvailable ?? true,
    ports: fakePorts(state, overrides.ports),
  });
}

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
      packProduct(),
    ],
    plans: [
      held,
      makePlan({ id: "plan-premium-v1", name: "Premium", productId: "prod-premium", priceUSD: 59.99, includedRuns: 30 }),
    ],
  });
}

describe("resolveOffer runsPacks list (#3246 §3.7)", () => {
  it("lists an approved effective pack version with runs + price verbatim", async () => {
    const payload = await offer(baseState());
    expect(payload.eligible).toBe(true);
    expect(payload.runsPacks).toEqual([
      {
        productId: "prod-pack-10",
        name: "Pack of 10",
        versionId: "packver-10",
        runs: 10,
        priceUSD: 4.99,
        effectiveFromMs: NOW - 1000,
      },
    ]);
  });

  it("sorts cheapest first, ties by more runs, then version id", async () => {
    const state = baseState({
      products: [
        makeProduct({ id: "prod-free", name: "Free", rank: 1 }),
        makeProduct(),
        packProduct({ id: "prod-pack-10", name: "Pack of 10" }),
        packProduct({ id: "prod-pack-20", name: "Pack of 20" }),
        packProduct({ id: "prod-pack-5", name: "Pack of 5" }),
      ],
      packVersions: [
        makePackVersion({ id: "packver-20", productId: "prod-pack-20", runs: 20, priceUSD: 9.99 }),
        makePackVersion({ id: "packver-10", productId: "prod-pack-10", runs: 10, priceUSD: 4.99 }),
        makePackVersion({ id: "packver-5a", productId: "prod-pack-5", runs: 5, priceUSD: 4.99 }),
        makePackVersion({ id: "packver-5b", productId: "prod-pack-5", runs: 15, priceUSD: 4.99, version: 2, effectiveFromMs: NOW - 500 }),
      ],
    });
    const payload = await offer(state);
    // Same price: the 15-run version is effective (later
    // effectiveFromMs), so prod-pack-5 sorts before prod-pack-10
    // on runs; prod-pack-20 is dearest and last.
    expect(payload.runsPacks.map((p) => p.versionId)).toEqual(["packver-5b", "packver-10", "packver-20"]);
  });

  it("a PROPOSED pack version never appears", async () => {
    const state = baseState({
      packVersions: [
        makePackVersion({ approvalStatus: "proposed", approvedBy: null, approvedAtMs: null }),
      ],
    });
    expect((await offer(state)).runsPacks).toEqual([]);
  });

  it("a newer PROPOSED version shadows an older approved one: no row until it is approved", async () => {
    const state = baseState({
      packVersions: [
        makePackVersion(),
        makePackVersion({
          id: "packver-11",
          version: 2,
          runs: 20,
          priceUSD: 8.99,
          approvalStatus: "proposed",
          approvedBy: null,
          approvedAtMs: null,
          effectiveFromMs: NOW - 500,
        }),
      ],
    });
    // The effective version for the segment is the PROPOSED one,
    // so no APPROVED effective version resolves for the product.
    expect((await offer(state)).runsPacks).toEqual([]);
  });

  it("a pack version for another segment never appears", async () => {
    const state = baseState({
      packVersions: [makePackVersion({ segment: "enterprise" })],
    });
    expect((await offer(state)).runsPacks).toEqual([]);
    // The same version appears for an enterprise-segment account.
    const enterprise = baseState({
      account: makeAccount({ segment: "enterprise" }),
      packVersions: [makePackVersion({ segment: "enterprise" })],
    });
    expect((await offer(enterprise)).runsPacks).toHaveLength(1);
  });

  it("runsPacksEnabled false reads as no packs", async () => {
    const state = baseState({ policy: seedPolicy(seedRules({ runsPacksEnabled: false })) });
    expect((await offer(state)).runsPacks).toEqual([]);
  });

  it("an unbound runsPack port reads as no packs and a zero balance", async () => {
    const state = baseState({ packBalance: 7 });
    const payload = await offer(state, { ports: { runsPack: null } });
    expect(payload.runsPacks).toEqual([]);
    expect(payload.current.packRunsRemaining).toBe(0);
  });

  it("packRunsRemaining is the real balance read", async () => {
    const state = baseState({ packBalance: 7 });
    const payload = await offer(state, { trigger: "ambient" });
    expect(payload.current.packRunsRemaining).toBe(7);
  });
});

describe("resolveOffer rule 5 with packs as an action (#3246 §2.3)", () => {
  it("no plan targets + packs present + no top-up is still an offer", async () => {
    const state = baseState({
      plans: [],
      products: [makeProduct({ id: "prod-free", name: "Free", rank: 1 }), packProduct()],
    });
    const payload = await offer(state, { topUpAvailable: false });
    expect(payload.eligible).toBe(true);
    expect(payload.targets).toEqual([]);
    expect(payload.runsPacks).toHaveLength(1);
  });

  it("no targets + no packs + no top-up is NO_TARGET", async () => {
    const state = baseState({
      plans: [],
      products: [makeProduct({ id: "prod-free", name: "Free", rank: 1 })],
      packVersions: [],
    });
    const payload = await offer(state, { topUpAvailable: false });
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_NO_TARGET");
  });
});

describe("resolveOffer rule 4 pack coverage mirror (#3246 §2.3, NQ7)", () => {
  it("pack balance + approved price = coverage, no offer", async () => {
    const state = baseState({ packBalance: 3 });
    const payload = await offer(state);
    expect(payload.eligible).toBe(false);
    expect(payload.reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
    expect(payload.current.packRunsRemaining).toBe(3);
  });

  it("pack balance + PROPOSED family price = no coverage: the gate fails closed on it", async () => {
    const state = baseState({
      packBalance: 3,
      catalogueEntry: makeCatalogueEntry({ approvalStatus: "proposed", approvedBy: null, approvedAtMs: null }),
    });
    const payload = await offer(state);
    expect(payload.eligible).toBe(true);
    expect(payload.perRun).toBeNull();
    expect(payload.current.packRunsRemaining).toBe(3);
  });

  it("an empty pack balance is no coverage (control)", async () => {
    const state = baseState({ packBalance: 0 });
    expect((await offer(state)).eligible).toBe(true);
  });

  it("ambient relaxes the pack coverage rule entirely", async () => {
    const state = baseState({ packBalance: 3 });
    expect((await offer(state, { trigger: "ambient" })).eligible).toBe(true);
  });
});

describe("resolveOffer held-plan currentPriceUSD (#3246 §3.4)", () => {
  it("carries the current effective price when a newer approved version exists", async () => {
    const state = ladderState();
    state.plans.push(
      makePlan({
        id: "plan-basic-v2",
        productId: "prod-basic",
        priceUSD: 59.99,
        version: 2,
        effectiveFromMs: NOW - 500,
      }),
    );
    const payload = await offer(state);
    expect(payload.current.heldPlan).toMatchObject({
      planId: "plan-basic-v1",
      heldPriceUSD: 49.99,
      currentPriceUSD: 59.99,
    });
  });

  it("equals the held price when the held version is current", async () => {
    const payload = await offer(ladderState());
    expect(payload.current.heldPlan).toMatchObject({
      planId: "plan-basic-v1",
      heldPriceUSD: 49.99,
      currentPriceUSD: 49.99,
    });
  });

  it("is null when no approved effective version resolves for the held product", async () => {
    const held = makePlan({ id: "plan-basic-v1", productId: "prod-basic", priceUSD: 49.99, includedRuns: 20 });
    const state = baseState({
      account: makeAccount({ tier: "Subscribed", tierSource: "subscription", includedRuns: 0 }),
      subscriptions: [{ planId: held.id, periodEndMs: NOW + DAY_MS, providerSubscriptionId: null }],
      heldPlan: held,
      // The held plan resolves via getPlan, but no approved
      // version is listed for its product — nothing current.
      plans: [],
    });
    const payload = await offer(state);
    expect(payload.current.heldPlan).toMatchObject({
      planId: "plan-basic-v1",
      heldPriceUSD: 49.99,
      currentPriceUSD: null,
    });
  });

  it("a PROPOSED newer version never sets the current price", async () => {
    const state = ladderState();
    state.plans.push(
      makePlan({
        id: "plan-basic-v2",
        productId: "prod-basic",
        priceUSD: 59.99,
        version: 2,
        approvalStatus: "proposed",
        approvedBy: null,
        approvedAtMs: null,
        effectiveFromMs: NOW - 500,
      }),
    );
    const payload = await offer(state);
    expect(payload.current.heldPlan).toMatchObject({ currentPriceUSD: 49.99 });
  });
});
