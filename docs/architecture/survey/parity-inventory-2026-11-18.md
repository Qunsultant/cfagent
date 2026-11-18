# BizCopilot chat/UX full-parity inventory — CBO domain

- **Date:** 2026-11-18. **Basis:** code on `origin/main` at `cd094b6f28877dcb3f6e6b74e2b53ff0484fffc4` (fetched 2026-11-18; HEAD was stale, all reads scoped to `origin/main`). Issue bodies read live via connector `issue_read` the same day.
- **Directed by:** Mars, 2026-11-18 — bring full parity between chat and UX; enumerate the discrete flows chat/LLM can compose; simplest first; sub-issues prioritized as quick wins. Extended brief the same day: APIs/MCPs fully AOP- and ADD.md-compliant, holistic, never duplicate — reuse/enhance/optimize/extend first.
- **Scope:** CBO domain only — Platform Admin views (tenants, accounts, channels, free-runs, products), checkout, billing, payment-assurance, and the underlying commercial routes. NOT trading/order ticket (CPO), NOT research jobs / J-stack, NOT saga (CAIO #2041), NOT users/IAAA (CISO), NOT bundles (COO #2781) except where noted as cross-lane.
- **Analysis only.** No issue filed, no PR opened, no GitHub write. The parent files after review.
- **Evidence files:** [ux-actions.md](ux-actions.md) (134 UX action rows), [routes.md](routes.md) (150 routes + provenance + shared-layer check), [compliance.md](compliance.md) (AOP/ADD assessment, 12 groups). Issue bodies saved under `issues/` (4514–4522, 4741–4743).
- **Key:** `B` = `/api/payments/agentic/commercial`. "Chat today" = deterministic intent / MCP tool / none, as verified in code. "Cx" = complexity: S = simple (single route call), C = composed (multi-step). "Gap?" = YES means no chat path exists. Decision flags mean Mars's call is needed before build.

## A. Flow inventory

### Tenants — `?tab=platform-admin&view=tenants`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F01 List tenants | Tenant list table | GET `/api/platform-tenants` (`platformTenants.ts:231/:261`) | `list` intent (`bizCopilotTenants.ts:83`) | #4515 built; #4741 MCP | No (MCP pending) | S | Directory read; feeds every tenant workflow |
| F02 Create tenant | Create tenant (`TenantAdminPanel.tsx:179`) | POST `/api/platform-tenants` (`:231/:273`) | `create` | #4515; #4741 | No (MCP pending) | S | Onboarding start; idempotent re-create |
| F03 Tenant detail + members | Manage, per row (`:200`) | GET `/api/platform-tenants/:id` (`:236/:316`) + GET `/api/iaaa/memberships` | `detail` | #4515; #4741 | No (MCP pending) | S | Verify-before-act read |
| F04 Read tenant settings | Detail view | Same GET | `settings-read` | #4515; #4741 | No (MCP pending) | S | Settings read |
| F05 Update tenant settings | Checkboxes / blur saves (`:220–266`) | PATCH `.../:id/settings` (`:236/:339`) | `settings-update` | #4515; #4741 | No (MCP pending) | S | Ads / auto-refresh / providers. Partial-apply gap (G-2) |
| F06 Membership write | Read-only on page | — (IAAA writes, CISO lane) | `membership-write-refused` (deterministic refusal) | #4515 (out of scope) | No — refused by design | — | Correct refusal; never build |
| F07 Tenant ads-flag (commercial route) | No UX caller | GET/POST `B/tenant-settings` (`agenticPayments.ts:1647/:1665`) | none | — | Reconcile, not parity | S | Overlaps F05; no caller. Deprecate-or-keep decision; do not surface |

### Accounts — `?tab=platform-admin&view=accounts`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F08 Set up account (self) | Set up account (`AccountAdminPanel.tsx:339`) | POST `/api/platform/accounts/setup` (`platformAccounts.ts:300/:578`) | none | — | YES | S | First-run account creation; idempotent; session-derived identity |
| F09 Look up account | Look up (`:415`) | GET `/api/platform/accounts/lookup` (`:301/:321`) | `lookup` (`bizCopilotAccounts.ts:89`) | #4516; #4742 | No (MCP pending) | S | The key read for all account workflows |
| F10 Save account (upsert) | Save account (`:446`) | POST `B/account` (`agenticPayments.ts:1289`) | none | — (grant flows reuse the route) | YES | S | Set tier / credits / included runs directly; operator-only |
| F11 Adjust credits | Adjust credits (`:456`) | POST `B/account/credits` (`:1382`) | none | — | YES | S | Manual credit correction |
| F12 Grant subscription | Grant subscription (`SubscriptionGrantSection.tsx:137`) | POST `B/subscription/grant` (`:4637`) | `grant-subscription` | #4516; #4742 | No (MCP pending) | S | Operator grant; selective |
| F13 Grant unlimited free | Grant (`UnlimitedFreeGrantSection.tsx:228`) | POST `B/account` (`:1289`, `unlimitedFreeGrant`) | `grant-unlimited-free` | #4516; #4742 | No (MCP pending) | S | Selective; bounded by quota (F32) |
| F14 Revoke unlimited free | Revoke (`:234`) | POST `B/account` (grant null) | `revoke-unlimited-free` | #4516; #4742 | No (MCP pending) | S | — |
| F15 Grant free access | Grant (`FreeAccessGrantSection.tsx:298`) | POST `B/free-access/grant` (`:8549`) | `grant-free-access` | #4516; #4742 | No (MCP pending) | S | Lifetime / limited; operator-only in v1 |
| F16 Revoke free access | Revoke (`:304`) | POST `B/free-access/revoke` (`:8616`) | `revoke-free-access` | #4516; #4742 | No (MCP pending) | S | — |
| F17 Grant history | Grant state display | GET `B/free-access` (`:8667`) | `grant-history` | #4516; #4742 | No (MCP pending) | S | Audit read |
| F18 Move to current pricing | Move to vN (`AccountVersionMoveSection.tsx:203`) | POST `B/subscriptions/:id/move` (`:6220`) | `move-current-pricing` | #4516; #4742 | No (MCP pending) | S | Per-customer move; holders stay grandfathered until moved |
| F19 Change segment | Change segment (`:244`) | POST `B/accounts/:userId/segment` (`:6297`) | none | — | YES | S | Segment drives what the NEXT charge resolves to |
| F20 View own account | Self view (mount read) | GET `/api/platform/accounts/self` (`platformAccounts.ts:299/:342`) | none | — (read overlaps #4521) | YES | S | "Show my account" — the most common user question; no intent |
| F21 Onboarding state | First-run flow | GET/POST `/api/platform/onboarding/state` (`:302/:354`) | none | #3256 (not BizCopilot) | Out of parity scope | S | Onboarding flow, not a BizCopilot surface |
| F22 Profile read/save | Profile UI | GET/POST `/api/platform/accounts/profile` (`:304/:430`) | none | #3261 (not BizCopilot) | Out of parity scope | S | Profile management, not a BizCopilot surface |

### Channels — `?tab=platform-admin&view=channels`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F23 View channel enablement | Tenant select (`ChannelsAdminPanel.tsx:128`) | GET `/api/platform-channels/:id` (`platformChannels.ts:157/:191`) | `show` (`bizCopilotChannels.ts:100`) | #4517; #4743 | No (MCP pending) | S | Enablement flags + bindings in one read |
| F24 Enable channel | Checkbox (`:145`) | PATCH `.../:id/channels` (`:157/:291`) | `enable` | #4517; #4743 | No (MCP pending) | S | — |
| F25 Disable channel | Checkbox (`:145`) | PATCH `.../:id/channels` | `disable` | #4517; #4743 | No (MCP pending) | S | — |
| F26 Enforcement state | (read) | Same GET | `enforcement` | #4517; #4743 | No (MCP pending) | S | Disabled = refused, never attempted. Copilot/Docs config-only (#3178) |
| F27 Slack channel mapping | No UX caller | GET/PUT/PATCH `.../:id/slack-channel` (`:157/:264`) | none | — (#4610 built the route) | YES — API-only; decision | S | Route exists, unused. Chat-first, or leave API-only? |
| F28 Webhook URL binding | No UX caller | GET/PUT/PATCH `.../:id/webhook-url` (`:157/:215`) | none | — (#4611) | YES — API-only; decision | S | Same question as F27 |

### Free runs — `?tab=product-hub&view=free-runs` + billing tab quota section

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F29 View free-run allowance | Allowance display | GET `B/free-run-allowance` (`agenticPayments.ts:1431`) | none | #4518 | YES | S | Operator-data read; caps per product/month |
| F30 Set allowance per family | Save ×4 families (`FreeRunAllowanceSection.tsx:174`) | POST `B/free-run-allowance` (`:1451`) | none | #4518 | YES | S | Caps are operator-changeable, never constants |
| F31 View approved-free quota + usage | Quota display | GET `B/approved-free-quota` (`:1522`) | none | #4518 | YES | S | Quota + usage + grant state in one read |
| F32 Set quota cap per family | Save cap ×4 (`ApprovedFreeQuotaSection.tsx:309`) | POST `B/approved-free-quota` (`:1583`) | none | #4518 | YES | S | Bounds the unlimited-free grant (F13) |
| F33 Set quota window / at-limit action | Save window/action (`:331/:346`) | POST `B/approved-free-quota` (`:1583`) | none | #4518 | YES | S | Window + limit behavior |

### Products — `?tab=product-hub&view=admin-products`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F34 View products + versions | Products list; move section | GET `B/products` (`:6408`); GET `B/products/:id/versions` (`:6797`) | none | #4519 | YES | S | Foundation read for pricing workflows |
| F35 Create product | Create product (`ProductsSection.tsx:499`) | POST `B/products` (`:6439`) | none | #4519 (surface; body names versions) | YES | S | New product identity |
| F36 Create version (subscription) | Create version (`:1434`) | POST `B/products/:id/versions` (`:6840`) | none | #4519 | YES | S | Price change = new version; lands PROPOSED |
| F37 Create catalogue version (per-run) | Create catalogue version (`:1553`) | POST `B/catalogue/versions` (`:7192`) | none | #4519 | YES | S | Returns NO version id — chain by family/segment/effectiveFromMs |
| F38 Create pack version | Create pack version (`:1933`) | POST `B/products/:id/versions` (`:6840`) | none | #4519 | YES | S | (runs, price) terms; never per-run-derived |
| F39 Approve version | Approve vN (`:1174`) | POST `.../versions/:vid/approve` (`:7005`) | none | #4519 — approval itself out of scope, human-gated | YES + DECISION | S | Price approval via chat needs Mars's call |
| F40 Deactivate version | Deactivate vN (`:1183`) | POST `.../versions/:vid/deactivate` (`:7086`) | none | #4519 | YES | S | New purchases stop; holders ride on |
| F41 Set ladder rank | Save ladder position (`:270`) | POST `B/products/:id/rank` (`:6724`) | none | #4519 | YES | S | Drives offer ladder order |
| F42 Bulk-move preview | Preview move (`:1702`) | POST `B/products/:id/bulk-move` dryRun (`:7256`) | none | #4519 | YES | S | Count before moving; in-chat confirmation decision open |
| F43 Bulk-move execute + resume | Move N holders (`:1743`); Resume (`:1761/:1797`) | POST `B/products/:id/bulk-move` (`:7256`) | none | #4519 | YES | C | Audited; resume via `resumeBulkMoveId`; synchronous row cap |
| F44 Bulk-move history/detail | History + detail (`:1793/:1797`) | GET `B/products/:id/bulk-moves[/:id]` (`:7353/:7386`) | none | #4519 | YES | S | Verify moves per customer |
| F45 Configure referral rules | Save rule ×3 issuers (`ReferralCodesSection.tsx:798`) | POST `B/referral-code-rules` (`:4252`) | none | #4519 | YES | S | Per-product rules; seeded inactive until an operator activates one |
| F46 View referral rules | Rules display | GET `B/referral-code-rules` (`:4231`) | none | #4519 | YES | S | — |
| F47 Issue referral code (operator) | Issue code (`:983`) | POST `B/referral-codes/issue` (`:4284`) | none | #4519 ("no live code issued by chat alone") | YES + DECISION | S | Plaintext returned ONCE — chat transcript persistence question |
| F48 View issued codes | Code list | GET `B/referral-codes` (`:4367`) | none | #4519 | YES | S | Public views only (no plaintext) |
| F49 Revoke code (operator) | Revoke (`:1011`) | POST `B/referral-codes/revoke` (`:4386`) | none | #4519 | YES | S | — |
| F50 View effective prices | Pricing display | GET `B/pricing` (`:6056`); GET `B/prices` (`:6126`) | none | #4519 ("effective prices") | YES | S | Server-truth prices; operator catalogue read |
| F51 Legacy plan create/approve/deactivate | No UX caller (UI uses versions) | POST `B/plans[/approve|/deactivate]` (`:2210/:2330/:2364`) | none | — | Reconcile, not parity | S | Superseded by versions routes; deprecate-or-keep decision |
| F52 Bundles view/create/approve/deactivate | Catalog read; admin fns, no button enumerated | GET/POST `B/bundles[/approve|/deactivate]` (`:2391/:2413/:2476/:2508`) | none | #2781 (COO lane) | Cross-lane — COO's call | S | Do not file CBO parity issues; COO owns bundling |

### Referral codes, self-service — billing tab (`ReferralCodesSection.tsx`)

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F53 View referral code balance | Balance display | GET `B/referral-codes/balance` (`:4608`) | none | #4521 (referral-code state) | YES | S | `codeRunsAvailable` read |
| F54 View own codes | Own codes list | GET `B/referral-codes/mine` (`:4507`) | none | #4521 | YES | S | — |
| F55 Mint own code | Get my code ×4 (`:307`) | POST `B/referral-codes/mine` (`:4528`) | none | #4521 (servicing, vague) | YES + DECISION | S | Self-serve issuance; rule must be active; plaintext ONCE |
| F56 Redeem code | Redeem (`:279`) | POST `B/referral-codes/redeem` (`:4424`) | none | #4521 | YES | S | Runs granted; replay-safe |
| F57 Revoke own code | Revoke (`:330`) | POST `B/referral-codes/mine/revoke` (`:4574`) | none | #4521 | YES | S | Issuer-only |
| F58 Legacy referral credits | Billing overview referral credits | GET `B/referral/balance` (`:8410`); POST record-earn/attribute (`:8449/:8490`, no UX caller) | none | — (#2657 legacy) | YES (view); fallbacks = decision | S | Distinct from codes; fallbacks operator-only, no UX |

### Offer rules / billing policy — billing tab

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F59 View/save offer rules | Save rules (`OfferRulesSection.tsx:250`) | GET/POST `B/billing-policy` (`:5244`) | none | — (closest #4521, vague) | YES | S | Offer triggers / cooldown / downgrades / packs |
| F60 View/save billing policy | Save policy (`BillingPolicySection.tsx:386`) | GET/POST `B/billing-policy` (`:5244`) | none | — | YES | S | Grace / dunning / proration / periods / discount. No id in response — verify by re-read |
| F61 Set top-up limits | Save (`TopUpLimitsSection.tsx:182`) | POST `B/billing-policy` via `setTopUpLimits` (`billingPolicyApi.ts:167`) | none | — | YES | S | Bounds top-up amounts |
| F62 Set Stripe price by plan | Save (`PlanStripePriceSection.tsx:210`) | POST `B/billing-policy` via `setStripePriceByPlan` (`:223`) | none | — | YES | S | Billing-route price mapping; money-adjacent config |

### Usage billing — billing tab

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F63 View usage billing | Usage display | GET `B/usage-billing` (`:1208`) | none | #4521 | YES | S | Receipts / subs / renewals / refunds / referral balances. The journal-verification substitute (no journal route exists) |

### Checkout — `?tab=checkout`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F64 Submit paid run | Pay / Run-for-free (`CheckoutPanel.tsx:897`) | POST `B/goal-command` (`:8274`, goal only) + POST `B/submit` (`:1696`) + poll GET `B/submission-status` (`:2087`) | none | #4520 (per-run checkout, partial) | YES — nuance | C | Chat runs screens via copilot paths; parity = the checkout/confirm half |
| F65 Check payment (run) | I have paid — verify (`:930`) | POST `B/submission/check-payment` (`:8043`) | none | #4520 | YES | S | Re-reads Stripe session / x402 proof |
| F66 Subscription checkout mint | Buy, per plan (`:1044`) | POST `B/subscription/checkout` (`:2875`) | none | #4520 | YES | C | Returns `checkoutUrl` + `checkoutSessionId` — chainable |
| F67 Subscription purchase (activate) | I have paid — activate (`:1081`) | POST `B/subscription/purchase` (`:3007`) | none | #4520 | YES | C | Verified-payment only; auto-creates account; stacking |
| F68 Runs-pack checkout | Create pack checkout (`:1111`) | POST `B/runs-packs/checkout` (`:3720`) | none | #4520 | YES | C | — |
| F69 Runs-pack confirm | I have paid — verify (`:1152`) | POST `B/runs-packs/confirm` (`:3881`) | none | #4520 | YES | C | Claim-before-credit; journal projection (no journal read) |
| F70 Cancel subscriptions | Yes, cancel (`:1181`) | POST `B/subscription/cancel` (`:5629`) | none | — (closest #4521 servicing) | YES | S | Cancel-at-period-end or immediate per policy |
| F71 Top-up checkout + confirm | Create top-up (`:1283`); verify (`:1328`) | POST `B/top-up/checkout` (`:3283`) + `/confirm` (`:3454`) | none | — | YES | C | Credits purchase; bounded by policy (F61) |
| F72 View subscription / plans (buyer) | Plan / subscription rows | GET `B/subscription` (`:5985`); GET `B/plans` (`:2174`) | none | #4521 (state) | YES | S | Effective tier + held plans |
| F73 Billing-route checkout + purchase | Start checkout / I have paid (`ProductCatalogPanel.tsx:783/:827`) | POST `B/subscription/billing-checkout` (`:4802`) + `/billing-purchase` (`:4926`) | none | #4520 | YES | C | Tier-only; never included runs |
| F74 Bundle checkout + purchase | Start bundle checkout / paid (`:857/:884`) | POST `B/subscription/bundle-checkout` (`:2542`) + `/bundle-purchase` (`:2643`) | none | #2781 (COO) | Cross-lane | C | COO-owned; same as F52 |
| F75 Channel checkout + purchase (cfpay) | Start channel checkout / paid (`:923/:944`) | POST `B/channel/checkout` (`:5416`) + `/purchase` (`:5474`) | none | — | YES + DECISION | C | cfpay gate deprecated in place; HITL confirm. Surface via chat? Decision |
| F76 Start free trial | Start free trial (`:788`) | POST `B/subscription/trial` (`:4706`) | none | #4520 (subscription start) | YES | S | $0, no payment, no journal |
| F77 Present upgrade offer | Offer display (mount POST + compare GET) | POST `B/offer` (`:6544`); GET `B/offer/compare` (`:6618`) | none | #4520 | YES | S | Server-computed, read-only; drives F66/F68 preselect |
| F78 Dismiss offer | Not now (`UpgradeOffer.tsx:141`) | POST `B/offer/dismiss` (`:6662`) | none | #4520 | YES | S | Cooldown honored; no id — keyed by login+trigger+family |
| F79 Billing change plan (operator) | No UX caller | POST `B/subscription/billing-change-plan` (`:5901`) | none | — | YES — API-only; decision | S | Operator plan change; no UX |

### Payments / wallet — `?tab=payments` (legacy)

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F80 View gateways + transactions | Refresh (`PaymentsPage.tsx:189`) | GET `/api/payments/gateways`\|`transactions` (`payments.ts:375/:406`) | MCP `get_payment_gateways`, `get_transactions` | — (legacy; tools exist) | No — MCP-covered | S | mas_transactions world; tools registered in `commands.ts` |
| F81 Create payment draft (HITL) | Create checkout link (`:354`) | POST `/api/payments/create` (`:573`) | MCP `draft_payment` | — | No — MCP-covered | C | HITL; no money moves at draft |
| F82 Authorize/reject draft | Authorize / Reject (`:404/:411`) | POST `/api/payments/confirm` (`:808`) | MCP `confirm_payment_draft` | — | No — MCP-covered | S | HITL decision step |
| F83 View receipts | Receipts (wallet) | GET `/api/payments/receipts` (`:499`) | none | — | YES | S | Login-scoped receipts (#4601) |
| F84 Capture (PayPal) | No UX caller | POST `/api/payments/capture` (`:1005`) | none | — | Reconcile — API-only | S | Real capture; no UX; do not surface without decision |
| F85 Wallet view | `AgenticWalletPanel` | GET `/api/payments/agentic/wallet` (`:485`) + transactions + receipts | MCP `agentic_wallet_status` (partial) | — | Partial — tool exists (SIMULATED balance); panel shows more | S | Tool reads simulated local ledger; panel adds transactions/receipts |
| F86 Auto-approve limit | Shown from wallet status; no write UX | GET/POST `.../auto-approve-limit` (`:8355`) | none | — | YES — API-only; decision | S | HITL threshold singleton; no id in response |

### Billing servicing / refunds — billing tab

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F87 Billing overview | Overview display | GET `B/identity` + `B/subscription` + `/api/payments/receipts` + `B/plans` + `B/referral/balance` | none | #4521 | YES | S | The "what's my billing?" answer, one aggregate |
| F88 Refund policy view | Policy display | GET `B/refund-policy` (`:7914`) | none | #4521 (reads) | YES | S | Policy + disclosure |
| F89 Refund policy set/approve | act() (`RefundPolicySection.tsx:169`) | POST `B/refund-policy` (`:7935`) + `/approve` (`:7971`) | none | #4521 EXCLUDES refund execution | Excluded + DECISION | S | Owner policy + approvals; no chat without a call |
| F90 Refund request | Request (`RefundFlowSection`) | POST `B/refunds` (`:7563`) | none | #4521 excludes | Excluded + DECISION | C | HITL chain step 1 |
| F91 Refund approve/deny | Approve / Deny (`:487/:490`) | POST `B/refunds/approve` (`:7669`) | none | #4521 excludes | Excluded + DECISION | S | HITL decision; operator-only |
| F92 Refund execute | Execute (`:496/:501`) | POST `B/refunds/execute` (`:7712`) | none | #4521 excludes | Excluded + DECISION | S | Money movement; approved-only |
| F93 Refund view (record/list) | Record list/detail | GET `B/refunds` (`:7879`) | none | #4521 (reads) | YES | S | Status readable with flag OFF |

### Payment assurance / prices / operators — `?tab=payment-assurance`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F94 Start live assurance run | Start live run (`PaymentWorkflowAssurance.tsx:1206`) | POST `/api/assurance/payment-workflow/start` (`paymentAssuranceLive.ts:456/:219`) | none | #4522 | YES | C | Real workflow, test input; returns `workflowId` |
| F95 Assurance status | Refresh status (`:1207`) | GET `.../status` (`:466/:354`) | none | #4522 | YES | S | Poll step |
| F96 Assurance event (approve/reject) | Approve / Reject live (`:1208/:1209`) | POST `.../event` (`:461/:314`) | none | #4522 | YES | S | Delivers HITL events in the test run |
| F97 Assurance check-payment | Check payment (`:1210`) | POST `.../check-payment` (`:471/:405`) | none | #4522 | YES | S | Card rail only |
| F98 View prices | Price table (refresh) | GET `B/pricing` (`:6056`) + GET `B/prices` (`:6126`) | none | — (#4522 hosts the tab, doesn't cover prices) | YES | S | Operator catalogue read |
| F99 Save price (PROPOSED) | Save ×4 (`:850`) | POST `B/prices` (`:6155`) | none | — | YES + DECISION | S | Price write; lands PROPOSED unless approved in-call |
| F100 Approve price | Approve / Save & approve (`:859/:868`) | POST `B/prices` approvalStatus (`:6155`) | none | — | DECISION — human gate | S | THE price-approval gate. No chat without Mars's explicit call |
| F101 Operators list/add/remove | `StoreOperatorsPanel` | GET/POST `B/operators[/add|/remove]` (`:7431/:7449/:7491`) | none | — | YES | S | Who operates the store; sensitive; later batch |

### Legacy community referrals / ads — `ReferralsTab`

| Flow | UX surface + action | Route (file:line) | Chat today | Covering issue | Gap? | Cx | Value note |
|---|---|---|---|---|---|---|---|
| F102 Community referral links | Links CRUD | GET/POST/DELETE `/api/referrals` (`adsRevenueReferrals.ts`) | MCP `manage_referrals` | — (legacy) | No — MCP-covered | S | mas_referrals; distinct system from #3307 codes |
| F103 External ads | Ad clicks | POST `/api/external-ads/click` | MCP `manage_external_ads` | — | No — MCP-covered | S | Legacy marketplace ads |
| F104 Revenue summary | Revenue display | GET `/api/revenue` | MCP `get_revenue_summary` | — | No — MCP-covered | S | Ads/marketplace analytics |

### Boundary — inventoried, not parity rows

- **Saga (CAIO #2041):** start/status/gates/journey-decision routes exist (`sagaJourneyHandlers.ts`, `paymentSagaHandlers.ts`, `gateHandlers.ts`, `premiumMeters.ts:23`). CAIO lane; HITL journey. No CBO parity work. The meter route is internal-only.
- **Premium x402 endpoints** (`/api/premium/*`, `premiumHandlers.ts`): `paid_options_screener` / `paid_market_research` MCP tools already cover two of them; stock-signals has no MCP tool — that gap belongs to the screener lanes, not BizCopilot.
- **Users/IAAA** (`UserAdminPanel`, `/api/platform/users`): CISO-owned. No parity work.
- **Ledger** (`?tab=ledger`): trading surface, out of scope.
- **Journal + failure-credit claims:** NO HTTP routes exist at all (verified by route inventory). The journal is a projection written inside purchase/confirm/submit handlers; claims are created by the workflow and redeemed inside POST `B/submit`. This is a composability gap (see §B), not a flow row.
- **Lifecycle preferences/welcome/digest** (`lifecycle/*`): first-run/notification surface, no BizCopilot covering issue; welcome/digest send routes have no callers. Not parity rows; lifecycle preference writes have the tenantId hole (G-4, §G).

## B. Composability

### Chainable inputs/outputs (every flow; grouped where the shape is identical)

| Flow(s) | Chainable input | Chainable output | Chains to |
|---|---|---|---|
| F01, F03, F04, F23, F26, F29, F31, F34, F44, F46, F48, F50, F53, F54, F63, F72, F80, F83, F85, F87, F88, F93, F95, F98, F101-list, F102-read, F104 | tenantId / userId / login / productId / family | View object carrying the ids the writes need (tenantId, userId, subscriptionId, planId, versionId, codeId, bulkMoveId, refundId, workflowId) | Any write below |
| F02 | tenant name/id | tenant object (id) | F03, F05, F23–F28 |
| F05 | tenantId + patch | Fresh settings object | F04 verify |
| F08 | session identity | Account view (tenantId, userId) | F09–F20 |
| F09, F20 | login | Account view (tier, credits, runs, subscriptionId) | F10–F19 |
| F10, F11 | userId + values | Updated record | F09 verify |
| F12 | userId + planId | subscription | F18, F72 verify |
| F13–F16 | userId + grant | Grant record | F17, F31 verify |
| F18 | subscriptionId + toVersionId | subscription + `bulkMove: null` | F09 verify |
| F19 | userId + segment | account | Next charge resolution |
| F24, F25 | tenantId + channel | config object | F23 verify |
| F27, F28 | tenantId + value | Saved value | F23 verify |
| F30, F32, F33 | family + value | Echo / keyed response | F29/F31 re-read verify |
| F35 | product fields | product (id) | F36, F38, F41 |
| F36, F38 | productId + terms | version/plan (id) | F39, F40, F42, F18 |
| F37 | family/segment/effectiveFromMs | Entry keyed by family/segment/effectiveFromMs — **NO version id** | Chain by key, not id |
| F39, F40 | versionId | version/plan | F34 verify |
| F41 | productId + rank | product | F77 offer order |
| F42 | productId + segment | counts + holder sample | F43 execute |
| F43 | productId + segment (+ resumeBulkMoveId) | `bulkMove` id + preview/moved counts (null on dry runs) | F44 verify; resume via id |
| F45 | productId + rule | rule key | F47, F55 gating |
| F47, F55 | rule + issuer | codeId + **plaintext ONCE** | F56 redeem (plaintext cannot be re-read) |
| F49, F57 | codeId | Public code view | F48/F54 verify |
| F56 | code | redemption + runsGranted | F53 verify |
| F59–F62 | policy fields | Singleton `{policy}` — **NO id** | Re-read to verify |
| F64 | run params | `runRequestId` + `workflowId` | Status poll; F65 |
| F65 | submission id + proof | paymentUrl / verified state | F64 completion |
| F66 | planId + billing period | `checkoutRequestId` + `checkoutUrl` + `checkoutSessionId` (x402: `checkoutId` + challenge) | F67 |
| F67 | checkoutSessionId + proof | subscription + account | F72/F63 verify |
| F68 | pack version id | packRequestId + checkout ids | F69 |
| F69 | packRequestId + proof | pack balance | F63 verify |
| F70 | subscription id | cancel record | F72 verify |
| F71 | amount | topUpRequestId + checkout ids | confirm step |
| F73 | planId | checkout ids | billing-purchase |
| F75 | draft params | draft id + checkout URL (field name unverified — see routes.md) | channel purchase |
| F76 | planId | subscription + trialEndsAtMs | F72 verify |
| F77 | login + context | Offer payload (plan/pack ids) | F66/F68 preselect; F78 dismiss |
| F78 | login + trigger + family | `{suppressedUntilMs}` only — **NO id** | Terminal; re-presenting honors cooldown |
| F79 | subscription id + plan | subscription | F72 verify |
| F81 | amount + rail | draftId + checkoutUrl | F82 |
| F82 | draftId + decision | draft status | F80 verify |
| F84 | capture id | capture result | Terminal (API-only) |
| F86 | limit | Singleton — **NO id** | Re-read to verify |
| F89 | policy text | Singleton `{policy}` — **NO id** | F88 re-read verify |
| F90 | refund params | refundId | F91 → F92 |
| F91, F92 | refundId + decision | refund record | F93 verify |
| F94 | test params | `workflowId` | F95, F96, F97 |
| F96 | workflowId + event | event ack | F95 verify |
| F97 | workflowId | payment state | F95 verify |
| F99, F100 | family + price | price entry | F98 re-read verify |
| F101-add/remove | login | operator row | F101-list verify |
| F06 | — | Refusal (no route call) | Terminal, by design |
| F07, F51 | — | (routes exist, no callers) | Reconcile; do not chain |

### Example composed workflows

**W1 — Onboard a tenant and user (F02 → F08 → F09 → F15 → verify).**
1. Create tenant (`POST /api/platform-tenants`, chat `create` / future MCP tenant tool) → tenantId.
2. Set up the account for the new login (`POST /api/platform/accounts/setup`, F08 — no chat yet) → account view.
3. Look up the account (`lookup` / MCP) to confirm tier and tenant binding.
4. Grant free access (`grant-free-access` / MCP) with the approved window.
5. Verify: `lookup` + quota read (F31, future tool) show the grant and its bound.
Value: one conversation replaces four page visits; every step reuses the route the page calls.

**W2 — Pricing change end-to-end (F34 → F36 → F39 → F18/F43 → F44).**
1. View current versions and effective prices (F34/F50, future tool).
2. Create the new version (F36) → version id, PROPOSED.
3. **Approve the version (F39) — human-gated; in chat only after Mars's call.** Until then this step stays on the page.
4. Move one customer (F18, `move-current-pricing`) or preview + execute a bulk move (F42 → F43).
5. Verify: bulk-move detail (F44) per customer + account lookup (F09). Nobody moves by the version alone — grandfathering holds until a move runs.

**W3 — Purchase (F77 → F66 → F67 → F72/F63).**
1. Present the upgrade offer (F77) with the current plan, the higher plan, and the dismiss option.
2. Mint the checkout (F66) → `checkoutUrl` handed to the user; the user pays on the checkout page (no prompt in the money path).
3. Confirm the purchase (F67) on verified payment → subscription + account.
4. Verify: subscription read (F72) + usage-billing read (F63). **Journal verification is not possible via API** — no journal read route exists (see below); verification is via the subscription/usage reads, not the journal.

**W4 — Support triage (F09 → F31/F53/F63 → F11/F13/F15 → F09).**
1. Look up the account (F09) — tier, credits, runs, subscription.
2. Read quota + usage (F31), referral balance (F53), usage billing (F63).
3. Fix: adjust credits (F11), or grant unlimited free (F13) / free access (F15), each within the operator's authority.
4. Verify: re-read the account and quota. The whole triage stays in one chat turn sequence.

### Flows that CANNOT be composed today, and why

- **Journal verification (all purchase/confirm flows):** no HTTP route reads the journal (projection only). Workaround: verify via F63/F72 reads. A journal read route would be a NEW capability — file only if Mars wants journal verification via API (see §I).
- **Failure-credit claims:** no HTTP route creates or reads claims; redemption happens inside POST `B/submit`. A claim's existence is only visible via usage-billing reads. Same NEW-capability note as the journal.
- **Plaintext-once codes (F47, F55):** the plaintext is returned once and never again. Composing "issue → show later" is impossible by design; and putting plaintext in a chat transcript raises a persistence question Mars must call.
- **HITL chains (F81→F82, F90→F91→F92, F75, saga gates):** composable only with a human pause between steps. The LLM can prepare and present, and can resume after the decision — it cannot complete the chain alone.
- **No-id responses (F37, F59–F62, F78, F86, F89):** the write returns no identifier; the next step must re-read by key (family/segment, login+trigger, singleton). Composable, but by re-read rather than by id.
- **Channel checkout result shape (F75):** the response field carrying the checkout URL is unverified (routes.md marks it unclear). Do not compose until verified.
- **Bulk move (F43):** synchronous with a row cap; large moves need the resume id. Composable via `resumeBulkMoveId`, not as a single fire-and-forget.
- **Price approval (F39, F100) and refund execution (F89–F92):** composable technically, gated by owner decision. Not a technical gap — a governance gate.

## C. Parity matrix

104 discrete flows (F01–F104). Complexity: 90 simple (single route), 13 composed (multi-step), 1 refusal by design (F06).

| Surface | Flows | Chat-covered (deterministic) | Chat-covered (MCP) | Gap (no chat) | Other |
|---|---|---|---|---|---|
| Tenants | 7 | 5 | 0 | 0 | 1 refusal (F06), 1 reconcile (F07) |
| Accounts | 15 | 8 | 0 | 5 | 2 out of parity scope (F21, F22) |
| Channels | 6 | 4 | 0 | 2 (API-only decisions) | — |
| Free runs | 5 | 0 | 0 | 5 | — |
| Products | 19 | 0 | 0 | 17 | 1 reconcile (F51), 1 cross-lane (F52) |
| Referral self-service | 6 | 0 | 0 | 6 | — |
| Offer rules / billing policy | 4 | 0 | 0 | 4 | — |
| Usage billing | 1 | 0 | 0 | 1 | — |
| Checkout | 16 | 0 | 0 | 15 | 1 cross-lane (F74) |
| Payments / wallet | 7 | 0 | 3 full + 1 partial | 2 | 1 reconcile (F84) |
| Billing servicing / refunds | 7 | 0 | 0 | 3 | 4 excluded, decision-gated (F89–F92) |
| Assurance / prices / operators | 8 | 0 | 0 | 8 | — |
| Legacy community / ads | 3 | 0 | 3 | 0 | — |
| **Total** | **104** | **17** | **6 full + 1 partial** | **68** | **12** |

Headline: **17 of 104 flows are reachable in chat deterministically, 6 more via legacy MCP tools, 1 partially; 68 have no chat path at all.** Of the 68 gaps, 46 are covered by an existing filed slice issue (#4518–#4522), 22 have no covering issue (see §D reconciliation), 6 carry a governance decision flag that must be settled before build (F39, F47, F55, F75, F99, F100), and 4 more are API-only routes needing a surface decision (F27, F28, F79, F86). Zero CBO-surface MCP tools exist today — the MCP coverage above is all legacy tools in other worlds (payments drafts, community referrals, ads, revenue); none of them calls a CBO commercial route.

## D. Filing plan

**Relationship rule (no duplicates):** flow issues DECOMPOSE slice issues (#4518–#4522) into one-PR build units. They link the slice issue as Related and the tracker as parent; they do not restate the slice's scope. A slice issue closes when its flows land. A flow already built (#4515–#4517) or already filed (#4741–#4743) gets no new issue. The tracker carries the inventory; the quick wins carry the builds.

**PR-body rule (close-workflow regex landmine, AGENTS.md 2026-11-18):** never write a closing verb (close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved) directly before an issue reference that the PR does not mean to close — the close script matches with no negation handling and auto-closed #4062 in PR #5289. In PR bodies, keep verbs and references non-adjacent, or put the reference in backticks (e.g. `#4518`).

### D1. Parity tracker issue draft (under #4514)

**Title:** `[BizCopilot] Chat/UX full-parity tracker: flow inventory, sequencing, and gap closure`

**Body sketch:**
- Purpose: one tracker for bringing chat/UX to full parity across the CBO domain, per Mars's 2026-11-18 direction. Inventory: 104 flows (file:line grounded, `parity-inventory-2026-11-18.md`); 17 deterministic-covered, 6 MCP-covered (legacy), 68 gaps.
- Parity matrix (the §C table, condensed) and the complexity split (90 simple / 13 composed / 1 refusal).
- Prioritization: reads before writes; operator config before money movement; highest-frequency questions first; decisions deferred, not assumed (§E).
- Sequencing: quick-win batch (§D2) → batch 2 (referral self-service, product writes, offer present/dismiss, checkout prepare, account gaps) → batch 3 (checkout confirm, bulk moves, operators, prices, policy, receipts, cancel, channel bindings) → decision-gated work only after Mars's calls (§D3).
- Relationship to existing issues: slices #4518–#4522 own the surfaces; flow issues decompose them (Related links, not duplicates); #4741–#4743 own the MCP conversions of the three built surfaces and stay file-only until build is directed; #4515–#4517 are built and closed.
- Decision items carried here (not decided in this issue): Checkout capture scope (#4520); price approval via chat (F39/F100); plaintext-once codes via chat (F47/F55); refund execution via chat (F89–F92, currently excluded by #4521); cfpay channel purchase (F75); bulk-move confirmation in chat vs page-only; non-operator permission visibility for MCP tools (an AC on every MCP build); reconcile-or-deprecate for no-caller routes (F07, F51, F84); API-only routes (F27/F28, F79, F86) — chat-first or leave API-only.
- Compliance linkage: API hardening gaps from §G/§H are filed alongside parity work (§I), not silently skipped.
- **Reuse class:** N/A (tracker; no build). **Dependencies:** none.

### D2. Quick-win batch (4 flow sub-issues, file first)

All four: parent = the tracker; mechanism = MCP tool primary (Mars's 2026-11-15 decision), deterministic branch as an option; one PR each; every result links the page URL. FS-ledger disposition (R-2: all 8 FS sub-issues created in the SAME motion as the parent): FS-1 UX-URL verify-only (chat links the page; no UX change); FS-2 AOP verify-only (tool reuses the route's gates/audit/coded responses; §G gaps linked, not fixed here); FS-3 Services = build (the MCP command class + executor); FS-4 API endpoints N/A (no new HTTP route; the tool calls existing routes in-process); FS-5 MCP endpoints = build (registration, schema, steering lines); FS-6 Data layer N/A (no migration, no new tables); FS-7 Integration verify-only (tool discovery via the existing MCP auto-merge + steering verified in chat turns); FS-8 Release verify-only (§18: merge + deploy receipts).

**QW-1 — `[BizCopilot] Free Runs via MCP: allowance + quota reads/writes`**
- Flows: F29–F33. Decomposes #4518 (all of it — #4518 closes when this lands).
- Reuse class: **enhancement**. Evidence: routes exist (`agenticPayments.ts:1431/1451/1522/1583`); executor pattern reused from `executeBizCopilotAccountIntent` (`bizCopilotAccounts.ts:486`, in-process route calls, no second implementation); MCP command pattern `IMcpToolCommand` + `McpToolFactory.registerTool` (`src/mcps/openaimp/commands.ts:1757`). The enhancement is one new tool (action enum over the five flows) + steering lines in `src/agents/chatPrompt.ts`.
- Dependencies: none blocking (routes on main). Related: #4518, #4741 (pattern precedent).
- Scope: MCP tool primary; deterministic branch as option; operator gate reused; every result links the free-runs page; no price implications.
- Acceptance: all five flows work via the tool; gates/audit identical to the page; needs-identifier ask behavior; non-operator permission check passes; chip prompts (if added) parse against the parser; tests green; Policy Gate repro green.

**QW-2 — `[BizCopilot] Billing state reads via MCP: subscription, usage-billing, balances`**
- Flows: F63, F72, F87, F88, F93, F53, F54 (read side of #4521).
- Reuse class: **enhancement**. Evidence: read routes exist (`agenticPayments.ts:1208/5985/7914/7879/4608/4507` + `/api/payments/receipts`); MCP read-tool pattern exists (`get_payments_overview`, `meshDoorCommands.ts:434`); session-scoped identity pattern reused from the lookup executor. The enhancement is one read-only tool aggregating the reads the billing page already makes.
- Dependencies: none blocking. Related: #4521.
- Scope: READ-ONLY. Session-scoped (own billing only; operator reads reuse the lookup path). Links the billing page. No writes in this issue — billing writes are a later batch.
- Acceptance: answers "what's my billing / tier / balance / usage?" from server truth; never returns another user's billing; reads show PROPOSED/unavailable states honestly; permission check passes; tests green.

**QW-3 — `[BizCopilot] Products reads + rank via MCP`**
- Flows: F34, F44, F46, F48, F50, F41 (read side + rank of #4519).
- Reuse class: **enhancement**. Evidence: read routes exist (`agenticPayments.ts:6408/6797/7353/7386/4231/4367/6056/6126`); rank route exists (`:6724`); MCP pattern as QW-1. The enhancement is one tool over existing reads plus the single low-risk rank write.
- Dependencies: none blocking. Related: #4519.
- Scope: reads + rank only. NO version create/approve/deactivate, NO bulk moves, NO code issue (later batches + decisions). PROPOSED versions shown as unavailable.
- Acceptance: all six flows via the tool; rank floor for prod-free refused by the reused route; version/price reads match the page exactly; permission check passes; tests green.

**QW-4 — `[BizCopilot] Payment assurance runs via MCP: start, poll, event, check`**
- Flows: F94–F97. Decomposes #4522 (all of it — #4522 closes when this lands).
- Reuse class: **enhancement**. Evidence: assurance routes exist (`paymentAssuranceLive.ts:219/314/354/405`, dispatch `:456–471`); the live-test guard and workflow-id polling pattern are reused verbatim; MCP pattern as QW-1. The enhancement is one tool (action enum) plus the poll-until-terminal composition.
- Dependencies: none blocking. Related: #4522.
- Scope: MCP tool primary; start returns `workflowId`; status poll; event delivery; check-payment; test-only (`live-test-` ids, guard reused); links the assurance page.
- Acceptance: a full assurance run completes via chat; the guard fails closed exactly as the page path; no live money moves; every step answers plainly (start / status / result); tests green.

### D3. Reconciliation notes + sequencing for the remaining gaps

**No new issue — already built:** F01–F05, F09, F12–F18, F23–F26 (deterministic, #4515–#4517 closed). MCP conversion already filed: #4741–#4743 (file-only; build when directed).

**No new issue — legacy MCP tools already cover:** F80–F82, F85 (partial — the simulated-balance caveat is a tool-truth issue, not a parity gap; note it, don't file parity work), F102–F104.

**No new issue — excluded by scope or lane:** F06 (refusal, correct); F21/F22 (onboarding/profile, #3256/#3261); F52/F74 (bundles, COO #2781); saga/premium/users/ledger (other lanes — see §A boundary).

**No new issue — reconcile, not parity:** F07 (commercial tenant-settings, no caller), F51 (legacy plans, superseded by versions), F84 (PayPal capture, no UX). These need a reconcile-or-deprecate decision, not chat parity. File one `[Out-of-Scope]`-style reconciliation issue only if Mars directs cleanup; otherwise carry them on the tracker.

**No new issue yet — excluded pending a decision:** F89–F92 (refund chain; #4521 explicitly excludes refund execution — separate owner policy + approvals). F39/F100 (price/version approval), F47/F55 (plaintext-once codes), F75 (deprecated cfpay rail) are decision-flagged inside their batches below.

**Sequencing after the quick wins:**
- **Batch 2** (decomposes #4519/#4520/#4521, plus account gaps): referral self-service reads + redeem (F53–F57, minus the plaintext decision for F55); product writes — create product/version, deactivate, referral rules (F35–F38, F40, F45, F49); offer present/dismiss (F77/F78); checkout prepare — offer-driven mint, trial start (F66/F68/F73/F76, model prepares, deterministic confirm stays); account gaps — setup, upsert, credits, segment, own-account (F08/F10/F11/F19/F20).
- **Batch 3:** checkout confirm flows (F65/F67/F69/F71 — capture-scope decision first); bulk moves (F42–F44 — confirmation decision first); operators (F101); prices read/save (F98/F99 — decision first); billing policy + offer rules (F59–F62); receipts + wallet reads (F83/F85); cancel (F70); channel bindings (F27/F28 — API-only decision first); billing change-plan + auto-approve limit (F79/F86 — API-only decisions); legacy referral credit view (F58).
- **Decision-gated (no filing until Mars calls):** price approval via chat (F39/F100); plaintext-once code issue via chat (F47/F55); refund execution via chat (F89–F92); cfpay channel purchase (F75); MCP conversion builds (#4741–#4743).

## E. Prioritization rationale (business terms)

- **Reads before writes.** The fastest value is answering questions: "what's my account?", "what's my billing?", "what are the prices?", "what's the quota?" Reads are safe (no state change), they exercise the MCP pattern once, and they make every later write workflow verifiable — a write without a read-back is a guess. QW-2 and QW-3 are mostly reads for exactly this reason.
- **Operator config before money movement.** Free-run allowances, quotas, ranks, and prices are the levers operators pull daily; putting them in chat removes page-hopping without touching money. Checkout capture, refunds, and approvals move money or commit policy — they go last and only after the decisions that gate them.
- **Highest-frequency questions first.** Billing state is the question every user asks and every support conversation starts with. Free-runs config is the question every operator asks when a user hits a limit. Those two batches pay back on the first day.
- **Test-only assurance early.** QW-4 lets an operator verify the whole money path from chat without moving live money. It is the safest composed workflow and the one that de-risks everything after it.
- **Decisions deferred, not assumed.** Price approval, refunds, plaintext codes, and checkout capture are owner decisions. Filing them as if decided would build the wrong thing; carrying them on the tracker keeps them visible without spending build effort on a guess.
- **Reuse keeps each batch small.** Every quick win is one MCP tool over routes that already exist, following a pattern that already exists. No new HTTP route, no new table, no new gate. That is why four issues, four PRs, is a realistic first batch — and why batch 2 is cheaper than batch 1: the pattern is proven once, then repeated.

## F. API inventory

**Answer to Mars's question — did CBO build the APIs the UX calls?** Yes, for the platform and commercial surfaces: the platform tenants/accounts/channels/users routes and the commercial family's slice additions were built under CBO issues (provenance table below). The older wallet/ledger, legacy payments, and premium routes arrived as extractions whose original building issues are unnamed in history — they predate the CBO program as named work. Either way, the routes exist per-slice: **there is no separately designed "CBO API" layer.** The verification is in §F2.

### F0. The 150 routes, by group

Full per-route table (method + path + handler file:line + client caller + gate + response with chainable ids) is in [routes.md](routes.md). Summary:

| Group | Routes | Handler file | Client caller |
|---|---|---|---|
| Wallet + ledger | 10 | `src/agents/routes/agenticPayments.ts` | Wallet panel, receipts, legacy |
| Catalogued commercial (87) + parameterized uncatalogued (10) | 97 | `agenticPayments.ts` (8,969 lines) | All CBO panels/sections |
| Legacy payments | 9 | `src/agents/routes/payments.ts` | PaymentsPage, checkout, wallet |
| Platform accounts | 7 | `src/agents/routes/platformAccounts.ts` | AccountAdminPanel, first-run, settings |
| Tenants | 4 | `src/agents/routes/platformTenants.ts` | TenantAdminPanel |
| Channels | 6 | `src/agents/routes/platformChannels.ts` | ChannelsAdminPanel |
| Users | 2 | `src/agents/routes/platformUsers.ts` | UserAdminPanel (CISO) |
| Assurance | 4 | `src/agents/routes/paymentAssuranceLive.ts` | PaymentWorkflowAssurance |
| Premium | 6 | `src/agents/routes/premiumHandlers.ts` | No direct client caller (x402-gated APIs) |
| Saga | 4 | `sagaJourneyHandlers.ts`, `paymentSagaHandlers.ts`, `gateHandlers.ts` | CAIO surfaces |
| Meter | 1 | `src/agents/routes/premiumMeters.ts:23` | Internal-only |
| **Total** | **150** | | |

41 routes have no client caller found (6 by design: 2 webhooks, meter, unsubscribe, 2 internal ledger rows). 9 routes return no identifier. Journal and failure-credit claims have NO HTTP routes (see §B).

**Dispatch (hand-rolled, no router):** `src/server.ts` handleFetch → family handlers (`platform.ts:472` payments, `core.ts:156` `/api/*` fallthrough, `messaging.ts:217` saga) → DO thin router `routeRequest.ts` calling per-module handlers in fixed order, each with its own `endsWith` if-chain. The dispatch order is load-bearing (later modules only see requests earlier modules declined).

### F1. Provenance (changelog.d grep + `git log -3` + first-appearing commit; no PR number is named in history for any group)

| Group | First-appearing commit | Named fragments / issues |
|---|---|---|
| Commercial family handler | `67beca31a`, 2026-10-20 (#359/#380 extraction) | Fragments name #2015/#2020/#2022, #2846 (catalog), #3246, #3247, #3263, #3307, #2657, #2662, #2985, #3571, #5227, #2945 |
| Wallet/ledger routes | Unnamed in history | Oldest routes; no fragment names them |
| Legacy payments | `9f00e8888`, 2026-10-19 (#370 extraction) | Unnamed |
| Platform accounts | `e828cfc28`, 2026-11-04 | #2222 |
| Tenants | `78302e4bd`, 2026-11-04 | #2221 |
| Channels | `baa674c4e`, 2026-11-04 | #3169 |
| Users | `3abb8c42a`, 2026-11-04 | #2220 |
| Assurance | `a0add1a44`, 2026-10-27 | #2059; #2197 rework |
| Premium | `a6a4cb47e`, 2026-10-19 (#371 extraction) | Unnamed |
| Saga | `53e7eeff1` 2026-11-01 (entry/status), `84f4114cc` 2026-10-31 (journey) | #2041 |
| Meter | `8c77f8f68`, 2026-11-01 | #2041 |
| URL catalog | `f90d45e54`, 2026-11-14 | #2846 |

### F2. No separately designed "CBO API" layer — verification

Searches run (recorded in routes.md §F2): zero hits for router frameworks / `createRouter` / `commercialRouter` in src; no router dependency in package.json; no `v1`/`v2` path segments or version headers on any inventoried route (only unrelated `/api/otel/v1/*`); the phrase "CBO API" appears nowhere in src or docs; no API doc covers these routes. What exists instead:
- A path-only catalog, `src/data/commercialUrlCatalog.ts` (does not cover the 10 parameterized routes).
- A static IAAA explorer catalog (commercial family = one prefix entry).
- An OpenAPI spike, `src/security/openapiSpec.ts` (pilot schemas only; commercial routes "not yet specified"; served at `/openapi.json` + `/api/docs`).
- Ingress guards that explicitly decline a router table (`src/api/ingress.ts:14-17`).
- Shared pieces only as helpers inside `agenticPayments.ts` (login/operator/flag checks, coded responses) + the outcome catalog.

**Characterization, stated plainly:** the APIs are a per-slice accumulation behind one hand-rolled dispatcher, not a designed layer. The parity work must not add a second accumulation — §I maps every gap to the existing route/executor/port, and §G/§H gaps are filed as hardening, not hidden.

## G. AOP compliance

**Headline:** ADD.md names AOP once (one bullet, `docs/architecture/ADD.md:111`) and defines none of it. The enforceable rules live in ADRs, the architecture standards, and the code itself. The assessment below quotes the rules from their sources (full text in [compliance.md](compliance.md) §1) and grades each route group against all six AOP aspects. Groups: G1 commercial/agentic, G2 tenants, G3 accounts, G4 channels, G5 users, G6 payments, G7 premium, G8 meter, G9 assurance, G10 ads/referrals, G11 audit, G12 dispatcher.

**Rules (sources):** R-EXC — all exceptions carry a code, message, remediation, and context; no raw `err.message` to clients (`docs/architecture/adr/0018-error-handling.md`, `docs/architecture/standards/error-handling.md`). R-CODED — user-facing messages use coded messages via `codedMessage` + the outcome catalog, never inline literals (`docs/architecture/adr/0009-coded-messages.md`, `docs/architecture/standards/message-codes.md`). R-LOG — module loggers, trace ids, no PII (`docs/architecture/adr/0013-observability.md`, `docs/architecture/standards/logging.md`; #3515 module-logger seam). R-CFG — defaults externalized in operator-managed config, never code constants; missing data fails closed (ADD.md, ADR 0004, Mars 2026-10-28 directive). R-SEC — session-scoped identity, `canAccessAccount`/`isStoreOperator` gates, no client-supplied tenantId, no fail-open defaults (`docs/architecture/adr/0007-security.md`, `docs/architecture/standards/security.md`, Mars 2026-10-29 correction). R-TXN — multi-statement writes atomic via D1 `batch()` (ADR 0002 R5; `db.transaction()` not relied on for D1 atomicity).

### Verdict matrix (compliant / partial / gap / not-verified)

| Group | Exceptions | Coded messages | Logging | Config | Security | Transactions | ADD.md |
|---|---|---|---|---|---|---|---|
| G1 commercial | partial | partial | partial | compliant | partial | gap | partial |
| G2 tenants | gap | gap | gap | compliant | partial | gap | partial* |
| G3 accounts | partial | partial | partial | compliant | compliant | partial | partial* |
| G4 channels | gap | gap | gap | compliant | partial | gap | partial* |
| G5 users | compliant | gap | gap | compliant | compliant | compliant | partial |
| G6 payments | partial | partial | partial | compliant | partial | not-verified | gap |
| G7 premium | not-verified | gap | gap | gap | partial | not-verified | partial |
| G8 meter | partial | gap | gap | compliant | compliant | compliant | compliant |
| G9 assurance | compliant | gap | partial | compliant | compliant | compliant | partial* |
| G10 ads/referrals | partial | gap | gap | partial | partial† | not-verified† | gap |
| G11 audit | gap | partial | gap | partial | partial | compliant | gap |
| G12 dispatcher | — | — | — | — | compliant | — | gap |

(* = port-first compliant, API-first partial. † = caveated in compliance.md §13. "Not verified" verdicts are marked with reasons in compliance.md — no runtime/live-state verification was done anywhere in this inventory.)

Cross-cutting: config is the strongest aspect; logging + coded messages the weakest; **zero zod/schema validation in any scope file; zero multi-statement atomicity anywhere in scope.**

### Ranked gaps (file:line evidence in compliance.md §14; fix reuses an existing mechanism in every case)

| Gap | Finding | Fix (reuse) |
|---|---|---|
| G-1 | Ledger write-throughs unauthenticated — `agenticPayments.ts:508–763` (`ledger/record`, `record-cfpay`, `record-native`) contain no gate reference; body identity trusted. **Independently spot-verified by this session (direct code read, 2026-11-18).** Exposure is any-authenticated-user, not anonymous. | In-file `isStoreOperator` / `commercialLogin` + identity match |
| G-2 | No multi-write atomicity anywhere; partial-apply risk (F05 settings PATCH, F43 bulk move, purchase flows) | Reuse D1 batch leg `d1BatchTransactionBackend` / `withTransaction` (`transactionAspect.ts:354–393`), today used only by `d1ProviderConfigAdapter.ts:347` |
| G-3 | Raw `err.message` returned to clients in G1/G2/G4/G6/G11 | Reuse the G9 pattern (`paymentAssuranceLive.ts:101–112`) |
| G-4 | No schema validation + lifecycle tenantId hole — preference GET/POST (`agenticPayments.ts:8688–8730`) check only `canAccessAccount(login, userId)` while `tenantId` from query/body is used as the store key unverified. **Independently spot-verified by this session.** | One shared validation helper reusing `validateProfileInput` / `validateStrictAuditWrite` |
| G-5 | Zero or error-only logging in six files | #3515 module-logger seam |
| G-6 | Uncoded error literals across groups | Outcome catalog + `codedMessage` + in-file helpers |
| G-7 | Premium prices hardcoded (`TRADING_PAID_SERVICES`, `agenticPayments.ts` service:123–145) | Reuse `getApprovedPrice`; owner decision on seeds |
| G-8 | No shared schemas / OpenAPI; platform paths duplicated | Extend the `commercialUrlCatalog` pattern |
| G-9 | Silent operator-list degrade (empty list on store failure) | Log + audit the degrade |
| G-10 | Route-layer ORM / `.db` shortcuts + the 8,969-line handler | Existing ledger/marketplace/audit ports; `ensureSchema` into adapter factories; extract services |
| G-11 | Channel mutations unaudited + best-effort after-write audit | Wire the funnel; audit-before-write is an owner decision |
| G-12 | ADD.md names AOP without definitions | Doc-only AOP section (reuses the ADR/standards sources) |
| G-13 | `POST /audit` legacy mode unvalidated | Verify the live default first; owner decision |
| G-14 | Audit pagination literals | Reuse `COMMERCIAL_DEFAULTS` |
| G-15 | Verification debt | Follow-up reads: `src/services/payments.ts` + draft/confirm commands, `src/services/agenticPayments.ts` gate + claim/release, `src/config/adsRevenueModes.ts` |

## H. ADD.md compliance

ADD.md (153 lines) is a **container doc only** — "holds the section structure and links… duplicates nothing." The API/MCP architecture of record is `docs/architecture/application/api-mcp.md` (281 lines, CPO lane), which itself records gaps (no modular router, MCP error-format inconsistency, `x-user-login` header risk).

**Port-first (ADR 0002 R1 — non-negotiable: domain depends only on `src/data/*` ports; no store client, no `env.AGENT_DB`, no SQL in domain):** G2/G3/G4/G9 are port-first compliant (platform routes depend on ports; stores behind adapters). G1 is partial (route-layer ORM/`.db` shortcuts in the commercial handler — G-10). G6/G10/G11 are gaps (direct store/ORM use in route code). G8 is compliant.

**Layering (routes → services → ports → adapters):** no group fully honors it. The commercial handler is 8,969 lines of route + service + store logic in one module (G-10); `ensureSchema` reach-throughs exist in route code; there is no service layer for most families (services exist as `src/services/*` for payments/agentic but the commercial handler does not route through them uniformly). The platform groups (G2/G3/G4) are closer: thin handlers over `src/data/*` ports.

**API-first:** path catalog exists (`commercialUrlCatalog.ts`) and the client uses it — compliant at the path level. Schema-first is a gap: no shared request/response schemas, no zod validation anywhere in scope, OpenAPI covers pilot schemas only with commercial routes "not yet specified" (G-8). Versioning: none (see §F2).

**One codebase / one implementation:** the commercial family is one module, but the same capability surfaces twice in places (F07 commercial tenant-settings vs F05 platform settings; F51 legacy plans vs versions routes) — the reconcile items in §D3. The MCP catalog has no duplicates for CBO surfaces because it has no CBO tools at all.

**ADR 0002 R2/R5:** dialect isolation holds (D1-only in scope); R5 projection-write contract holds for the journal (projection of the DO ledger, loud-logged failures, no auto-correction) — but the projection has no read-back route, which is the §B composability gap, not an ADD violation.

## I. Reuse-first plan

**One-surface rule:** API + MCP + UX are one surface. An MCP tool reuses the route's executor (no second implementation): the tool's `execute()` builds the same intent object the deterministic executor takes and calls the same executor, which calls the same route handler in-process — the exact mechanism specified in #4741–#4743. A deterministic branch and an MCP tool over the same flows share the executor; neither duplicates the route.

### Every parity gap → the existing capability to reuse/enhance/extend

| Gap flows | Reuse (file:line) | Enhancement | Reuse class |
|---|---|---|---|
| F29–F33 (QW-1) | Routes `agenticPayments.ts:1431/1451/1522/1583`; executor pattern `bizCopilotAccounts.ts:486`; MCP pattern `commands.ts:1757` | One tool, action enum over 5 flows + steering lines | Enhancement |
| F63/F72/F87/F88/F93/F53/F54 (QW-2) | Read routes (see §D2); read-tool pattern `meshDoorCommands.ts:434`; session identity from lookup executor | One read-only aggregating tool | Enhancement |
| F34/F44/F46/F48/F50/F41 (QW-3) | Read + rank routes (see §D2); MCP pattern | One tool, reads + rank write | Enhancement |
| F94–F97 (QW-4) | Assurance routes `paymentAssuranceLive.ts:219/314/354/405`; guard + polling pattern | One tool + poll-until-terminal composition | Enhancement |
| F08/F10/F11/F19/F20 (batch 2) | Account routes `platformAccounts.ts:300/578`, `agenticPayments.ts:1289/1382/6297`, `platformAccounts.ts:299/342`; `lookup` executor | Extend the accounts tool's action enum (or a second tool over the same executor pattern) | Enhancement |
| F35–F38/F40/F45/F49 (batch 2) | Versions/rules routes `agenticPayments.ts:6439/6840/7192/7086/4252/4386`; QW-3 tool | Extend the products tool's action enum | Enhancement |
| F53–F57 (batch 2) | Code routes `agenticPayments.ts:4608/4507/4528/4424/4574`; QW-2 read tool | Extend with redeem/revoke; mint only after the plaintext decision | Enhancement |
| F77/F78 (batch 2) | Offer routes `agenticPayments.ts:6544/6618/6662`; QW-3 product reads | Offer presentation + dismiss actions on the products/checkout tool | Enhancement |
| F66/F68/F73/F76 (batch 2) | Checkout mint routes `agenticPayments.ts:2875/3720/4802/4706` | Model prepares + presents; deterministic confirm stays (no prompt in money path) | Enhancement |
| F65/F67/F69/F71 (batch 3) | Confirm routes `agenticPayments.ts:8043/3007/3881/3454`; existing deterministic checkout/confirm flows | Chat resume-after-payment composition, after the capture-scope decision | Enhancement |
| F42–F44 (batch 3) | Bulk-move routes `agenticPayments.ts:7256/7353/7386`; QW-3 tool | Preview → confirm → execute → verify composition, after the confirmation decision | Enhancement |
| F59–F62 (batch 3) | `B/billing-policy` `agenticPayments.ts:5244` + `billingPolicyApi.ts` field mappings | Policy read/write actions on the billing tool | Enhancement |
| F83/F85 (batch 3) | Receipts/wallet routes `payments.ts:499/485`; `get_payments_overview` pattern | Receipts read action; wallet tool truth fix (simulated balance) is a separate tool fix, not parity | Enhancement |
| F70/F79/F86/F27/F28 (batch 3) | Cancel/change-plan/limit/binding routes (see §A) | Single actions on the existing tools, after the API-only decisions | Enhancement |
| F98/F99 (batch 3) | Price routes `agenticPayments.ts:6056/6126/6155` | Price read/save actions, after the decision | Enhancement |
| F101 (batch 3) | Operator routes `agenticPayments.ts:7431/7449/7491` | Operator list/add/remove actions on the accounts tool | Enhancement |
| F58 (batch 3) | `B/referral/balance` `agenticPayments.ts:8410` | Balance read on the billing tool | Enhancement |
| F39/F100, F47/F55, F89–F92, F75 | Routes exist (see §A) | NO enhancement filed until Mars's decisions — carried on the tracker | — (decision-gated) |

### NEW solutions — allowed only where the search shows nothing exists (searches recorded)

- **MCP command classes** for the new tools: new files, but the `IMcpToolCommand` + `registerTool` pattern already exists — classified **enhancement**, not new. Search: `grep -rn "registerTool" src/mcps/openaimp/commands.ts` (pattern present, ~100 tools); `grep` for tenant/account/channel/free-runs/products/checkout/billing/assurance in `src/mcps/openaimp/*` (zero hits — no CBO tools exist, which is why the tools are new files over existing routes).
- **Shared request-validation helper** (G-4): no shared helper exists (zero zod/schema validation in scope files; only `validateProfileInput` / `validateStrictAuditWrite` as in-file validators to reuse) — **enhancement** of those validators into one helper.
- **Route→role registry** (G-8/G-11, optional): no registry exists — genuinely **new**, and only if the hardening issue judges it needed; the default is to extend `commercialUrlCatalog` instead.
- **Journal / claims read routes** (§B): no routes exist (route inventory searched all dispatch tables; journal/claims are projection/internal only) — genuinely **new**, and filed only if Mars wants journal verification via API. The default is verification via F63/F72 reads, which needs no new route.
- **ADD.md AOP section** (G-12): doc-only, reuses ADR/standards sources — **enhancement** of the doc.

### API hardening filed alongside parity work (not silently skipped)

File as a hardening batch under the tracker (or as a sibling tracker — parent's call), sequenced with the parity batches so each parity PR lands on hardened routes where the gap touches its flows:

1. **G-1 ledger write-through auth** — enhancement (in-file gates). Highest priority; touches no parity flow directly but is the one unauthenticated write surface.
2. **G-4 shared validation helper + lifecycle tenantId fix** — enhancement. Before batch 2 writes.
3. **G-2 D1 batch atomicity for multi-write routes** — enhancement (existing batch leg). Before batch 3 (bulk moves, checkout confirms).
4. **G-3 coded error responses** — enhancement (G9 pattern). With QW-1 (new tools must not surface raw errors).
5. **G-5 module logging + G-6 coded messages** — enhancement. With QW-1/QW-2.
6. **G-11 channel audit funnel** — enhancement. With the #4743 conversion build.
7. **G-7 premium prices via `getApprovedPrice`** — enhancement; owner decision on seeds. Not on the parity critical path.
8. **G-8 catalog extension + shared schemas** — enhancement. With batch 2.
9. **G-9/G-14** — small enhancements, fold into the nearest hardening PR.
10. **G-12 ADD.md AOP section** — doc-only enhancement. Anytime.
11. **G-13/G-15** — verify-first items; file after the live-default check / follow-up reads.

---

*End of inventory. Method limits: static code + issue-body reads only; no runtime, live-state, or signed-in verification was done. Response shapes marked "unclear" in routes.md (notably the F75 checkout-URL field) and the G-15 verification-debt items need follow-up reads before build. All counts are from the files cited; recount from §A if the inventory is amended.*
