# Entitlement model re-verification — #3241 definition groundwork

- **Verified against:** `origin/main` = `b66d9cfd7ecd7ac67784edd5986caac51235f17b`
- **Date:** 2026-11-05 ~04:15–04:30 EST
- **Scope:** read-only survey of the free-vs-paid entitlement model as implemented on main. Every verdict cites file:line on that SHA. No code changed, nothing posted to GitHub.

## Headline: main moved during this survey — #3270 has landed

The brief said the operator subscription grant (PR #3270) was "NOT on main yet". It landed **during this survey**: `b66d9cfd` "feat(3244): operator subscription grant per product" is itself the landing commit (7 files, +576/−2, matching the rebuild's file list), and PR #3270 reads merged/closed with head `9c965a68`. The grant route, `grantSubscription()`, and the Accounts-panel grant section are therefore **on main** and are verified in §(d) below. Only the trial slice (#3271) is still absent — see §(e).

## (a) Gate coverage order — VERIFIED, with exact positions

`src/services/nativeMonetization.ts`, `NativeMonetizationGate.check()` (~:224–310). Order:

1. **Verified identity required; tenant mismatch throws** (:226–227). Existing paid row → `already_paid` (:229–231).
2. **Flag OFF → free, price 0, no price resolution** (:238–241, status `free_flag_off`). A free run never depends on catalogue approval state.
3. **Unlimited-free grant FIRST, before price resolution and before the scheduled coverage-only rule** (:242–256). An active grant returns `{ allowed: true, status: "paid", priceUSD: 0, paidVia: "unlimited_free_grant" }` and records a paid row, so a later `confirmPaid` returns `already_paid`. A grant-covered run therefore **never fails on a missing/unapproved family price** and **covers recurring runs** — a deliberate change to the recurring rule (comment :242–249). Audit: the payment workflow records `payment.covered` with `paidVia: "unlimited_free_grant"` (`src/workflows/paymentWorkflowFlow.ts:708`), and `consumeCoverage` no-ops for it (`src/workflows/paymentWorkflow.ts:499–524`: only `subscription_included` consumes an included run, only `credits` consumes credits; grant / flag-off / already-paid consume nothing).
4. **Price resolution** via `priceFor()` (:201–221): only an APPROVED catalogue price charges; missing/unapproved/invalid throws fail-closed — never a guessed price.
5. **Coverage:** `Subscribed` + `includedRunsRemaining > 0` → `subscription_included` (decremented); else `creditsUSD >= price` → `credits` (deducted, cent-rounded); else null (:258–270).
6. **Scheduled, not one-off-authorized → `coverage_required`, httpStatus 402**, reason "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken." (:279–283). One-off scheduled = `trigger === "scheduled" && scheduleKind === "one_off" && authorizedAtSubmission === true` (:276–278); anything else scheduled (recurring or unstated kind) is coverage-only.
7. **Manual / one-off-authorized, uncovered → checkout minted** (Stripe card or x402; no ports → throw fail-closed), recorded as `payment_required`, returned as 402 with the checkout + `NATIVE_PAYMENT_DISCLOSURE` (:284–310).

Caller side, `src/services/paidScreenSubmission.ts`: `resolvePaidScreenCoverage()` mirrors the order exactly — grant first (active = `expiresAtMs === null || > nowMs`), then Subscribed included runs, then credits (:81–104); `PaidScreenCoverage` includes `"unlimited_free_grant"` (:77). `resolvePaidScreenAction()` routes flag-OFF → `free`, manual → `start_payment` (the workflow gate-checks internally), covered scheduled / one-off-authorized → `start_payment`, uncovered recurring/unstated → `skip` with the same coverage-required reason (:108–166). `resolvePaidScreenAccount()` resolves the account from the verified session only, effective tier at read time, `includedRunsRemaining` from the account row; unbound store / tenant mismatch / subscription-read failure all throw (:184–208).

Grant shape: `UnlimitedFreeGrant { grantedBy, reason, expiresAtMs }`, `expiresAtMs: null` = no expiry (`src/data/commercialPorts.ts:51–56`); active iff it exists and expiry is null or in the future (`isUnlimitedFreeGrantActive`, :58–65). Upsert semantics: `undefined` = preserve, explicit `null` = revoke, object = grant (`resolveUnlimitedFreeGrantUpdate`, :103–111).

The **draining cfpay gate does NOT honor the grant**: its `CommercialAccount` interface carries the field inlined "for shape compatibility" with an explicit comment that the native gate checks it first and the cfpay gate does not (`src/services/cfpayMonetization.ts:98–112`). New runs use the native gate; cfpay is drain-only (`@deprecated`, :146–150).

## (b) Tier model — VERIFIED

- Three stored tiers: `StoreTier = "Free" | "PayPerUse" | "Subscribed"` (`src/data/commercialPorts.ts:26–28`); `TierSource = "operator" | "subscription"` (:37; null = absent).
- Effective tier resolved at read time by `resolveEffectiveTier(account, subscriptions, nowMs)` (`src/data/subscriptionPorts.ts:140–151`): **any** subscription row with `periodEndMs > nowMs` confers `Subscribed`; no account → `Free`; stored `Subscribed` with a non-operator `tierSource` and no live row → `Free`; otherwise the stored tier. Used by the identity endpoint (`src/services/platformIdentity.ts:103`), the account read route (`src/agents/routes/agenticPayments.ts:952`), and ads suppression (`src/agents/routes/adsRevenueReferrals.ts:195`).
- **Nuance:** `resolveEffectiveTier` does **not** check subscription `status` — a canceled-but-unexpired row still confers `Subscribed` (cancel-at-period-end keeps the tier until period end). The deactivation gate `hasUnexpiredSubscription` (`subscriptionPorts.ts:160–165`) **does** require `status === "active"`, so the comment at :156–158 ("same unexpired rule … can never disagree") overstates the agreement. The definition should state the tier rule as written (period-end only), not as the comment claims.
- Included runs are read from the account row only: `includedRunsRemaining: stored ? stored.includedRuns : 0` (`platformIdentity.ts:108`). No other source feeds the gate.
- No contradiction found on main: no fourth tier, no per-tenant tier, no sweeper.

## (c) Price catalogue — VERIFIED, with one correction to the record

- Families: `stock | goal | options | strategy` (`src/data/priceCataloguePorts.ts:29–31`).
- Seed values are **PROPOSED, not approved**: `PROPOSED_SEED_PRICES = { stock: 0.02, goal: 0.10, options: 0.05, strategy: 0.10 }` (:51–62), header "PROPOSED seed prices, NOT owner-approved and NOT an activation". The D1 ensure writes all four rows with `approvalStatus: "proposed"`, `approvedBy/approvedAtMs: null`, `INSERT OR IGNORE` so operator edits survive (`src/data/d1PriceCatalogueAdapter.ts:49–76`); migration 0027 gives every seeded/pre-existing row `'proposed'`.
- Approval: `PriceApprovalStatus = "proposed" | "approved"` (:76); `getApprovedPrice` returns null unless the entry exists, is valid, and is APPROVED — that null is the gates' fail-closed signal (:109–117). Writing a price always lands as PROPOSED with the approval record cleared; `approvePrice` records approver + time (:119–133).
- **Correction to the earlier record:** the "gate triple stands (stock $0.02 / options $0.05 / research $0.10)" is **not** a catalogue-approval fact verifiable from the repo. Approval lives in the live store (operator data); code seeds everything as proposed, and no approval of any family is recorded in code. What the "triple" actually is: a **second, hardcoded price source**, `TRADING_PAID_SERVICES` in `src/services/agenticPayments.ts:112–140` — `OPTIONS_SCREENER $0.05`, `MARKET_RESEARCH $0.10`, `STOCK_SIGNALS $0.02` — used by the NLQ/chat paid path (`src/agents/nlq/execution.ts:380–381, 2177, 2201`). The numbers agree with the catalogue seeds today, but the sources differ and an operator price change diverges them (`src/data/productAccess.ts:355–368`).
- **Live divergence F3** (`src/data/productAccess.ts:369–378`, flagged as a #2547 gap): the stock chat paid path reads the **raw** operator catalogue price with **no approval check**, while HTTP gates fail closed on PROPOSED prices. Noted as latent while the monetization flag is OFF, with a follow-up to align door + NLQ paid price sources to `getApprovedPrice`. The definition's conformance line ("no second pricing source, no PDP-seam bypass") is therefore **currently violated by the chat/NLQ path** — the definition must either bless that path's prices or require the alignment.
- Billing path (re-verified on this SHA): the Stripe Billing purchase route accepts provider status `active | trialing` (`src/services/billingService.ts:63, 375`) but its fulfillment "confers tier only, never included runs" ("Included-run bypass stays OFF", `src/agents/routes/agenticPayments.ts` billing-purchase comment). A trialing — or paid Billing — subscription holds tier Subscribed with zero included runs and still 402s/skips. A trial must grant included runs or it enables nothing.

## (d) Operator levers on main — VERIFIED (all four exist)

- **Issue credits:** `POST /payments/agentic/commercial/account/credits`, operator-only (`src/agents/routes/agenticPayments.ts:1084–1085`); UI "Adjust credits" (`src/client/AccountAdminPanel.tsx:444`).
- **Set tier / included runs:** `POST /payments/agentic/commercial/account` upsert (:992), operator-only; UI "Update tier and coverage (operator)" (`AccountAdminPanel.tsx:412`).
- **Unlimited-free grant write path:** the same account upsert accepts `unlimitedFreeGrant` (:1000, :1023–1051; preserve/revoke/grant per §(a)); grantedBy = session-verified operator login, never client-supplied; UI `UnlimitedFreeGrantSection` (`src/client/UnlimitedFreeGrantSection.tsx:86`, rendered `AccountAdminPanel.tsx:453`).
- **Operator subscription grant (NEW on main via b66d9cfd):** `POST /payments/agentic/commercial/subscription/grant` (`agenticPayments.ts:1897, 1910`); `grantSubscription()` mirrors purchase activation (`src/services/subscriptionActivation.ts:98`, imported :213): subscription row + account included-runs bump (the gate reads included runs from the account row only). Operator-only (403 otherwise); 404 unknown plan; 409 inactive plan; 400 no account row (fail-closed — operator creates the account first); client `tenantId` ignored; tenant from the target account row; audited `commercial.subscription.granted` with before→after effective tier (:1948–1960). **Not** gated on the monetization flag. UI `SubscriptionGrantSection` (`src/client/SubscriptionGrantSection.tsx:38`, rendered `AccountAdminPanel.tsx:354`). Known edge carried from the PR body: a grant to a user whose stored tier was operator-granted Subscribed overwrites `tierSource` to `subscription` (falls back to Free at expiry).
- **Per-user flag exemption:** still NO — the monetization flag is a single platform-wide boolean input to the gate (`NativeMonetizationConfig.monetizationEnabled`, `nativeMonetization.ts:99, 237`); no per-user/per-tenant flag exists anywhere in the gate path.

## (e) What is NOT on main yet — VERIFIED

- **Trial subscriptions: still absent.** `agent_subscription_plans` columns are exactly `id, name, priceUSD, periodDays, includedRuns, active, createdAtMs, updatedAtMs` (`src/data/drizzleSchema.ts:709–718`) — no `trial_days`. Zero `trial` hits in `subscriptionPorts.ts`, `drizzleSchema.ts`, `subscriptionActivation.ts` (excluding Stripe's `trialing` status). No trial checkout route, no "Start trial" UI. The only "trial" on main: Stripe's `trialing` provider-status tolerance (§(c)), the journal trial balance, and the RSI experiment-trial ledger (`src/rsi/trialLedger.ts`) — none of which is a product trial.
- **#3271 (trial rebuild) has not landed.** What the definition must still absorb when it lands: `trial_days` on plans (migration 0041, after 0040), the `$0` trial checkout route, `activateTrialSubscription` semantics (trialing row + included-runs grant for the trial period), trial-end handling, and the client entry point. The known open edge: trial runs join the fungible `includedRuns` counter with no separate clawback at trial end.
- **#3270 is no longer in this list** — it landed as `b66d9cfd` during this survey (§(d)).

## (f) "Triggered" run kinds — VERIFIED (candidates only, no definition)

The money path knows only two triggers: `NativeRunTrigger = "manual" | "scheduled"` (`nativeMonetization.ts:80`). "Triggered" appears nowhere in the money path (zero hits in `nativeMonetization.ts`, `paidScreenSubmission.ts`, `paymentWorkflowFlow.ts`, `paymentWorkflowSubmission.ts`). Candidates in code:

- `WorkflowRunTrigger = "manual" | "scheduled" | "autonomous" | "webhook" | "agent" | "unknown"` (`src/services/workflowRuns.ts:51`; labels at :622–629: Manual / Scheduled / Autonomous / Webhook / Agent / Not recorded). This is the workflow-runs reporting taxonomy, not a money-path input.
- `DiscoveryRunTrigger = "scheduled" | "manual-trigger"` (`src/data/discoveryRunPorts.ts:57`) — discovery runs only.
- NLQ/chat-triggered runs (a chat/NLQ request that starts a screen) and async-job follow-up chains exist as call paths but carry no single trigger enum the money path reads.

The definition must pick which of these "triggered" covers; it cannot be inferred from the code.

## (g) At-limit behavior today — VERIFIED

- **Manual, uncovered:** the paid seam refuses with 402; the client maps **any** 402 on a screen route to one fixed outcome-encoded message — "Screens require payment while monetization is on. Start the run through the payment workflow (Stock Hub → Run a new screen) — no screen has started yet." (`src/client/paidScreenSubmit.ts:86–93`; the sync-refusal code `monetization_enabled_workflow_required` is never rendered raw, :59, :77–84). The message directs the user to the payment workflow; it offers **no checkout inline, no plan choice, no upgrade**.
- **Scheduled, uncovered:** the run is SKIPPED, audited, explained — reason "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken." (`paidScreenSubmission.ts:74, 162–166`).
- **Upgrade offers: none.** Zero `upgrade`/`upsell` hits in `src/client` (only false positives: WebSocket upgrade, a comment about never upgrading "not reported" to success). No side-by-side tier comparison and no choose-a-plan surface exist in the client (zero hits for tier-compare / choose-plan patterns); plans are listed for purchase via `CheckoutPanel.tsx` and the product catalog, and the account tier/credits/included-runs are displayed read-only. This is #3246's scope, still unbuilt.
- **Free-for-lifetime (#3247):** no such option on main — today's Free tier is the implicit tier with no account row (or a Free row), and under monetization ON it 402s/skips exactly as §(a) describes, except where an unlimited-free grant applies.

## Changed vs #3241 issue body / earlier surveys

1. **#3270 landed during this survey** (b66d9cfd). Any statement that the operator subscription grant is "not on main" is now stale. The definition can describe the grant route as shipped, not planned.
2. **"Gate triple stands" is not a catalogue fact.** The triple's numbers live in the hardcoded `TRADING_PAID_SERVICES` constants, a second price source the definition's conformance note forbids. The approved-price set in the live store is not verifiable from the repo; code seeds all four families as PROPOSED.
3. **F3 divergence is live on main** (productAccess.ts:369–378): the stock chat path bypasses the #2547 approval check. Earlier surveys recorded the gate's approval rule without noting this path. The definition must address it.
4. **cfpay gate does not honor the grant** (cfpayMonetization.ts:98–112) — the field exists on its account interface for shape compatibility only. Draining runs therefore do not get grant coverage; new runs use the native gate.
5. **Effective-tier rule is period-end only, status-blind** (subscriptionPorts.ts:140–151) — a canceled-but-unexpired row still confers Subscribed until period end; the "same rule" comment for the deactivation gate overstates agreement.
6. **#3241 decision 1 (Free allowance) is answered for approved accounts** by the grant mechanism now on main, but the **who-approves / which-account-first** question is still open, and no account is granted by code (no seeded grant exists; live-store grants are not verifiable from the repo).
7. **"Triggered" remains undefined** — the money path has no such trigger; the definition must pick from §(f).
8. **Trial remains absent** (§(e)); the only trial-adjacent behavior is Stripe's `trialing` status tolerance, which confers tier only and enables no runs.

## Still to verify after #3271 lands

- Migration 0041 (`trial_days`) sitting after 0040 in `ALL_MIGRATIONS`; the trial checkout route; `activateTrialSubscription` (trialing row + included-runs grant + trial-end behavior); the client "Start free trial" entry; the thin-router pin carrying both grant and trial lines.
- Live-store facts code cannot verify: the actually-approved price set per family; whether any real account holds an unlimited-free grant or an operator-granted subscription; whether any live trial rows exist.
- The #3270 §18 (CI + Deploy on the landing SHA) is the merge-watcher's job, not this survey's — this note verifies only that the landing commit's content is on main.
