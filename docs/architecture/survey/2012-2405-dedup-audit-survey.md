# Dedup audit: #2012 vs #2405 — one of everything?

Audited 2026-11-04 against current main. Headline: **no true duplicates found in code.** Every capability claimed by either program resolves to exactly one implementation. Where both programs touched the same capability, the second built a layer on the first, or addressed an adjacent capability with a similar name. The duplication is at the *program* level (two open programs claiming one goal), not the code level.

## What each program claims

**#2012 (CBO, Oct 27)** — 4 goals, 6 phases. Goal 1: monetize all workflows (pay-per-run, subscription included usage, prepaid credits for scheduled runs), phases 1–6 from shared gate through staging/testnet pilot to gated PROD mainnet enablement. Goal 2: subscription/entitlements/credits (builds on #1623). Goal 3: cancellation/refunds/lifecycle (builds on #1076). Goal 4: ads tier rule + revenue observability. Its body states it "links, and does not duplicate" #1598, #1623, #1076, #1972. One stale line: Goal 1 still reads "Pay-per-run via cfpay" — the native Stripe/x402 migration superseded that, and the body was never updated.

**#2405 (COO)** — Phase 1 single-user (x402 verification, metering enforcement, tier plumbing, receipts, prices stand) and Phase 2 multi-user (subscription product + recurring billing, referral credits, tier-gated ads, lifecycle, deactivation, admin provisioning/offboarding, cancellation/refunds, cfpay decision, tenant hardening, reliability/headroom). Its conformance section claims "this wires the existing scaffolding into a product; it does not build a parallel billing system" — the audit bears that out.

## Capability map (capability → owning issue, implementation on main, lane)

- Payment gate + workflow (admission stage) → #2023, #2190 (2012) → `src/workflows/paymentWorkflow.ts`, `paymentWorkflowFlow.ts`, gate via `check()/confirmPaid()` → CBO
- Same payment path, all workflows + scheduled → #2373, #3058/#3056/#3057 → `paidScreenSubmission.ts`, `paidStockScreenSeam.ts`, `etradeBroker.ts`, `marketDataResearch.ts`, `premium.ts`, `scheduledTasks.ts`, `schedules.ts` guard → CBO
- x402 premium endpoints (3 priced) → #2406/#2407 (2405 P1.1) → `premium.ts` `handleGatedEndpoint` + facilitator → COO/CAIO-adjacent
- Metering enforcement → #2408 (2405 P1.2) → `meter.ts`, usage port over canonical report store, `doSqliteUsageEventAdapter.ts` (usage_events) → COO
- Tier resolution → #2522 (2405 P1.3) + #2127 (2012) → `resolveEffectiveTier` in `commercialPorts.ts`, consumed by `platformIdentity.ts` and `paidScreenSubmission.ts` (`coverageForAccount`) → shared
- Receipts/ledger surfacing → #2543 (2405 P1.4) → `GET /payments/receipts` in `payments.ts`, `mas_transactions` DO ledger → COO
- Price catalogue + approval → #2185/#2189 (2012) + #2638 + #2547 → `priceCataloguePorts.ts` (`getApprovedPrice`), D1 + in-memory adapters; gate triple stands, goal/strategy proposed-only → CBO + CAIO
- Subscription object + plans → #2142/#2127 (2012) → `agent_subscriptions` + `agent_subscription_plans` (migration 0008), effective tier at read time → CBO
- Stripe Billing (recurring) → #2202/#2296 (2012) + #2656/#2694 (2405 P2.1) → `stripeBillingAdapter.ts`, `createBillingPorts.ts`, `billingPorts.ts`, billing checkout/purchase/cancel routes in `agenticPayments.ts`; migration 0014 extends `agent_subscriptions` in place; migration 0030 adds only `agent_billing_customers` mapping → CBO + COO, one record
- Referral credits → #2208/#2229 (2012) + #2657 (2405 P2.2) → `lifecyclePorts.ts` earn/vest/redeem rules (migration 0015) + `agent_referral_attributions` (migration 0031) → CBO + COO, one ledger
- Refunds (request → approval → execution) → #2147 design + #2662 (2405 P2.7) + #2204/#3110 (2012) → `refundService.ts` (requestRefund, approve/deny, `executeRefund` + #2549 XOR guard), one route in `agenticPayments.ts` wiring `refundPaymentIntent.ts` resolver, `refundPorts.ts` + D1/in-memory adapters, UI `RefundFlowSection.tsx`/`RefundPolicySection.tsx` (#2985/#3045) → COO + CBO, one pipeline
- Double-entry journal + recognition → #2158/#2155 (2012) → `journalPorts.ts`, `createJournalPorts.ts`, `journalRecognition.ts` (schedule built, caller unwired) → CBO
- Checkout UI → #2137/#2175/#2293 (2012) → `CheckoutPanel.tsx`, `ProductCatalogPanel.tsx` → CBO (+CFO products UI)
- Assurance → #2049/#2059/#2197 (2012) → `paymentAssuranceLive.ts`, `PaymentWorkflowAssurance.tsx` → CBO
- Platform identity → #2219/#2231 (2012) → `platformIdentity.ts` (`tenantId` from account row, else null/login-scoped) → CBO
- User admin → #2220/#3109 (2012) → `platformUsers.ts`, `UserAdminPanel.tsx` → CBO
- Tenant admin → #2221/#3115 (2012) → `platformTenants.ts`, `TenantAdminPanel.tsx`, `tenantDirectoryPorts.ts` + D1/in-memory adapters → CBO
- Account admin → #2222/#3149 (2012) → `platformAccounts.ts` (self/setup/lookup), `AccountAdminPanel.tsx` → CBO
- Ads tier rule (server-side) → #2022 (2012 G4) + #2658 (2405 P2.3) → single file `adsTier.ts` (Subscribed-only suppression); `mas_ads` system; no second ads gate found → CBO (+COO verification)
- Lifecycle (welcome/digest/preferences) → #2208 (2012) + #2981/#2984 (2405 P2.4) → `provisioningWelcome.ts`, `lifecycleDigestPass.ts`, digest `send` + `run-due` routes, notification-preferences store → CBO + COO
- Deactivation / offboarding → #2981/#2984 (2405 P2.4–2.5) → `POST /api/iaaa/offboard` (self-service deactivation + admin offboarding via `iaaaLifecycleWiring.ts`), membership edit/list in `server.ts` → COO/CISO-adjacent
- Subscription cancel → #2127/#2142 + billing cancel → `POST /payments/agentic/commercial/subscription/cancel` (cancel-at-period-end; Stripe path 503s when unconfigured) → CBO + COO
- Tenant isolation → #2664 (2405 P2.9) + #1344 → session-scoped `resolveIaaaTenant` across routes, tenant-scoped challengers, tenant-scoped rows → COO
- Native ledger + webhook → #2192/#2245 (2012) → `createNativeLedgerPorts.ts`, native ledger charge rows, webhook arm → CBO
- cfpay acceptance → #2663/ADR 0026 + #2945 → `cfpayChannelPorts.ts`, `cfpayChannel.ts` (channel wiring); `cfpayA2A` retained for Slack/email delivery → COO
- Q7 audit mechanism → #2183 (2012) → audit-policy ports, blocking set, hash-chained tamper evidence (mechanism built; activation gated on CISO+CDO sign-off) → CBO

## Adjacency verdicts

- **Subscription object vs Stripe Billing — ONE SYSTEM, layered.** One subscription record: `agent_subscriptions` (0008, CBO). Migration 0014 extends that same table in place; migration 0030 adds only `agent_billing_customers` (user→Stripe-customer-id mapping), not a second subscription record. Residual detail: two purchase rails feed the one object (one-time-payment checkout-to-subscription and recurring Billing checkout).
- **Referral credits vs referral attribution — ONE SYSTEM, layered, explicitly documented.** Migration 0015 built the credit ledger plus earn/vest/redeem rules; migration 0031 states in its own header comment: "The ledger itself is #2208 (migration 0015); this migration adds ONLY the missing link #2208 named as follow-up: which referrer a user came from."
- **Refund PI resolution vs COO refunds + approval UI — ONE PIPELINE, layered.** One `refundService.ts`, one execute route, one refund store port. COO #2662 built request/approval/execution; CBO #2204/#3110 plugged the payment-intent resolver into that same execute path; #2985/#3045 added the UI on top. Genuine gap, not duplication: per-model refund policies are owner-undecided, so self-service per-model refunds are unbuilt; what exists is operator-HITL refunds plus subscription cancel-at-period-end.
- **Tenant/user admin vs CEO #2457/#2462 and CISO #2688 — DISTINCT capabilities, layered.** CEO #2457 is cross-tenant *queues* (tenant queue mapping tests), not tenant administration — a name collision, not an overlap. CISO #2688 is the *role-grant* layer (who may hold platform/tenant admin roles) — it gates the CBO admin slices; it does not manage tenants or users. CEO #2462 is the user-management module owning the per-member permission deny/clear UI (#2450) — the *write* side of member permissions, adjacent to CBO #2220's *read-only* identity/linkage/membership lookup. Caveat: no implementation file for #2462's module itself was found on main (only references saying the UI "belongs to" #2462), so #2462's UI is recorded as not found rather than assumed built.
- **Payment gate vs metering/tier — the gate USES them, it does not re-implement them.** `paidScreenSubmission.ts` imports the shared `resolveEffectiveTier` and decides via `coverageForAccount`. The premium x402 path builds `MeteredGateOptions` over the same usage port, with a code comment stating "no new store" (#2408 Phase 1.2). One meter, one tier resolution, two enforcement points for two different paths — layered by path, not duplicated.

## True duplicates found: NONE

Closest calls, each resolved to non-duplicate above: two purchase rails into one subscription object; two enforcement points sharing one meter/tier; CEO #2457's name resembling tenant admin while being queue mapping; #2462's referenced-but-unfound UI.

## Claimed but NOT found / NOT done (explicit)

- Staging/testnet pilot with real users (#2012 Phase 5): never run. The prototype lives in workspace only; no pilot deployment or pilot report found on main.
- PROD mainnet enablement (#2012 Phase 6 gates): not met — goal/strategy prices proposed-only, no Stripe keys or x402 recipient provisioned by CBO, post-merge reviews outstanding except CAIO's, no live charge verified, no program §15 report.
- Self-service per-model refunds: unbuilt; policies undecided.
- Real-vs-simulated UX price labels (#2405 P1, unchecked): not verified in this audit; #2405 itself leaves the box unchecked.
- HITL confirm on every payment (#2405 P1, unchecked): partial only — approval wait exists on the workflow path and HITL gates on refunds; x402 premium paths use payment verification, not HITL confirm per call.
- #2462 user-management module UI: referenced by #2450, no implementation file found on main.
- Recognition caller (#2155): schedule + posting function merged, but nothing calls it autonomously — unwired, not duplicated.
- #2373 residuals: NLQ-scheduled guard gap and goal one-off creation arming blocked (schema) — known gaps, not duplicates.
- #2000 Phase 5 reliability + #1819 headroom (#2405 P2.10): claimed verified in #2405's body (PR #3004); not independently checked in this audit (CTO lane, out of scope).

## Docs discrepancy (not a code duplicate, needs owner confirmation)

ADR 0026 on main still reads "Status: Proposed — recommendation recorded, owner decision pending," while #2405's acceptance criteria claim an owner decision on 2026-11-02 to "accept as a separate channel" (overriding ADR 0026's DECLINE recommendation), with channel wiring present (`cfpayChannelPorts.ts`). One of those two records is stale. The code is consistent with accept-as-channel; the ADR file was never updated. This needs a one-line owner confirmation and an ADR update, not engineering.

## Consolidation recommendation

**Make #2012 canonical; re-scope #2405 as its delivery/operations plan rather than a competing program.** Reasons: #2012 carries what #2405 does not — the commercial program frame (goals, phases, proposed-vs-approved price discipline), the Phase 6 PROD gates, the journal/GL track, Q7 audit, the platform-management program linkage, and the CEO-owned decision authority. #2405 carries the slice-by-slice operational verification record, which is valuable and should not be destroyed. The reverse (make #2405 canonical, close #2012) would orphan the gates and tracks above, since #2405's scope is operations delivery, not commercial program ownership — and #2405 itself defers the hard decisions (prices, policies, cfpay) to the owner rather than recording them.

Concretely: (1) update #2012's body — fix the stale "Pay-per-run via cfpay" Goal 1 line to native Stripe/x402, and record the Phase 6 gates as open; (2) re-scope #2405's title/body to "#2012 delivery plan — operational slices and verification" and link its slice issues under #2012 (or, if the owner wants exactly one open program, close #2405 as superseded-by-#2012 only *after* that re-linking, so the verification record survives); (3) resolve the ADR 0026 vs #2405 cfpay-decision discrepancy with a one-line owner confirmation and ADR update; (4) leave both programs' slice issues untouched — they are already de-duplicated at the code level, and closing or moving them would create churn without removing any duplicate.
