# Upgrade offers — design for #3246

- **Issue:** #3246 — "[Platform] Offer upgrades to users (upsell at the allowance limit + plan comparison)"
- **Status:** DESIGN ONLY. No code, no PR, no build authorized by this document. Build follows only after Mars answers the open questions in §11 (or explicitly waives them) and directs the build. Rev 1 was waived ("Build on the recommendations", 2026-11-12 ~07:54 EST) and slice 1 started; Mars's answers below (Rev 2) override the waived recommendations, the builder was stopped before pushing anything, and no PR exists. The build restarts only on a fresh direction after Rev 2.
- **Verified against:** `origin/main` = `1dc4a859` (2026-11-12, Rev 2 re-verification). Rev 1 was verified against `05262fe0` (2026-11-12). All file/line facts below were read from fresh main unless marked otherwise.
- **Predecessors, all DONE:** #3289 product versions (slices 1–2 merged, issue closed 2026-11-12; design `~/workspace/cbo-3289/design-3289.md`); #3357 monthly + annual plans (closed completed 2026-11-06, commit `e0410949`); #3241 entitlements definition (AGREED, `docs/architecture/business/entitlements-01.md`).
- **Delegation:** Mars, 2026-11-11: "come up with the best upgrade offer design" — the offer design is delegated to CBO, produced at the #3246 step, after #3289/#3357.

## Revision log

- **Rev 1 (2026-11-12, main `05262fe0`):** initial design. Offer = server-computed read-only presentation; two slices (server, client); no migration; no dismissal memory; derived ladder only; PROPOSED hidden; downgrades out; no referral/free-access mentions; "buy included runs" served by subscribing. Ten open questions (Q1–Q10) with recommendations.
- **Rev 2 (2026-11-12 ~07:58 EST, re-verified against main `1dc4a859`):** Mars answered Q3–Q10, OVERRIDING the recommendations on Q3, Q4, Q5, Q6, Q7, Q10 and confirming Q8, Q9. Q1 (stacking) and Q2 (all four triggers + ambient) were not re-answered and stand on the earlier waiver. Closing directive: "all of this must be configurable through UX with externalized defaults." What changed:
  - **Q3 — standalone included-runs purchase SUPPORTED as well as subscribing.** New money behavior: runs-pack products with their own approval-gated prices, a dedicated pack balance, a new gate coverage step, and a checkout/confirm purchase pair (§3.7). New **slice 3**. Migration 0060.
  - **Q4 — explicit operator rank SUPPORTED as well as the derived ladder.** Rank is a nullable column on the product row, edited in the Products section; the ladder resolves rank-first with derived fallback (§3.3). Migration 0059 (rank column).
  - **Q5 — dismissal/cooldown REQUIRED in v1.** Per-(login, trigger) server-side suppression, operator-configured cooldown, dismiss route + audit (§4.4). Migration 0059 (suppressions table).
  - **Q6 — PROPOSED plans SHOWN as unavailable** in the compare surface (no buy action, price labeled proposed-not-approved). Payload gains `unavailableTargets` (§2.4, §5.3).
  - **Q7 — downgrades INCLUDED.** Buying down the ladder through the existing native route with stacking semantics; no cancel, no proration (§3.6). Downgrade targets render in the ambient compare surface only.
  - **Q10 — referral/free-access mentions INCLUDED.** Read-only mentions from existing referral data + a defined read contract for #3247 grants that tolerates their absence (§3.8).
  - **Slice split is now three slices** (§8). Slice 1 needs migration 0059. The gate changes in slice 3 only (additive `runs_pack` step). Decisions D5, D8, D9, D10 are OVERTURNED and annotated in §10; D4 is revisited and stands. New load-bearing questions NQ1–NQ7 in §11.

## §0 — Decisions already made (owner) that constrain this design

These are not re-decided here. They come from #3241 (decisions 1–5), the 2026-11-11 answers, the 2026-11-12 answers, and standing rules:

1. **Nothing over allowance.** At the limit the user is asked to upgrade or buy credits (§7 of the definition; decision 4). The run does not start until one of those is done.
2. **Tiers cumulative.** Basic includes Free; Premium includes Basic. A higher tier never removes an entitlement.
3. **Allowances are operator data, changeable, never hardcoded.** Free 10 / Basic 20 / Premium 30 runs per product per month are the decided counts, stored as operator data.
4. **Prices FULLY FLEXIBLE operator data, never constants** (Mars 2026-11-11). No invented prices or discounts anywhere in an offer. The offer shows server-truth prices only.
5. **Grandfathering.** Existing holders keep their price until moved; new customers pay the current price; a plan change pays the new plan's current price. A new version moves no one by itself (#3289).
6. **Subscriptions per-user WITHIN a tenant.** An offer is always for the verified login's own subscription in their own tenant.
7. **Session-scoped identity always.** No client-supplied tenantId or segment is ever read. The segment comes from the account row.
8. **No hardcoded defaults.** Offer behavior rules must be operator data with a UI. Seeded defaults are allowed only as operator-editable data (the "build with defaults externalized" directive), never as code constants the operator cannot change.
9. **One implementation of everything.** No parallel purchase path, no second pricing source, no second entitlement path (definition §11 conformance).
10. **Outcome-encoded messages, never raw error codes** (#3239 lesson, definition §7). Offer copy comes from the outcome catalog (AOP), never hand-written per channel.
11. **An upgrade is one of: subscribe to a higher plan, top up credits, or buy included runs** (#3246 scope, per decision 4). "Buy included runs" is served BOTH by subscribing AND by a standalone included-runs purchase (Mars Q3, Rev 2) — the standalone purchase is designed in §3.7.
12. **Every offer behavior is operator-configurable through the UX with externalized defaults** (Mars 2026-11-12, closing directive). Trigger toggles, cooldown duration, mention toggles, proposed/downgrade/pack visibility, and product rank are all operator data edited in the UI; seeds are PROPOSED operator-editable data, never code constants. The configuration surface is §4.2 (rules) + the Products section (rank, §3.3) + the pack management surface (§3.7, slice 3).

## §1 — The problem, as verified on fresh main

There is no upgrade/upsell UI anywhere. Verified 2026-11-12 on `origin/main`:

- **Manual 402:** `src/client/paidScreenSubmit.ts` `mapScreenError` maps ANY 402 on a screen route to one fixed string — "Screens require payment while monetization is on. Start the run through the payment workflow (Stock Hub → Run a new screen) — no screen has started yet." It offers only the per-use checkout, with no upgrade offer and no plan choice. A grep for `upsell|upgrade offer` across `src/` returns nothing (excluding WebSocket/DO upgrades).
- **Scheduled skip:** the caller seam (`src/services/paidScreenSubmission.ts`) skips uncovered recurring runs with the coverage-required reason, audited and explained. No offer reaches the owner; the skip explanation carries no upgrade path.
- **Trial end:** `src/client/ProductCatalogPanel.tsx:607` renders `trialEndedMessage` ("Your free trial of {plan} has ended. Subscribe or pay per run to keep running screens.") as a text notice. No comparison, no action beyond the existing buy buttons.
- **No compare/choose surface:** plans are listed for purchase in the CheckoutPanel subscriptions tab (`?checkoutTab=subscriptions`) and the ProductCatalogPanel selling section, and the account tier / credits / included runs display read-only. There is no side-by-side tier comparison and no choose-a-plan surface.
- **The gate already produces everything an offer needs to key off:** `payment_required` (manual/one-off, checkout attached, 402) and `coverage_required` (scheduled, no checkout, 402) in `src/services/nativeMonetization.ts`, both carrying `priceUSD`, `family`, `productId`, `versionId`. The approved-free quota path already returns the outcome-coded `FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED` ("…Upgrade or buy credits to keep running screens.") with an at-limit action setting of `upgrade_or_buy_credits` | `stop` (`src/data/approvedFreeQuotaPorts.ts:117`). The offer design reuses this vocabulary; it does not invent a second one.

## §2 — The offer model

### 2.1 What an offer is

An offer is a **server-computed, read-only presentation** of existing server-truth data at a decision moment: the user's current position (tier, held version + held price, included runs left, credits, segment) set against the plans they could buy (current effective versions for their segment — higher for upgrades, lower for downgrades in the ambient surface, §3.6 — approved versions buyable, PROPOSED versions shown as unavailable, §2.4), with working actions into the **existing** checkout (subscribe, top up credits), the standalone runs-pack purchase (§3.7, slice 3), and — when they exist for the user — read-only referral and free-access mentions (§3.8).

An offer is NOT:

- a price, a discount, or a promotion — it invents no numbers;
- a new product or plan — it presents versions that already exist (runs-pack versions are created by the operator through the pack management surface, §3.7 — never by the offer);
- a stored marketing campaign — there is no offer inventory table and no pre-built offer content. Offers are **computed deterministically** from account state + effective versions + operator offer rules (§4.2) + the user's own dismissals (§4.4), every time they are requested. Two identical states produce identical offers.
- an entitlement decision — the gate is untouched in slices 1–2 (slice 3 adds one additive coverage step, §3.7). An offer never grants coverage, never changes a tier, never mints a checkout by itself. Acceptance flows through the existing purchase/top-up routes (or the slice-3 pack routes), which re-validate everything (approval, effectiveness, segment) at the money moment.
- a cancellation — an offer never cancels a subscription. A downgrade buys the lower plan; the current plan runs to period end and is never canceled by the offer (§3.6). Canceling stays a separate user act via the existing cancel route.

### 2.2 Triggers (when an offer is computed)

| Trigger | Moment | User present? | Surface (§5) |
|---|---|---|---|
| `manual_402` | A manual (or triggered, §9 manual treatment) run hits the gate's `payment_required` 402 | Yes | Inline at-limit upsell where the 402 lands |
| `skip_notice` | A recurring scheduled run is skipped (`coverage_required`) | No | Owner-facing: the offer renders state-derived on the owner's next visit to the checkout/account surface; the skip record links to it (§5.4) |
| `trial_end` | A trial row has lapsed and the tier fell back | Yes (on next visit) | Trial-ended notice gains the compare + subscribe action (§5.5) |
| `quota_exhausted` | An approved-free grant hits its per-service quota cap | Yes | Same inline upsell, gated by the quota at-limit action setting (§2.3) |
| `ambient` | The user opens the compare surface unprompted | Yes | Plan compare/choose surface, always available (§5.3) |

The `ambient` trigger is the plan comparison/choose surface from the issue title. It is not interruptive: it renders whenever the user opens it, showing current-vs-higher (and, in ambient only, current-vs-lower downgrade targets, PROPOSED-as-unavailable versions, and mentions) whether or not the user is at the limit. The other four triggers are the interruptive offer, shown only when the eligibility rules (§2.3) hold. Dismissal (§4.4) applies to the interruptive triggers only — the ambient surface is never suppressed, because the user explicitly opened it.

### 2.3 Eligibility — the offer shows only when ALL hold

Evaluated server-side, deterministically, in this order (first failure = no offer, with the reason recorded in the response for observability, never rendered as a raw code):

1. **Monetization flag ON.** Flag OFF → everything is free; an offer is never computed. (The flag is one platform-wide boolean; there is no per-user exemption.)
2. **Trigger enabled by operator rules** (§4.2). Each trigger can be disabled operator-side. Disabling a trigger suppresses that trigger's offer everywhere. The master switch `enabled: false` suppresses all offers.
3. **Not dismissed (interruptive triggers only).** No live suppression row for (login, trigger) (§4.4). A dismissed trigger returns `eligible: false` with `FAILURE_OFFER_SUPPRESSED`. The `ambient` trigger skips this rule entirely — dismissal never hides a surface the user explicitly opened.
4. **At the limit for the next run.** The derivation reuses the gate's coverage computation read-only (no consumption): no grant coverage within quota, no free allowance left for the family, no included runs left, no runs-pack balance left (slice 3), credits below the family's approved price. If any coverage exists for the next run, NO offer — this is the issue's acceptance criterion ("no offer where coverage exists") and it is enforced server-side, not left to the client. For the `ambient` trigger this rule is relaxed: the compare surface renders regardless of coverage, but it is labeled comparison, not an at-limit offer, and shows the current position (including remaining allowance) honestly.
5. **A purchasable action exists.** At least one effective, approved, active version for the caller's segment ranks higher than the current position (§3.3), OR the top-up path is available (credits purchase), OR an effective approved runs-pack version exists for the segment (slice 3, when `runsPacksEnabled`). If none exists, no offer — the at-limit message falls back to the existing fixed copy. PROPOSED versions never satisfy this rule (they are shown as unavailable, §2.4, but are not purchasable). Downgrade targets never satisfy this rule for interruptive triggers (a downgrade cannot resolve being at the limit — downgrades appear in the ambient surface only, §3.6).
6. **Quota at-limit action permits it** (for `quota_exhausted` only): the operator's `ApprovedFreeQuotaAtLimitAction` must be `upgrade_or_buy_credits`. When it is `stop`, the stop message renders with no offer. This reuses the existing setting; no second switch is introduced.
7. **Segment scoping.** Targets are the caller's segment's effective versions only — the same discipline as `GET /plans`. A segment with no higher effective version gets no subscribe target (top-up-only / packs-only offer, if available).

Deliberately NOT eligibility inputs: the user's history, predicted intent, or any scoring. The ONE per-user state input is the user's own explicit dismissal (§4.4) — an act, not a prediction. The offer is otherwise a deterministic function of entitlement state, not a recommendation engine. No per-user targeting data is collected or stored for offers.

### 2.4 The offer payload (server-truth, client renders verbatim)

One shape, returned by both routes in §5.1:

```
OfferPayload {
  trigger: "manual_402" | "skip_notice" | "trial_end" | "quota_exhausted" | "ambient";
  eligible: boolean;                 // false => reasonCode only, no targets
  reasonCode?: string;               // outcome-catalog code when ineligible (never a raw string)
  family?: ScreenerFamily;           // the family the at-limit moment concerns
  current: {
    effectiveTier: string;           // resolveEffectiveTier
    heldPlan: {                      // null when no subscription row (implicit Free)
      planId: string;                // = held version id
      productId: string;
      name: string;
      heldPriceUSD: number;          // grandfathered price
      billingPeriod: "monthly" | "annual";
      includedRuns: number;          // the version's included runs
      periodEndMs: number;           // the subscription row's period end
      billingManaged: boolean;       // true when the held row is provider-managed (providerSubscriptionId !== null)
    } | null;
    includedRunsRemaining: number;   // account row only (the gate's source)
    packRunsRemaining: number;       // runs-pack balance (slice 3; 0 until then)
    creditsUSD: number;
    freeRunsRemaining?: number | null; // free-run allowance left, when the counter is bound
    segment: string;
  };
  targets: OfferTarget[];            // approved effective versions ranking HIGHER (§3.3)
  downgradeTargets: OfferTarget[];   // approved effective versions ranking LOWER — ambient trigger ONLY (§3.6)
  unavailableTargets: OfferTarget[]; // effective PROPOSED versions (both directions), never buyable (§2.4 rules)
  runsPacks: RunsPackOffer[];        // slice 3: effective APPROVED pack versions for the segment
  mentions: {
    referral: ReferralMention | null;   // §3.8; null when no referral state, toggle off, or port unbound
    freeAccess: FreeAccessMention | null; // §3.8; null until #3247 lands (port unbound) or no grant
  };
  perRun: {                          // the pay-per-run alternative, when an approved price exists
    family: ScreenerFamily;
    priceUSD: number;                // effective catalogue version price for the segment, APPROVED only
    productId: string;
    versionId: string;
  } | null;                          // null when no approved catalogue price (fail-closed: omitted, never guessed)
  topUp: { minUSD: number; maxUSD: number } | null; // billing-policy bounds; null when top-up unavailable
}

OfferTarget {
  productId: string;
  name: string;
  versionId: string;                 // the effective version id (= plan id to buy)
  priceUSD: number;                  // current effective price for the segment
  approvalStatus: "approved" | "proposed";
  buyable: boolean;                  // false for PROPOSED versions and for Billing-managed downgrades
  unavailableReason?: "proposed" | "billing_managed"; // present exactly when buyable is false
  billingPeriod: "monthly" | "annual";
  includedRuns: number;
  periodDays: number;
  trialDays: number | null;
  features: string[];                // display-only, from featuresJson (Q11)
  effectiveFromMs: number;
  annualOption?: {                   // when BOTH monthly and annual effective versions exist for the product
    versionId: string;
    priceUSD: number;                // the annual version's own priceUSD (operator-set or #3357-derived)
    savingsVsMonthlyUSD: number;     // monthly*12 - annual, computed server-side from operator prices, never client-side
  };
  recommended: boolean;              // exactly one target: the nearest step up (§3.3)
}

RunsPackOffer {                       // slice 3
  productId: string;
  name: string;
  versionId: string;                 // the effective pack version id (= pack id to buy)
  runs: number;                      // runs the pack adds to the pack balance
  priceUSD: number;                  // the pack version's own APPROVED price
  effectiveFromMs: number;
}

ReferralMention {
  redeemableUSD: number;             // vested, unspent referral balance (ReferralCreditPort)
  totalEarnedUSD: number;            // all earnings, vested or not
  earnAmountUSD: number;             // the operator rule row: earned per referred user
  vestingDelayMs: number;            // the operator rule row
  attributedReferrer: string | null; // who referred this user, if attributed
}

FreeAccessMention {
  kind: "lifetime" | "limited";
  expiresAtMs: number | null;        // null for lifetime
}
```

Rules the payload enforces:

- On an ineligible response, `targets`, `downgradeTargets`, `unavailableTargets`, and `runsPacks` are empty, both mentions are null, and `perRun`/`topUp` are null — only `trigger`, `eligible: false`, `reasonCode`, and `family` carry meaning. The client renders the fixed copy only.
- The client NEVER invents a price, a discount, or a charging decision (issue scope). Every number in the payload is server-resolved from operator data. The client renders the payload verbatim; the only client-side formatting is currency/number display (`formatUSD`).
- Version numbers are operator-facing (per #3289 §5.1): buyers see product name + price + terms, not "v2". The payload carries `versionId` as the opaque buy key only.
- A held price that differs from the current effective price for the same product is shown as BOTH numbers ("Your price" vs "Current price") — never silently one or the other (§3.4).
- `perRun` is omitted (null) when the family's effective catalogue price is unapproved or missing. The gate fails closed on PROPOSED prices; the offer must not display a PROPOSED price as a buyable alternative. Q6 (PROPOSED plans shown) does NOT change this: the per-run line is a buy-adjacent price, and only an approved price may appear there.
- **PROPOSED versions are shown, never buyable.** An `unavailableTarget` renders with its stored proposed price labeled as proposed — "not yet approved, not buyable" — and no buy action (`buyable: false`). The proposed price is operator data displayed with its status, not a price the user can pay; the checkout would refuse it with 402, so no action is offered. Hiding the number entirely (a bare "coming soon") was considered and rejected: the compare table must let the user plan, and the label keeps the display honest (open question NQ5).
- **Downgrade targets are ambient-only.** The server populates `downgradeTargets` only for the `ambient` trigger; every interruptive trigger returns an empty array. The client never has to decide this.
- **Mentions are information, never actions.** A mention carries numbers the user already owns (referral balance) or a grant the user already holds (free access). Mentions never promise codes, never grant anything, and never change eligibility.

## §3 — Resolution against versions, segments, and annual plans

### 3.1 Current position (the "you are here" side)

Resolved server-side from the verified session login only:

- **Account row** → `segment` (default `"default"` when no account exists — same rule as `GET /plans`), `tier`, `creditsUSD`, `includedRuns` (the gate's only included-runs source, `platformIdentity.ts:108`).
- **Effective tier** via the existing `resolveEffectiveTier(account, subscriptions, nowMs)` — period-end-only, status-blind, exactly as the gate reads it. The offer never re-implements tier resolution.
- **Held version:** the subscription rows' `planId` values resolved through the existing store `getPlan(planId)` (`SubscriptionStore.getPlan` exists; no new port method is needed). A held version may be superseded, future-dated, or deactivated — it is still the holder's grandfathered version, and its price is the held price. The "current" subscription for display is the row with the latest `periodEndMs` (the same rule `GET /subscription` uses for `current`). `billingManaged` is true when that row's `providerSubscriptionId` is non-null (the #2202 rule: a null provider id is exactly what makes a row NOT Billing-managed).
- **Free allowance left:** read from the free-run counter port when bound (`agent_free_run_counts`); null when the counter is unbound (the gate falls through in that case, and so does the offer derivation — no invented count).
- **Grant/quota state:** the unlimited-free grant (account row) and the approved-free quota counts, read through the existing ports. A grant-holder within quota has coverage → no offer (§2.3 rule 4). A grant-holder at the quota cap → offer, subject to rule 6.
- **Pack balance** (slice 3): read from the runs-pack balance port (`agent_runs_pack_balances`); 0 when the port is unbound or no row exists. A positive balance is coverage for any family (§3.7).

### 3.2 Targets (the "you could have" side)

For each subscription product (`ProductKind === "subscription"`, via the product store):

1. Take all versions of the product for the caller's segment.
2. Resolve the effective version with the existing pure `resolveEffectiveVersion(versions, segment, nowMs)` (`src/data/productPorts.ts:125`) — greatest `effectiveFromMs` at or before now, same-start ties by greatest version, inactive/future/expired excluded. The offer reuses this function; it does not re-implement resolution.
3. Split by approval: an effective version with `approvalStatus === "approved"` AND `active` is a candidate target; an effective version with `approvalStatus === "proposed"` is an `unavailableTarget` (shown, never buyable — §2.4), included only when the `showProposed` rule is on (§4.2). Deactivated versions never appear (the resolver already excludes them).
4. Rank each candidate against the current position with the §3.3 ladder: ranking HIGHER → `targets` (upgrade direction); ranking LOWER → `downgradeTargets`, populated only for the `ambient` trigger (§3.6); ranking EQUAL (the same product at the same ladder position, e.g. the held product's own current version) → neither array (it is the current column, shown with held-vs-current prices per §3.4).
5. Runs-pack products (`ProductKind === "runs_pack"`, slice 3) resolve through the same resolver over the pack-version store (§3.7) and land in `runsPacks`, never in `targets`.

Per-run products (`prod-per-run-<family>`) are never subscribe targets — they surface only through the `perRun` alternative (§2.4). The Free baseline row (`prod-free`, read-only, no versions) is never a target; it is the implicit "current" row for accounts with no subscription, and its rank is fixed at 1 (the ladder floor, §3.3).

### 3.3 The ladder — what "higher" means (rank + derived)

Plan names are operator data. The design must not hardcode "Basic" / "Premium" as a ladder, and must not assume any fixed set of plans. The ladder resolves from TWO mechanisms, both supported (Mars Q4):

- **Explicit operator rank.** Each product row carries a nullable integer `rank` (`agent_products.rank`, migration 0059, §4.1). Rank is the ladder position: **1 = the lowest rung, larger = higher** (Free 1, Basic 2, Premium 3 in the usual shape — the numbers are operator-chosen, never assumed). `NULL` = unranked. Rank is set by the operator in the Products section (§5.3, slice 2) through the `setProductRank` store method + `POST /products/:productId/rank` route (slice 1, §5.1); new products may carry a rank at creation. Rank validation: a positive whole number or null; anything else is a catalog-coded 400. `prod-free` ships with rank 1 (seeded by migration 0059) and its rank is NOT editable — it is the definitional floor, consistent with the row's existing read-only baseline status (the set-rank route 409s for `prod-free`).
- **Derived order (fallback).** For products without a rank, the derived rule applies: `includedRuns` descending, tie-broken by `priceUSD` ascending. The current position's derived key is the held version's `includedRuns`, or the Free allowance count when no subscription is held (read from the free-run allowance operator data, never the constant 10).

**The total order (one rule, deterministic, pinned by tests):** sort all candidate products by (ranked-before-unranked, rank ascending, includedRuns descending, priceUSD ascending). Ranked products come first in rank order; unranked products follow, ordered by the derived rule. "Higher than the current position" = sorting strictly AFTER the current product under this same key (the current product's key is computed identically: its rank if set, else its derived key; no subscription → `prod-free`, rank 1). "Lower" = sorting strictly BEFORE. The same key orders the compare table's columns left-to-right.

**Build erratum (slice 1, PR #4286):** the total-order sentence above contradicts itself as written — with "higher = sorting strictly AFTER", includedRuns descending would make fewer runs read as HIGHER. The build resolves it in favor of the Rev 1 rule: the low-to-high key is (ranked group first, rank ascending, includedRuns ASCENDING, priceUSD ascending); "higher" is a strictly greater key. Recorded as deviation D-1 in the slice-1 PR body.

- **Why unranked sorts last (stated, not hidden):** an unranked product surfaces at the TOP of the compare table — visibly misplaced, prompting the operator to rank it. The alternative (unranked sorts first, below Free) would silently hide an unranked product from every upgrade path. Loud misplacement beats silent disappearance. The mixed ranked/unranked case arises only during partial adoption; once the operator ranks the ladder, the derived rule never fires for those products.
- **Rank is per-product, NOT per-segment.** Segments select WHICH products/versions are sellable to a customer; rank orders the ones shown. A per-segment rank would need a rank table keyed by (product, segment) with no evidence of demand — rejected. A product's rank is the same in every segment; a product absent from a segment simply does not appear there.
- **Recommended target:** exactly one — the target with the smallest ladder position strictly above the current position (ties by `priceUSD` ascending): the nearest step up. When no rank is set anywhere this reduces to the Rev 1 rule (the cheapest strict increase in included runs). When the user already holds the top ladder position, there is no subscribe target; the offer degrades to top-up-only (credits) plus the per-run alternative plus runs packs (slice 3).
- **Annual vs monthly is not a ladder step.** Billing period is an option within a product, not a rank: the same product's monthly and annual effective versions appear as one target row with an `annualOption` (§2.4). The annual price is the annual version's own `priceUSD` — set by the operator, or derived by the #3357 derivation (`annualPriceUSD(monthly, annualDiscountPct)`, monthly × 12 × (1 − discount), operator-managed discount, PROPOSED seed 15%). The offer never derives an annual price itself; it reads the version that already carries it. If only one period has an effective version for the segment, only that period is offered.
- **Preselection:** when both periods exist, the preselected period follows `billingPeriodDefault` from the billing policy (operator data, seed `"monthly"`). Confirmed by Mars (Q9).

### 3.4 Grandfathering in the offer (the honesty rule)

The held price and the current effective price are different numbers with different meanings, and the offer must never blur them:

- **Held price** = what the user pays today for the version they hold. Shown as "Your price" on the current side.
- **Current effective price** = what a new purchase of that product costs today, for their segment. Shown on the target side.
- **A purchase made from the offer charges the CURRENT effective price.** A plan change pays the new plan's current price (decided, definition §8) — for upgrades AND downgrades alike: buying the lower plan charges the lower version's current effective price. The offer copy states this where the two prices differ: the user is buying the current version at the current price, not extending their held version at their held price.
- **A new version moves no one by itself** (#3289). The offer never implies the user will be moved, and accepting an offer never moves any other customer. Movement remains explicit-only (per-customer / bulk, operator surfaces).

### 3.5 Purchase semantics — stacking, stated plainly (the most consequential design fact)

The existing purchase activation (`activateSubscription`, `src/services/subscriptionActivation.ts`) **stacks**: a repurchase before expiry extends the period from the latest paid-through instant, and the new plan's `includedRuns` ADD to the account's single fungible counter. Buying a second plan does not replace the first, does not convert it, and does not prorate anything. There is no plan-change / replace / convert operation anywhere in the codebase; proration and downgrade semantics live only as design in #2145 and as provider-side policy fields (`prorationBehavior`, `downgradeTiming` in the billing policy) for Stripe-managed subscriptions. Stacking stands per Mars's waiver (Q1).

Consequence for this design, stated without softening:

- **In v1, "upgrade" means "buy a higher plan, which stacks with your current subscription."** The offer copy must say exactly that where the user already holds a subscription: the new plan's period stacks from the current paid-through instant and its included runs add to the balance. The offer must never use "switch", "convert", or "replace" language, and must never imply the old plan is canceled or refunded — because it is not.
- **"Buy included runs"** (the issue's third upgrade form) is served BOTH by subscribing AND by the standalone runs-pack purchase (§3.7, slice 3). Subscribing remains the included-runs purchase for users who want a plan; the pack purchase is the standalone path for users who want runs without a plan.
- **The Billing (provider-managed) purchase route confers tier only, never included runs** ("Included-run bypass stays OFF", definition §6). An offer whose acceptance flows through the Billing route would confer tier with zero included runs — the same hole the definition records for paid Billing subscriptions. Therefore: **offer acceptance MUST flow through the native one-time purchase route** (`POST /subscription/checkout` → `POST /subscription/purchase`, `activateSubscription`), which grants tier + included runs together. The Billing route is not an offer acceptance path in v1. The compare surface may still link to the Products catalog for Billing purchases, but the offer's own subscribe action uses the native route. This is a design invariant, not a preference.

### 3.6 Downgrades — buying down the ladder (in scope, Rev 2)

Mars (Q7): downgrades are INCLUDED. The v1 downgrade uses ONLY existing machinery — it is the stacking purchase pointed down the ladder, not a plan-change operation:

- **Mechanism:** the user buys a LOWER-ranked plan through the SAME native one-time purchase route as an upgrade. Stacking applies unchanged: the lower plan's period extends from the latest paid-through instant (so it takes effect at the next period boundary), its included runs ADD to the fungible counter, the current higher plan is NOT canceled, no refund is issued, and runs already in the balance stay. The display's "current" version (latest `periodEndMs` row) becomes the lower plan once bought — the downgrade is visible as the next period's terms.
- **Copy (required, pinned by test):** the downgrade action carries the disclosure — "Buying this plan adds its runs to your balance and starts its period when your current paid-through period ends. Your current plan is not canceled and is not refunded." The offer must never use "switch" or "convert" language for downgrades either, and must never imply the higher plan stops.
- **No cancel is performed.** The existing cancel route (`POST /subscription/cancel`, #2662) cancels ALL of the user's subscription rows (self-service or operator-on-behalf, timing from the `downgradeTiming` policy, no cash refund) — there is NO per-row cancel route. The offer never calls it: canceling is a separate user act with all-rows consequences the offer must not trigger silently. A per-row cancel route is a separate decision, out of #3246 (§6).
- **No proration, no replace, no convert.** Those remain #2145's unbuilt design. A downgrade in v1 never credits unused time and never shortens the current period.
- **Placement: ambient compare only.** Downgrade targets populate ONLY for the `ambient` trigger (§2.4). A downgrade cannot resolve being at the limit — fewer runs is the wrong direction at the limit — so interruptive at-limit offers never show downgrade targets. The ambient compare is where a user deliberately reviews their plan, and that is where downgrades belong.
- **Billing-managed held rows: buy-action disabled.** When the held (latest-periodEnd) subscription row is provider-managed (`providerSubscriptionId !== null`), the downgrade targets render with `buyable: false` and `unavailableReason: "billing_managed"`, with copy stating the current plan is managed through Stripe Billing and buying here would not change the Stripe subscription. Rationale: a downgrade's entire point is paying less next period, and a native purchase alongside an active Billing subscription cannot deliver that — showing a buy button would mislead. (Upgrades keep the buy action for Billing-held accounts: buying more runs delivers exactly what it promises, and the Billing subscription is unaffected either way. The asymmetry is real and stated.) Open question NQ3.
- **Toggle:** `downgradesEnabled` (§4.2) hides downgrade targets platform-wide when false. Seed: true (Mars Q7).

### 3.7 Standalone included-runs purchase — runs-pack products (new money behavior, slice 3)

Mars (Q3): the offer must support an included-runs purchase as well as subscribing. No standalone path exists today: included runs enter the account ONLY through a plan purchase, an operator grant, or a trial. This section designs the new path. It is NEW MONEY BEHAVIOR — a new purchaseable unit, a new balance, a new gate step — and it lands as its own slice (slice 3), after the offer surfaces exist.

**Why a pack balance, not the included-runs counter (verified, load-bearing):** the gate consumes included runs ONLY when `tier === "Subscribed"` (`nativeMonetization.ts`, the coverage ternary: `account.tier === "Subscribed" && account.includedRunsRemaining > 0 ? "subscription_included" : …`). A Free or PayPerUse account that bought runs into `includedRuns` could never spend them — the exact stranding the design must not ship. And widening the gate to spend `includedRuns` regardless of tier would silently change the documented trial-leftover semantics (definition §6: leftover trial runs sit unspendable until Subscribed again). Therefore pack runs live in a DEDICATED balance, consumed by a DEDICATED gate step, leaving the Subscribed condition and the trial semantics untouched.

**The unit — runs-pack products:**

- New `ProductKind` value `"runs_pack"` (port union extension; the `kind` column is plain TEXT, no DDL constraint to change). A runs-pack product is a product like any other: identity row in `agent_products`, versions as immutable terms snapshots, effective-dated, segment-scoped.
- Pack versions live in their OWN table, `agent_runs_pack_versions` (migration 0060, §4.1) — following the established one-table-per-purchaseable-unit pattern (plans in `agent_subscription_plans`, per-run versions in `agent_price_catalogue`). A pack version carries: `product_id`, `segment`, `version`, `effective_from_ms`, `effective_to_ms`, `runs` (positive integer), `price_usd` (positive), `approval_status` (`proposed` | `approved`, same discipline as plans), `approved_by`/`approved_at_ms`, `active`, timestamps. Unique index on (`product_id`, `segment`, `version`). Resolution reuses the pure `resolveEffectiveVersion` — no second resolver.
- **Pricing: the pack version's OWN approval-gated price.** A pack costs what its version says, and only an APPROVED pack version can be bought (the mint route 402s on PROPOSED, like the plan checkout). Per-run catalogue prices are IRRELEVANT to packs. The alternative — price = N × the family's catalogue per-run price — is REJECTED for three stated reasons: (1) all per-run catalogue prices are PROPOSED today, so nothing could charge until per-run approval lands; (2) N × catalogue invents a pricing rule and a second price computation, violating "no invented prices"; (3) a user-chosen N makes the price user-derived, not operator-set. Pack (runs, price) pairs are operator-set, approval-gated terms — the same discipline as plans.
- **Packs are family-agnostic** (a pack run spends on any family — the same fungibility as the included-runs counter). Per-family packs would multiply products without evidence of demand (open question NQ6). **Packs never expire in v1** (runs are bought, not rented; expiry needs its own design + disclosure — open question NQ2). Packs never confer tier and never create a subscription row.

**The balance:**

- New table `agent_runs_pack_balances` (migration 0060): `login` PK, `tenant_id` (scoping/audit denormalization, from the account row), `balance_runs`, `updated_at_ms`. One row per login. Port `RunsPackBalancePort` with `getBalance(login)`, `addRuns(login, tenantId, runs)` (purchase credit), and `consumePackRun(login, tenantId): Promise<boolean>` — a single conditional decrement (applies only while balance > 0) with an applied-check read-back, mirroring the `consumeQuotaRun` precedent: the gate never allows a pack run it did not count.
- **Purchase flow (mirrors the top-up checkout/confirm pair, #3262):** `POST /commercial/runs-packs/checkout` mints a native checkout for the pack version's approved price (402 when the version is unapproved/missing; segment from the account row; no client-supplied price); `POST /commercial/runs-packs/confirm` credits the balance on VERIFIED payment only, then journals and audits. Activation is a new pure service `activateRunsPack` (mirroring `activateSubscription` minus the subscription row): verify payment → add runs → journal charge entry (Dr 1000 / Cr 4000, the journal port's charge mapping, carrying productId/versionId/priceUSD per #3289) → audit `commercial.runs_pack.purchased`. Journal write failures are loud-logged, never fail the purchase (the ADR 0002 projection discipline — the DO ledger stays authoritative; the pack balance write is the money fact, and it precedes the journal write). No deferred-revenue mapping (that stays a later slice, per the 2026-10-28 decision — packs journal exactly like subscription charges).
- **Offer integration:** `runsPacks` in the payload (§2.4) lists effective APPROVED pack versions for the segment, gated by `runsPacksEnabled` (§4.2). The buy action flows through the pack checkout with `offerContext`, audited `commercial.offer.accepted` with action `"runs_pack"`. Eligibility rule 5 (§2.3) counts an available pack as a purchasable action. Pack management UI (create pack product, pack versions, approve/deactivate) rides the Products section in slice 3, following the #3289 product/version route pattern with pack-specific routes (§5.1).

**The gate step (slice 3 only, additive):**

- In `check()`, the coverage ternary gains one branch, placed AFTER `subscription_included` and BEFORE `credits`: `tier === "Subscribed" && includedRuns > 0 ? "subscription_included" : packBalance > 0 ? "runs_pack" : credits >= price ? "credits" : null`. The gate reads the pack balance through the balance port (following the quota-check precedent of a port read inside the gate) and consumes via `consumePackRun` AT DECISION TIME — the gate never allows a pack run it did not count. The payment workflow's `consumeCoverage` no-ops for `paidVia: "runs_pack"` (already consumed — the same shape as the quota/grant no-ops). `paidVia: "runs_pack"`, `priceUSD` = the quoted catalogue price (the run's recorded value, same precedent as `subscription_included`), `productId`/`versionId` = the quoted catalogue version. Placement rationale: most-specific prepaid balance first, money last — the decided coverage order (included runs → credits → offer) keeps its shape with packs inserted between the two prepaid forms (open question NQ1).
- **Honesty constraint (stated, not hidden):** price resolution precedes the coverage ternary and throws fail-closed on an unapproved catalogue price — so pack runs, like subscription included runs, are spendable ONLY when the family's catalogue price is APPROVED. Buying a pack before catalogue approval stores the balance but cannot spend it. Packs do not become an approval bypass (open question NQ7). The pack purchase itself is gated only on the PACK version's approval, which is independent — an operator can approve pack prices while per-run prices stay PROPOSED, and the balance will spend once the catalogue price is approved.

### 3.8 Referral codes and free-for-lifetime — mentions in scope, mechanics out (Rev 2)

Mars (Q10): the offer surface mentions referral codes (#3307) and free-access grants (#3247) when they exist for the user. What "exist" can mean today is sharply bounded by what is built — this section states the read contract and its absences honestly.

**Referral mentions — reads exist today (verified on fresh main):**

- The `ReferralCreditPort` (`src/data/lifecyclePorts.ts`, #2208/#2657) is bound in the commercial route file's context (the existing `GET /referral/balance` route already reads it): `getRules()` (the single operator rule row: `earnAmountUSD` $0.50 seed, `vestingDelayMs` 7 days, `redemptionScope` pay-per-run), `redeemableBalance(userId)` (vested, unspent), `listEarnings(userId)` (total earned), `getAttribution(userId)` (who referred this user; the attribution record carries a `code` field RESERVED for future referral-code surfaces — no codes exist yet).
- The mention (`ReferralMention`, §2.4) renders ONLY when the user has referral state: redeemable balance > 0, total earned > 0, or an attribution row exists. Otherwise null — no generic "invite friends" noise to users with no referral history. The mention shows the balance + the earn rule ("You have $X in referral credit. Referrals earn $Y per referred user.") and links to the existing surface that renders the referral balance (`UsageBillingSection`, which already shows "Redeemable: …" — the exact tab/view is a build-time verification, §13). The mention must NOT link to the chat `?tab=referrals` surface — that is the marketplace referral-links tab (`agent_referrals`), a different feature.
- **What the mention must never promise:** codes. No referral-code issuance, redemption, per-product rules, or invite-link machinery exists (`agent_referral_code_rules`, the #3307 design's table, does not exist; the #3307 slice owns it). The mention reads the #2208/#2657 ledger only, and its copy says nothing about codes. If #3307 lands first and defines a code surface, the mention may link to it under that slice's contract — the offer does not invent the link.

**Free-access mentions — nothing exists; the contract tolerates absence:**

- No free-access table, port, or grant exists anywhere on main (#3247 is unbuilt; its only trace is a line in the entitlements doc header). The offer therefore defines a READ CONTRACT and tolerates its absence: `FreeAccessGrantPort.getActiveGrant(login) → { kind: "lifetime" | "limited", expiresAtMs: number | null } | null`, read ONLY when bound (the ADR 0002 composition-root rule: unbound reads as null). Until #3247 implements the port, `mentions.freeAccess` is always null and no mention renders. The offer never grants, revokes, or displays grant-management UI — #3247 owns all of that.
- A #3247 grant never changes offer eligibility: access-only grants never make a run free and never confer tier or runs (#3289 §6.2), so the account meets the limit the same way with or without one. The mention is pure information ("You have free access until {date}" / "You have free lifetime access").
- **Boundary test (revised):** deleting #3307 and #3247 from the codebase must not break any offer code. The mention reads tolerate absence (unbound port → null; no referral state → null), and the offer derivation reads only the stores named in §3.1–3.2 plus the two mention ports. The #3307 config table is still not read by the offer derivation.

**Toggles:** `mentionsEnabled.referral` and `mentionsEnabled.freeAccess` (§4.2) hide each mention platform-wide when false. Seeds: true/true (Mars Q10).

## §4 — Data model

### 4.1 What is added (Rev 2: migrations ARE required)

- **Migration 0059 (slice 1):** `agent_offer_suppressions` table (§4.4) + `rank` column on `agent_products` (§3.3, seeded rank 1 for `prod-free`). The migration number is the next free number at build time — re-check before writing (§13); if another lane lands 0059 first, this slice takes the next number and the registry test stays canonical.
- **Migration 0060 (slice 3):** `agent_runs_pack_versions` + `agent_runs_pack_balances` tables (§3.7). Same re-check rule.
- **No new money tables in slices 1–2.** No offer table holds prices, runs, or entitlements. The offer is computed from existing stores (§3.1–3.2) plus the suppression reads. The runs-pack tables in slice 3 hold the pack unit itself (a purchaseable product's versions + a prepaid balance), not offer state.
- **No gate changes, no seam changes, no purchase-route behavior changes in slices 1–2** except the additive optional `offerContext` field on the mint routes (§4.3). The gate's 402 shapes are unchanged; the client fetches the offer separately (§5.2). **Slice 3 adds one additive gate step** (`runs_pack`, §3.7) and one new purchase pair (pack checkout/confirm) — both designed in §3.7, both additive, neither changing any existing path's behavior.
- **The billing-policy store needs NO migration for the grown rules block** (§4.2): rules ride one JSON-valued key, the store's existing shape.

### 4.2 Offer rules — operator data, in the billing policy (D4 revisited, stands)

Offer behavior rules are operator data, following the #3262 (top-up bounds) and #3357 (annual discount) precedent of extending `BillingPolicy` (`src/data/billingPolicyPorts.ts`) and the existing operator-only `GET`/`POST /payments/agentic/commercial/billing-policy` route (serviced in the Billing servicing UI surface). **D4 revisited (Rev 2):** the rules set grows from five booleans to a mixed object, but the store shape is unchanged — the policy store is one JSON-valued row per key (`valueJson`, `d1BillingPolicyAdapter.ts`), and `stripePriceByPlan` already proves a nested object rides one key. The whole block is ONE new key, `offer_rules`. A dedicated `agent_offer_rules` table is still rejected: it would duplicate the policy store's exact job for one settings blob. (The migration 0059 need comes from suppressions + rank, not from rules.)

```
BillingPolicy += {
  offerRules: {
    enabled: boolean;              // master switch; false => no offer is ever computed
    triggersEnabled: {
      manual402: boolean;
      skipNotice: boolean;
      trialEnd: boolean;
      quotaExhausted: boolean;
      ambient: boolean;            // the compare surface itself; false hides compare too
    };
    dismissCooldownDays: number;   // 1..365 whole days; seed 7 (PROPOSED). §4.4.
    showProposed: boolean;         // seed true (Mars Q6). false => PROPOSED versions hidden again.
    downgradesEnabled: boolean;    // seed true (Mars Q7). false => no downgrade targets.
    runsPacksEnabled: boolean;     // seed true (Mars Q3). Read from slice 3; inert until then.
    mentionsEnabled: {
      referral: boolean;           // seed true (Mars Q10)
      freeAccess: boolean;         // seed true (Mars Q10)
    };
  };
}
```

- **Seeded defaults (PROPOSED, operator-editable):** `enabled: true`, all triggers `true`, `dismissCooldownDays: 7`, `showProposed: true`, `downgradesEnabled: true`, `runsPacksEnabled: true`, both mention toggles `true`. The seed lives in `PROPOSED_SEED_BILLING_POLICY` (INSERT OR IGNORE at ensure time; an operator-edited value survives re-ensure — the existing discipline). No default is a code constant the operator cannot change. The 7-day cooldown seed follows the referral vesting precedent (7 days, `agent_referral_rules` seed) — a PROPOSED value, not an owner decision.
- **Validation:** the existing `assertBillingPolicyPartial` pattern extends with an `assertOfferRules` assert (booleans only + `dismissCooldownDays` a whole number 1–365; unknown keys rejected). A malformed rules value fails the POST with a catalog-coded 400; it never silently disables offers. A zero or negative cooldown is rejected — a zero cooldown would make the dismiss button a lie.
- **No per-plan, per-segment, or per-user offer rules.** Rules are platform-wide. Per-segment offer targeting would duplicate the segment mechanism the version model already provides (a segment with no higher version already gets no target). Per-plan suppression is achieved by deactivating the version or leaving it unapproved — existing operator levers, not new ones. Product RANK is not a rule — it lives on the product row and is edited in the Products section (§3.3).
- **UI (the closing directive, made concrete):** every field above is editable in the existing Billing servicing surface beside the top-up bounds and annual discount editors (same section, same operator-only gating, same audit pattern): the master switch, five trigger toggles, the cooldown-days editor, the proposed/downgrade/pack visibility toggles, and the two mention toggles. No new admin tab. Rank editing lives in the Products section (§3.3); pack management lives in the Products section from slice 3 (§3.7).

### 4.3 Audit — shown, accepted, dismissed, ranked (issue requirement + Rev 2)

Audit events in the existing `commercial.*` family, emitted through the existing audit port (no new audit infrastructure):

| Event | When | Payload |
|---|---|---|
| `commercial.offer.shown` | The triggered offer endpoint (§5.1) returns an eligible offer | `{ login, tenantId, trigger, family?, targetPlanIds, segment, runRequestId? }` |
| `commercial.offer.accepted` | A checkout mint (native subscription checkout, top-up mint, or runs-pack mint in slice 3) is called WITH an `offerContext` | `{ login, tenantId, trigger, targetPlanId?, action: "subscribe" \| "topup" \| "runs_pack", checkoutId?, shownAtMs? }` |
| `commercial.offer.dismissed` | The dismiss route (§5.1) writes a suppression | `{ login, tenantId, trigger, family?, suppressedUntilMs, cooldownDays }` |
| `commercial.product.rank.set` | The set-rank route (§5.1) changes a product's rank | `{ productId, oldRank, newRank, operator }` |
| `commercial.runs_pack.purchased` | (slice 3) A pack purchase confirms on verified payment | `{ login, tenantId, productId, versionId, runs, priceUSD, checkoutId }` |

- **Acceptance wiring:** the client passes an additive, optional `offerContext: { trigger, shownAtMs }` in the body of the EXISTING mint routes (`POST /subscription/checkout`, `POST /top-up/checkout`, and the slice-3 `POST /runs-packs/checkout`). The routes ignore it when absent (all existing callers unchanged) and audit `commercial.offer.accepted` when present. No new route, no new purchase path for subscribe/top-up. The context is audit-only metadata: it authorizes nothing, changes no price, and is never trusted for any money decision. A forged context can only create a false audit row, never a false charge — the same trust level as any other client-supplied audit annotation.
- **Shown audit is server-side and guaranteed:** the triggered endpoint audits on every eligible response (§5.1). The client cannot suppress it. The ambient compare route (§5.1) does NOT audit shown — ambient views are not offers, and auditing every compare view would flood the log with non-decision reads.
- **Dismissed audit precedes the write:** the dismiss route audits `commercial.offer.dismissed` BEFORE writing the suppression row (audit failure = 503, no suppression written, client retries) — the same audit-before-state discipline as the shown-audit. A dismissal is never silently unrecorded.
- **No PII beyond what commercial audit already carries.** Login + tenantId are the existing audit identities.

### 4.4 Dismissal, cooldown, suppression — REQUIRED in v1 (Rev 2)

Mars (Q5): dismissal/cooldown is REQUIRED. The operator kill-switch alone is not enough. The semantics, decided here:

- **Scope: per (login, trigger), server-side.** Dismissing suppresses THAT trigger for THAT login. Dismissing `manual_402` does not suppress `trial_end` or `skip_notice`; dismissing one trigger never affects another. Suppression is NOT per-family: the user dismissed the OFFER, not the family — a dismissal suppresses the trigger across families (open question NQ4). Suppression is keyed by the verified session login (never a client-supplied id) and is tenant-agnostic within the login (a login's dismissal follows the login, like the account row).
- **Storage: `agent_offer_suppressions`** (migration 0059): `login TEXT NOT NULL, trigger TEXT NOT NULL, suppressed_until_ms INTEGER NOT NULL, dismissed_at_ms INTEGER NOT NULL, PRIMARY KEY (login, trigger)`. Port `OfferSuppressionPort` with `getSuppression(login, trigger)`, `setSuppression(login, trigger, suppressedUntilMs, dismissedAtMs)` (upsert), following the ADR 0002 port/adapter split (D1 + in-memory adapters, composition root). Expired rows are inert (read as absent); no deletion sweeper exists in v1 — a retention sweep is a follow-up slice, the same precedent as the quota counts and free-run counter rows.
- **Cooldown: operator-configured duration.** `dismissCooldownDays` (§4.2, 1–365, seed 7 PROPOSED). Dismissing sets `suppressedUntilMs = now + cooldownDays`. Re-dismissing an already-suppressed trigger RE-ARMS from now (not from the previous `suppressedUntilMs`) — one rule, deterministic. When the cooldown expires, the offer reappears if the eligibility rules still hold — correct: the user is still at the limit.
- **Write path: `POST /commercial/offer/dismiss`** (§5.1). Body `{ trigger, family? }`. Dismissing `ambient` is a 400 (the ambient surface is not dismissible — the user opened it deliberately). Response 200 carries `{ suppressedUntilMs }`. The route is self-only (no userId parameter), session-scoped, audited (§4.3).
- **What dismissal does NOT do:** it never hides the fixed at-limit copy — the user still sees the decided at-limit message, just no offer section (§5.2). It never suppresses the ambient compare surface. It never suppresses the skip-notice LINK (§5.4 — the link is a link, not an offer; the offer the link leads to is the ambient surface, which dismissal does not touch). It never affects any other login. Client-side (localStorage) suppression is rejected as the mechanism: device-local, unauditable, trivially bypassed — the wrong durability for an entitlement-surface decision.
- **Buying coverage moots suppressions.** The coverage rule (§2.3 rule 4) dominates: a user who buys coverage is ineligible anyway, so a stale suppression row is harmless and needs no clearing. No "clear on purchase" write exists.

### 4.5 Outcome-catalog codes (AOP #2381)

New entries in `src/outcomes/outcomeCatalog.json` (category `commercial`, resolved ONLY through the single resolver — no hand-written message variants):

| Code | Meaning / businessMessage (draft; catalog owns the final wording) |
|---|---|
| `SUCCESS_OFFER_RESOLVED` | Offer computed (ambient/triggered success; informational, not rendered as a banner). |
| `SUCCESS_OFFER_RULES_UPDATED` | Operator updated the offer rules. |
| `FAILURE_OFFER_DISABLED` | Offers are disabled by the operator. (Payload reason, HTTP 200: disabled is a state, not an error. Follows the quota-expired precedent.) |
| `FAILURE_OFFER_NO_TARGET` | No higher plan is available for this account/segment. (Payload reason, HTTP 200.) |
| `FAILURE_OFFER_COVERAGE_EXISTS` | The account has coverage; no offer applies. (Payload reason, HTTP 200. Never rendered to the user as an accusation — the client simply shows no offer.) |
| `FAILURE_OFFER_SUPPRESSED` | (Rev 2) The trigger was dismissed and the cooldown has not expired. (Payload reason, HTTP 200. The client shows the fixed at-limit copy with no offer section.) |
| `SUCCESS_OFFER_DISMISSED` | (Rev 2) The dismissal was recorded. |
| `FAILURE_OFFER_DISMISS_INVALID` | (Rev 2) The dismiss request failed validation (unknown trigger, or `ambient`). (400.) |
| `FAILURE_OFFER_RULES_INVALID` | The offer-rules update failed validation. (400.) |
| `FAILURE_OFFER_UNAVAILABLE` | An offer store (plans/account/policy) is unavailable. (503, retryable. The client falls back to the existing fixed at-limit copy — never a blank state.) |
| `SUCCESS_PRODUCT_RANK_UPDATED` | (Rev 2) The operator set a product's rank. |
| `FAILURE_PRODUCT_RANK_INVALID` | (Rev 2) The rank value failed validation, or the product is `prod-free`. (400/409.) |
| `SUCCESS_RUNS_PACK_PURCHASED` | (Rev 2, slice 3) A runs-pack purchase confirmed on verified payment. |
| `FAILURE_RUNS_PACK_UNAVAILABLE` | (Rev 2, slice 3) A runs-pack store is unavailable. (503, retryable.) |
| `FAILURE_RUNS_PACK_NO_APPROVED_PRICE` | (Rev 2, slice 3) No approved pack version exists for the segment. (Payload/402 reason — the mint refuses, like the plan checkout.) |

The at-limit user-facing copy itself reuses the existing decided messages (the quota-exhausted message, `trialEndedMessage`, the coverage-required reason) — the offer ADDS the comparison and actions to those messages; it does not replace their wording. New user-facing sentences introduced by the offer UI (column headers, button labels, the stacking/downgrade disclosures in §3.5–3.6, the proposed-unavailable label, the mention lines) are fixed UI strings in the component, not catalog codes — they state no outcome. Any sentence that states an outcome goes through the catalog.

## §5 — Surfaces and routes

### 5.1 Routes — one service, three offer routes + set-rank (Q10 answered: yes, a dedicated endpoint is needed)

The #3289 design (§6.3, Q10) deferred whether the §6.3 exposure suffices or the offer design needs a dedicated compare endpoint. **It needs one, for three verified reasons:** (1) held superseded versions are NOT in `GET /plans` (it returns effective versions only), so the client cannot resolve a held price without a new read; (2) eligibility (§2.3) is server-side entitlement logic the client must not re-implement; (3) the shown-audit must be server-side and guaranteed. There is no buyer-facing single-plan read today (verified: no `GET /plans/:id` exists; the admin version-chain read is operator-only).

One pure service, `resolveOffer(input)` (new file `src/services/upgradeOffers.ts`, following the `versionMoves.ts` service precedent — pure computation over ports, no HTTP):

```
resolveOffer({ login, trigger, family?, runRequestId?, nowMs, ports })
  → OfferPayload (§2.4)   // eligible:false + reasonCode when any §2.3 rule fails
```

Three thin offer routes in `handleAgenticPaymentsRoutes` (the existing commercial route file — no new route file, no thin-router addition beyond the inventory pin), plus the set-rank route in the product route family:

| Route | Method | Audit | Use |
|---|---|---|---|
| `/payments/agentic/commercial/offer` | POST | Audits `commercial.offer.shown` on every eligible response | Triggered offers: `manual_402`, `skip_notice`, `trial_end`, `quota_exhausted`. Body: `{ trigger, family?, runRequestId? }`. |
| `/payments/agentic/commercial/offer/compare` | GET | None (pure read) | Ambient compare surface. Query: `?family=` optional. Same payload shape, `trigger: "ambient"`. Populates `downgradeTargets`; ignores suppressions. |
| `/payments/agentic/commercial/offer/dismiss` | POST | Audits `commercial.offer.dismissed` BEFORE writing | Dismissal (§4.4). Body: `{ trigger, family? }`. 400 for `ambient` or unknown trigger. |
| `/payments/agentic/commercial/products/:productId/rank` | POST | Audits `commercial.product.rank.set` | Operator-only: set (or clear, with explicit null) a product's rank. 409 for `prod-free`. |

Slice 3 adds, in the same route file: `POST /commercial/runs-packs/checkout` + `POST /commercial/runs-packs/confirm` (mirroring the top-up pair), and pack-version routes following the #3289 product/version pattern (`POST /commercial/runs-packs/:productId/versions`, approve, deactivate — exact paths measured at slice-3 build; the pack version list rides the Products-section read). Route counts are MEASURED at build, never assumed (§13).

Route semantics follow the existing commercial routes exactly: 401 absent login; 403 for operator-only routes when the caller is not an operator (set-rank, pack management); self-only offer routes never 403 (the caller reads only their own offer; there is no userId parameter to abuse, unlike `GET /subscription`); 400 unknown trigger/family; 503 ports unbound or a store unavailable (catalog-coded `FAILURE_OFFER_UNAVAILABLE`, retryable). Session-scoped always: login from the verified session header, segment from the account row, tenant from the account row. No client-supplied tenantId, segment, or price is read — a body carrying any of them is ignored (or 400s on a price field; the build picks one and pins it — recommend ignore-with-audit-note, matching the grant route's "client tenantId ignored" precedent).

The `POST /offer` route audits BEFORE returning (audit failure = 503, never a silent unaudited offer — the shown-audit is a requirement, not best-effort). The audit write uses the existing audit port; if the audit port is unbound, the route 503s with the unavailable code rather than returning an unaudited offer. (If the build finds the audit port cannot fail independently of the stores, this collapses to the normal 503 path — record the finding, do not invent a second audit mechanism.)

### 5.2 At-limit upsell — the manual 402 moment

**The gate and the seam are untouched in slices 1–2.** The 402 response bodies keep their exact current shapes. The offer is fetched by the client AFTER the 402, from the surface that received it:

1. A screen call site receives a 402 (`payment_required` from the gate, or the seam's sync refusal — both already map through `mapScreenError`).
2. The call site's error handler, instead of rendering only the fixed string, renders the new `UpgradeOffer` component, which POSTs to `/commercial/offer` with `{ trigger: "manual_402", family, runRequestId }` (family/runRequestId taken from the 402 body when present — both ride the gate's 402 shape today).
3. On success with `eligible: true`, the component renders: the outcome-encoded at-limit message (existing copy, unchanged) + the comparison table (§5.3 component, shared) + actions: **Choose plan** (deep-links to `?tab=checkout&checkoutTab=subscriptions` with the recommended target preselected — preselection via query param the CheckoutPanel already supports for tabs; the plan preselect is a new query param, e.g. `?plan=<versionId>`, validated server-side at mint time, never trusted), **Buy credits** (deep-links to `?tab=checkout&checkoutTab=topup`), and **Buy runs** (slice 3: the runs-pack action, deep-linking to the pack purchase with the pack version preselected) + the **dismiss affordance** ("Not now" — POSTs to `/commercial/offer/dismiss`; on success the component collapses to the fixed copy with no offer section until the cooldown expires).
4. On `eligible: false`, or on ANY offer-fetch failure (network, 503, malformed payload), the component renders exactly today's fixed string from `mapScreenError`. The offer fetch can never make the at-limit experience worse than today, and never blocks on a slow offer service: the fixed message renders immediately, and the offer section fills in when (if) the payload arrives. (Loading state: the fixed message + a neutral "Loading upgrade options…" line; no spinner that implies the run is proceeding.) A dismissed trigger (`FAILURE_OFFER_SUPPRESSED`) renders identically to any other ineligible state — the user is not told they dismissed anything; the fixed copy simply stands alone.
5. The component passes `offerContext` (§4.3) into the checkout mint calls when the user acts from the offer, so acceptance is audited.

**`mapScreenError` keeps its contract.** The fixed 402 string remains the fallback and the no-offer behavior. The function gains no offer logic (it is a pure string mapper shared by every call site; offer fetching is the component's job). Call sites that render the offer component are the ones that can show it; call sites that only have a string slot keep the string. The build enumerates the call sites by grep (the #3239 lesson: one mapping, every call site shares it — the offer wiring must not fork the mapping).

**Triggered runs** (§9 of the definition) receive manual treatment at the gate, so a triggered run's 402 lands in the same handler with the same offer. No separate triggered path is built; the money path still knows only `manual | scheduled` (§3.1 gap 2 of the definition), and the offer does not need the triggered trigger carried through the seam — the 402 handler cannot distinguish triggered from manual today, and the offer is identical for both. When gap 2 ships, the offer trigger gains `triggered` as an alias of `manual_402` with no other change.

### 5.3 Plan compare/choose surface — the shared component

One component, `PlanCompare` (new file `src/client/PlanCompare.tsx`), used by all surfaces (at-limit upsell, CheckoutPanel subscriptions tab, trial-end notice). One implementation: the comparison renders in exactly one place, from exactly one payload shape.

Layout (columns, not cards — a comparison must be scannable):

| Row | Current (you) | Target 1 (recommended) | Target 2 | … |
|---|---|---|---|---|
| Plan | {held name or "Free"} | {name} | {name} | |
| Price | Your price $X / period (held) | $Y / period (current effective) | … | |
| Included runs | {remaining} of {allowance} left | {includedRuns} / product / month | … | |
| Period | ends {date} | {periodDays} days, {monthly\|annual} | … | |
| Trial | — | {N} days, {M} included runs / no trial | … | |
| Features | — | {display-only list} | … | |
| Action | — | [Choose plan] | [Choose plan] | |

Plus, below the table when applicable:

- The per-run alternative line ("Or pay per run: $0.02 per stock run at the current approved price") with a **Buy credits** action.
- The stacking disclosure (§3.5), only when the user holds a subscription: "Buying a plan adds its period to your current subscription and adds its included runs to your balance. Your current plan is not canceled or replaced."
- **Unavailable (PROPOSED) versions** (§2.4): rendered as greyed columns in the same table (or a clearly-separated "Not yet available" row group — the build picks one layout and pins it), each labeled "Proposed price — not yet approved, not buyable", with NO buy action. The proposed price number renders with the label (NQ5). When `showProposed` is false, the group does not render at all.
- **Downgrade targets (ambient only):** rendered below the upgrade columns as a separate "Lower plans" group with the downgrade disclosure (§3.6) and [Choose plan] actions flowing through the same native checkout. A Billing-managed held row renders the downgrade actions DISABLED with the Billing copy (§3.6). Interruptive surfaces never receive downgrade targets, so the component never has to hide them there.
- **Mentions** (§3.8): one line per non-null mention, above the actions: the referral line ("You have $X in referral credit…") with its link to the balance surface, and the free-access line when a grant exists. No mention renders when the payload carries null.
- **Runs packs (slice 3):** a "Buy runs without a plan" group listing `runsPacks` (runs + price per pack) with [Buy runs] actions flowing through the pack checkout. Hidden when `runsPacksEnabled` is false or the array is empty.

- **Current column when no subscription exists:** "Free" with the free allowance (remaining/allowance from the payload), price "$0". The `prod-free` baseline row gives this a uniform shape; the component does not hardcode Free's terms — the allowance count comes from the payload (operator data).
- **Choose plan** deep-links to the checkout subscriptions tab with the target preselected (§5.2 step 3). The purchase itself is the existing native checkout flow, unchanged — the offer adds preselection, not a purchase path. Preselection must survive the checkout panel's own plan fetch: the panel matches the query-param version id against its fetched `GET /plans` list and ignores it when absent (a superseded/deactivated version can never be preselected into a purchase — the mint route re-validates effectiveness + approval anyway).
- **No new top-level tab, no new nav item.** The compare surface lives inside existing surfaces (CheckoutPanel tab, at-limit notice, trial notice). No left-nav, admin-panel, or nav-config pin changes. The thin-router inventory pin moves only by the new routes (§5.1), in registration order, measured at build (never assumed).
- **Rank editor (Products section, slice 2):** each product row in `ProductsSection` gains a rank field ("Ladder position", 1 = lowest) with a save action calling the set-rank route; `prod-free` shows its fixed rank 1 with no edit control. The new-product form gains an optional rank input. The rank editor is operator-only, same gating as the rest of the section.
- **Accessibility:** the table is a real `<table>` with caption + scoped headers (the existing `DataTable` pattern in CheckoutPanel); actions are buttons, not links styled as buttons; the at-limit message uses `role="alert"` only for the error itself, the offer section uses `role="status"` (follows the quota-section WCAG precedent in definition §5.3). Unavailable columns use `aria-disabled` + text labels, not color alone.

### 5.4 Scheduled-skip owner notice — state-derived, no new channel

The skipped run is unattended: no offer can be shown in-run, and no checkout may be offered for the skipped run itself (definition §7). The design therefore does NOT build a notification, email, or push for skipped runs. Instead:

- The skip audit record and the run record keep their current shapes (reason + outcome code). Wherever skip explanations render to the owner (run history / workflow output surfaces — the build enumerates the render sites by grep for the coverage-required reason string), the explanation gains a link to the compare surface (`?tab=checkout&checkoutTab=subscriptions`). The link is the only addition; the explanation text is unchanged.
- When the owner next opens the CheckoutPanel subscriptions tab or the Accounts page, the compare surface renders with the at-limit context derived LIVE from account state (the account is still at the limit, so the offer derivation returns eligible). No stored "pending offer" is needed: the state IS the pending offer. If the owner has since bought coverage, the derivation returns ineligible and no offer shows — which is exactly correct.
- The `skip_notice` trigger exists for the audit trail: when the owner opens the compare surface within a session that follows a skip, the client passes `trigger: "skip_notice"` to the POST route (the client knows a skip occurred because the run record it just viewed carries the skip outcome). The server does not verify the skip happened — the trigger is audit context, not authorization. If the client cannot establish a skip preceded the view, it uses `ambient`.
- **Dismissal interplay:** dismissing `skip_notice` suppresses the skip-triggered offer (the POST route returns ineligible while suppressed). The skip-explanation LINK still renders — it is a link, not an offer — and the compare surface it leads to is the ambient surface, which dismissal never hides.
- **Build-time verification (required):** the skip render sites must be enumerated before slice 2 starts. If the sites are scattered across surfaces that cannot share the `PlanCompare` component, the skip-notice link becomes its own micro-slice (slice 2b) rather than bloating slice 2. Record the enumeration in the slice-2 claim.

### 5.5 Trial-end offer

The `trialEndedMessage` notice in `ProductCatalogPanel.tsx:607` gains the shared `PlanCompare` component below the message, fetched with `trigger: "trial_end"`. The trial detection already exists client-side (`trialExpired` state); the offer fetch reuses it. The existing "Start checkout" / "Start free trial" buttons are unchanged; the compare's Choose-plan action deep-links to the checkout subscriptions tab as in §5.2. The trial-end offer shows only when the derivation returns eligible (trial lapsed AND at the limit AND a purchasable action exists) — a user whose trial lapsed but who still holds free allowance sees the notice without the offer, per §2.3 rule 4. Mentions render in the trial-end offer when the payload carries them (§3.8); downgrade targets do not (ambient only, §3.6).

### 5.6 What the client must never do (pinned by tests)

- Never invent a price, discount, or charging decision (issue scope). Pinned: a test feeds the component a payload and asserts the rendered numbers equal the payload numbers exactly, including the annual-option savings figure.
- Never read tier, tenant, segment, or price from client state, query params, or localStorage for the offer. The payload is the only source. The `?plan=` preselect param is a hint the server re-validates, never a price or entitlement input.
- Never render a raw outcome code. Ineligible states render the fixed fallback copy; reason codes stay in the payload for observability.
- Never show an offer when the payload says ineligible, and never show the offer section while the payload is still loading in a way that implies the run will proceed. The fixed at-limit message is always present first.
- Never render a PROPOSED price without the unavailable label, and never render a buy action on an unavailable target (`buyable: false`). Pinned: a payload with `unavailableTargets` renders the label on every one and zero buy buttons for them.
- Never render downgrade targets on an interruptive trigger. (The server never sends them there; the component asserts the trigger before rendering the downgrade group — defense in depth, pinned.)
- Never store dismissal state client-side. Dismissal is a server write (§4.4); the client holds no suppression memory beyond the current render.
- Never render a mention the payload does not carry, and never link a referral mention to the marketplace referrals tab (§3.8).

## §6 — Boundaries: explicitly NOT in #3246 (Rev 2)

- **#3307 referral MECHANICS** (code issuance, redemption, per-product rules, invite links, attribution writes, abuse enforcement). Mentions are in (§3.8); mechanics stay with #3307.
- **#3247 free-access MECHANICS** (grant/revoke, semantics Q5). Mentions are in (§3.8, read contract only); mechanics stay with #3247.
- **Per-row subscription cancel.** The cancel route cancels all rows (#2662); a selective per-row cancel is a separate decision, not designed here. The offer never cancels anything (§3.6).
- **Plan-change / replace / convert / proration semantics.** #2145's territory. v1 stacks in both directions (§3.5–3.6). Provider-side proration (`prorationBehavior`) is untouched.
- **Billing-managed downgrade via provider update.** Downgrading a Stripe Billing subscription through the provider update path is out; the offer disables the downgrade buy-action for Billing-managed held rows instead (§3.6).
- **#3357 annual versions, revisited.** #3357 shipped; the offer READS annual versions, it does not create, derive, or approve them. No annual-derivation code is written here.
- **Any price approval.** No version is approved by an offer slice — including pack versions. The offer and the pack mint only read `approvalStatus`.
- **Any Stripe Price creation.** `stripePriceId` mapping stays an operator step (Q7 of #3289, still open).
- **Any gate, seam, or purchase-route behavior change in slices 1–2** beyond the additive `offerContext` audit field (§4.3). Slice 3's gate step and pack routes are the designed exceptions (§3.7).
- **Any new notification channel** (email, push, Slack) for skipped runs or trial ends (§5.4).
- **Any discount, coupon, promotional pricing, or bundle offer.** Bundles are COO #2781, explicitly distinct. Discounts would violate "no invented prices" and the price-flexibility rule (a discount IS a price decision, owner-gated).
- **Any per-user targeting, scoring, history-based, or A/B offer logic.** The offer is a deterministic function of entitlement state + the user's own dismissals (§2.3).
- **Per-segment rank.** Rank is per-product (§3.3). A per-segment rank table is rejected.
- **Dismissal of the ambient surface.** Ambient is never suppressible (§4.4).
- **Suppression retention sweep.** Expired suppression rows are inert; a sweep is a follow-up slice (§4.4).
- **The triggered-trigger tracking gap** (definition §3.1 gap 2). The offer works identically for manual and triggered 402s without it.

## §7 — File list

**New files (slice 1)**
- `src/services/upgradeOffers.ts` — pure `resolveOffer()` over ports (§5.1). No HTTP, no audit calls (the route audits; the service returns the audit payload with the response).
- `src/data/offerSuppressionPorts.ts` — `OfferSuppressionPort` + record type + validators (§4.4).
- `src/data/d1OfferSuppressionAdapter.ts` + `src/data/inMemoryOfferSuppressionAdapter.ts` + `src/data/createOfferSuppressionPorts.ts` — adapters + composition root (verify naming against the free-run-counter precedent at build).
- `tests/upgradeOffers.test.ts` — the §2.3 eligibility matrix + §3 resolution rules + payload-shape pins.
- `tests/upgradeOfferRoutes.test.ts` — route semantics (401/400/503, audit emission, no client-trusted fields, dismiss route).
- `tests/offerSuppressions.test.ts` — suppression port/adapter parity + cooldown arithmetic.
- `changelog.d/3246-upgrade-offers.md` — Policy Gate (d) fragment (`### ` first line + bullet; never edit CHANGELOG.md). One fragment for the whole issue, in slice 1 (the fragment describes the issue's delivery; slices 2–3 do not add further fragments for the same issue — verify the fragment convention at build; if one fragment per PR is required, each slice carries its own).

**Modified files (slice 1)**
- `src/data/migrationRunner.ts` — migration 0059: `agent_offer_suppressions` table + `rank` column on `agent_products` + rank-1 seed for `prod-free`; registry entry in `ALL_MIGRATIONS` (number re-checked at build, §13).
- `src/data/drizzleSchema.ts` — `agentOfferSuppressions` table + `rank` on `agentProducts`.
- `src/data/productPorts.ts` — `rank: number | null` on `ProductRecord`, `assertProductRank`, `rank` accepted by `createProduct`/`getOrCreateProduct`, `setProductRank(productId, rank)` on `ProductStore`.
- `src/data/d1ProductAdapter.ts` + `src/data/inMemoryProductAdapter.ts` — rank mapping + `setProductRank`.
- `src/data/billingPolicyPorts.ts` — `offerRules` block on `BillingPolicy`, `assertOfferRules`, seed default in `PROPOSED_SEED_BILLING_POLICY`, `offer_rules` key in `BILLING_POLICY_KEYS` (§4.2).
- `src/data/d1BillingPolicyAdapter.ts` + `src/data/inMemoryBillingPolicyAdapter.ts` — the `offer_rules` key: seed row + field mapping (zero DDL change; verify the in-memory mirror at build).
- `src/agents/routes/agenticPayments.ts` — the three offer routes + the set-rank route (§5.1) + the additive `offerContext` audit field on the native subscription checkout + top-up checkout mints (§4.3). No other route behavior changes.
- `src/outcomes/outcomeCatalog.json` — the §4.5 codes (via the catalog's own update path; verify the "single resolver" wiring at build — the catalog file + resolver are the one implementation, no second code list).
- `tests/thin_router_inventory.test.ts` — the new routes in registration order; MEASURE the count, never assume.
- `tests/billing_policy*.test.ts` (identify at build) — the rules block validation + seed.
- `tests/product*.test.ts` (identify at build) — rank validation, set-rank, `prod-free` rank fixed, adapter parity.

**New files (slice 2)**
- `src/client/PlanCompare.tsx` — the shared comparison component (§5.3), including unavailable/downgrade/mention groups.
- `src/client/UpgradeOffer.tsx` — the at-limit offer wrapper: fetches, falls back, dismisses, passes `offerContext` (§5.2). (Or a single file with PlanCompare if the build finds the split artificial — one component file is acceptable; two components in one file is not: keep the comparison renderable standalone for the ambient surface.)
- `tests/planCompare.test.tsx` + `tests/upgradeOffer.test.tsx` — render-verbatim pins (§5.6), fallback behavior, dismissal wiring, acceptance wiring.

**Modified files (slice 2)**
- `src/client/CheckoutPanel.tsx` — compare section in the subscriptions tab + `?plan=` preselect handling (§5.3). No purchase-flow change.
- `src/client/ProductCatalogPanel.tsx` — trial-end notice gains the compare component (§5.5).
- `src/client/paidScreenSubmit.ts` — NO change expected (the fixed string stays the fallback). Change only if the build finds a call site that must distinguish "offer available" from the string — and if so, the change is additive (a new export), never a change to `mapScreenError`'s existing contract.
- The 402-handler call sites (enumerated by grep at build) — render `UpgradeOffer` where a component can mount (§5.2 step 2).
- The skip-explanation render sites (enumerated by grep at build, §5.4) — link to the compare surface.
- `src/client/BillingServicingPanel.tsx` (verify filename at build) — offer-rules editors: all toggles + cooldown-days editor (§4.2). Operator-only, same gating.
- `src/client/ProductsSection.tsx` — per-product rank editor + rank input on the new-product form (§5.3). Operator-only, same gating.
- `tests/*pin*` — only the thin-router pin (slice 1). No nav/admin pins (no new tab, §5.3). If the build adds ANY admin-surface element that a pin counts, update EVERY pin file it affects (the #3315/#3115 lesson) — the design expects zero.
- `docs/architecture/business/entitlements-01.md` — §3.1 gap 1 → shipped (the at-limit offer), §7 "shipped today" paragraph → the offer behavior, §12 "still to verify" → the live at-limit rendering stays unverified until a live check (do not claim it). No other doc changes in slice 2.
- `src/client/commercialApi.ts` — `OfferPayload`/`OfferTarget`/`RunsPackOffer`/mention types + `getOfferCompare` / `postOffer` / `postOfferDismiss` fetchers, following the existing `get`/`post` helpers. The fetchers send the session identity header like every other call; no new auth shape.

**New files (slice 3 — runs packs)**
- `src/data/runsPackPorts.ts` — pack version record + `RunsPackVersionPort` + `RunsPackBalancePort` + validators (§3.7).
- `src/data/d1RunsPackAdapter.ts` + `src/data/inMemoryRunsPackAdapter.ts` + `src/data/createRunsPackPorts.ts` — adapters + composition root (verify naming at build).
- `src/services/runsPackActivation.ts` — pure `activateRunsPack` (verify payment → add runs → journal → audit payload), mirroring `subscriptionActivation.ts` minus the subscription row.
- `tests/runsPacks.test.ts` + `tests/runsPackRoutes.test.ts` + `tests/runsPackGate.test.ts` — version/approval rules, route semantics, gate-step matrix.

**Modified files (slice 3)**
- `src/data/migrationRunner.ts` — migration 0060: `agent_runs_pack_versions` + `agent_runs_pack_balances`; registry entry (number re-checked at build).
- `src/data/drizzleSchema.ts` — the two pack tables.
- `src/data/productPorts.ts` — `ProductKind` gains `"runs_pack"` + `assertProductKind` extension.
- `src/services/nativeMonetization.ts` — the additive `runs_pack` coverage branch in `check()` (§3.7). NOTHING else in the gate moves.
- The payment workflow's `consumeCoverage` (identify the file at build — the `paymentWorkflow.ts` flow) — no-op for `paidVia: "runs_pack"` (consumed at decision time, §3.7).
- `src/agents/routes/agenticPayments.ts` — pack checkout/confirm routes + pack-version routes (create/approve/deactivate) + `offerContext` on the pack mint (§4.3).
- `src/services/upgradeOffers.ts` — `runsPacks` in the payload + pack balance in the rule-4 coverage read (§2.3–2.4).
- `src/client/PlanCompare.tsx` — the runs-pack group (§5.3).
- `src/client/ProductsSection.tsx` — pack product creation (kind selector gains `runs_pack`) + pack version chains + approve/deactivate (§3.7).
- `src/client/CheckoutPanel.tsx` — pack purchase action (preselect + mint via the pack routes; no purchase-flow redesign).
- `src/outcomes/outcomeCatalog.json` — the slice-3 pack codes (§4.5).
- `tests/thin_router_inventory.test.ts` — the slice-3 routes, measured.
- `docs/architecture/business/entitlements-01.md` — §2.1 gate order gains the `runs_pack` step (between `subscription_included` and `credits`) + a §4/§5 note recording the pack balance as a prepaid coverage kind distinct from included runs. The definition update lands in the slice-3 PR (the behavior ships in slice 3, so the doc must not claim it earlier).

**Never touched:** `tests/actor-ports-conformance.test.ts`; `src/services/paidScreenSubmission.ts` (the seam); `src/services/subscriptionActivation.ts` (purchase stacking semantics); any other lane's in-flight work; no flag, price, grant, or secret changes in production. (`src/services/nativeMonetization.ts` is touched ONLY in slice 3, ONLY by the additive `runs_pack` branch.)

## §8 — Slice split

No sub-issues. The split + justification are recorded in the #3246 claim comment (gitops §9 test 2: each slice independently shippable + revertible on its own). No ADR: the decisions in §10 are recorded in this design doc, which is the decision record; no architectural rule changes (all work reuses ports/adapters/routes/audit/catalog under ADR 0002, and the new tables/ports follow existing patterns — the runs-pack unit follows the plan/catalogue version pattern, the suppression store follows the quota-counter pattern). If Mars or review requires an ADR, it is `docs/architecture/adr/0030-upgrade-offers.md` (verify the next number at build) and it lands with slice 1.

| Slice | Scope | Shippable alone? |
|---|---|---|
| **Slice 1 — server: offer derivation + rules + dismissal + rank** | `resolveOffer()` service + three offer routes + set-rank route + billing-policy `offerRules` + suppression store + rank on products + migration 0059 + audit events + catalog codes + thin-router pin + tests. No UI. The routes are live but unreachable from any UI surface; the offer is verifiable by direct API call. | Yes: additive routes + settings + one new table + one nullable column, zero behavior change to any existing path (the `offerContext` field is ignored when absent; rank NULL everywhere reads as derived order). Revertible by removing the routes (migration 0059's table/column stay, inert, per the no-down-migration discipline). |
| **Slice 2 — client: offer surfaces** | `PlanCompare` + `UpgradeOffer` (incl. dismiss affordance) + CheckoutPanel compare + trial-end offer + 402-handler wiring + skip-link wiring + Billing servicing rules editors + Products-section rank editor + pins + docs + changelog. | Yes, on top of slice 1: all UI reads the slice-1 routes; with slice 1 reverted the UI falls back to today's fixed copy (the fetch-failure fallback, §5.2 step 4). |
| **Slice 3 — runs-pack purchase (server + gate + client)** | Pack versions + balances (migration 0060) + ports/adapters + gate `runs_pack` step + checkout/confirm routes + activation + journal + audit + offer payload `runsPacks` + PlanCompare pack group + Products-section pack management + tests + docs. | Yes, on top of slices 1–2: the pack unit is additive (new tables, new routes, one new gate branch); with slice 3 reverted, packs vanish from the offer (empty `runsPacks`, zero balances) and every existing path behaves as before. The gate branch is the one money-path touch in the whole issue, isolated here. |
| **Slice 2b (only if §5.4 enumeration requires it)** | Skip-notice render-site wiring, if the sites cannot share slice 2's components. | Yes: links only, no behavior change. |

Each slice: one PR, claim comment naming slice + branch before starting, publish-early (draft PR as soon as Tier 1 is green, full suite in CI), go/no-go presented to Mars per the discussion rule, §18 on the landing SHA, completion note on Mars's tap. Slice 3's PR completes #3246; the issue closes only when all slices are merged and the completion note is posted.

**Explicitly deferred out of #3246 (not slices, separate decisions):** per-row subscription cancel (§3.6); plan-change/replace/proration (§3.5, #2145's design); Billing-managed downgrade via provider update (§3.6); referral mechanics (§3.8, #3307); free-access mechanics (§3.8, #3247); per-segment rank (§3.3); suppression retention sweep (§4.4); pack expiry (§3.7, NQ2).

## §9 — Verification

### 9.1 Slice 1 (server)

- **Eligibility matrix** (`tests/upgradeOffers.test.ts`): flag OFF → ineligible; coverage exists (each coverage kind: grant-within-quota, free allowance left, included runs left, credits ≥ price) → ineligible; at limit + approved higher target → eligible with the exact §2.4 payload; at limit + only PROPOSED higher target → ineligible (`FAILURE_OFFER_NO_TARGET`) AND the payload carries the proposed version in `unavailableTargets` when the derivation runs for ambient; at limit + no higher target + top-up available → eligible, top-up-only, empty targets; quota cap + action `stop` → ineligible; quota cap + action `upgrade_or_buy_credits` → eligible; segment with no effective version → no targets for that segment; segment isolation (another segment's cheaper version never appears); held superseded version → held price shown, current effective price shown, both correct; trial-lapsed + at limit → eligible; missing account row → implicit Free current side, segment `default`.
- **Suppression matrix:** dismiss `manual_402` → POST offer for `manual_402` ineligible with `FAILURE_OFFER_SUPPRESSED`; other triggers unaffected; `ambient` unaffected by any suppression; expired suppression (cooldown passed) → eligible again; re-dismiss re-arms from now; dismiss `ambient` → 400; dismiss unknown trigger → 400; dismiss audits `commercial.offer.dismissed` with the §4.3 payload; suppression survives a derivation with the port unbound → 503 (never a silent unsuppressed offer — the port is required when the route is live; if the build finds the port optional, record the finding and pin the chosen behavior).
- **Ladder rules:** ranked products order by rank ascending; unranked order by includedRuns desc then priceUSD asc, after all ranked products; mixed ranked/unranked comparison follows the total order; `recommended` is exactly one target (the nearest step up), or none when no strict increase exists; `prod-free` rank is 1 and set-rank 409s for it; rank validation rejects 0/negative/fractional/non-numeric; annualOption present iff both periods have effective versions, with `savingsVsMonthlyUSD` equal to monthly×12 − annual computed from the versions' own prices.
- **Downgrade rules:** `downgradeTargets` populated for `ambient` only (empty for every interruptive trigger); lower-ranked approved versions only; Billing-managed held row → `buyable: false` + `unavailableReason: "billing_managed"`; `downgradesEnabled: false` → empty array.
- **Mention rules:** referral mention present iff referral state exists (balance/earnings/attribution) + toggle on + port bound; numbers verbatim from the port reads; null when the port is unbound; null when no referral state; `freeAccess` always null (port unbound — pinned, so the #3247 landing cannot silently change offer behavior without a test update); mention toggles off → null.
- **Route tests:** 401 no login; 400 unknown trigger/family; 503 ports unbound (catalog-coded, retryable); `commercial.offer.shown` audited on every eligible POST response with the §4.3 payload, and NOT audited for ineligible responses or GET compare calls; client-supplied tenantId/segment/price ignored; `offerContext` on mint routes audits `commercial.offer.accepted`, absence audits nothing new, mint behavior otherwise byte-identical; set-rank route: 403 non-operator, 409 `prod-free`, audit `commercial.product.rank.set`, rank visible on the next product read.
- **Rules tests:** seed default (all triggers on, cooldown 7, all visibility/mention toggles on); POST validation rejects non-boolean/unknown triggers, cooldown outside 1–365, and unknown keys, with a catalog-coded 400; `enabled: false` → every derivation ineligible with `FAILURE_OFFER_DISABLED`; operator-only (403 otherwise, same gating as the billing-policy route).
- **Migration tests:** migration 0059 applies cleanly on a store with existing products (rank NULL everywhere except `prod-free` = 1); the canonical registry test passes; the `agent_offer_suppressions` table accepts the (login, trigger) PK + upsert shape.
- **No-regression:** the full existing commercial route/gate test suites pass unchanged; the thin-router inventory pin matches the measured count.

### 9.2 Slice 2 (client)

- **Render-verbatim pins:** feed `PlanCompare` a fixed payload; assert every rendered number (prices, runs, periods, savings, held vs current) equals the payload exactly. Feed it a payload with no annualOption and assert no annual row renders. Feed it a held≠current price payload and assert both numbers render with distinct labels.
- **Unavailable pins:** a payload with `unavailableTargets` renders the proposed label on every one, the proposed price with the label, and ZERO buy buttons for them. `showProposed: false` payloads carry no unavailable group (server-side; the component renders what it is given).
- **Downgrade pins:** an ambient payload renders the downgrade group with the §3.6 disclosure; a Billing-managed downgrade target renders disabled with the Billing copy; an interruptive-trigger payload renders no downgrade group even if one were (incorrectly) present.
- **Mention pins:** a payload with mentions renders the referral numbers verbatim + the link to the balance surface (never the marketplace referrals tab); a payload with null mentions renders no mention lines.
- **Dismissal pins:** the dismiss affordance POSTs to the dismiss route with the trigger; on success the component collapses to the fixed copy; no client-side suppression storage exists (assert no localStorage/sessionStorage writes from the component).
- **Fallback pins:** offer fetch rejects / 503s / returns malformed JSON → the fixed `mapScreenError` string renders, no blank section, no spinner forever. `eligible: false` → fixed string only, no offer section.
- **Acceptance wiring:** acting from the offer calls the EXISTING mint routes with `offerContext` present; acting from the plain checkout (no offer) calls the same routes without it. No new purchase route is called anywhere (assert by route spy / fetch mock on the exact existing paths).
- **Preselect:** `?plan=<versionId>` preselects only when the id matches a fetched effective plan; a superseded/unknown id is ignored (no purchase path to a dead version).
- **Rank editor pins:** the Products section rank field saves through the set-rank route; `prod-free` shows rank 1 with no edit control; invalid rank input is rejected client-side with the catalog message.
- **No-offer-where-coverage-exists (acceptance, end-to-end shape):** a test account with coverage opens the at-limit surface → no offer section. (Client test with a mocked eligible:false payload + the slice-1 server matrix test together cover the acceptance criterion; a full live e2e is not required — the live at-limit rendering stays in §12 "still to verify" until a live check.)
- **Pins:** thin-router inventory (already moved in slice 1 — slice 2 adds no routes, so zero pin movement expected; verify, don't assume). No nav/admin pins (no new tab).
- **Docs:** entitlements-01.md §3.1 gap 1 marked shipped with the slice's PR/landing reference; §7 "shipped today" paragraph rewritten to the offer behavior; no other doc claims changed. The doc update lands in the slice-2 PR (the behavior ships in slice 2, so the doc must not claim it in slice 1).

### 9.3 Slice 3 (runs packs)

- **Version/approval rules:** pack versions resolve through `resolveEffectiveVersion` (segment, window, active); only APPROVED versions are buyable; PROPOSED versions 402 at mint; deactivated versions never resolve; same-start ties break by greatest version (the #3289 rule).
- **Gate matrix:** pack balance > 0 + no included runs → `paidVia: "runs_pack"`, balance decremented exactly once (conditional-decrement + applied-check; concurrent double-spend refused); included runs present → `subscription_included` wins over packs; credits-only + pack balance 0 → `credits`; pack balance > 0 + credits ≥ price → pack wins (NQ1 placement); unapproved catalogue price → fail-closed before the pack branch (the §3.7 honesty constraint — pinned, so a future change to price-resolution order breaks loudly); pack-covered run records the quoted catalogue version + price with `paidVia: "runs_pack"`.
- **Purchase rules:** mint 402s on unapproved/missing pack version; confirm credits ONLY on verified payment (unverified → no credit, no journal, audited refusal); confirm is idempotent on replay (same checkout id → same result, no double credit — the top-up replay-guard precedent, verified at build); purchase confers NO tier and creates NO subscription row (assert the account row's tier and the subscription list are unchanged); journal entry Dr 1000 / Cr 4000 with productId/versionId/priceUSD; audit `commercial.runs_pack.purchased`; `offerContext` on the pack mint audits `commercial.offer.accepted` with action `"runs_pack"`.
- **Offer integration:** `runsPacks` lists effective approved pack versions for the segment only; `runsPacksEnabled: false` → empty; pack balance > 0 → rule-4 coverage (no interruptive offer); pack group renders in `PlanCompare` with runs + price verbatim and a working buy action.
- **Migration tests:** migration 0060 applies cleanly; the canonical registry test passes; pack version unique index + balance PK hold.
- **Docs:** entitlements-01.md §2.1 gate order + coverage-kind note updated in the slice-3 PR.

### 9.4 What is NOT verified by tests (stated, not hidden)

- The live at-limit rendering (real browser, real account, real 402) — stays in entitlements §12 "still to verify" until a live check with a real login. The design does not claim it.
- The live store's approved-price set (which versions are actually approved, which segments exist, which products are ranked) — operator data, not verifiable from the repo. The offer derivation is correct for ANY operator data; the specific offers real users see depend on the live store.
- Whether any real account currently sits at the limit and would see an offer on day one — a live-store question, not a code question.
- Whether any real account holds referral earnings or an attribution row — live-store data; the mention renders only when the reads return state.

## §10 — Decisions log (design decisions made here, with rationale)

Rev 1 decisions D1–D14 stand except where annotated OVERTURNED. Rev 2 decisions are D15–D23.

| # | Decision | Rationale | Alternative rejected / status |
|---|---|---|---|
| D1 | Offers are computed, not stored. No offer inventory/campaign table. | One implementation; no second source of pricing truth; deterministic and testable. | Stored offer campaigns (marketing inventory) — would duplicate plan data and need a content-approval workflow the issue never asks for. |
| D2 | Dedicated compare/offer endpoint (Q10: yes). | Held versions aren't in `GET /plans`; eligibility is server-side; shown-audit must be guaranteed. | Reusing `GET /plans` + client-side join — the client cannot resolve held prices and must not implement eligibility. |
| D3 | One service, two routes (POST audited / GET pure). | Triggered offers need guaranteed shown-audit; ambient views must not flood the audit log. | Single POST for everything (audit noise) or beacon-after-GET (client can forget/forge the beacon). EXTENDED in Rev 2: a third route (dismiss) + the set-rank route (§5.1). |
| D4 | Offer rules extend the billing policy (no new table, no migration for rules). | The #3262/#3357 precedent; the policy store IS the operator commercial-settings store; the grown block still rides ONE JSON-valued key. | Dedicated `agent_offer_rules` table — REVISITED in Rev 2, still rejected for rules. (Migration 0059 exists for suppressions + rank, not for rules.) |
| D5 | Ladder derived from includedRuns then price; no operator rank field. | — | **OVERTURNED by Mars (Q4, Rev 2).** Replaced by D15: rank + derived, both supported. |
| D6 | Stacking purchase semantics in v1; no "switch/convert" language or behavior. | It is the existing, tested purchase behavior; replace/proration is #2145's unbuilt design. Claiming switch semantics would be false. | Building plan-change/replace in this slice — out of scope, new money behavior, needs its own design + owner decision (Q1). STANDS (waiver). Applies to downgrades too (§3.6). |
| D7 | Offer acceptance flows ONLY through the native one-time purchase route (tier + runs together). | The Billing route confers tier-only and would strand the user with zero included runs — the exact hole the definition records. | Accepting through either route — would ship the tier-only hole inside the offer. STANDS. Extended: pack acceptance flows through the pack checkout/confirm pair (§3.7), never the Billing route. |
| D8 | "Buy included runs" is served by subscribing. No standalone runs purchase. | — | **OVERTURNED by Mars (Q3, Rev 2).** Replaced by D19–D20: standalone runs-pack purchase in slice 3, alongside subscribing. |
| D9 | No dismissal/cooldown memory in v1; operator kill-switch is the suppression mechanism. | — | **OVERTURNED by Mars (Q5, Rev 2).** Replaced by D16: server-side dismissal/cooldown required in v1. |
| D10 | PROPOSED versions are never offer targets (excluded, not shown-unavailable). | — | **OVERTURNED by Mars (Q6, Rev 2).** Replaced by D17: PROPOSED versions shown as unavailable, never buyable. |
| D11 | No gate/seam/purchase-route behavior changes; the client fetches the offer after the 402. | Zero risk to the money path; the offer is additive and falls back to today's copy on any failure. | Embedding the offer payload in the 402 body — touches the gate/seam contract and every 402 producer. STANDS for slices 1–2; slice 3's additive gate step + pack routes are the designed exceptions (§3.7). |
| D12 | No ADR; this design doc is the decision record. | No new architectural primitive; everything reuses ADR 0002 ports/adapters/routes/audit/catalog. | ADR 0030 — available if Mars/review requires it; it would restate §10. REVISITED in Rev 2: still no ADR — the new tables/ports follow existing patterns; no architectural rule changes. |
| D13 | Skip-notice offer is state-derived on next visit; no new notification channel. | The state IS the pending offer; a notification channel is a new system the issue never asks for. | Email/push/ Slack skip notices — out of scope, new channel, new consent/scope questions. STANDS. |
| D14 | Annual price is read from the annual version, never derived by the offer. | #3357 owns derivation; the offer must not compute prices (issue scope: client never invents a price — the same discipline applies to the offer service). | Deriving annual in the offer service — duplicates #3357's derivation, second computation of the same price. STANDS. |
| D15 | (Rev 2) Ladder = explicit rank first, derived fallback; rank 1 = lowest rung; NULLS LAST; `prod-free` fixed at rank 1; rank per-product, not per-segment. | Both mechanisms supported (Mars Q4) under one total, deterministic, testable order; unranked-last is the loud failure mode (visible misplacement prompts ranking); per-segment rank has no evidence of demand. | Rank-only (breaks unranked catalogues); derived-only (overturned); per-segment rank (rejected, no demand); unranked-first (silent disappearance). |
| D16 | (Rev 2) Dismissal = per-(login, trigger) server-side suppression, operator-configured cooldown (1–365 days, seed 7), dismiss route + audit-before-write; ambient exempt; re-dismiss re-arms from now. | Mars Q5 requires it; server-side is the only auditable durability; per-trigger scope matches the trigger model; ambient exemption preserves the user's deliberate act. | Client-side dismissal (device-local, unauditable); kill-switch-only (overturned); per-family dismissal (NQ4); global cooldown (rejected — one trigger's dismissal must not silence another). |
| D17 | (Rev 2) PROPOSED versions shown as unavailable: stored price labeled proposed-not-approved, no buy action; `perRun` stays approved-only. | Mars Q6; the label keeps the display honest; the per-run line is buy-adjacent and must stay chargeable-only. | Hiding proposed (overturned); showing the number unlabeled (would present an unapproved price as buyable); hiding the number entirely (NQ5). |
| D18 | (Rev 2) Downgrade = buy the lower plan through the native route with stacking disclosure; no cancel, no proration; ambient only; Billing-managed held rows get a disabled buy-action. | Mars Q7 with existing machinery only; a downgrade cannot resolve the limit (ambient placement); a native purchase cannot reduce a Stripe Billing charge (disabled action avoids misleading the user). | Plan-change/replace (needs #2145); per-row cancel (no route exists); downgrade buy-action for Billing-held rows (NQ3). |
| D19 | (Rev 2) Runs-pack products with their OWN approval-gated (runs, price) versions; per-run × N pricing rejected. | Pack terms are operator-set and approval-gated like plans; per-run × N cannot charge today (all PROPOSED), invents a pricing rule, and makes price user-derived. | Per-run × N (rejected, three reasons in §3.7); packs as plan rows (would surface as subscriptions in GET /plans — conflates two purchaseable units). |
| D20 | (Rev 2) Pack runs live in a DEDICATED balance, consumed by a dedicated gate step placed after `subscription_included`, before `credits`, consumed at decision time (quota precedent). | The gate spends `includedRuns` only for Subscribed — reusing the counter would strand Free/PayPerUse buyers and change trial-leftover semantics; decision-time consumption means the gate never allows a run it did not count. | Reusing `includedRuns` (strands buyers); widening the gate's Subscribed condition (silently changes #3243 semantics); workflow-time consumption (race between allow and count). |
| D21 | (Rev 2) Mentions are read-only with absence tolerance: referral reads from the existing `ReferralCreditPort` (render only with referral state); free-access read contract defined, port unbound until #3247 (always null until then). | Mars Q10 within what exists: referral data is built, free-access data is not; absence tolerance keeps offer code independent of #3307/#3247 landings. | Waiting for #3307/#3247 (would block the offer on unbuilt slices); inventing a code/free-access read (no data to read). |
| D22 | (Rev 2) Every offer behavior is operator-configurable through the UX with externalized defaults: rules block (§4.2) + rank editor + pack management, all operator data, PROPOSED seeds. | Mars's closing directive, made concrete per surface. | Any code-constant default (forbidden by the standing rule); operator configuration without a UI (forbidden by the directive). |
| D23 | (Rev 2) Three slices; migration 0059 in slice 1 (suppressions + rank), migration 0060 in slice 3 (pack tables); gate changes isolated in slice 3. | Each slice independently shippable + revertible (gitops §9 test 2); the money-path touch is isolated in the last slice, after the offer surfaces prove themselves. | Two slices with packs folded into slice 2 (mixes a new money path into a client slice); one migration for everything (couples slice 1 to slice 3's tables). |

## §11 — Open questions: Q1–Q10 ANSWERED; new questions NQ1–NQ7

### Q1–Q10 — all answered (Mars, 2026-11-12)

| # | Question | Answer | Effect |
|---|---|---|---|
| Q1 | Stacking vs replace | **Stands on the waiver** ("Build on the recommendations", ~07:54 EST): stacking acceptable for v1 with the disclosure. | §3.5 unchanged; applies to downgrades too (§3.6). |
| Q2 | Trigger scope | **Stands on the waiver:** all four triggers + ambient in v1. | §2.2 unchanged. |
| Q3 | Standalone included-runs purchase | **OVERRIDDEN (~07:58 EST): "it should support included runs-purchase as well."** | §3.7 + slice 3 (D19–D20). |
| Q4 | Ladder ranking | **OVERRIDDEN: "explicit operator rank should be supported as well."** | §3.3 (D15). |
| Q5 | Dismissal/cooldown | **OVERRIDDEN: "required."** | §4.4 (D16). |
| Q6 | PROPOSED plans in compare | **OVERRIDDEN: "shown."** | §2.4 + §5.3 (D17). |
| Q7 | Downgrades | **OVERRIDDEN: "included."** | §3.6 (D18). |
| Q8 | Inline vs link-out | **Confirmed: inline.** | §5.2 unchanged. |
| Q9 | Annual preselection | **Confirmed: follow the billing-policy default.** | §3.3 unchanged. |
| Q10 | Referral/free-access mentions | **OVERRIDDEN: "included."** | §3.8 (D21). |
| — | Configurability | **Directive: "all of this must be configurable through UX with externalized defaults."** | §0 item 12, §4.2, §5.3 (D22). |

### NQ1–NQ7 — new load-bearing questions from the expanded scope (each with a recommendation)

A different answer on any of these changes a slice. The build can proceed on the recommendations if Mars waives them explicitly.

1. **NQ1 — Pack-consumption order (blast radius: the gate).** Pack runs are consumed AFTER subscription included runs and BEFORE credits. Is that order right — or should packs consume before included runs, or after credits? *Recommendation: after included runs, before credits — most-specific prepaid balance first, money last; the decided coverage order keeps its shape.*
2. **NQ2 — Pack expiry.** Packs never expire in v1: bought runs stay in the balance until spent. Acceptable — or must packs carry an expiry (which needs its own design + disclosure + a lapse mechanism)? *Recommendation: no expiry in v1 — runs are bought, not rented, and no expiry machinery exists to reuse.*
3. **NQ3 — Downgrade + Billing-managed held rows.** The downgrade buy-action is DISABLED when the held subscription is Stripe-Billing-managed, with copy explaining why. Acceptable — or should the buy-action stay enabled with a disclosure (the user buys natively alongside their Billing subscription)? *Recommendation: disabled — a native purchase cannot reduce a Stripe Billing charge, and an enabled button would mislead about the downgrade's whole point.*
4. **NQ4 — Dismissal scope.** Dismissal suppresses the trigger across ALL families (per login + trigger). Acceptable — or should dismissal be per-family (dismissing the stock offer leaves the options offer showing)? *Recommendation: per (login, trigger) — the user dismissed the offer, not the family; per-family dismissal multiplies suppression rows without evidence of demand.*
5. **NQ5 — PROPOSED price number.** Unavailable versions show the stored proposed price number WITH the "proposed — not yet approved, not buyable" label. Acceptable — or should the number be hidden behind a bare "coming soon" (no price shown until approved)? *Recommendation: show the number with the label — the compare table must let the user plan, and the label keeps it honest.*
6. **NQ6 — Pack family scope.** Packs are family-agnostic: a pack run spends on any screen family (the same fungibility as included runs). Acceptable — or must packs be per-family (a stock pack, an options pack)? *Recommendation: family-agnostic — per-family packs multiply products without evidence of demand, and the included-runs precedent is fungible.*
7. **NQ7 — Pack spending needs catalogue approval.** Pack runs, like subscription included runs, are spendable only when the family's catalogue price is APPROVED (price resolution precedes coverage and fails closed). Buying a pack before catalogue approval stores the balance but cannot spend it. Acceptable — or should pack runs bypass catalogue approval like grant-covered runs do? *Recommendation: keep the precondition — packs must not become an approval bypass, and consistency with included runs keeps the gate's story total.*

## §12 — Cross-references and question resolutions

- **#3289 Q10 (offer data) — ANSWERED by this design (D2):** the §6.3 exposure is NOT sufficient; a dedicated compare/offer endpoint is needed (held versions, server-side eligibility, guaranteed shown-audit). The endpoint design is §5.1.
- **#3289 Q9 consequence:** Free as a product row (`prod-free`) gives the compare surface a uniform "current" row for Free accounts (§5.3). No special-casing of Free in the component beyond the payload's null-held-plan shape. Rev 2: `prod-free` also anchors the ladder (rank 1, fixed, §3.3).
- **#3289 Q11 consequence:** features are display-only free text; the compare renders them verbatim from `featuresJson` and never gates behavior on them.
- **Definition §3.1 gap 1** (the at-limit offer) is the gap this design closes. Gap 2 (triggered tracking) is untouched (§6).
- **Definition §7** is the decided behavior this design implements; §7's "shipped today" paragraph is rewritten by slice 2's doc update (§7 file list). Slice 3 updates §2.1 (gate order) with the `runs_pack` step.
- **#2145 (recurring design):** proration/downgrade/replace semantics stay there. This design's stacking disclosure (§3.5) and downgrade disclosure (§3.6) must be re-checked against #2145 if #2145 lands plan-change semantics before #3246 ships — the offer copy would then be wrong and must be updated in the same window. Recorded as a build-time re-verification, not a dependency.
- **#2669 (COO checkout UI):** the offer reuses the checkout UI it built; it does not redesign checkout. The `?plan=` preselect param is the only checkout-panel addition, and it is additive.
- **#2781 (COO bundles):** distinct — bundle offers are never #3246 offers (§6).
- **#2662 (cancel route):** exists and cancels ALL rows; the offer never calls it (§3.6). A per-row cancel route is a separate decision.
- **#2208 / #2657 (referral ledger):** the mention reads (§3.8). The offer reads `ReferralCreditPort` only; it writes nothing to referral tables.
- **#3307 / #3247:** mentions in scope (§3.8), mechanics out (§6). If either slice lands first and defines an offer-surface link, the #3246 build adopts the link contract from that slice's design; it does not invent one. The free-access read contract (§3.8) is the interface #3247 implements.
- **#4246 (CPO ratchet follow-up):** unrelated to offer content, but the #4217 lesson applies to slice 2's UI copy: never write `#NNNN` issue references in rendered JSX text under `src/client` (the UX token ratchet reads them as hex colors). Offer copy references issues, if at all, as "issue NNNN" without the hash, and preferably not at all.

## §13 — Build-time verifications (the builder must re-check, not assume)

1. The 402-handler call sites (grep for `mapScreenError` callers) and the skip-explanation render sites (grep for the coverage-required reason string) — enumerate before slice 2 starts (§5.2, §5.4).
2. The thin-router inventory count — measure, never assume (§7). Slice 1 adds four routes (three offer + set-rank); slice 3 adds the pack routes — count each slice's routes at its build.
3. The Billing servicing panel filename + the offer-rules editor placement (§4.2, §7).
4. The outcome-catalog update path — the single-resolver wiring for new codes (§7).
5. Whether the D1/in-memory billing-policy adapters need any change beyond the `offer_rules` key + seed row (§7) — expect key + mapping only, verify the in-memory mirror.
6. Whether `GET /plans` still returns the full plan records (version fields included) at build time — the preselect matching in §5.3 depends on it.
7. Whether #2145 has landed plan-change semantics (see §12) — if yes, §3.5's stacking disclosure and §3.6's downgrade disclosure must be revisited before the slice that ships them.
8. The changelog-fragment convention for a three-slice issue (one fragment vs one per PR — §7).
9. The next ADR number, if an ADR is required (D12) — verify at build.
10. Fresh-main re-survey of every file/line fact cited here — main moves fast; a cited line that moved does not invalidate the design, but a cited BEHAVIOR that changed (gate order, purchase stacking, GET /plans filter, cancel-route scope) must be reconciled before the slice that depends on it starts.
11. (Rev 2) The next free migration numbers for 0059/0060 — if another lane lands one first, take the next number; the canonical registry test is the backstop, and the slice's claim records the actual numbers.
12. (Rev 2) The `UsageBillingSection` mount point (which tab/view renders it) — the referral mention's link target (§3.8). If no user-facing surface renders the referral balance, the mention is text-only in slice 2 (no link invented).
13. (Rev 2) The `ReferralCreditPort` binding in the commercial route context — the `GET /referral/balance` route already reads it in the same file, so the offer derivation should reuse the same binding; confirm, don't assume. Confirm no `FreeAccessGrantPort` exists yet (the mention stays null until #3247).
14. (Rev 2) `resolveChargePricing` throw behavior vs the coverage ternary — confirm price resolution still precedes coverage and throws fail-closed on PROPOSED, so the §3.7 honesty constraint (pack spending needs catalogue approval) holds as designed. If the order changed, reconcile §3.7 + NQ7 before slice 3 starts.
15. (Rev 2) The journal charge-mapping call site for the pack purchase (§3.7) — confirm the journal port method + the Dr 1000 / Cr 4000 helper, and the top-up confirm replay-guard precedent for pack-confirm idempotency.
16. (Rev 2) The payment workflow's `consumeCoverage` location + the quota `consumeQuotaRun` precedent file — the slice-3 gate step's consumption shape depends on both.
17. (Rev 2) The D1/in-memory product adapter mapping points for `rank` + the `createProduct`/`getOrCreateProduct` call sites that must accept an optional rank without breaking existing callers.
