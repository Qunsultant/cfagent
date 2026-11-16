# Design — #3289 Product configuration UI

**Issue:** OpenAIMP/cfagent#3289 — `[Enhancement] Product configuration UI — versioned products, effective-dated launches, legacy vs new customers`
**Status:** Design only. No build, no PR, no GitHub writes, no issue comments.
**Verified against:** main `4355dc00` (2026-11-11), plus issue reads of #3289 / #2185 / #2739 on 2026-11-11 ~06:05 EST. **Revision 2026-11-11 ~06:40 EST re-verified against main `3e3a045d`** (charge records, journal mappings, subscription store, gate inputs — see §2.1).
**Author:** CBO-mlops (coordinator subagent). **Parent judges; build starts only on parent direction.**

## Revision 2026-11-11 ~06:40 EST — scope, Q1, Q3, and the move mechanism (Mars)

Mars answered the three gating questions and refined the move mechanism. Folded in below; §0 (the four earlier decisions) is unchanged.

1. **Scope note — first reading CONFIRMED (Mars ~06:40 EST).** The gate's policy and order do not change; only the price-source lookup gains version resolution. **PLUS Mars's qualification: a new price version moves NO ONE by itself — a customer pays the new price only when moved onto it.** Existing holders stay on their held version/price until moved; new customers buy the current effective version. Changed: §4.1–§4.4 (resolution is now availability, not repricing), §4.7–§4.8 (new: the move mechanism), §5 (move actions in the UI), §8 (slice split), §9 (move tests), §10 (scope + Q4 answered), §12 (scope note confirmed).
2. **Q1 — per-run is a product (Mars ~06:37 EST).** Every per-run charge must record which product, version, and price applied, so the business can track who used what product at what price. Changed: §2.1 (new — charge-record survey on fresh main), §3.9 (new — per-charge recording), §4.2 (per-run rewritten), §7 (journal/ledger/claim columns), §9 (recording tests), §10 (Q1 answered). There is no per-customer held per-run version for pricing — the version effective for the customer's segment applies at charge time — but the charge itself is pinned to the version + price at time of use.
3. **Q3 — concurrent versions, YES (Mars ~06:37 EST).** Multiple versions of one product can be sellable at once for different markets/customer segments. The chain model is REJECTED. Changed: §3.2–§3.4 (segment column on versions and accounts), §3.7 (resolver takes segment), §4.1 (resolver is now (product, segment, time)), §4.2 (purchase/plan-change resolve per segment), §5 (per-segment chains), §8–§10. The segment model is explicit operator assignment (§3.4) — alternatives evaluated and rejected there.
4. **Move mechanism refined (Mars ~06:42 EST).** "Move all customers to current pricing" must work as ONE bulk action (no customer-by-customer work), AND per-customer moves must also be possible. BOTH are UX-enabled UI actions, not API-only. Changed: §4.8 (new — the move mechanism, bulk + per-customer), §5.1–§5.2 (where both actions sit, routes), §8 (which slice each lands in), §9 (bulk-move tests).

## §0 — Decisions folded in (Mars, 2026-11-11 ~06:01 EST)

Four answers arrived after the design work started. Each is folded in below; the section that carries it is named.

1. **#3357 prices are fully flexible.** "Price can be anything... and it can change... build your billing with that flexibility." Annual $509.90/$611.90 are NOT fixed or approved amounts. Consequence: **a price change is a new version with an effective date** (§4.4); no price is ever a constant in code; the annual-price derivation is a UI *suggestion* the operator may override to any value (§4.5). The approved subscription prices (Free $0, Basic $49.99, Premium $59.99) remain approved *amounts* for the versions that carry them — a new version carrying a different amount is a new price that needs its own approval via the #2547/#3357 discipline (§4.3).
2. **#3307 referral codes: all rules configurable from the UI, per product.** Issuer, runs, one-time vs reusable, expiry, attribution, abuse limits — every rule UI-configurable per product. Consequence: the config surface lives **inside the Products admin section, one panel per product** (§6.1); the rules table is keyed by `productId` (§3.5); referral *mechanics* (issue/redeem/attribute) are NOT designed here — they belong to the #3307 slice.
3. **#3247 free-for-lifetime: YES — configurable, grantable AND revocable — plus free-for-a-limited-time.** Consequence: free-access grants get their **own account-level record, distinct from the #3245 unlimited-free grant and the #3243 trial** (§6.2). They are NOT product versions and NOT built in #3289 — only the placement, the distinction table, and the table shape are defined here; the build is the #3247 slice.
4. **#3246 upgrade offers: design delegated to CBO, produced at the #3246 step (after #3289/#3357).** Consequence: this design only states **what the product/version model must expose** so offers can compare and price plans (§6.3). No offer design is produced here.

## §1 — Requirement and what #3289 is distinct from

**Requirement (decided by Mars 2026-11-05 ~06:45 EST; issue body verified 2026-11-11):** products managed as real products — versioned products, effective-dated launches, the same product with different features and/or different prices over time (versions), new products added through the UI over time, legacy vs new customers on different products or different versions of the same product. Grandfathering (decided, entitlements-01.md §8): existing customers keep their price when prices change; new customers pay the new price; a plan change pays the new plan's current price. **Plus Mars ~06:40 EST: a new version moves NO ONE by itself** — a customer pays the new price only when moved onto it (§4.8). Multiple versions of one product can be sellable at once for different markets/customer segments (§4.1).

**Scope boundaries (issue body):** operator-only surface (same gating as the Accounts/price UIs); no self-service price editing; prices managed are the approved subscription prices and the per-run catalogue prices (currently PROPOSED seeds — per-run approval is a separate owner decision); no production config, flag, price, or secret change lands in this issue's slices.

**Distinct from (verified by issue read):**
- **#2185 — OPEN, not closed.** (The task brief said closed; that was wrong.) CBO slice 0: externalized price catalogue on D1, port-first. It *built* the catalogue (migration 0011 + `priceCataloguePorts.ts`); the catalogue exists on main. #3289 does not rebuild it — it *versions* it and adds the product/version model + UI on top.
- **#2739 — CLOSED (CTO lane).** Per-family per-run price edit + approve + status UI (`PriceApprovalSection` in `PaymentWorkflowAssurance.tsx`, payment-assurance tab; one new route `GET /payments/agentic/commercial/prices`). #3289 does **not** replace it: the Products section shows a catalogue version's approval status read-only and links to the payment-assurance tab for the approval action. The Products section is the *first* UI for plan-version approval (route-only today) — no duplication there.
- **#2547** — price-approval state (gate fails closed on unapproved). #3289 reuses it per version (§4.3); it does not redesign approval.
- **#3357** (monthly + annual subscriptions) — #3289 makes annual versions *possible* (a `billingPeriod` field on versions, §3.2); #3357 creates the annual versions and the checkout support. Annual prices remain unapproved dollar amounts (flexibility decision, §0.1).
- **#3246** — upgrade offers. #3289 exposes the data offers need (§6.3); the offer design is later.

## §2 — Survey: current state (main `4355dc00`)

- **Plans are operator data, unversioned.** `SubscriptionPlanRecord` = id, name, priceUSD, periodDays, includedRuns, trialDays (nullable), approvalStatus (proposed/approved), approvedBy, approvedAtMs, active, created/updated (`src/data/subscriptionPorts.ts`). **No** version, effective-date, productId, or billingPeriod field. **No `updatePlan` route or store method** (create/deactivate/approve only); plan rows are immutable except active/approval flags. `POST /plans` creates PROPOSED (or derives an annual price from a monthly plan: 365 days, monthly × 12 × (1 − discount), discount from billing policy). Subscription rows carry `planId` only — **no price or version snapshot**.
- **Billing policy already has the annual shape.** `billingPolicyPorts.ts`: `BillingPeriod = "monthly" | "annual"`, `annualDiscountPct` (PROPOSED seed 15; derivation pinned: 49.99→509.90, 59.99→611.90), `RepurchaseMigration = "grandfather" | "expire" | "migrate"` (seed `"grandfather"`). That grandfather rule is ONLY about repurchase rows vs Billing-managed rows — it is **not** #3289's price grandfathering, which does not exist as a mechanism today.
- **Per-run catalogue is global and unversioned.** `agent_price_catalogue`, keyed by family (stock $0.02 / goal $0.10 / options $0.05 / strategy $0.10, all PROPOSED seeds). `setPrice` edits in place, always lands PROPOSED, clears approval. The gate's `priceFor` reads `getApprovedPrice(family)` (`src/services/nativeMonetization.ts`) — one global price per family, no per-customer variation.
- **Gate order (re-verified, post-#3263):** verified identity → already-paid → flag OFF → grant bounded by approved-free quota → free-run allowance → grant fall-through → approved-price resolution (#2547 fail-closed) → Subscribed included runs → credits → 402/skip. The gate's *policy and order do not change* in this slice; only the price-source lookup gains version resolution (§4.2–4.3). See the scope note in §12.
- **Purchase/activation paths.** One-time purchase `activateSubscription` (`src/services/subscriptionActivation.ts`) grants tier + plan included runs; trial activation (`src/services/trialSubscriptionActivation.ts`, $0 checkout, flag ON required) auto-creates a missing account in the session tenant. The Stripe Billing purchase route confers tier only, never included runs ("Included-run bypass stays OFF"). Repurchase stacks from the latest periodEnd on the same planId. Checkout routes check `isPlanPriceApproved` (4 places in `agenticPayments.ts`).
- **No `agent_products` or `ProductVersion` table exists anywhere in `src/data/`.** No plan seeds exist in `migrationRunner.ts` (only a comment at line 1763 stating today's monthly prices). Plan rows are operator-created live data.
- **Operator UI patterns to follow.** Platform Admin: `PLATFORM_ADMIN_TABS` in `src/client/PlatformAdminPage.tsx:93` — 15 tabs; left-nav admin item has 17 sub-items (`src/client/nav-config.json`, `platformAdminSections[0].items` — the 15 tabs plus `scheduled-goals` and `jobs`); distinct icons 16 of 17 (Agents shared by Tenants+Users). The Free Runs section (`src/client/FreeRunAllowanceSection.tsx`, tabId `free-runs`, icon `Runs`, distinct) is the closest precedent: GET+POST route pair in `handleAgenticPaymentsRoutes` (`src/agents/routes/agenticPayments.ts:1306–1327`), operator-only, audited (`commercial.free_run_allowance.set`), migration-seeded value. The unlimited-free grant section lives in `AccountAdminPanel.tsx` (`UnlimitedFreeGrantSection.tsx`). `PriceApprovalSection` lives in `PaymentWorkflowAssurance.tsx` (payment-assurance tab), NOT in Platform Admin.
- **Migrations.** Registry in `src/data/migrationRunner.ts`; latest is **0057** (delivery datasets #3539). Next is **0058**. The registry test (`tests/migration_registry.test.ts`) is the canonical owner of "latest" — a well-formed new migration passes with zero updates. The thin-router inventory test pins `EXPECTED_INVENTORY` (measured 283 entries at #2298; the array has grown since — the build must measure, not assume).
- **CheckoutPanel** lists plans via `GET /plans` (active only) and shows prices; no client calls `POST /plans` — plan creation is route-only today, so #3289's UI is the first operator UI for plans/products.

### 2.1 Charge records today — what carries product/version/price (re-verified on main `3e3a045d`, Revision ~06:40)

Q1 asks every per-run charge to record product, version, and price. Here is what exists; **nothing today carries product, version, or a per-charge price snapshot** — that recording is new work in slice 1 (§3.9).

- **`agent_journal_entries` (D1) — the carrier.** `JournalEntry`: id, transactionRef, accountCode, debitUSD, creditUSD, currency, tenantId, runRequestId, family, createdAtMs. One row per money event (charge, failure credit, redemption, subscription purchase, top-up), mapped by `mapChargeToJournalEntries` / `mapFailureCreditToJournalEntries` / `mapSubscriptionPurchaseToJournalEntries` / `mapRedemptionToJournalEntries` (`src/data/journalPorts.ts`) from `JournalMappingInput` {transactionRef, tenantId, runRequestId, family, amountUSD, currency?}. Family is already carried on the entry row from the mapping input. The journal is the double-entry record the business reads — it gains `productId`, `versionId`, `priceUSD` (§3.9).
- **`agent_native_ledger_rows` (D1) — second carrier.** id, sessionId, action, amount, currency, customer, gateway, gatewayRef, status, checkoutUrl, proposerDid, proofSignature, note, tenantId, family, runRequestId, createdAtMs, updatedAtMs. Same three columns are added here: it is the other per-charge D1 record, joinable to the journal on runRequestId.
- **`mas_transactions` (DO, shared-table DDL in `src/data/ormSchema.ts`) — NOT touched.** id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at. It carries **no family and no product/version** — and neither does the journal's family come from it: family already lives only on the journal + native ledger rows, from the mapping input at the call site. Product/version/price follow that established pattern; the DO ledger stays amount-only.
- **`agent_credit_claims` (`CreditClaimRecord`) — reversal ties to its charge.** creditRunId, userId, family, amountUSD, createdAtMs. Gains productId, versionId, priceUSD (the price of the charge it reverses) so a failure credit is attributable to the same product/version/price as the charge.
- **`agent_paid_submissions` (`PaidSubmissionRecord`) — ownership only.** workflowId, userId, runRequestId, createdAtMs. No price, no product. Leave it.
- **Gate's in-memory record is ephemeral, not the record.** The gate's `byRun` map already carries `priceUSD` per run (`src/services/nativeMonetization.ts`), but that state is in-memory and lost on restart. The durable per-charge record is the journal posting in the payment workflow's confirm path; that is where version + price must be threaded (§3.9).
- **Name-collision check:** `agent_referral_rules` already exists (referral-credit ledger #2208, `src/data/drizzleSchema.ts`). The new table in §3.5 stays named `agent_referral_code_rules` — distinct, no collision.

## §3 — Data model (a)

**Recommended shape: products are identity; versions are immutable terms snapshots; plans ARE versions; catalogue rows ARE versions.** No new purchaseable-unit table is introduced alongside plans — that would be a duplicate implementation. One product-version mechanism serves both subscription products and per-run products.

### 3.1 New table: `agent_products` (migration 0058)

| Column | Type | Notes |
|---|---|---|
| id | text PK | Server-generated (`prod_` + id or UUID — follow the existing plan-id generation; never client-supplied). |
| name | text | Display name. Unique per kind (enforce in the adapter; backfill creates one per distinct existing plan name). |
| kind | text | `"subscription"` \| `"per_run"`. |
| description | text, nullable | Operator-entered. |
| createdAtMs / updatedAtMs | integer | Epoch ms. |

**Seed (migration 0058, operator data — never code constants):** the four per-run products (`stock`, `goal`, `options`, `strategy`, kind `per_run`, names matching the catalogue families); subscription products are **backfilled dynamically**: for each distinct name in `agent_subscription_plans`, create a product with that name (covers Basic/Premium and any operator-created plan, whatever the live store holds). A `Free` product row (kind `subscription`, no versions — see §3.4) is seeded as the read-only baseline.

### 3.2 `agent_subscription_plans` gains version columns (migration 0058)

New columns on the existing table (no new table; the plan row *is* the version):

| Column | Notes |
|---|---|
| productId | text — the product this version belongs to. Backfill: the product created from the plan's name (§3.1). |
| segment | text — the market/customer segment this version is sellable to (§3.4). Backfill: `"default"` for every existing row. A version belongs to exactly one segment; concurrent versions of one product are versions in *different* segments (§4.1). |
| version | integer — per-product **per-segment** sequence starting at 1, assigned server-side on creation, never reused, never client-supplied. |
| effectiveFromMs | integer — launch instant (epoch ms). Backfill: migration time (the row is already live, so it must be effective). |
| effectiveToMs | integer, nullable — explicit end instant; null = open-ended. Set only when the operator explicitly ends a version. **No automatic chain-close on create** (see §4.1 — this keeps D1 writes single-statement per ADR 0002). |
| billingPeriod | text — `"monthly"` \| `"annual"` (from `billingPolicyPorts.ts`). Backfill: derived from `periodDays` (365 → annual, else monthly). |
| featuresJson | text, nullable — JSON array of operator-entered feature strings, **display-only in v1** (does not gate behavior; see Q11). |
| stripePriceId | text, nullable — the Stripe Price object for this version (see §4.6). |

Existing columns keep their meaning; `approvalStatus`/`approvedBy`/`approvedAtMs` become **per-version** automatically (they already live on the row). A new version is created PROPOSED and must be approved before it can be sold (§4.3).

### 3.3 `agent_price_catalogue` gains version columns (migration 0058)

Same treatment: `productId` (the per-run product for the family), `segment` (backfill `"default"`), `version` (per-product per-segment, from 1), `effectiveFromMs` (backfill: migration time), `effectiveToMs` (nullable). The row's existing `approvalStatus` becomes per-version. `setPrice`'s in-place semantics are **superseded**: the write path becomes "create a new version" (§5.2); the old route delegates to it so #2739's UI keeps working against the current version.

### 3.4 The customer's held version — no new field needed for subscribers

- **Subscribers:** the subscription row already holds `planId`. Under this model `planId` **is** the held version id. Nothing new is recorded; grandfathering falls out of the existing row (§4.2).
- **Free tier / pay-per-run customers:** no held version. The Free tier is implicit (no subscription row) and the per-run price is the catalogue version effective now (§4.2). The `Free` product row carries no versions and is never purchasable (nothing to buy); the UI shows it as a read-only baseline for comparison (see Q9).
- **Accounts:** no version field on the account row. The account's product/version state is derived: active subscription row → held version; otherwise Free. The account **does** gain one new field: `segment` (§3.4, segment model).

#### Segment model — explicit operator assignment (revised)

**How a segment is defined and assigned.** A segment is an operator-managed label on the account: a `segment` text column on `agent_commercial_accounts` (migration 0058), default `"default"`, set by a store operator in the Accounts admin UI (slice 2; the set-segment route is a slice-1 primitive, §5.2). A missing/null segment reads as `"default"`. Segment labels are free-form operator strings (`"default"`, `"enterprise-eu"`, `"smb-us"`, …) — there is no segment registry table, no approval for creating a segment label, and no validation against a fixed list; the operator invents the segments the business needs. The segment is the **only** input to per-segment version resolution besides product and time (§4.1). It affects nothing else in the gate: the grant, the free-run allowance, credits, and included runs are all segment-independent.

**Alternatives evaluated and rejected:**
- **Tenant-derived** — rejected: tenant is the isolation boundary, not a price. A tenant spans markets; there is no tenant table; pricing would be forced to follow org structure, and a per-tenant price would need a tenant entity that does not exist.
- **Plan-derived** — rejected: circular. The plan *is* the version; two versions of one product cannot be distinguished by the thing they are.
- **Region** — rejected as the *mechanism*: no region data exists on the account, login, or session, so region would need a new source of truth (IP geolocation is unreliable and a privacy surface). Region can be a segment *value* — the operator assigns segment `"eu"` using whatever knowledge they have — but it is not how segments are determined.
- **Explicit operator assignment (chosen)** — fits the codebase: operator-managed data like every other commercial dimension, auditable (segment changes are recorded, §4.8), works identically for subscribers and per-run customers, needs no new external source, and the move action can change either the segment or the held version.

**Backfill.** Every existing account row gets segment `"default"`; every existing plan/catalogue version gets segment `"default"`. Current behavior is preserved exactly: before any operator assigns a segment or creates a segment-scoped version, everyone resolves the `"default"` chain, which is the single chain the pre-revision design described.

### 3.5 Referral-code rules table (config only — §6.1)

`agent_referral_code_rules` (created in slice 2, §8; config data only, no issuance/redemption logic):

| Column | Notes |
|---|---|
| id / productId | Rule belongs to a **product**, not a version (it must survive version changes; see Q6). |
| issuer | `"platform_admin"` \| `"tenant_admin"` — who may issue codes under this rule. |
| runsPerCode | integer — free runs a code confers. |
| reusable | boolean — one-time vs reusable. |
| expiryDays | integer, nullable — code lifetime; null = no expiry. |
| attribution | text — how the runs are attributed (enum to be fixed by the #3307 slice from Mars's list; the config UI offers the options, the mechanics interpret them). |
| maxRedemptionsPerCode / maxRedemptionsPerLogin / globalCap | integers, nullable — abuse limits. |
| active / createdAtMs / updatedAtMs | Standard. |

### 3.6 Free-access grants table (placement note only — NOT built in #3289; §6.2)

`agent_free_access_grants`: login, kind (`"lifetime"` \| `"limited"`), grantedBy, grantedAtMs, expiresAtMs (nullable), revokedAtMs (nullable), reason. Defined here so the #3247 slice builds exactly this; **no migration for it in #3289**.

### 3.7 Ports (ADR 0002, port-first)

- **New** `src/data/productPorts.ts`: `ProductRecord`, `ProductVersionRecord` (the shared version shape), `ProductStore` (createProduct, getProduct, listProducts, createVersion, getVersion, listVersions(productId), `resolveEffectiveVersion(productId, segment, nowMs)`). The resolver is a **pure function over the version list** (max `effectiveFromMs` ≤ now among active, unexpired versions **in the given segment**) so it is unit-testable without D1. Its signature is `resolveEffectiveVersion(versions, segment, nowMs)` — segment is a required input, never defaulted inside the resolver (callers pass the account's segment, `"default"` when unset).
- **Extend, don't duplicate:** `subscriptionPorts.ts` / `priceCataloguePorts.ts` records gain the §3.2/§3.3 fields (including `segment`); their stores gain `listVersions` / effective-version reads backed by the same resolver. The D1 + in-memory adapters gain the columns; the composition root wires the new product port alongside the existing ones.
- **New** `src/services/versionMoves.ts` (slice 1, §4.8): the move service — `moveSubscriptionToVersion` (per-customer) and the bulk-move job driver. It owns the move audit writes (§3.8) and the single-statement subscription `planId` update, following the precedent of `updateProviderBilling` (`src/data/subscriptionPorts.ts`, #2662 operator plan change on a Billing row, which already changes `planId` in one statement). The move extends that pattern from Billing rows to all subscription rows via a dedicated store operation — it does not invent a second plan-change mechanism.
- **Invariants enforced at the port/adapter, not the UI:** version numbers server-assigned per product **per segment**; `effectiveFromMs` unique per (product, segment) (unique index on `(productId, segment, effectiveFromMs)` on both tables — if Drizzle/D1 cannot express it, enforce in the adapter's create with a conflict error; see §11); a version's terms are immutable after creation (no update method — a correction is a new version; `active` and approval flags are the only mutable fields, as today). A version's segment is immutable after creation — a version for the wrong segment is deactivated and re-created in the right segment, never re-targeted.

### 3.8 Move audit tables (new, migration 0058, slice 1)

One row per customer moved — the audit that answers "what happened to customer X" — plus one summary row per bulk move.

**`agent_version_moves`** (one row per customer per move):

| Column | Notes |
|---|---|
| id | text PK, server-generated. |
| bulkMoveId | text, nullable — the bulk move this row belongs to; null for a per-customer move. |
| userId | text — the moved customer (login). |
| productId | text — the product. |
| fromVersionId | text, nullable — the held version before the move; null when the customer held no version (segment-change move, §4.8). |
| toVersionId | text — the version after the move. |
| segment | text — the customer's segment at move time. |
| movedBy | text — the operator login that performed the move. |
| reason | text, nullable — operator-entered reason. |
| movedAtMs | integer. |

Uniqueness: `(bulkMoveId, userId)` unique where bulkMoveId is not null — the idempotency backstop for the bulk job (a retry never moves the same customer twice in one bulk move; the job also checks the subscription's current `planId` before moving).

**`agent_bulk_moves`** (one summary row per bulk move):

| Column | Notes |
|---|---|
| id | text PK, server-generated. |
| productId | text. |
| segmentScope | text, nullable — the segment the bulk move was scoped to; null = all segments ("all customers on this product"). |
| targetVersionIdsJson | text — the per-segment target version ids resolved at job start (one per segment in scope). |
| movedBy / reason | text — operator login, operator-entered reason. |
| status | text — `"running"` \| `"complete"` \| `"complete_with_failures"`. |
| movedCount / skippedCount / failedCount | integers — moved = planId changed; skipped = already on the target version (or no subscription row); failed = per-customer error, recorded in the job result, never fatal to the job. |
| startedAtMs / finishedAtMs | integers, finished nullable while running. |

### 3.9 Per-charge recording (new, migration 0058, slice 1)

Every per-run money event records product, version, and price (Q1, §2.1). Three columns are added to the D1 charge records — **nullable in DDL** (legacy rows predate versioning) but **required by the mapping layer for new per-run events** (the assert refuses a new charge/failure-credit/redemption/subscription-purchase mapping without them, fail-closed, same as the existing family assert):

- `agent_journal_entries`: `productId` text, `versionId` text, `priceUSD` real — via `JournalMappingInput` + `JournalEntryInput` (`src/data/journalPorts.ts`): `mapChargeToJournalEntries`, `mapFailureCreditToJournalEntries`, `mapRedemptionToJournalEntries`, `mapSubscriptionPurchaseToJournalEntries` carry them onto the entry rows. A failure credit carries the same product/version/price as the charge it reverses; a redemption carries the redeemed run's.
- `agent_native_ledger_rows`: `productId` text, `versionId` text, `priceUSD` real — same three columns, same migration, joinable to the journal on `runRequestId`.
- `agent_credit_claims` (`CreditClaimRecord`): `productId`, `versionId`, `priceUSD` — the price of the charge the claim reverses.
- `mas_transactions` (DO): **unchanged** — no columns added (§2.1).
- `agent_paid_submissions`: **unchanged** — ownership only (§2.1).

**Threading.** The gate resolves the version effective for the customer's segment at charge time (`priceFor(family, segment)`, §4.2) and the payment workflow's confirm path threads the resolved `productId` + `versionId` + `priceUSD` into the journal/ledger mapping inputs. The gate's in-memory `byRun` record already carries `priceUSD`; it gains `productId` + `versionId` so the confirm path reads all three from one place. The segment reaches the gate through the account: `toCommercialAccount` (`src/data/commercialPorts.ts`) maps the account row's `segment` onto the gate's account shape, and `NativeCheckInput.account` carries it — no caller supplies a segment (client-supplied segment is never trusted; it always derives from the verified account row).

## §4 — Version-resolution rule (b)

### 4.1 Effective-version resolution (the one rule) — revised: (product, segment, time)

For a product, a segment, at time `nowMs`, the effective version is:

> Among the product's versions with `segment = <the customer's segment>`, `active = true`, `effectiveFromMs <= nowMs`, and (`effectiveToMs IS NULL` OR `nowMs < effectiveToMs`), pick the one with the greatest `effectiveFromMs`. (The `(productId, segment, effectiveFromMs)` unique index makes ties impossible.)

The chain model is gone: **two versions of one product are sellable at once when they are in different segments** — each segment has its own chain, resolved independently. Within one segment the rule is still a chain (one effective version per segment at a time). A version in a segment nobody is assigned to is simply never resolved — it waits until the operator assigns customers to that segment or moves them onto it.

No chain-close write is needed when creating a version: overlap *within* a segment is harmless because the resolver is total and deterministic regardless of overlap. `effectiveToMs` is an operator's explicit end, not bookkeeping. A version with `effectiveFromMs` in the future is a **scheduled launch**; it becomes effective for its segment with no deploy and no further action.

**What "effective" does NOT do (Mars ~06:40).** A new version becoming effective moves **no one**. It only becomes *available*: new customers in that segment buy it, plan changes in that segment buy it, and the move actions (§4.8) can target it. Existing holders stay on their held version/price until moved. The effective date is a launch date, not a repricing date.

### 4.2 Who holds what

- **New subscription purchase:** resolve the product's effective version **for the buyer's segment** at purchase time; that version's id becomes the subscription's `planId`. If no version is effective for that segment (none exists, none yet launched, or the only one is deactivated/expired) the purchase **fails closed** — never fall back to a future version, never sell an expired version, never sell another segment's version.
- **Existing subscriber (grandfathering):** the subscription row's `planId` is the held version. Renewal/repurchase stacks from the latest periodEnd **on the same planId, at the same price** — the held version's terms never change under the holder. The gate and the account read price/terms from the held version, never from the product's current version. A new version of the product, in any segment, changes nothing for the holder until the holder is **moved** (§4.8). This is the decided rule, implemented as data, not as a special case.
- **Plan change:** the new subscription is created on the **target product's current effective version for the customer's segment, at its current price**; the old row is superseded per the existing #2145 plan-change mechanics (not redesigned here). "A plan change pays the new plan's current price" — exact. A plan change is the *customer's* path onto a new version; the operator's path is the move (§4.8).
- **Trial:** `trialDays` lives on the version; a trial starts on the version effective **for the triallist's segment** at trial start and holds it (subscription row `planId`) for the trial's life; included runs come from that version.
- **Per-run (pay-per-run) — revised (Q1, Mars ~06:37).** Per-run is a product like any other. The gate's `priceFor(family, segment)` resolves the **catalogue version effective now for that customer's segment**, then applies the approval check (§4.3). There is **no per-customer held per-run version for pricing** — a per-run customer holds no version, so each charge is priced at the version effective for their segment at charge time. But **every charge is pinned**: the charge record carries `productId` + `versionId` + `priceUSD` (§3.9), so the business can track who used what product at what price. The distinction is deliberate: *pricing* is charge-time resolution (a one-off purchase has no price to grandfather), *recording* is per-charge and permanent. A segment change is the per-run customer's move — it changes which version's price applies to their future charges (§4.8).

### 4.3 Approval is per version, and independent of the effective date

A version is sellable/chargeable only when **both** hold: it is the effective version **for the customer's segment** (§4.1) **and** `approvalStatus = "approved"` (#2547 discipline, per version). Approved-but-not-yet-effective → not sold. Effective-but-not-approved → not sold; the gate fails closed and checkout refuses, exactly as today. Approval is per version, not per segment — a version approved in one segment is approved wherever it is the effective version (a version belongs to exactly one segment, so this is the same statement). Creating a version lands PROPOSED; approval is the existing approve action, extended to address a version id (§5.2). **This slice approves no price** (hard constraint): every version it seeds or backfills carries the approval state its source row already had — backfilled plan/catalogue rows keep their current status; newly created versions are PROPOSED until an admin approves them through the existing approval path.

### 4.4 How a price change takes effect (price flexibility, §0.1)

A price change is **never an in-place edit of a live price**. The operator creates a new version of the product (new price, same or changed period/included runs/trial days/features) with an effective date — now for immediate effect, or a future date for a scheduled launch — **in the segment it is for**. From the effective instant, that version is *available* in its segment: new purchases and plan changes in that segment use it at the new price. **Existing holders are untouched by the launch itself** (Mars ~06:40): a customer pays the new price only when moved onto it (§4.8). Any price is allowed: the UI accepts any numeric price (no constants, no hardcoded range); the only gates are approval (§4.3) and the effective date. This is the mechanism that implements "price can be anything... and it can change."

### 4.5 Annual versions (#3357 interface)

A version carries `billingPeriod` (`monthly` | `annual`) and `periodDays` (365 for annual). At version creation the UI **suggests** the annual price as `monthly × 12 × (1 − annualDiscountPct)` using the billing policy's `annualDiscountPct` (PROPOSED seed 15, operator-configurable, never hardcoded) — the operator may accept it or type any other price. The $509.90/$611.90 figures are that suggestion for the approved monthly prices, not approved amounts. #3357's build creates the annual versions and the checkout support on top of this mechanism; #3289 only makes it possible (see Q8).

### 4.6 Stripe mapping

Each plan version maps to its own Stripe Price object (`stripePriceId` on the version, §3.2) — this matches Stripe's own model (a new Price per version). Creating the Stripe Price is an operator step outside this slice (see Q7); the Products UI records the id per version, and the Billing purchase path must resolve the effective version's `stripePriceId` **for the buyer's segment** at purchase time. The Billing route's subscription creation must set `planId` to the effective version's id (build-time check, §11) so Billing subscribers also hold a version. The included-run bypass stays OFF.

### 4.7 In-flight subscriptions at a version change — revised: the launch changes nothing; the move changes the terms

Nothing changes for the holder when a version launches: the held version is immutable, renewal stacks on it, and deactivating or ending a version blocks only **new** purchases — holders ride to period end or plan change. What changes a holder's terms is the **move** (§4.8), and only the move:

- **Current paid period:** runs to its period end on the old terms. No retroactive charge, no refund, no proration in this slice — proration is a billing feature, not designed here; if Mars wants mid-period price adjustments, that is a separate design.
- **Included runs:** the account-row balance is untouched by a move. Runs already granted are the customer's property; a move neither grants the new version's included runs immediately nor claws back the old version's. The new version's included runs are granted at the **next renewal**, which stacks on the new version at the new price.
- **Credits:** untouched by a move. A credit balance is money, never repriced.
- **From the move instant:** credit-sufficiency checks (`creditsUSD >= price`) and new checkouts use the **new version's price**; the gate reads the held version for any price it needs. For a subscriber with included runs remaining, the move is invisible until the runs exhaust or renewal arrives — the move changes the terms that apply from the move instant; already-paid-for entitlements (the current period + granted runs) are honored.
- **Q4 — forced migration: SETTLED (Mars ~06:40).** Movement is explicit, never automatic on version launch. There is no forced migration as a side effect of anything. If a version must be killed for cause (e.g. mispriced), the operator moves its holders with the bulk move (§4.8) — that is the forced-migration mechanism, and it is an explicit operator action with an audit trail, not an automatic consequence.

### 4.8 The move mechanism (new) — per-customer move and bulk move

Two actions, both operator-initiated, both UX-enabled (UI actions in the admin, §5.1 — not API-only). The move is the **only** way an existing holder changes version; a version launch never moves anyone (§4.1).

**Per-customer move.** The operator picks one customer (in the Accounts panel, §5.1) and a target version of a product the customer holds (or a segment to assign them to). Two forms, one mechanism:
- **Move to version:** sets the customer's subscription `planId` to the target version id (single-statement update, §3.7). The target must be effective **and approved for the customer's segment** at move time, or the move refuses — never move a customer onto a version they could not have bought. Writes one `agent_version_moves` row (bulkMoveId null) with from/to version, segment, operator, reason, timestamp.
- **Move to segment (the per-run customer's move):** sets the account's `segment` (§3.4). No subscription row changes — the customer's future per-run charges resolve the new segment's effective version, and their next purchase buys it. Writes a move row with `fromVersionId` null (no held version) and the segment change recorded. A segment move and a version move can be combined in one action (set segment + set held version together) when the operator is moving a subscriber into a new segment's pricing.

**Bulk move — "move all customers to current pricing."** One operator action, product-scoped and segment-aware: it moves **every holder of a non-current version of the product** to **their own segment's current effective version**. Scope parameter: the operator picks the product and optionally narrows to one segment; the default scope is the whole product ("all customers on this product", all segments). The job resolves, per segment in scope, that segment's current effective version at job start, then moves each holder whose `planId` is not already that version. Per-run customers need no move — they always pay their segment's current price (§4.2) — so the bulk move's population is subscribers holding the product; segment assignment for per-run customers is a separate (per-customer) action, not part of the bulk job.

**How the bulk job runs.** A paged server-side job (`src/services/versionMoves.ts`, slice 2, §8): it pages the product's subscription holders, and for each holder either moves them (subscription `planId` update + one `agent_version_moves` row with the bulkMoveId) or skips them (already on the target version, or no subscription row). D1 has no multi-statement transaction through the port, so each customer move is atomic per customer; the job is resumable and reports counts. Idempotency: the `(bulkMoveId, userId)` unique constraint plus a check of the subscription's current `planId` before moving — a retry or re-run never moves the same customer twice in one bulk move. The job writes one `agent_bulk_moves` summary row (status, moved/skipped/failed counts, per-segment target versions, operator, reason, timestamps). A per-customer failure (e.g. the target version was deactivated mid-job) is recorded and counted, never fatal to the job; the operator re-runs the bulk move for the failures, or moves those customers individually.

**What a bulk move does to in-flight subscriptions, included runs, and credits.** Exactly what a per-customer move does (§4.7), applied to every holder in scope: current paid periods run to period end on old terms; included-runs balances untouched; credits untouched; from the move instant, credit checks and new checkouts use the new version's price; renewals stack on the new version. The bulk move is N per-customer moves executed as one action — no different semantics, only scale.

## §5 — Operator UI (c)

### 5.1 Placement and shape

- **New Platform Admin section "Products"**, tabId `products`, view `products` (`?tab=platform-admin&view=products`), placed after the Free Runs tab. Operator-only, same gating as Accounts/Free Runs. Icon: an icon string not already present in `nav-config.json` (e.g. `"Products"` — the build must verify the icon resolver maps it; see §11).
- **Product list:** one row per product — name, kind (subscription / per-run), current effective version **per segment** (number, price, period, included runs, approval status, effective from), and version count. Free appears as a read-only baseline row (no versions, never purchasable).
- **Per product, the version chains — one chain per segment:** expandable, grouped by segment — every version with number, segment, effective from/to, price, period, included runs, trial days, features (display list), approval status + approver + timestamp, active flag, Stripe Price id (subscription versions). The current effective version **for each segment** is marked; future (scheduled) versions are marked as launching on their date. A segment picker filters the chain view; the `"default"` segment is shown first.
- **Actions:** "New product" (name, kind, description); "New version" (form: price [any value], periodDays / billingPeriod, includedRuns, trialDays, features list, effective date = now or a future date-time, **segment** [default `"default"`], Stripe Price id for subscription versions); "Approve" (plan versions — first UI for the existing approve action); "Deactivate" (blocks new purchases only; holders unaffected, §4.7). Approval status of catalogue versions is shown read-only with a link to the payment-assurance tab, where #2739's approval UI lives — no second approval UI is built.
- **Bulk move (Products section, per product):** a "Move all to current pricing" action with a segment scope picker (default: all segments = all customers on this product) and a confirmation screen showing the count of affected holders per segment and the from → to version per segment, before anything moves. The action starts the bulk job (§4.8) and shows its progress + final counts (moved / skipped / failed) with a link to the per-customer move audit.
- **Per-customer move (Accounts panel, beside the unlimited-free grant section):** a "Move to version" action on an account — shows the customer's held version + price vs the target version + price, a segment picker (assigning a segment is the per-run customer's move), and a reason field. The move executes immediately with a confirmation showing the audit record.
- **Buyer-facing read discipline:** `GET /plans` returns **one row per product — the effective version for the caller's segment only** (server-side filter by the account's segment, never a client-supplied segment), so `CheckoutPanel` is unchanged and can never offer an expired or future version, or another segment's version. The admin chain is served by a separate admin route (§5.2). Version numbers are operator-facing; buyers see product name + price + terms, not "v2".

### 5.2 Routes (all operator-only, audited `commercial.product.*`, in `handleAgenticPaymentsRoutes` after the prices route — same pattern as the free-run-allowance pair)

| Route | Purpose |
|---|---|
| `GET /payments/agentic/commercial/products` | List products with their effective version (admin read; also the data source for the section). |
| `POST /payments/agentic/commercial/products` | Create a product. |
| `GET /payments/agentic/commercial/products/:productId/versions` | Full version chain for a product (admin only). |
| `POST /payments/agentic/commercial/products/:productId/versions` | Create a version (PROPOSED; server-assigned version number; validates price present, effective date well-formed, no duplicate `effectiveFromMs` for the product). |
| `POST /payments/agentic/commercial/products/:productId/versions/:versionId/approve` | Approve a plan version (existing approve action, extended to a version id). |
| `POST /payments/agentic/commercial/products/:productId/versions/:versionId/deactivate` | Deactivate a version (new purchases only). |
| `GET /payments/agentic/commercial/catalogue/versions?productId=` | Catalogue version chain per family (admin read; the write path is the next row). |
| `POST /payments/agentic/commercial/catalogue/versions` | Create a catalogue version (PROPOSED; supersedes in-place `setPrice` for versioned families — the old `setPrice` route delegates to it so #2739's UI keeps working). |
| `GET /payments/agentic/commercial/products/:productId/referral-rules` + `POST ...` | Referral-code rule config (§6.1; config only). |
| `POST /payments/agentic/commercial/subscriptions/:subscriptionId/move` | **Per-customer move (slice 1).** Operator-only, audited `commercial.product.move`. Body: `{versionId, reason?}` and/or `{segment}`. Validates the target version is effective + approved for the holder's segment; single-statement `planId` update + one `agent_version_moves` row. |
| `POST /payments/agentic/commercial/accounts/:userId/segment` | **Set segment (slice 1 primitive; UI in slice 2).** Operator-only, audited `commercial.account.segment.set`. Body: `{segment, reason?}`. The per-run customer's move. |
| `POST /payments/agentic/commercial/products/:productId/bulk-move` | **Bulk move (slice 2).** Operator-only, audited `commercial.product.bulk_move`. Body: `{segmentScope?: string \| null, reason}`. Starts the paged job (§4.8); returns the bulkMoveId. Target versions are resolved per segment at job start — the operator picks the product and scope, never a version. |
| `GET /payments/agentic/commercial/products/:productId/bulk-moves` + `GET .../bulk-moves/:bulkMoveId` | **Bulk-move status (slice 2).** Summary row + per-customer move rows for the job. |

`GET /plans` keeps its shape and gains the effective-only **per-segment** filter (§5.1). Every write validates server-side (never trust the client): price is a finite non-negative number, `periodDays` a positive integer, `trialDays` null or non-negative, effective date a valid epoch ms, `effectiveFromMs` unique per (product, segment), segment a non-empty string, move target effective + approved for the holder's segment.

## §6 — Where the neighboring decisions plug in

### 6.1 #3307 referral-code config (§0.2)

The config surface is a **"Referral codes" panel inside each product's view** in the Products section (not a separate top-level tab — the rules are per product). Fields, all UI-editable: issuer (platform admin / tenant admin), runs per code, one-time vs reusable, expiry (days or fixed date), attribution, abuse limits (max redemptions per code, per login, global cap). Stored in `agent_referral_code_rules` (§3.5), keyed by `productId` so the rules survive version changes. **Interface to the product model:** the #3307 mechanics will read rules by `productId` and confer runs denominated in that product's allowance terms; no issuance, redemption, code generation, or attribution logic is built or designed in #3289. The rules table + panel are config data and are separable: if slice 2 gets too big, they drop to the #3307 slice with only the placement + `productId` FK contract defined here (§8).

### 6.2 #3247 free-for-lifetime / free-for-a-limited-time (§0.3)

**Placement: Accounts, not Products.** These are per-account grants, not product versions, and they are **not built in #3289** — only placed and distinguished here; the build is the #3247 slice, on the `agent_free_access_grants` table (§3.6), with grant/revoke UI beside the unlimited-free grant section in `AccountAdminPanel.tsx`.

**The three free-access mechanisms are distinct — do not merge them:**

| Mechanism | What it confers | Time-box | Revocable | Home |
|---|---|---|---|---|
| #3245 unlimited-free grant (shipped) | Runs free at price 0, bounded by the approved-free per-service quota (#3263) | Optional `expiresAtMs` | Yes (set grant to null) | Account row (`unlimitedFreeGrant`) |
| #3243 trial (shipped) | Subscribed tier + the version's included runs | `trialDays`, then period end | Lapses automatically; not a grant | Subscription row (`planId` = trial version) |
| #3247 free-for-lifetime / free-for-limited-time (decided YES, unbuilt) | **Access free** — no subscription fee ever due for access; **any activity (runs) still requires payment/coverage** through the normal gate (free allowance → credits → 402) | Lifetime, or a limited window (`expiresAtMs`) | **Yes — "it can be taken off" (Mars 2026-11-11)** | `agent_free_access_grants` (new table, auditable grant/revoke history) |

The gate treats a #3247 grant as access-only: it never makes a run free (unlike #3245) and never confers tier or included runs (unlike #3243). What exactly the grant pins beyond the implicit Free tier (allowance? exemption from future access fees?) is **Q5** — the semantics need Mars's answer before the #3247 slice is designed.

### 6.3 #3246 upgrade offers (§0.4)

No offer design is produced here. What the product/version model must expose so the #3246 step can compare and price plans:

- Per plan/product, **for the customer in question**: the held version's price (their grandfathered price), the current effective version's price **for their segment** (what a new customer in that segment pays), included runs, period/billingPeriod, trial days, and effective dates.
- Served by: `GET /plans` (effective versions for the caller's segment — the "new customer" side, already exists), the admin version-chain read (§5.2), and a per-account held-version read (the subscription row's `planId` resolved to its version — the #3246 slice adds the read if it does not already exist; it is not added here).
- Whether that exposure is sufficient, or the offer design needs a dedicated compare endpoint, is deferred to #3246 (see Q10).

## §7 — File list (d)

**New files**
- `src/data/productPorts.ts` — ProductRecord, ProductVersionRecord, ProductStore, pure `resolveEffectiveVersion(productId, segment, nowMs)`.
- `src/data/d1ProductAdapter.ts` + in-memory counterpart (follow the existing adapter file naming; verify at build) — D1 + in-memory `ProductStore`.
- `src/data/createProductPorts.ts` (or the existing composition-root module — verify filename at build) — wiring.
- `src/services/versionMoves.ts` — move service: per-customer move + bulk-move job driver (§4.8, slice 1 service; bulk job route + UI in slice 2).
- `src/client/ProductsSection.tsx` — product list, per-segment version chains, new-product/version forms, referral panel, bulk-move action.
- `tests/productVersions.test.ts` — resolution rules (§9).
- `changelog.d/<slug>.md` — Policy Gate (d) fragment (`### ` first line + bullet; never edit CHANGELOG.md).

**Modified files**
- `src/data/migrationRunner.ts` — migration **0058** (§3.1–3.3 segment columns, §3.4 account `segment`, §3.8 move audit tables, §3.9 journal/ledger/claim columns, §3.5 referral table if it rides in slice 2).
- `src/data/subscriptionPorts.ts`, `src/data/priceCataloguePorts.ts` — version fields on the records (including `segment`); effective-version reads on the stores; subscription store gains the move operation (single-statement `planId` update, following the `updateProviderBilling` precedent).
- `src/data/commercialPorts.ts` — account record gains `segment`; `toCommercialAccount` maps it onto the gate's account shape; `CreditClaimRecord` gains productId/versionId/priceUSD.
- `src/data/journalPorts.ts` — `JournalMappingInput` + `JournalEntryInput` gain productId/versionId/priceUSD; the four per-run mappings carry them; the assert requires them for new per-run events.
- `src/data/d1SubscriptionAdapter.ts`, `src/data/d1PriceCatalogueAdapter.ts` (+ in-memory counterparts) — new columns.
- `src/data/drizzleSchema.ts` — `agent_journal_entries`, `agent_native_ledger_rows`, `agent_credit_claims` gain the three columns (mapping must agree with migration 0058 DDL; the existing mapping-vs-DDL pin test pattern applies).
- `src/data/d1JournalAdapter.ts`, `src/data/d1NativeLedgerAdapter.ts` (+ in-memory counterparts — verify filenames at build) — the three columns.
- `src/services/subscriptionActivation.ts`, `src/services/trialSubscriptionActivation.ts` — validate the version is effective + approved **for the buyer's segment** at purchase/trial start; record `planId` = version id (already the shape — validation is the change).
- `src/services/nativeMonetization.ts` — `priceFor(family, segment)` resolves the effective catalogue version for the segment, then the per-version approval check; the gate's `byRun` record gains productId + versionId so the confirm path threads all three into the journal/ledger mappings.
- `src/agents/routes/agenticPayments.ts` — §5.2 routes; `GET /plans` effective-only **per-segment** filter; `setPrice` delegates to catalogue-version creation.
- `src/client/PlatformAdminPage.tsx` — `products` tab in `PLATFORM_ADMIN_TABS` + TabPanel wiring.
- `src/client/AccountAdminPanel.tsx` — per-customer "Move to version" + segment picker beside the unlimited-free grant section (slice 2).
- `src/client/nav-config.json` — Products item (icon string unused elsewhere; verify the resolver maps it).
- `src/client/routes.ts` — verify at build whether the Products deep link (`?tab=platform-admin&view=products`) needs an entry (nav-config data is consumed here).
- `src/client/CheckoutPanel.tsx` — **verify only**: no change expected (effective-only `GET /plans` keeps its shape); change it only if the build finds a consumer that needs the version.
- `tests/left_nav_bar.test.tsx` — admin sub-items 17→18; distinct icons 16→17 (if the new icon is unused).
- `tests/thin_router_inventory.test.ts` — add the new routes in registration order; measure the new count (do not assume).
- Tests for the admin tab pin(s) — identify at build via grep for `PLATFORM_ADMIN_TABS` / `free-runs` in `tests/` (the #3315 lesson: update **every** pin file the new tab touches — left-nav, admin panel, admin page, nav-config-data, thin-router — and check icon sharing first).
- `tests/migration_registry.test.ts` — expect **zero** changes (canonical "latest" owner; a well-formed 0058 passes as-is).
- `docs/architecture/business/entitlements-01.md` — §8: product configuration UI now shipped (status + the resolution rule in one paragraph).
- `docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md` — §12.2 #3289 row status.
- `docs/architecture/business/platform-entity-capability-map.md` — add the Product entity (identity, versions, held-version derivation).

**Never touched:** `tests/actor-ports-conformance.test.ts` (if additive optional fields break it, escalate to the parent — do not edit it); no other lane's in-flight work; no flag, price, grant, or secret changes in production.

## §8 — Slice split (e)

**Recommendation: TWO sequential PRs, not one.** The slice spans a data model + gate price resolution + checkout filter + a full admin section + five pin files. One PR would be ~20+ files with the pin risk concentrated in the same change as the correctness-critical resolution rules. Two PRs keep each go/no-go judgeable. **Do NOT file sub-issues** — the split is recorded here and in the PR bodies.

- **Slice 1 — Data + resolution + the move primitive (no UI).** Migration 0058 (products table + version columns + `segment` on versions and accounts + move audit tables §3.8 + journal/ledger/claim recording columns §3.9 + backfills, all in `"default"`); ports + adapters; pure resolver + `resolveEffectiveVersion(productId, segment, nowMs)`; gate `priceFor(family, segment)` version resolution; per-charge recording threaded through the confirm path; activation validation (effective + approved for the buyer's segment); `GET /plans` effective-only per-segment filter; `setPrice` delegation; the move service (`versionMoves.ts`) + per-customer move route + set-segment route (primitives only, no UI); unit + migration-backfill + route tests. No admin tab, no bulk-move job, no UI. This is the load-bearing correctness piece and can land and be verified without the UI — and it must contain the move primitive, because "a new version moves no one" is only true if the move exists.
- **Slice 2 — Operator UI + bulk move + routes + pins + docs.** `ProductsSection.tsx` (per-segment chains, bulk-move action), per-customer move + segment picker in `AccountAdminPanel.tsx`, Platform Admin tab, nav-config item, all remaining §5.2 routes (bulk-move start + status), the bulk-move job driver wiring, the referral-rules table + panel (§6.1 — separable: if slice 2 grows too big, the referral config drops to the #3307 slice and slice 2 keeps only the placement + `productId` FK contract), all pin updates, changelog fragment, and the three doc updates (§7). Depends on slice 1.
- **Explicitly NOT in #3289:** the #3247 free-access grants build (own slice, own design step, on `agent_free_access_grants`); #3307 referral mechanics (own slice); #3246 offer design (own step after #3357); #3357 annual versions (own slice — #3289 only makes them possible); any price approval (no version created here is approved by this slice); any Stripe Price creation (operator step, Q7).

Each slice: one PR, claim comment first, draft until its own CI is green, then go/no-go discussion with Mars per the discussion rule, then ready + auto-merge via the queue.

## §9 — Verification plan (f)

- **Unit tests (`tests/productVersions.test.ts`, new):** effective-version picks max `effectiveFromMs` ≤ now **in the given segment**; future version not picked; expired (`effectiveToMs` passed) not picked; deactivated not picked; no effective version for the segment → fail-closed (purchase refuses; gate throws/402s as today); **two segments resolve different versions independently** (same product, same time, different effective versions); a version in another segment is never resolved for this segment; held version survives a newer effective version (grandfathering); renewal stacks on held version at held price; plan change buys the target's current effective version **for the customer's segment** at its current price; trial holds its start version; per-run resolution picks the effective catalogue version for the segment; effective-but-unapproved version fails closed in gate and checkout; duplicate `effectiveFromMs` for a (product, segment) is rejected.
- **Move tests (new, `tests/productVersionMoves.test.ts` or inside `productVersions.test.ts`):** **a new version moves no one** — launching a version (effective now) leaves every holder's `planId` and every per-run charge price unchanged; **a per-customer move assigns the new price from the move instant** — credit checks and new checkouts after the move use the new version's price, included-runs balance and credits unchanged, renewal after the move stacks on the new version; move onto an unapproved or not-yet-effective version refuses; move onto another segment's version refuses; segment change changes the next per-run charge's resolved version; **bulk move moves all holders in scope and none outside it** — holders in a non-scoped segment untouched, holders already on the target version skipped (not re-moved), per-run customers untouched; bulk-move audit has one row per moved customer plus the summary row with exact counts; a retry of a bulk move moves nobody twice.
- **Per-charge recording tests:** a paid per-run charge writes a journal entry carrying the resolved `productId` + `versionId` + `priceUSD`; the failure credit for that run carries the same three values; the native ledger row carries the same three; the credit claim carries the same three; a charge posted without product/version/price is refused by the mapping assert; legacy journal rows (nulls) still read.
- **Migration tests:** 0058 registers and applies on an empty store (seed products present; Free product with no versions); applies on a store with existing plan rows (each plan linked to a product created from its name, version 1, segment `"default"`, effective at migration time, approval status preserved); catalogue rows become v1 of their family products in `"default"`; existing account rows gain segment `"default"`; journal/ledger/claim columns exist and accept nulls for legacy rows. Registry "latest" pin passes with **zero** updates.
- **Route tests:** every §5.2 route — operator-only (non-operator 403), validation errors (bad price, bad date, duplicate effective date), approve/deactivate semantics (deactivate blocks new purchases only; holders unaffected).
- **Pins (the #3315 lesson — update ALL of them in the same PR as the tab):** `tests/left_nav_bar.test.tsx` (18 sub-items; 17 distinct icons if the new icon is unused — verify the icon is actually unused first, Agents-sharing rule); `tests/thin_router_inventory.test.ts` (entries in registration order; count measured, not assumed); the Platform Admin tab pin test(s) (identify by grep); `PLATFORM_ADMIN_TABS` + `PlatformAdminSectionId` union + nav-config-data.
- **Non-regression:** existing plans still purchasable (backfill); existing subscriptions keep terms; gate order unchanged (quota → allowance → grant → price → included → credits → 402) — price resolution is now per-segment but the order and the checks are identical; `CheckoutPanel` unchanged in behavior; conformance test untouched and passing; full local shard run green (only assertion failures are real — the ~15–21 `cloudflare:` load failures are pre-existing environmental noise).
- **Policy Gate local repro** against the single-parent commit matching the eventual PR head (never a merge commit); PR body with `Related OpenAIMP/cfagent#3289` (repo-qualified, never bare `#3289`), `## Agent #CBO-mlops`, `lane:cbo-mlops` + `auto-merge` labels, changelog fragment, `Process documentation impact:` line; **zero file deletions** (gate (i)).
- **§18 after merge:** landing SHA from the PR page (never assumed — the queue may rebase-land); CI "Test & Build (Node 22) [PROD]" + "Deploy NextGenTP" Success on that exact SHA, reporting honestly which runs are gate summaries vs full shards; then the completion note to #3289.

## §10 — Open questions for Mars (g)

Do not decide these in the build; the parent puts them to Mars.

**ANSWERED 2026-11-11 (folded into this revision):**
- **Q1 — Per-run grandfathering. ANSWERED ~06:37 EST.** Per-run is treated as a PRODUCT: every per-run charge records which product, version, and price applied (§3.9, §4.2). No per-customer held per-run version for pricing — the version effective for the customer's segment applies at charge time — but the charge itself is pinned to version + price at time of use.
- **Q3 — Concurrent versions. ANSWERED ~06:37 EST.** YES — multiple versions of one product can be sellable at once for different markets/customer segments. Chain model rejected; resolution is (product, segment, time) (§4.1); segments are explicit operator assignment (§3.4).
- **Q4 — Forced migration. ANSWERED ~06:40 EST.** Movement is explicit, never automatic on version launch. The bulk move (§4.8) is the forced-migration mechanism — an explicit operator action with an audit trail.
- **Scope note. ANSWERED ~06:40 EST.** First reading confirmed: gate policy/order unchanged, only the price-source lookup gains version resolution — PLUS a new version moves NO ONE by itself; a customer pays the new price only when moved onto it (§4.1, §4.8, §12).

**Still open:**
1. **Q2 — Version numbering.** Integer v1/v2/v3… per product per segment (recommended), or semantic/date-based? And is the version number admin-only (recommended) or buyer-visible?
2. **Q5 — Free-for-lifetime semantics (#3247).** What does it confer beyond the implicit Free tier — does it pin the 10-run allowance, exempt the account from any future access fee, or something else? And how does free-for-a-limited-time differ from a trial (#3243) in what the user gets (no tier? no included runs?)?
3. **Q6 — Referral rules scope (#3307).** Attach rules to the product (recommended — they survive version changes) or to a specific version? And who issues codes — platform admin only, or tenant admin too (does the selective-admin decision apply)?
4. **Q7 — Stripe Price creation.** Who creates the Stripe Price object for a new version and when — operator in the Stripe dashboard pasting the id in, or a route, and before or after approval?
5. **Q8 — Annual versions.** Are Basic/Premium annual versions created in #3289 slice 2 (with the $509.90/$611.90 derived figures as *suggested*, unapproved values) or only in the #3357 slice? (Recommended: only in #3357.)
6. **Q9 — Free as a product.** Should the Free tier be a product row (recommended, for a uniform compare/offer surface) or stay implicit with the UI rendering the baseline statically?
7. **Q10 — Offer data (#3246).** Is exposing held-version price vs current-effective-version price per plan (via the reads in §6.3) sufficient for the offer design, or will it need a dedicated compare endpoint?
8. **Q11 — "Features" per version.** What is a feature here — a free-text list (recommended for v1, display-only) or capability flags that gate behavior? If features must gate behavior, that is a larger design than this slice.
9. **Q12 — New-product launch approval.** Does launching a *new product* (not a new version) need any approval beyond the version approval (e.g. a product-level approval), or is version approval sufficient?

## §11 — Unverified items (h)

- The `PlatformAdminSectionId` union file (`platformAdminConfig.ts` per the brief) and the exact Platform Admin tab pin test filename(s) — not re-read; identify by grep at build.
- The nav-config icon-string → SVG resolver: which strings are valid, and whether `"Products"` (or the chosen string) resolves. The left-nav test checks strings are non-empty and counts distinct icons; the build must verify the chosen icon actually renders.
- The composition-root filename for the new product port wiring (the `create*Ports` module) and the in-memory adapter file naming — follow the existing pattern; verify at build. Same for the D1 + in-memory journal/native-ledger adapter filenames for the §3.9 columns.
- Exact approve-route names for catalogue versions (the plan approve action exists; the catalogue approval action's route name needs a re-read of `priceCataloguePorts.ts` / the approval route before wiring §5.2).
- Whether `GET /plans` has consumers besides `CheckoutPanel` that would see the effective-only per-segment filter — full grep at build.
- Whether the Billing purchase route's subscription creation sets `planId` (it must set the effective version's id, §4.6) — check at build.
- The live store's existing plan rows (names/ids) — not visible from the repo; the §3.1 dynamic backfill is designed so it does not matter, but the build should confirm the backfill against a staging snapshot if one exists.
- The thin-router `EXPECTED_INVENTORY` current count (283 was measured at #2298; it has grown since) — measure at build, never assume.
- The conformance test's sensitivity to additive optional fields on plan/catalogue records — run it; if it fails, escalate rather than editing it.
- #3357's exact issue scope vs this design's annual-version interface — re-read #3357 at the #3357 step.
- #2739's `PriceApprovalSection` exact current shape — cited from the survey summary; re-read before wiring the status link in slice 2.
- Bulk-move job execution detail: whether the runtime has an existing background-job pattern the paged job should reuse, or whether the job runs synchronously inside the bulk-move route with a row cap — decide at slice-2 build time; the design requires resumability + per-customer atomicity either way.

**Verified in the Revision (main `3e3a045d`) — no longer open:** `coverageForAccount()` (`paidScreenSubmission.ts`) does **not** call `priceFor` — it takes `priceUSD` as a parameter, so the segment-aware price must be resolved by the caller (the gate) before the coverage read. The single-statement `planId` update precedent exists (`updateProviderBilling`, #2662). `mas_transactions` carries no family column (verified DDL) — the journal-as-carrier pattern is established. The journal mapping entry points are `mapChargeToJournalEntries` / `mapFailureCreditToJournalEntries` / `mapSubscriptionPurchaseToJournalEntries` / `mapRedemptionToJournalEntries` (`src/data/journalPorts.ts`). No segment/market concept exists anywhere in the commercial domain — the segment model in §3.4 is new. `agent_referral_rules` already exists (#2208) — the new table stays `agent_referral_code_rules`.

## §12 — Hard-constraints compliance

- **One implementation of everything:** plans *are* versions; catalogue rows *are* versions; no parallel product table alongside plans; the resolver is one pure function used by gate, activation, and checkout; the approval action is extended, not duplicated; #2739's approval UI is linked, not rebuilt.
- **No hardcoded defaults:** every price, date, period, and rule is operator data; seeds live in migration 0058; the annual derivation is a UI suggestion computed from the configurable billing-policy discount.
- **Per-run prices stay PROPOSED:** no version created or backfilled by this slice is approved by it; approval remains the existing admin action.
- **No live charge, grant, or activation:** no Stripe call, no grant, no flag change; merging code is not activation.
- **Never modify `tests/actor-ports-conformance.test.ts`; never touch another lane's in-flight work.**
- **Scope note — "does not change the gate": CONFIRMED first reading (Mars ~06:40 EST).** #3289's body says the slice "does not change the gate or the monetization flag." Confirmed: **gate policy and order unchanged; only the price-source lookup gains version resolution** (same fail-closed approval check, same order, same 402 semantics) — PLUS the qualification that **a new price version moves NO ONE by itself**: a customer pays the new price only when moved onto it (§4.8). Existing holders stay grandfathered until moved; new customers buy the current effective version for their segment.
- **Do not claim anything built or live that is only filed:** this document is a design; nothing in it is built.

## §13 — Build deviations (slice 1, built 2026-11-11)

Recorded during the slice-1 build, not hidden. The design above stays as approved; this section is what actually landed.

1. **Catalogue PK rebuild** (§3.1): `agent_price_catalogue`'s PK was `family`, so versioning required the RENAME / CREATE / COPY / DROP rebuild with a surrogate `id` PK. Non-convergent window documented in the migration comment.
2. **Backfill effectiveFromMs = the row's own `createdAtMs` / `updatedAtMs`**, not migration time (portable-subset rule forbids dialect date functions).
3. **Catalogue price seeds stay in `ensurePriceCatalogueSchema`** (PROPOSED_SEED_PRICES), not in migration 0058 — the fail-closed empty-catalogue test needs a seed-free path; products seed IS in 0058.
4. **Duplicate plan names**: version = rank by (createdAtMs, id) per name-derived product, effectiveFromMs staggered by rank−1 ms.
5. **Deterministic ids**: per-run `prod-per-run-<family>`; Free `prod-free`; subscription `prod-sub-` + lowercase, spaces→hyphens; catalogue version `cat-<family>-<segment>-v<version>`.
6. **Store method is `getEffectiveVersion(productId, segment, nowMs)`**; the pure function is `resolveEffectiveVersion(versions, segment, nowMs)`.
7. **ProductStore owns products + move audit only**; version reads live on the subscription/catalogue stores.
8. **Activation validation split**: trial validates effective+approved for the buyer's segment; purchase activation validates approved+active only (NOT effective) so a version launched between checkout mint and purchase doesn't strand a paid checkout; effective+approved is enforced at checkout mint.
9. **`agent_version_moves.productId` and `.toVersionId` are NULLABLE** (design §3.8 showed them NOT NULL): a segment-only move by a customer holding no version has no product/version to record.
10. **Move write order**: planId update first, then audit row; audit failure throws (route 500) — state true, audit missing.
11. **Bulk-move job driver NOT in slice 1**; bulk tables still created in 0058; bulk store methods deferred to slice 2.
12. **0058 prerequisites are {0007, 0008, 0009, 0011, 0012, 0027}** — the design's {0007, 0008, 0011, 0027} was incomplete: 0058 also ALTERs `agent_journal_entries` (0009) and `agent_native_ledger_rows` (0012). All six ensure lists that include 0058 carry the full set. Found by a test failure (ensure threw "no such table: agent_journal_entries").
13. **`setPrice` delegates inside the catalogue adapter** (creates a new version); the POST /prices route is unchanged.
14. **GET /plans**: effective version per product for the caller's segment; approval NOT filtered.
15. **POST /plans**: creates a version of the name-derived product (route ensures the product row via `getOrCreateProduct`; adapter derives productId from name defensively, version = max+1, segment `"default"`, effectiveFromMs = now, billingPeriod from periodDays 365→annual else monthly). Monthly "Basic" and annual "Basic Annual" are DIFFERENT products by the name-derived rule (each with its own version chain); a monthly→annual change is a plan change (repurchase), not a version move.
16. **Journal assert**: requires productId/versionId for the four per-run mappings (charge, failure credit, redemption, subscription purchase); top-up mapping unchanged.
17. **Products seed timestamps**: per-run + Free rows use createdAtMs/updatedAtMs = 0 (no source row).
18. **`VersionLike.active` is OPTIONAL**: plan rows carry it, catalogue rows do not (a catalogue version's activation is its approval + effective window); the resolver treats only an explicit `false` as inactive.
19. **cfpay-era confirmations carry no product/version** (the draining cfpay gate never resolved one): the charge journal entry is skipped with a loud log (guarded, not thrown); the DO row stays authoritative. Same guard for failure-credit and redemption journal posts on pre-0058 claims.
20. **Same-start ties are ALLOWED — the design's "duplicate effectiveFromMs rejected" is superseded.** Two versions may share an effectiveFromMs (same-millisecond creation is a race, not a caller error); the resolver tiebreaks ties by greatest version. The (product, segment, effectiveFromMs) unique indexes were DROPPED from 0058 (only the (product, segment, version) indexes remain). Why: a first fix (bump a defaulted start to max+1ms) made a version created "effective now" effective 1ms in the future, which broke setPrice→approvePrice in the same millisecond — approvePrice approves the effective version, and the bumped version was not yet effective, so it approved the OLD version and the gate then threw "not approved". The tie rule keeps "effective now" exact and deterministic.
21. **Read-path family validation**: `getPrice`/`getEntry`/`getEffectiveEntry` return null for an invalid family (the old `getPrice("nope") → null` contract); the write path still validates. Found by the existing catalogue test.
22. **0058 prerequisite fix for the subscription ensure**: `ensureSubscriptionSchema` also needed 0009 + 0012 (same root cause as #12).
23. **Test updates required by the slice** (all in the PR): `price_catalogue_ports.test.ts` (empty adapters apply the full 0058 prerequisite set; invalid-row test writes a new-shape version row; parity test parses the 0058 CREATE block); `journal_ports.test.ts` + `journal_recognition_2155.test.ts` + `tenant_scope_1761.test.ts` (mapping inputs carry productId/versionId; journal parity test adds the 0058 ALTER columns); `monthly_annual_plans_3357.test.ts` (legacy-row test applies 0058 + prerequisites before the adapter read); `thin_router_inventory.test.ts` (+4 entries: the two path-param routes contribute an includes + an endsWith literal each; pinned total 420 → 424).
