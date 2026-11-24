# Native-payments migration design (DRAFT — awaiting owner decisions)

**Program:** Commercialize NextGenTP (#2012) · **Umbrella issue:** #2146 · **Related designs:** #2145 (recurring), #2147 (refunds)
**Decision:** Mars, 2026-10-28 — all-native payments (cfagent's own Stripe + x402); cfpay A2A becomes the legacy path.
**Status:** Draft. No code changed, no PRs, no merges, no secrets touched, no fund movement. Read from a fresh worktree at main `5904711a` (which already includes the #2140 merge) plus draft UI branch `cbo/payui/checkout-ui` (PR #2141).
**Amendment 2026-10-28 (port/adapter restructure, standards review):** §1.1 and §1.6 are restructured to port/adapter form (CheckoutPort + adapters + composition root; same split for the native ledger). No other section changes: slices, sequencing, secrets-by-name-only, open decisions (§5), and could-not-verify (§6) are intact, and no price, activation, or approval claim is added.
**Prices:** stock $0.02 / goal $0.10 / options $0.05 / strategy $0.10 remain **proposed, not approved**. This migration changes rails, not prices.

## Headline finding

The migration is smaller than it looks. The payment flow (`paymentWorkflowFlow.ts`) already consumes the gate through a narrow interface (`check()` / `confirmPaid()`), and the paid-submission route never touches cfpay at all — it only starts the workflow. The cfpay couplings are exactly four: the workflow adapter's gate construction, the subscription checkout/purchase routes, the live-assurance checkout mode, and the draft UI's check-payment route. Everything else (coverage logic, effective tier, D1 store, failure-credit issuance, audit) is provider-neutral and stays.

## 1. Every cfpay coupling point and its native replacement

### 1.1 Workflow adapter gate — `src/workflows/paymentWorkflow.ts`

**Today:** `getCfpayConfig(env)` (null when no `DASHBOARD_API_KEY_IS_A2A_TOKEN`/`CFPAY_A2A_TOKEN`) + `CfPayMonetizationGate` built over a `CfPayCheckoutClient` whose `createCheckout` calls `cfpayA2AOperation(cfpay, "/a2a/payments", "checkout.create", {requestId, email, request})` and whose `checkoutStatus` calls `checkout.status`. Network from `MONETIZATION_NETWORK` env, default `base-sepolia`, validated against `ALLOWED_NETWORKS` (`base-sepolia`, `ethereum-sepolia`, `base`, `eip155:8453`).

**Native replacement:** a new gate class (proposed name `NativeMonetizationGate`, proposed module `src/services/nativeMonetization.ts` — names are proposals, not decisions) implementing the **same structural interface** the flow already consumes: `check({id, family, trigger, scheduleKind, authorizedAtSubmission, tenantId, account})` and `confirmPaid({id, userId, email}, {claimTxHash?, paymentIntentId?})`, returning the same `GateDecision` union. The flow file imports the gate type-only, so if the interface is preserved, `paymentWorkflowFlow.ts` needs **no logic change**.

**Port/adapter restructure (normative — standards review).** The native gate does NOT keep both rails inside the gate class. The checkout surface is a `CheckoutPort` interface (proposed module `src/services/checkoutPorts.ts` — name is a proposal, not a decision) exposing the checkout operations the gate consumes (`createCheckout` / status-or-retrieve), implemented by two adapters and wired by a composition root:

- **Card adapter — `StripeCheckoutAdapter`:** wraps `PaymentGatewayService.createCheckout({draftId: requestId, amount: priceUSD, currency: "USD", customer: userId, gateway: "stripe", userLogin})` (`src/services/payments.ts:118`). This creates a real Stripe Checkout Session (`POST /v1/checkout/sessions`, `mode: "payment"`, variable `unit_amount` from `params.amount`, `client_reference_id: draftId`) and returns `{checkoutUrl, gatewayRef (session id `cs_*`), status: "pending_checkout", didAttestation}`. This **fixes the cfpay fixed-amount limitation**: native card charges the family's actual price, not one deployment-wide amount.
- **Crypto adapter — `X402CheckoutAdapter`:** wraps the `ETradeAgenticPaymentService` (`src/services/agenticPayments.ts`) 402 challenge (`PAYMENT-REQUIRED` header, USDC, recipient from `X402_RECIPIENT_ADDRESS`, network from `X402_NETWORK` default `base-sepolia`, facilitator `X402_FACILITATOR_URL` default `https://x402.org/facilitator`) + verification via the facilitator (`POST {facilitator}/verify`, fail-closed, simulated proofs rejected — the `PaymentsAgent.verifyWithFacilitator` pattern, `src/agents/payments-agent.ts:176`).
- **Composition root — `createCheckoutPorts(env)`** (proposed module `src/services/createCheckoutPorts.ts` — name is a proposal): the ONLY place that reads checkout env (Stripe keys, `X402_RECIPIENT_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL`) and constructs the adapters. It returns **null when unconfigured**, and the gate's fail-closed `if (!nativeConfigured ...) throw` follows from that null. The gate keeps only domain rules — prices, coverage, scheduling, the idempotency maps, confirm semantics — and the flow keeps importing the gate type-only. No env read and no gateway SDK import lives in the gate or the flow.

**Normative citations.** ADR 0002 R1 (`docs/architecture/adr/data/0002-data-foundation-layer.md` — port-first, non-negotiable: domain code depends only on interfaces in port modules; the composition root wires env → adapter → ports), ADR 0002 R2 (dialect/isolation in exactly one place; a conformance suite run against every adapter), `docs/architecture/standards/standards.md` §7.1 (Hexagonal / Ports and Adapters: core logic decoupled from infrastructure via ports and adapters), and ADR 0004 (`docs/architecture/adr/0004-screener-workflows.md` — composition root returns null when unbound; conformance suite run unchanged against both adapters; structural test pins no provider SDK in port/flow code). Applied here, the structural pin is: the port module imports no Stripe/x402 client, and domain code (gate, flow) imports no gateway SDK.

**Slice requirements (added by this restructure, binding on slice 1):** (a) a port conformance suite run against both adapters **plus** an in-memory adapter (the in-memory adapter is a portability proof and test double, never a silent production fallback); (b) a structural pin test asserting the port module imports no Stripe/x402 client and domain modules import no gateway SDK. Both must pass before the slice is judged complete.

**Confirm semantics preserved, exactly:**
- **Fulfilled-only:** card confirms only when a Stripe session retrieve reports the session complete AND `payment_status` paid AND `amount_total == priceUSD × 100` AND `client_reference_id == runRequestId`. x402 confirms only when facilitator verification passes AND the on-chain claim amount matches AND the claim payer matches the verified user. A Stripe success-page redirect (the native `success_url`, `?payment=success&draft=`) is **never** proof — same rule as the cfpay return page, which today throws.
- **Idempotent on run-request id:** three layers, all preserved — the gate's in-memory `byRun`/`byClaim` maps (already-paid short-circuit, claimTxHash/paymentIntentId replay rejection across runs), the ledger endpoint's 409 dedupe, and the subscription replay guard.
- **Fail closed:** missing Stripe keys, unbound facilitator, unknown network, missing verified userId/email/tenantId, or tenant mismatch all throw/refuse — never a free run. The existing `if (!cfpay && trigger !== "scheduled") throw` becomes `if (!nativeConfigured && trigger !== "scheduled") throw` with the same coverage-only exception for scheduled runs.
- **Unchanged around the gate:** approval wait before capture (`waitForEvent` type `"approval"`, #1262 engine), 24h `PAYMENT_VERIFICATION_TIMEOUT`, one-off-authorized-at-submission skip, `paidVia` values (new values `stripe_checkout` / `x402` replace `cfpay_checkout`; coverage values `subscription_included` / `credits` / `free_flag_off` / `already_paid` unchanged), and `startScreenerOrCredit` failure-credit behavior.

### 1.2 Price catalogue and account types — `src/services/cfpayMonetization.ts`

`FAMILY_PRICES`, `CommercialAccount`, `ScreenerFamily`, `ScheduleKind`, and the coverage/scheduled-behind-the-scenes rules are **provider-neutral**. Recommendation: the native gate imports them from the existing module (no copy, no drift) in the migration slices; moving them to a neutrally-named module happens only in the final deprecation slice, with a deprecated re-export left behind. Do not duplicate the price table.

### 1.3 Subscription checkout/purchase — `src/agents/routes/agenticPayments.ts`

**Today:** checkout mints a route-owned cfpay checkout (`requestId: "sub-" + uuid`, `request: "subscription ${plan.id} ${plan.priceUSD}"`) via `checkout.create`; purchase re-reads `checkout.status` (fulfilled/paid/`paid===true`) and calls `activateSubscription`, whose replay guard is `findByPaymentRef` (UNIQUE payment-reference index → 409 on replay). Amount is **not** independently re-checked (cfpay status carries no amount) — a stated limitation of #2142.

**Native replacement:**
- Checkout: `PaymentGatewayService.createCheckout({draftId: "sub-" + uuid, amount: plan.priceUSD, currency: "USD", customer: login, gateway: "stripe", userLogin: login})`. Response keeps `checkoutRequestId` (= draftId/session id) and now **also returns `checkoutUrl`** (Stripe always provides one — this closes #2141's "no URL" gap for card).
- Purchase: verify by Stripe session retrieve — session complete AND `amount_total == plan.priceUSD × 100` AND `client_reference_id == checkoutRequestId`. **Amount re-check becomes mandatory on the native path** (it is now possible; keeping the cfpay-era non-check would be a regression in verification strength).
- `activateSubscription`, the plan record (`priceUSD`, `periodDays`, `includedRuns`), the `sub-` prefix rule, the replay guard, and cancel-at-period-end are **unchanged**. The subscription object needs no schema change for one-time native purchase.
- **New field discipline (open decision):** store both the Stripe session id and the payment-intent id on the subscription row (or a linked payment record). Refunds (#2147) need the payment-intent id — a session id alone cannot be refunded via `POST /v1/refunds`.

### 1.4 Live assurance — `src/agents/routes/paymentAssuranceLive.ts`

**Today:** checkout mode refuses unless `MONETIZATION_ENABLED === "true"` AND `getCfpayConfig(env)` non-null (409s naming the missing piece); `status` and `check-payment` re-read cfpay `checkout.status` for `live-test-`-prefixed ids. Coverage mode (fake Subscribed account, 1 included run) touches no payment rail.

**Native replacement:** checkout mode gates on the monetization flag AND native Stripe configured (`StripePaymentStrategy.isConfigured(env)` — a Stripe key present). Status/check-payment re-read native state: Stripe session retrieve for the `live-test-` run id (draftId == runRequestId), plus the x402 claim read where applicable. Coverage mode unchanged. The `live-test-` id prefix rule, the allowlist (`PAYMENT_ASSURANCE_LIVE_LOGINS`), and the generic-error CodeQL posture stay.

Flag-source note: assurance start currently reads the raw `MONETIZATION_ENABLED` env var, while the gate reads the Flagship port. The rework slice must reconcile these to one source (recommend the Flagship port, matching the gate) — otherwise assurance can disagree with production behavior.

### 1.5 Draft UI routes — PR #2141 branch

**Today (unmerged):** `GET /commercial/pricing` (server-truth `FAMILY_PRICES` + flag state + hardcoded `testnetOnly: true` + failure-policy copy), `POST /commercial/submission/check-payment` (cfpay `checkout.status` re-read, `payment_verified` only when fulfilled, payment URL surfaced only when cfpay provides one, then `deliverPaymentVerifiedViaHost`), `POST /commercial/goal-command` (server-built goal command, starts nothing). `CheckoutPanel.tsx` consumes these; its copy says "used only as the cfpay checkout contact."

**Native replacement:** `goal-command` is **unchanged** (no payment use). `pricing` must derive its network marker instead of hardcoding `testnetOnly: true` (Stripe test-vs-live mode from `resolveApiKey` + `X402_NETWORK` testnet detection) and must update its failure-policy copy when #2147 lands (no refund promises before the refund slice exists). `check-payment` becomes: Stripe session retrieve (paid only when complete + amount matches + reference matches) → deliver `payment_verified` via the same host seam; `paymentUrl` is now the native `checkoutUrl` from the checkout response (card) or absent for x402 (no URL exists — the panel must present the 402 challenge flow instead). The panel's "cfpay checkout contact" copy becomes "checkout contact" (email is still collected as the Stripe customer contact, not an identity proof — identity remains the verified login).

### 1.6 Ledger — `src/services/cfpayLedger.ts`, `src/payments/ledger.ts`, routes `record-cfpay`/`cfpay`/`cfpay-revenue`

**Today:** cfpay rows in `mas_transactions` via the SEARCH_AGENT canonical-hop client: session `screener-payment:<runRequestId>`, action `charge`/`credit`, gateway **hardcoded `"stripe"`** (even for cfpay x402 payments — an existing misattribution), `gatewayRef` = checkout id or run id, proposerDid ORCHESTRATOR. Writes go through `POST /payments/agentic/ledger/record-cfpay`, deduped server-side (one charge + one credit row per run; replay returns 409 with the existing row — atomic because the orchestrator DO is single-threaded). Read-back via `GET /ledger/cfpay`; reconciliation (`reconcileCfpayRun`) compares cfpay-reported paid vs charge-row presence; revenue (`aggregateCfpayRevenue`) filters rows by the `screener-payment:` prefix with audit-joined family attribution.

**Native replacement — a twin, not a rewrite, behind the same port/adapter split as §1.1:**
- New port (proposed `NativeLedgerPort`, module `src/services/nativeLedgerPorts.ts` — names are proposals) exposing the ledger operations the workflow adapter and reconciler consume (record charge/credit, read-back, reconcile inputs), implemented by a D1 adapter (proposed `src/services/nativeLedger.ts`, mirroring `cfpayLedger.ts`) plus an in-memory adapter, and wired by a composition root that returns null when unbound. Domain code (workflow adapter, reconciler) depends only on the port — never on the D1 store or a gateway SDK — per ADR 0002 R1/R2, standards.md §7.1, and ADR 0004 (same citations as §1.1). The port conformance suite (D1 adapter + in-memory adapter) and the structural pin test (port module imports no store/gateway client; domain imports no gateway SDK) are slice-0 requirements, mirroring §1.1.
- The D1 adapter's builders mirror `cfpayLedger.ts`: `buildNativeChargeTransaction` / `buildNativeCreditTransaction` with session prefix `screener-payment-native:` (new prefix keeps provenance clean and keeps the cfpay revenue report's history intact), action `charge`/`credit`, and **truthful gateway per rail** (`"stripe"` for card, `"x402"` for crypto). `gatewayRef` = Stripe session id / payment-intent id (card) or claim tx hash (x402). ProposerDid stays ORCHESTRATOR (no workflow DID exists).
- New endpoint `POST /payments/agentic/ledger/record-native` with the **identical 409 dedupe contract** (session + action lookup, existing row returned on replay). The workflow adapter's `recordEvent` calls the native writer on `payment.confirmed` and the native reader + reconciler for read-back; reconcile compares the *native* confirm source (session complete / facilitator verified) vs charge-row presence.
- Revenue: `aggregateCfpayRevenue` is untouched for history; a native counterpart aggregates the `screener-payment-native:` rows (same assumed-cost 1/5 presentation until measured cost exists — the assumption is owner-directed, not a migration artifact).
- **Hard constraint:** native rows must use action `"charge"`, never `"micropayment"`. `deriveBudgetGuardState` counts PaymentsAgent rows + `micropayment` x402/mpp rows; a native screener row labeled `micropayment` would pollute BudgetGuard state. `src/payments/ledger.ts` (`recordLedgerPayment`, PaymentsAgent-origin x402 rows only, session `payments-agent:<agentId>`) is **not reused and not modified** — same reasoning as the original #2019 comment.

### 1.7 What does NOT change

- `PaymentWorkflow` class shape (ThinkWorkflow, `any` agent type), the `PAYMENT_WORKFLOW` wrangler binding, the caller seam (`paymentWorkflowSubmission.ts`), the submit route (it never calls cfpay — the gate swap flows through automatically), the D1 commercial/subscription stores and ports, `resolveEffectiveTier`, coverage consumption, failure-credit issuance (DO row + D1 claim), audit events (`mas_events`, payload `runRequestId` + `tenantId`), the ads tier resolvers, and `PaymentsAgent`/`BudgetGuard`.
- `src/services/cfpayA2A.ts` is **not retired wholesale**: Slack/Email delivery (`cfpayPostToSlack`, `cfpaySendEmail`, `cfpaySendEmailWithAttachments`) is used by `researchPublish.ts`, `screeningDelivery.ts`, `screenerSlackDelivery.ts`, `screenerFollowupDelivery.ts`, `scheduledTasks.ts`, `browserAgent.ts`, and trading Slack code. Only the `/a2a/payments` call sites retire.

## 2. Sequencing

Order matters because the flag is currently OFF and no live charge exists: every slice below lands **behind the existing `monetization` flag, default OFF**, and no slice activates anything. User-visible behavior at each step is stated explicitly.

**Slice 0 — Native ledger + webhook extension point (additive only, no behavior change).** Land the native ledger port + D1/in-memory adapters + composition root (§1.6), the `record-native` endpoint (409 dedupe), and the native revenue aggregation alongside the cfpay ones. Extend the existing unified webhook listener `POST /payments/webhook` (`src/agents/routes/payments.ts:821`, already HMAC-verified via `PaymentGatewayService.verifyWebhookSignature`, draft-matched on `client_reference_id`) to recognize native screener drafts: on a verified `checkout.session.completed` whose `client_reference_id` is a run/subscription draft id, audit `payment.settled_webhook` and (once the native workflow exists) deliver the `payment_verified` wake-up. Until slice 1 lands, the webhook arm records and audits only — it must not deliver events to cfpay-gated workflows. *User-visible: nothing.*

**Slice 1 — Native gate + workflow adapter swap (the core).** Land `CheckoutPort` + `StripeCheckoutAdapter` + `X402CheckoutAdapter` + `createCheckoutPorts(env)` + `NativeMonetizationGate` (domain rules only — the gate holds no rail, no env read, no gateway SDK import), swap the adapter's gate construction (cfpay client → composition-root ports), extend `extractCheckoutId` to read native fields (session id, payment intent, claim hash — the ledger's `gatewayRef` must be the session/payment-intent id, never the checkout URL). Flow tests gain native-gate fakes; existing flow tests pass unchanged (interface preserved). The port conformance suite (both adapters + in-memory adapter) and the structural pin test from §1.1 are part of this slice, not follow-ups. The cfpay gate class stays in the tree, deprecated in place, unused by the adapter. *User-visible: nothing while the flag is OFF. With the flag ON in a staging env, new runs pay natively; in-flight cfpay runs drain unchanged.*

**Slice 2 — Subscription routes go native.** Checkout/purchase move to §1.3. Cancel, plans, account, and tenant-settings routes unchanged. *User-visible: subscription buy flow presents a native Stripe checkout URL (card) instead of a cfpay checkout; purchase verification now also checks the amount.*

**Slice 3 — UI rework (#2141 decision).** Rework `pricing` (derived network marker), `check-payment` (native retrieve + URL), and panel copy. *User-visible: the Checkout tab's payment step shows a real Stripe URL for card and a 402/wallet step for x402, instead of "complete payment and check again."*

**Slice 4 — Assurance live rework (§1.4).** Checkout mode gates on native configuration; status/check-payment read native state. *User-visible: the assurance page's live mode tests the native path; coverage mode unchanged.*

**Slices 5–6 — Separate program work, not migration:** Stripe Billing (#2145: new `createSubscription`/`cancelSubscription` methods on `PaymentGatewayService` + strategy, D1 subscription mapping, subscription webhook events, dunning) and refunds (#2147: refund route + approval + `executeRefund` for card; crypto payout decision). These depend on slices 1–2 but are not required for pay-per-run parity.

**What keeps working during migration:**
- Flag OFF = free path, unchanged at every step.
- Coverage path (subscription included runs, credits, effective tier) is provider-independent and never breaks.
- **In-flight cfpay runs drain cleanly:** the gate is constructed inside `PaymentWorkflow.run()` at instance start, so a workflow instance already running keeps its cfpay gate to completion. New submissions after the adapter swap use the native gate. cfpay checkouts have a 24h TTL and the workflow's verification timeout is 24h, so the drain window is bounded at ~24h after the swap lands. No run changes rails mid-flight.
- Existing cfpay ledger rows, D1 claims, and subscriptions remain readable and redeemable throughout.

**Cutover (a decision):** the recommended shape is a single flag-flip in staging, a 24h drain observation, then the same in PROD — not a per-family or per-rail phased rollout, which would double the state space. The flag flip itself is an operator/dashboard action, not a code change.

## 3. What retires when

**Retire in place, never delete (Policy Gate rule (j) + repo AGENTS.md §22):** any new deprecation marker in `src/` must name its successor (e.g. `@deprecated superseded by src/services/nativeMonetization.ts`), and no file is deleted.

- **At slice 1:** the cfpay client construction inside `paymentWorkflow.ts` is replaced; the old construction is removed from the adapter (not the module). `CfPayMonetizationGate` and `CfPayCheckoutClient` in `cfpayMonetization.ts` are marked deprecated in place with the native successor named. `ALLOWED_NETWORKS` and the `MONETIZATION_NETWORK` read retire with the gate (the native crypto network is governed by `X402_NETWORK` instead — the two vars must not be confused).
- **At slice 2:** the `/a2a/payments` calls in the subscription checkout/purchase routes are replaced; the route comments noting "route-owned cfpay checkout" are updated to the native equivalent.
- **At slice 4:** the `/a2a/payments` calls in `paymentAssuranceLive.ts` are replaced.
- **At the drain slice (≥24h after the native flag flip, after confirming zero in-flight cfpay checkouts and zero unredeemed cfpay-linked claims in flight):** the remaining `/a2a/payments` references are marked deprecated in place with successors. Nothing is deleted: `cfpayLedger.ts`, the `record-cfpay` / `cfpay` / `cfpay-revenue` endpoints, and `reconcileCfpayRun` stay as **read-only history** (new writes stop; reads and revenue reports keep working for the cfpay era).
- **Never retired by this migration:** `cfpayA2A.ts` itself, `getCfpayConfig`, `cfpayPostToSlack`, `cfpaySendEmail(_WithAttachments)` — delivery paths depend on them. Consequently `CFPAY_URL` and the A2A token env vars **stay** until delivery migrates off cfpay (out of scope for #2146). Removing them would break Slack/Email delivery, not just payments.
- **Existing cfpay ledger rows:** retained as history, never rewritten, never re-attributed. The `screener-payment:` prefix remains the cfpay-era marker; the native prefix (`screener-payment-native:`) distinguishes eras in every report. Failure credits issued under cfpay remain redeemable under the same D1 claim rules (claims carry family natively and are provider-agnostic).

## 4. Secrets needed, by NAME only (no values, none requested)

New secrets for the native path (worker secrets via the Deploy workflow's secret sync; never in the repo, never in code, never in a PR body):

- `STRIPE_SECRET_KEY` (generic), and/or the mode-split pair `STRIPE_TEST_SECRET_KEY` + `STRIPE_LIVE_SECRET_KEY` — the strategy resolves test vs live by environment config and key prefix (`sk_test_` vs `sk_live_`). Test keys first in staging; live keys only with price approval + flag enablement.
- `STRIPE_WEBHOOK_SECRET` — required for `POST /payments/webhook` Stripe signature verification (`PaymentGatewayService.verifyWebhookSignature`). Without it, Stripe webhooks verify as invalid and the wake-up path is dead (confirm-by-retrieve still works).
- `X402_RECIPIENT_ADDRESS` — the USDC recipient for native x402 challenges. **Security note:** the current service falls back to a hardcoded address when this is unset (`src/services/agenticPayments.ts:159-160`). The migration slices must require explicit configuration for the screener path and must not rely on the fallback in PROD.

Vars (not secrets, but must be set deliberately):

- `X402_NETWORK` (default `base-sepolia` in code) and `X402_FACILITATOR_URL` (default `https://x402.org/facilitator`). Mainnet x402 requires explicit `X402_NETWORK=base`.
- `APP_BASE_URL` (already set) — used for Stripe success/cancel URLs. These URLs are redirects only, never proof.

Already required, unchanged: `SERVICE_USER_LOGIN` (ledger forwarding identity), `COMMERCIAL_STORE_OPERATORS` (operator writes), the `FLAGS` binding + Flagship `monetization` flag.

Not needed for the receiving path: `X402_AGENT_WALLET_KEY` (the agent's own paying wallet, not the screener's receiving address) and `STRIPE_MCP_SERVER_URL` (the MCP-remote Stripe path — the migration uses the direct REST path; do not configure the MCP path for screener payments).

Retiring for payments (but staying for delivery): `DASHBOARD_API_KEY_IS_A2A_TOKEN` / `CFPAY_A2A_TOKEN` stop being read by any payment path; they remain configured while Slack/Email delivery uses cfpay.

## 5. Open decisions (questions, not defaults)

**5.1 Billing periods + dunning (#2145).** Which periods do plans offer (monthly, annual, both)? On renewal failure, how many retries over how long, what grace period applies, and exactly when does access (including ad-free status) downgrade — and with what notice? How is proration handled on plan change? Do existing repurchase-based subscriptions migrate, grandfather, or expire into Billing? (Stripe Billing has no in-repo code today.)

**5.2 Refunds (#2147).** What is the refund window per payment model, and is it full-only or partial? Who approves a refund — operator HITL only, or automatic within the window? What happens to entitlements on refund (subscription downgraded immediately? spent credits clawed back? included runs revoked?)? For crypto: is a "refund" an operator-wallet compensating payout (new fund-holding + signing surface, the highest-risk piece in this program) or is x402 explicitly non-refundable with replacement credit only? No fund-movement code lands before these are answered.

**5.3 Draft PR #2141 — merge before or after the slice-3 UI rework?** Option A: merge #2141 as-is (after its required rebase onto current main — it is behind, base `c73fa015`), then rework its routes in slice 3. Option B: rework the UI routes to native on the #2141 branch before merging, landing once. Either way the rebase is required first, and the pricing route's hardcoded `testnetOnly: true` must not survive the rework. (Note: #2141 is draft, unmerged, no monitor armed; merging it is an owner decision either way.)

**5.4 Disposition of the #2140 cfpay-mainnet monitor — RESOLVED, not open.** PR #2140 **merged** 2026-10-28T15:49:04Z (main head `5904711a`), and its monitor self-removed per its rules. Its change (Base mainnet in the cfpay allowlist) is now on main but becomes **legacy** under this migration: the `ALLOWED_NETWORKS` guard retires with the cfpay gate in slice 1. No action needed on the monitor.

**5.5 x402 in the browser.** The native x402 flow is a 402 challenge/response for API/agent payers (signed proof, facilitator verification). The browser `CheckoutPanel` has no wallet-sign flow today. Is card the only browser rail at launch, with x402 offered to API/agent callers via the submit route's 402 response — or is a wallet-connect/sign component in scope for slice 3? (Recommendation, not a decision: card-only in the browser first; wallet-sign as a follow-up slice. The `viem` dependency already exists, so the follow-up is feasible but is new UX scope.)

**5.6 Native confirm + payment-reference semantics.** Confirm-by-retrieve (Stripe session retrieve as the source of truth, webhook as wake-up-only accelerator) vs a webhook-written payment-state table as the confirm source? And for subscriptions, is `providerPaymentRef` the Stripe session id, the payment-intent id, or both stored? (Recommendation: retrieve as truth + webhook as wake-up, mirroring the cfpay design; store both ids, since refunds require the payment-intent id.)

**5.7 Cutover shape.** Single flag flip + 24h drain observation (recommended above), or phased by family/rail? If phased, which family or rail goes first, and how are in-flight checkouts of the other rail handled?

**5.8 x402 recipient configuration.** Is explicit `X402_RECIPIENT_ADDRESS` configuration required before any native x402 charge in PROD, with the hardcoded fallback forbidden there? (Recommendation: yes — the fallback must not receive production funds.)

**5.9 Price approval — still open, unchanged by this migration.** Per-run prices and all plan prices remain **proposed**. Native migration changes rails, not prices; no live charge happens until the owner approves prices (or supplies different numbers) plus the flag + keys from §4.

## 6. Could not verify from code

1. **No Stripe session-retrieve method was found** in the parts of `src/patterns/paymentStrategies.ts` read (`createCheckout`, `createPaymentIntent`, `capturePayment`, `executeRefund`, `verifyWebhookSignature`, `resolveApiKey`, `getStatus`). The native confirm slice must confirm whether a retrieve exists elsewhere in the file or must be added (direct `GET /v1/checkout/sessions/{id}` call in the strategy, keeping the strategy as the only Stripe API surface).
2. **The full `x402Verifier.ts` proof shape was not read** — the exact proof format a payer supplies (challenge nonce, signature encoding, USDC amount encoding) must be confirmed at slice 1 from `src/services/x402Verifier.ts` and the existing 402 challenge flow, not assumed from the PaymentsAgent path.
3. **Whether to add a `record-native` endpoint vs generalize `record-cfpay`** is a design choice, not a verified constraint. This report recommends a twin endpoint (clean provenance); generalizing the existing endpoint would mix cfpay-era and native rows under one route and is not recommended, but it is not ruled out by code.
4. **Stripe Billing API specifics** (subscription objects, webhook event types, dunning behavior) have no in-repo code and were not verified against Stripe docs here; slice 5 must verify them at design time.
5. **Main has moved since the read** (worktree snapshot `5904711a`); files, pins, and the #2141 branch's rebase conflicts must be re-measured at slice time. In particular, the #2141 rebase was not attempted, so its conflict set is unknown.
6. **The native Stripe success/cancel URL behavior in the worker** (whether the worker serves the `?payment=success&draft=` landing path or the client handles it) was not traced; slice 3 must confirm the redirect lands somewhere that prompts a status re-check rather than implying payment.
7. **Whether `PAYMENT_DISCLOSURE` (added on the #2141 branch as a shared const) should be backported to main before slice 3** was not decided here; on main today the disclosure lives only in the gate's checkout response string and the assurance page copy.
