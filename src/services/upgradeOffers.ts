/**
 * Issue #3246 (sub-issue of #3241) — upgrade-offer derivation.
 *
 * An offer is a server-computed, read-only presentation of server
 * truth: the caller's current position (account, held version,
 * coverage) against the higher approved effective versions for
 * their segment. Offers are computed deterministically from
 * account state + effective versions + operator offer rules +
 * the user's own dismissals, every time they are requested. Two
 * identical states produce identical offers. Nothing is stored
 * except a dismissal (§4.4); no offer inventory table exists.
 *
 * This service is pure computation over ports, following the
 * versionMoves.ts precedent: no HTTP, no store client, no audit
 * writes. The routes (§5.1) are thin: they bind ports, call
 * resolveOffer, and audit the shown/dismissed events. The gate
 * is untouched — the derivation REUSES the gate's coverage
 * computation read-only (no consumption) to decide whether the
 * next run has coverage, and an offer never grants coverage,
 * never changes a tier, and never mints a checkout.
 *
 * Eligibility (§2.3) is evaluated in the design's order and the
 * FIRST failure wins (the reason recorded, never rendered as a
 * raw code). The reads happen before evaluation — the order
 * governs which reason wins, not short-circuiting — so an
 * ineligible payload still carries a real `current` side.
 *
 * LADDER INTERPRETATION D-1 (design §3.3, recorded: the design
 * text contradicts itself and this resolution is the build's
 * judgment, flagged in the PR body). The design states the total
 * order as "(ranked-before-unranked, rank ascending,
 * includedRuns descending, priceUSD ascending)" with "higher =
 * sorting strictly AFTER". Taken literally, includedRuns
 * descending inside a low-to-high sort inverts the derived rule:
 * fewer runs would sort later and read as HIGHER, so a 5-run
 * plan would be offered as an "upgrade" over a held 30-run plan
 * — contradicting the same section's Rev 1 rule ("the cheapest
 * strict increase in included runs") and its statement that
 * unranked products sort last as a loud misplacement. The build
 * resolves the contradiction in favor of the Rev 1 rule: the
 * low-to-high key is (ranked group first, rank ascending,
 * includedRuns ASCENDING, priceUSD ascending); "higher" is a
 * strictly greater key. This preserves rank order, unranked-last
 * loud misplacement, more-runs-higher, and "recommended = the
 * nearest step up, ties by cheapest".
 *
 * ANNUAL-OPTION INTERPRETATION (design §2.4/§3.3): the target's
 * primary version is the resolver's pick over ALL the product's
 * versions for the segment (the canonical current effective
 * version — the same version GET /plans surfaces and checkout
 * validates). `annualOption` is populated only when the primary
 * is monthly and an effective annual version also exists; its
 * savings are computed from the versions' own prices in integer
 * cents. Products are per-cadence in practice (monthly "Basic"
 * vs annual "Basic Annual" are DIFFERENT products per #3289),
 * so the both-periods case is an edge; the resolver's pick stays
 * canonical.
 *
 * TOP-UP AVAILABILITY (design §2.3 rule 5): the design names "the
 * top-up path is available" as a purchasable action but defines
 * no service-level signal for it. The build takes it as a boolean
 * input from the route: the native checkout ports are configured
 * (a card or x402 port exists) — the same signal the mint routes
 * use. Subscribe targets are NOT gated on checkout availability:
 * the mint route fails closed at the money moment.
 *
 * FAMILY (design §5.1): `family` is required for the four
 * interruptive triggers — the coverage mirror cannot honestly
 * run without the family the at-limit moment concerns — and
 * optional for `ambient`, where it only scopes the per-run line
 * and the free-runs-remaining display. A missing family on an
 * interruptive trigger throws (the route maps it to 400 before
 * calling); the client always knows the family at a 402, skip,
 * or quota moment, and a 400 degrades to today's fixed copy.
 */
import {
  isUnlimitedFreeGrantActive,
  type CommercialStore,
  type StoreTier,
} from "../data/commercialPorts";
import type { OfferSuppressionPort, OfferTrigger } from "../data/offerSuppressionPorts";
import { assertOfferTrigger } from "../data/offerSuppressionPorts";
import {
  DEFAULT_SEGMENT,
  FREE_PRODUCT_ID,
  resolveEffectiveVersion,
  type ProductRecord,
  type ProductStore,
} from "../data/productPorts";
import {
  assertPriceFamily,
  type PriceCatalogue,
  type PriceFamily,
} from "../data/priceCataloguePorts";
import {
  resolveEffectiveTier,
  type SubscriptionPlanRecord,
  type SubscriptionStore,
} from "../data/subscriptionPorts";
import {
  freeRunMonthKey,
  type FreeRunCounter,
} from "../data/freeRunCounterPorts";
import {
  approvedFreeQuotaPeriodKey,
  type ApprovedFreeQuota,
} from "../data/approvedFreeQuotaPorts";
import type { ReferralCreditPort } from "../data/lifecyclePorts";
import type { BillingPolicyStore } from "../data/billingPolicyPorts";
import type {
  RunsPackBalancePort,
  RunsPackVersionStore,
} from "../data/runsPackPorts";
import { BusinessError } from "../outcomes/outcomeAspects";

/** The offer payload (§2.4): one shape, returned by both offer routes. */
export interface OfferPayload {
  trigger: OfferTrigger;
  eligible: boolean;
  /** Outcome-catalog code when ineligible (never a raw string). */
  reasonCode?: string;
  /** The family the at-limit moment concerns. */
  family?: PriceFamily;
  current: {
    effectiveTier: StoreTier;
    /** Null when no subscription row (implicit Free) or the held plan row is unresolvable. */
    heldPlan: {
      planId: string;
      productId: string;
      name: string;
      /** Grandfathered price — what the user pays today for the version they hold. */
      heldPriceUSD: number;
      /**
       * Slice 3 (§3.4): the held product's CURRENT effective
       * price for the segment — the price a new customer pays
       * today — so the comparison's current column shows the
       * current price instead of the held price. Null when no
       * approved effective version resolves for the held product.
       */
      currentPriceUSD: number | null;
      billingPeriod: "monthly" | "annual";
      includedRuns: number;
      /** The subscription row's period end. */
      periodEndMs: number;
      /** True when the held row is provider-managed (providerSubscriptionId !== null). */
      billingManaged: boolean;
    } | null;
    /** Account row only (the gate's source). */
    includedRunsRemaining: number;
    /** Runs-pack balance (slice 3; 0 until then). */
    packRunsRemaining: number;
    creditsUSD: number;
    /** Free-run allowance left, when the counter is bound and the family is known. */
    freeRunsRemaining?: number | null;
    segment: string;
  };
  /** Approved effective versions ranking HIGHER (§3.3). */
  targets: OfferTarget[];
  /** Approved effective versions ranking LOWER — ambient trigger ONLY (§3.6). */
  downgradeTargets: OfferTarget[];
  /** Effective PROPOSED versions (both directions), never buyable. */
  unavailableTargets: OfferTarget[];
  /** Slice 3: effective APPROVED pack versions for the segment. */
  runsPacks: RunsPackOffer[];
  mentions: {
    referral: ReferralMention | null;
    /** Null until #3247 lands (no port exists) or no grant. */
    freeAccess: FreeAccessMention | null;
  };
  /** The pay-per-run alternative, when an approved price exists. */
  perRun: {
    family: PriceFamily;
    priceUSD: number;
    productId: string;
    versionId: string;
  } | null;
  /** Billing-policy bounds; null when top-up unavailable. */
  topUp: { minUSD: number; maxUSD: number } | null;
}

export interface OfferTarget {
  productId: string;
  name: string;
  /** The effective version id (= plan id to buy). */
  versionId: string;
  /** Current effective price for the segment. */
  priceUSD: number;
  approvalStatus: "approved" | "proposed";
  /** False for PROPOSED versions and for Billing-managed downgrades. */
  buyable: boolean;
  /** Present exactly when buyable is false. */
  unavailableReason?: "proposed" | "billing_managed";
  billingPeriod: "monthly" | "annual";
  includedRuns: number;
  periodDays: number;
  trialDays: number | null;
  /** Display-only, from featuresJson (Q11). */
  features: string[];
  effectiveFromMs: number;
  /** When BOTH monthly and annual effective versions exist and the primary is monthly. */
  annualOption?: {
    versionId: string;
    priceUSD: number;
    /** monthly*12 - annual, from the versions' own prices, integer cents. */
    savingsVsMonthlyUSD: number;
  };
  /** Exactly one target: the nearest step up (§3.3). */
  recommended: boolean;
}

/** Slice 3: one runs-pack offer row. */
export interface RunsPackOffer {
  productId: string;
  name: string;
  /** The effective pack version id (= pack id to buy). */
  versionId: string;
  runs: number;
  priceUSD: number;
  effectiveFromMs: number;
}

export interface ReferralMention {
  /** Vested, unspent referral balance. */
  redeemableUSD: number;
  /** All earnings, vested or not. */
  totalEarnedUSD: number;
  /** The operator rule row: earned per referred user. */
  earnAmountUSD: number;
  /** The operator rule row. */
  vestingDelayMs: number;
  /** Who referred this user, if attributed. */
  attributedReferrer: string | null;
}

export interface FreeAccessMention {
  kind: "lifetime" | "limited";
  /** Null for lifetime. */
  expiresAtMs: number | null;
}

/** The ports resolveOffer reads. Null = unbound; see the required/optional contract below. */
export interface ResolveOfferPorts {
  /** Required: the account row (segment, tier, credits, included runs, grant). */
  store: CommercialStore | null;
  /** Required: subscription rows + plan versions. */
  subs: SubscriptionStore | null;
  /** Required: products (names, kinds, ranks). */
  products: ProductStore | null;
  /** Required: the effective catalogue entry (per-run line + credits comparison). */
  catalogue: PriceCatalogue | null;
  /** Required: the billing policy (offer rules + top-up bounds). */
  policy: BillingPolicyStore | null;
  /**
   * Required for interruptive triggers (never a silent unsuppressed
   * offer); unused for `ambient`, which dismissal never hides.
   */
  suppressions: OfferSuppressionPort | null;
  /** Optional: unbound reads as no allowance configured (the gate falls through, so does the offer). */
  freeRunCounter: FreeRunCounter | null;
  /** Optional: unbound reads as no quota configured (the grant fall-through covers, as in the gate). */
  quota: ApprovedFreeQuota | null;
  /** Optional: unbound reads as no referral state (no mention renders). */
  referral: ReferralCreditPort | null;
  /**
   * Slice 3, optional: unbound reads as no pack state — an empty
   * runsPacks list and a zero pack balance, exactly as the offer
   * read before packs existed. The port is bound by the route
   * whenever AGENT_DB is bound.
   */
  runsPack: {
    versions: RunsPackVersionStore;
    balance: RunsPackBalancePort;
  } | null;
}

export interface ResolveOfferInput {
  login: string;
  trigger: OfferTrigger;
  /** Required for interruptive triggers; optional for ambient. */
  family?: string;
  nowMs: number;
  /** The Flagship monetization flag, read by the route. */
  monetizationEnabled: boolean;
  /** The native checkout ports are configured (card or x402) — the top-up availability signal. */
  topUpAvailable: boolean;
  ports: ResolveOfferPorts;
}

/** The ladder key (D-1): low-to-high, lexicographic. Group 0 = ranked, group 1 = unranked. */
interface LadderKey {
  group: 0 | 1;
  rank: number;
  runs: number;
  priceCents: number;
}

function ladderKey(rank: number | null, runs: number, priceUSD: number): LadderKey {
  return {
    group: rank === null ? 1 : 0,
    rank: rank ?? 0,
    runs,
    priceCents: Math.round(priceUSD * 100),
  };
}

function compareLadderKey(a: LadderKey, b: LadderKey): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.runs !== b.runs) return a.runs - b.runs;
  return a.priceCents - b.priceCents;
}

/** The offer-rules trigger key for a trigger (design §4.2 names the manual key `manual402`). */
function triggerRuleKey(trigger: OfferTrigger): "manual402" | "skipNotice" | "trialEnd" | "quotaExhausted" | "ambient" {
  switch (trigger) {
    case "manual_402":
      return "manual402";
    case "skip_notice":
      return "skipNotice";
    case "trial_end":
      return "trialEnd";
    case "quota_exhausted":
      return "quotaExhausted";
    case "ambient":
      return "ambient";
  }
}

/** Parse a plan version's display-only features list; anything unparseable reads as none. */
function parseFeatures(featuresJson: string | null): string[] {
  if (!featuresJson) return [];
  try {
    const parsed: unknown = JSON.parse(featuresJson);
    if (Array.isArray(parsed)) return parsed.filter((f): f is string => typeof f === "string");
  } catch {
    // A malformed features blob never breaks the offer; the row renders with no features.
  }
  return [];
}

export async function resolveOffer(input: ResolveOfferInput): Promise<OfferPayload> {
  const { login, nowMs, ports } = input;
  if (typeof login !== "string" || !login.trim()) {
    throw new Error("Offer derivation requires a verified login.");
  }
  const trigger = assertOfferTrigger(input.trigger);
  const family = input.family === undefined ? undefined : assertPriceFamily(input.family);
  if (trigger !== "ambient" && !family) {
    throw new Error(`family is required for trigger ${trigger}.`);
  }
  const { store, subs, products, catalogue, policy } = ports;
  if (!store || !subs || !products || !catalogue || !policy) {
    throw new BusinessError("FAILURE_OFFER_UNAVAILABLE");
  }
  if (trigger !== "ambient" && !ports.suppressions) {
    throw new BusinessError("FAILURE_OFFER_UNAVAILABLE");
  }

  // ---- Reads (all of them; the rule order governs which reason wins, not short-circuiting). ----
  const fullPolicy = await policy.getPolicy();
  const rules = fullPolicy.offerRules;
  const account = await store.getAccount(login);
  const segment = account?.segment ?? DEFAULT_SEGMENT;
  const subscriptions = await subs.listSubscriptions(login);
  const effectiveTier = resolveEffectiveTier(account, subscriptions, nowMs);
  // The "current" subscription: the row with the latest periodEndMs — the same rule
  // GET /subscription uses (ties keep the earlier row, as in that reduce).
  const heldRow =
    subscriptions.length === 0
      ? null
      : subscriptions.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a));
  const heldPlan: SubscriptionPlanRecord | null = heldRow ? await subs.getPlan(heldRow.planId) : null;
  const heldRowBillingManaged = heldRow?.providerSubscriptionId != null;
  const allPlans = await subs.listPlans(true);
  const allProducts = await products.listProducts();
  const suppression =
    trigger === "ambient" ? null : await ports.suppressions!.getSuppression(login, trigger);

  // Catalogue entry for the family: the per-run line AND the credits comparison price.
  // The effective entry at nowMs, approval-checked — a PROPOSED price is never a buyable
  // alternative and never a credits yardstick (the gate fails closed on it).
  const catalogueEntry = family
    ? await catalogue.getEffectiveEntry(family, segment, nowMs)
    : null;
  const approvedPrice =
    catalogueEntry && catalogueEntry.approvalStatus === "approved" ? catalogueEntry.priceUSD : null;

  // Free-run allowance left (family-scoped; null when the counter is unbound or the family unknown).
  let freeAllowance: number | null = null;
  let freeRunsRemaining: number | null = null;
  let allowanceLeft = false;
  if (family && ports.freeRunCounter) {
    freeAllowance = await ports.freeRunCounter.getAllowance(family);
    const used = await ports.freeRunCounter.getUsed({
      login,
      family,
      month: freeRunMonthKey(nowMs),
    });
    if (freeAllowance !== null) {
      freeRunsRemaining = Math.max(0, freeAllowance - used);
      allowanceLeft = used < freeAllowance;
    }
  }

  // Approved-free quota state. The settings row is read whenever the
  // port is bound: the mirror needs it for grant-holders, and rule 6
  // needs the at-limit action for the quota_exhausted trigger.
  const quotaSettings = ports.quota ? await ports.quota.getSettings() : null;
  const grantActive = isUnlimitedFreeGrantActive(account?.unlimitedFreeGrant, nowMs);
  let quotaConfigured = false;
  let quotaHasRoom = false;
  if (grantActive && family && ports.quota && quotaSettings) {
    const tenantId = account?.tenantId ?? "";
    if (tenantId !== "") {
      quotaConfigured = true;
      const period = approvedFreeQuotaPeriodKey(nowMs, quotaSettings.windowKind);
      const cap = await ports.quota.getCap(family);
      const used = await ports.quota.getUsed({ tenantId, login, family, period });
      quotaHasRoom = cap !== null && cap > 0 && used < cap;
    }
  }

  // Slice 3: the dedicated pack balance — read whenever the port
  // is bound, for the coverage mirror (rule 4) and the `current`
  // side. Unbound reads as zero, exactly as the offer read
  // before packs existed.
  const packRunsRemaining = ports.runsPack ? await ports.runsPack.balance.getBalance(login) : 0;

  // ---- Coverage mirror (rule 4): the gate's order, read-only, no consumption. ----
  // Grant + quota configured: the quota IS the bound — at the cap the gate
  // refuses with no fall-through, so coverage is exactly "room left".
  // Grant + quota unconfigured: the gate falls through to the allowance and
  // then the grant fall-through, which covers — coverage, unconditionally.
  // No grant: the Free allowance (effective Free tier only), then the
  // coverage ternary — Subscribed + included runs, pack balance, else
  // credits >= price. The pack branch needs the approved price too:
  // the gate throws on an unapproved family price BEFORE the pack is
  // read, so a pack balance covers nothing while the price is
  // unapproved (NQ7) — the mirror must say the same.
  // Ambient relaxes this rule entirely: the compare surface renders
  // regardless of coverage.
  let hasCoverage = false;
  if (trigger !== "ambient" && family) {
    if (grantActive) {
      hasCoverage = quotaConfigured ? quotaHasRoom : true;
    } else if (effectiveTier === "Free" && allowanceLeft) {
      hasCoverage = true;
    } else if (effectiveTier === "Subscribed" && (account?.includedRuns ?? 0) > 0) {
      hasCoverage = true;
    } else if (packRunsRemaining > 0 && approvedPrice !== null) {
      hasCoverage = true;
    } else if (approvedPrice !== null && (account?.creditsUSD ?? 0) >= approvedPrice) {
      hasCoverage = true;
    }
  }

  // ---- Ladder + targets (§3.2/§3.3). ----
  const productsById = new Map<string, ProductRecord>();
  for (const p of allProducts) productsById.set(p.id, p);
  const plansByProduct = new Map<string, SubscriptionPlanRecord[]>();
  for (const plan of allPlans) {
    const list = plansByProduct.get(plan.productId) ?? [];
    list.push(plan);
    plansByProduct.set(plan.productId, list);
  }
  // The current position's key: the held version's key when a version is
  // held (its product's rank, else its derived key); the prod-free floor
  // (rank 1, the Free allowance count, price 0) when no subscription is
  // held. An unknown allowance reads as 0 — the lowest rank-1 key, so a
  // rank-1 product with runs still sorts higher.
  const heldProduct = heldPlan ? productsById.get(heldPlan.productId) : undefined;
  const currentKey = heldPlan
    ? ladderKey(heldProduct?.rank ?? null, heldPlan.includedRuns, heldPlan.priceUSD)
    : ladderKey(1, freeAllowance ?? 0, 0);

  const targets: Array<{ target: OfferTarget; key: LadderKey }> = [];
  const downgradeCandidates: Array<{ target: OfferTarget; key: LadderKey }> = [];
  const unavailable: Array<{ target: OfferTarget; key: LadderKey }> = [];
  for (const product of allProducts) {
    if (product.kind !== "subscription") continue;
    // The Free baseline row is never a target; it is the implicit
    // "current" row for accounts with no subscription.
    if (product.id === FREE_PRODUCT_ID) continue;
    const versions = plansByProduct.get(product.id) ?? [];
    const primary = resolveEffectiveVersion(versions, segment, nowMs);
    if (!primary) continue;
    const annual =
      primary.billingPeriod === "monthly"
        ? resolveEffectiveVersion(
            versions.filter((v) => v.billingPeriod === "annual"),
            segment,
            nowMs,
          )
        : null;
    const key = ladderKey(product.rank, primary.includedRuns, primary.priceUSD);
    const annualOption =
      annual === null
        ? undefined
        : {
            versionId: annual.id,
            priceUSD: annual.priceUSD,
            savingsVsMonthlyUSD:
              (Math.round(primary.priceUSD * 100) * 12 - Math.round(annual.priceUSD * 100)) / 100,
          };
    const base: OfferTarget = {
      productId: product.id,
      name: product.name,
      versionId: primary.id,
      priceUSD: primary.priceUSD,
      approvalStatus: primary.approvalStatus === "approved" ? "approved" : "proposed",
      buyable: true,
      billingPeriod: primary.billingPeriod,
      includedRuns: primary.includedRuns,
      periodDays: primary.periodDays,
      trialDays: primary.trialDays,
      features: parseFeatures(primary.featuresJson),
      effectiveFromMs: primary.effectiveFromMs,
      ...(annualOption ? { annualOption } : {}),
      recommended: false,
    };
    if (primary.approvalStatus === "approved") {
      const cmp = compareLadderKey(key, currentKey);
      if (cmp > 0) {
        targets.push({ target: base, key });
      } else if (cmp < 0) {
        // A Billing-managed held row disables the downgrade buy
        // action (§3.6): a native purchase alongside an active
        // Billing subscription cannot deliver paying less next
        // period. Upgrades keep the buy action (the asymmetry is
        // real and stated: buying more runs delivers what it
        // promises either way).
        downgradeCandidates.push({
          target: heldRowBillingManaged
            ? { ...base, buyable: false, unavailableReason: "billing_managed" }
            : base,
          key,
        });
      }
      // Equal keys are the current column — neither array.
    } else if (rules.showProposed) {
      unavailable.push({
        target: { ...base, buyable: false, unavailableReason: "proposed" },
        key,
      });
    }
  }
  const byKey = (a: { key: LadderKey }, b: { key: LadderKey }) => compareLadderKey(a.key, b.key);
  targets.sort(byKey);
  downgradeCandidates.sort(byKey);
  unavailable.sort(byKey);
  // Recommended: exactly one — the nearest step up (the first target in ladder order).
  const targetList = targets.map(({ target }, i) => ({ ...target, recommended: i === 0 }));
  const downgradeTargets =
    trigger === "ambient" && rules.downgradesEnabled
      ? downgradeCandidates.map(({ target }) => target)
      : [];
  const unavailableTargets = unavailable.map(({ target }) => target);

  // ---- Runs packs (§3.7). ----
  // Effective APPROVED pack versions for the segment only, one row
  // per runs_pack product; PROPOSED pack versions never appear
  // (they are not buyable, and the unavailable group is the plans'
  // surface). Gated by the operator rule: runsPacksEnabled false
  // reads as no packs. Sorted cheapest first — the pack group is a
  // price list, not a ladder — ties by more runs, then version id.
  const runsPacks: RunsPackOffer[] = [];
  if (rules.runsPacksEnabled && ports.runsPack) {
    for (const product of allProducts) {
      if (product.kind !== "runs_pack") continue;
      const versions = await ports.runsPack.versions.listVersions(product.id, segment);
      const effective = resolveEffectiveVersion(versions, segment, nowMs);
      if (!effective || effective.approvalStatus !== "approved") continue;
      runsPacks.push({
        productId: product.id,
        name: product.name,
        versionId: effective.id,
        runs: effective.runs,
        priceUSD: effective.priceUSD,
        effectiveFromMs: effective.effectiveFromMs,
      });
    }
    runsPacks.sort(
      (a, b) => a.priceUSD - b.priceUSD || b.runs - a.runs || (a.versionId < b.versionId ? -1 : 1),
    );
  }

  // ---- Eligibility (§2.3), first failure wins. ----
  // Ambient is gated by rules 1–2 only: it renders regardless of
  // coverage (rule 4 relaxed), and a compare surface with only
  // PROPOSED versions still renders them as unavailable columns —
  // rule 5's "no offer" fallback is about the at-limit message,
  // not the surface the user explicitly opened.
  let reasonCode: string | null = null;
  if (!input.monetizationEnabled) {
    reasonCode = "FAILURE_OFFER_DISABLED";
  } else if (!rules.enabled || !rules.triggersEnabled[triggerRuleKey(trigger)]) {
    reasonCode = "FAILURE_OFFER_DISABLED";
  } else if (trigger !== "ambient" && suppression && suppression.suppressedUntilMs > nowMs) {
    reasonCode = "FAILURE_OFFER_SUPPRESSED";
  } else if (trigger !== "ambient" && hasCoverage) {
    reasonCode = "FAILURE_OFFER_COVERAGE_EXISTS";
  } else if (
    trigger !== "ambient" &&
    targetList.length === 0 &&
    runsPacks.length === 0 &&
    !input.topUpAvailable
  ) {
    // Rule 5: a pack is a purchasable action too — an offer with
    // packs to buy is an offer, even with no plan target and no
    // top-up. (Ambient never reaches this rule.)
    reasonCode = "FAILURE_OFFER_NO_TARGET";
  } else if (trigger === "quota_exhausted" && quotaSettings?.atLimitAction === "stop") {
    // Rule 6: the operator's quota at-limit action is `stop` — the
    // stop message renders with no offer. The DISABLED reason: the
    // operator disabled the offer path for quota exhaustion.
    reasonCode = "FAILURE_OFFER_DISABLED";
  }

  // ---- Mentions (§3.8): information, never actions. Eligible responses only. ----
  // A referral-store failure degrades the mention to null: mentions
  // never change eligibility, and a mention-store outage must not
  // hide the at-limit offer. The referral balance route is the
  // referral surface's own health signal.
  let referralMention: ReferralMention | null = null;
  if (!reasonCode && rules.mentionsEnabled.referral && ports.referral) {
    try {
      const [referralRules, redeemableUSD, earnings, attribution] = await Promise.all([
        ports.referral.getRules(),
        ports.referral.redeemableBalance(login),
        ports.referral.listEarnings(login),
        ports.referral.getAttribution(login),
      ]);
      const totalEarnedUSD = earnings.reduce((sum, e) => sum + e.amountUSD, 0);
      if (redeemableUSD > 0 || totalEarnedUSD > 0 || attribution !== null) {
        referralMention = {
          redeemableUSD,
          totalEarnedUSD,
          earnAmountUSD: referralRules.earnAmountUSD,
          vestingDelayMs: referralRules.vestingDelayMs,
          attributedReferrer: attribution?.referrerUserId ?? null,
        };
      }
    } catch {
      referralMention = null;
    }
  }

  // Slice 3 (§3.4): the held product's CURRENT effective price —
  // the price a new customer pays today for the held product's
  // segment — resolved over APPROVED versions only (a PROPOSED
  // version becoming effective is not a price anyone can buy).
  // Null when no approved effective version resolves.
  const currentHeldVersion = heldPlan
    ? resolveEffectiveVersion(
        (plansByProduct.get(heldPlan.productId) ?? []).filter(
          (v) => v.approvalStatus === "approved",
        ),
        segment,
        nowMs,
      )
    : null;

  const current: OfferPayload["current"] = {
    effectiveTier,
    heldPlan: heldPlan
      ? {
          planId: heldPlan.id,
          productId: heldPlan.productId,
          name: heldPlan.name,
          heldPriceUSD: heldPlan.priceUSD,
          currentPriceUSD: currentHeldVersion ? currentHeldVersion.priceUSD : null,
          billingPeriod: heldPlan.billingPeriod,
          includedRuns: heldPlan.includedRuns,
          periodEndMs: heldRow!.periodEndMs,
          billingManaged: heldRowBillingManaged,
        }
      : null,
    includedRunsRemaining: account?.includedRuns ?? 0,
    packRunsRemaining,
    creditsUSD: account?.creditsUSD ?? 0,
    freeRunsRemaining,
    segment,
  };

  if (reasonCode) {
    // Ineligible: only trigger, eligible, reasonCode, and family
    // carry meaning; targets are empty, mentions null, perRun/topUp
    // null — the client renders the fixed copy only.
    return {
      trigger,
      eligible: false,
      reasonCode,
      ...(family ? { family } : {}),
      current,
      targets: [],
      downgradeTargets: [],
      unavailableTargets: [],
      runsPacks: [],
      mentions: { referral: null, freeAccess: null },
      perRun: null,
      topUp: null,
    };
  }

  return {
    trigger,
    eligible: true,
    ...(family ? { family } : {}),
    current,
    targets: targetList,
    downgradeTargets,
    unavailableTargets,
    runsPacks,
    mentions: { referral: referralMention, freeAccess: null },
    perRun:
      family && approvedPrice !== null && catalogueEntry
        ? {
            family,
            priceUSD: approvedPrice,
            productId: catalogueEntry.productId,
            versionId: catalogueEntry.id,
          }
        : null,
    topUp: input.topUpAvailable
      ? { minUSD: fullPolicy.topUpMinUSD, maxUSD: fullPolicy.topUpMaxUSD }
      : null,
  };
}

/**
 * The audit-only `offerContext` the client passes to the existing
 * mint routes (§4.3): `{ trigger, shownAtMs? }`. It authorizes
 * nothing, changes no price, and is never trusted for any money
 * decision. A malformed context reads as absent — the mint audits
 * nothing new and behaves byte-identically.
 */
export interface OfferContext {
  trigger: OfferTrigger;
  shownAtMs?: number;
}

export function parseOfferContext(value: unknown): OfferContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  let trigger: OfferTrigger;
  try {
    trigger = assertOfferTrigger(v.trigger);
  } catch {
    return null;
  }
  const shownAtMs = v.shownAtMs;
  if (shownAtMs !== undefined && (typeof shownAtMs !== "number" || !Number.isFinite(shownAtMs))) {
    return null;
  }
  return shownAtMs === undefined ? { trigger } : { trigger, shownAtMs };
}
