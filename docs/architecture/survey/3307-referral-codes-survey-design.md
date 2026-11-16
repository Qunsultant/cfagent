# Design — #3307 Referral / invite codes

**Issue:** OpenAIMP/cfagent#3307 — `[Enhancement] Referral / invite codes — extra free runs on top of sign-up and grants`
**Status:** Design only. No build, no PR, no GitHub writes, no issue comments.
**Verified against:** main `d02e043a` (2026-11-13 ~06:08 EST, fetched fresh; the clone's HEAD is stale — every read below is scoped to `origin/main`).
**Author:** CBO-mlops (design subagent). **Parent judges; build starts only on parent direction.**
**Ordering:** #3247 builds FIRST, #3307 second. This design depends only on what exists on main plus what its own slices build. It reads no #3247 table, port, or route, and it must keep working if #3247 never lands.

## §0 — Inputs, settled decisions, and decisions-on-recommendation

### §0.1 Inputs

1. **Issue #3307** (open, labels `enhancement` + `lane:cbo-mlops`, sub-issue of #3241, filed 2026-11-05, untouched since; body re-read 2026-11-13). Requirement (owner-directed 2026-11-05): a code a user enters to get more free runs, in addition to sign-up (trial) and operator grants; it stacks. Open questions in the body: issuer/distribution, runs per code, one-time vs reusable, expiry, per-account limits, attribution reuse vs separate path, free-run-counter interaction, abuse limits + audit. The body's "no build in this issue … the build is separate slices" posture is SUPERSEDED (see §0.2, item 3): the build is slice PRs against this issue, on the #3246 pattern — no sub-issues (recommendation D13, §8).
2. **#3289 design** (`~/workspace/cbo-3289/design-3289.md`): §0.2 (rules UI-configurable per product), §3.5 (`agent_referral_code_rules` keyed by `productId`, config only; name-collision check vs `agent_referral_rules` passed), §6.1 (config surface: "Referral codes" panel inside each product's view in the Products section; rules survive version changes via the `productId` key; mechanics NOT designed there), §8 (the config table + panel were separable and DROPPED from #3289 slice 2). **Re-confirmed on fresh main: `agent_referral_code_rules` does not exist anywhere in `src/` or `tests/`** (`git grep` on `origin/main`, zero hits); no `ReferralCode` symbol exists either. The #3307 slice creates the table fresh — there is no migration conflict and no #3289 residue to reconcile. The placement contract is already referenced in code: `src/client/ProductsSection.tsx` header ("Referral-code rules are keyed by product id and land with #3307; this section carries only the placement note, no referral mechanics").
3. **#3246 design §3.8** (`~/workspace/cbo-3246/design-3246.md`): the upgrade-offer referral mention reads the existing `ReferralCreditPort` only; the #3307 config table is NOT read by offer derivation; mentions tolerate absence. **Boundary (carried):** deleting #3307 from the codebase must not break any offer code. This design adds no offer read and no offer change (§7).
4. **Standing lessons** (`~/AGENTS.md`): pins (counted values grepped across the whole `tests/` tree), the UX-token ratchet (never `#NNNN` in rendered JSX under `src/client`), the lint ratchet (dead `react-hooks` directives), Policy Gate checks (a)–(k), queue-first merge discipline, single-parent-head gate repro. All are applied in §8–§9.
5. **#3247 placement** (#3289 §6.2): free-access grants are access-only, never make a run free, never confer tier/runs. #3307 is the opposite shape: codes confer RUNS, never access, never tier. The two mechanisms share nothing but the word "free" — no shared table, no shared port, no shared UI section.

### §0.2 Settled decisions (do not relitigate)

1. **Mars, 2026-11-11: ALL rules configurable from the UI, per product** — issuer, runs, one-time vs reusable, expiry, attribution, abuse limits. Every rule in §2 is UI-editable; every default is externalized operator data (§2.4).
2. **Stacking (issue body, owner-directed):** codes grant EXTRA free runs ON TOP of sign-up (trial) and operator grants. The design preserves this honestly: code runs are a separate balance spent only after the Free allowance is exhausted (§4), never a replacement for the allowance, the grant, or the trial.
3. **Mars, 2026-11-13 ~06:06 EST: "get it done and open full PRs (not draft)"** — #3247 and #3307, PRs opened FULL (`draft:false`), not drafts. The #3246 go/no-go pattern applies (green CI → queue → merge, never over red/conflict); money/production activation stays human-gated (nothing here activates anything — codes confer runs, never money).
4. **Selective-admin decision (Mars, 2026-11-05):** unlimited-free grants and per-run price approvals are selective, by platform admin and/or tenant admin. The issuer model (§1.3, D2) honors it: a tenant admin issues only within their own tenant, server-enforced.
5. **Session-scoped always (Mars, 2026-10-29):** no branch uses a client-supplied tenantId for scoping. Redemption resolves the redeemer's tenant server-side from the verified session; issuance resolves the issuer's authority server-side. No code path trusts a client tenant claim.
6. **One implementation of everything; no invented prices or discounts.** Codes confer RUNS, never credits, never tier, never a price. No Stripe object, no journal money entry, no price-approval interaction (§7).

### §0.3 Decisions-on-recommendation

Mars did not answer the issue's open questions; per the 2026-11-13 directive they are answered here ON RECOMMENDATION, stated explicitly. Nothing below blocks on a question.

| # | Question | Decision-on-recommendation | § |
|---|---|---|---|
| D1 | Rules keyed by product or version? (Q6) | **productId.** Rules survive version changes; one rule set per product. Refinement D1b: the rule key is (`productId`, `issuer`), so invite terms and referral terms for one product can differ. | §2.1 |
| D2 | Issuer model | **Three issuers:** `platform_admin` (store operator, existing `isStoreOperator`), `tenant_admin` (tenant-admin binding in the code's tenant, server-enforced via the proven KV membership seam), `user` (self-service; issuer = session login). The rule's `issuer` field names who may issue under it. | §1.3, §3.2 |
| D3 | Code kinds: referral vs invite? | **One code record with a `kind` field** (`referral` \| `invite`). One redemption path, one balance, one audit shape. Kind changes only attribution (referral writes it, invite never does) and who may issue (users issue referral only). | §1.2 |
| D4 | Code format / generation | **Server-generated only** (no vanity/custom codes in v1): 16 Crockford base32 chars in 4×4 groups from 10 random bytes (80 bits, `crypto.getRandomValues`); **SHA-256 hash stored**, plaintext shown once at issuance; display prefix (first group) for operator listing; input normalized server-side (uppercase, dashes/spaces stripped). | §3.1 |
| D5 | Redemption semantics | **Idempotent replay for one-time codes** (re-redeem returns the existing redemption, never double-credits); caps (per-code, per-login, global) enforced at redemption via conditional increments — the count never exceeds the cap; expiry + revocation enforced; every redemption audited. Unknown/expired/revoked share one generic response; cap exhaustion gets its own. | §3.3 |
| D6 | Free-run-counter interaction | **Separate bucket, exempt from the counter.** Code runs live in their own per-login balance (mirroring runs-pack balances). The counter is the monthly Free allowance; code runs never increment it, and grant-covered runs never touch it either (existing). The gate spends the allowance FIRST, so code runs are honestly "on top". | §1.4, §4 |
| D7 | Gate step | **One additive step, after `subscription_included`, before `runs_pack`** (free-before-paid within the priced branches). `paidVia: "code_runs"`. Price resolution precedes coverage and throws fail-closed (NQ7 generalized). Port unbound → fall through; store error → logged, fall through. `consumeCoverage` no-ops. **No journal entry** (no money moved). | §4 |
| D8 | Attribution | **Reuse the #2657 ledger, never rebuild it.** Referral-kind redemption writes attribution through `ReferralCreditPort.recordAttribution` with `source: "code"` (the value reserved for exactly this; requires an additive optional `source` input, default `"operator"`). Set-once semantics inherited; an attribution conflict never fails a redemption (audit + proceed). The earn trigger is UNCHANGED. Invite codes write no attribution. Referral credit (USD) is never conflated with code runs or failure credits. | §3.4 |
| D9 | Distribution (v1) | **Operator/tenant-admin code list** in the per-product panel (issue, list, revoke) **+ user referral-code display** on the billing tab (self-service issuance mints a fresh code each time — plaintext is never stored, so re-display is impossible). **No invite links / magic-link auto-redeem in v1** — redemption is an authenticated POST of a pasted code. | §6 |
| D10 | Abuse-limit defaults | **UI-configurable per rule, externalized, seeded inactive.** Migration seeds one INACTIVE rule row per per-run product with PROPOSED defaults (5 runs, one-time, 30-day expiry, per-code cap 1, per-login cap 1, no global cap, attribution `ledger`). No rule row, or an inactive rule, means codes are disabled for that product (fail-closed). | §2.4 |
| D11 | Balance shape | **One per-login balance, family-agnostic** (mirrors `agent_runs_pack_balances`). The per-product rule governs ISSUANCE terms only; the balance is not partitioned per product (per-product balances would leave subscription-product codes unspendable and multiply the gate). No balance expiry in v1 (expiry lives on the code); no clawback on revoke. | §2.3 |
| D12 | Failed code-covered run | **No failure credit.** The flow's `issue-failure-credit` step is SKIPPED when `paidVia === "code_runs"` — a free run has no charge to reverse, and minting a USD claim would convert a grant into money. No balance re-credit in v1; the failure is recorded with an honest status. The existing $0-run edge (allowance/grant) stays untouched. | §4.4 |
| D13 | Slice shape | **No sub-issues.** One issue (#3307), two slice PRs, claim comments justifying the split (the #3246 pattern). The split is recorded here and in the PR bodies. | §8 |

## §1 — Model

### §1.1 What a code is

A code is a bearer token that, when redeemed by a verified login, credits a number of runs to that login's code-runs balance. A code is issued under exactly one rule (which fixes its terms at issuance: runs, expiry, caps, kind, issuer, tenant scope). A code is denominated in RUNS only. It has no price, no tier effect, no subscription effect, and no expiry effect on anything but itself.

**Stacking, stated precisely.** A user may simultaneously hold: a trial (Subscribed tier + included runs), an operator unlimited-free grant (bounded by the approved-free quota), Free allowance (monthly counter), code runs (this slice), runs-pack balance, and credits. The gate spends them in its fixed order (§4); each mechanism is untouched by the others. A code redemption never changes tier, `tierSource`, `includedRuns`, `creditsUSD`, the free-run counter, or any grant row.

### §1.2 Code kinds (D3)

| Kind | Issued by | `referrerUserId` | Attribution on redeem | Meaning |
|---|---|---|---|---|
| `referral` | user (self-service) or operator/tenant-admin on a user's behalf | the referring login (required) | YES — `recordAttribution`, `source: "code"` (§3.4) | "Someone referred you; here are runs." The referrer may later earn referral credit through the UNCHANGED #2657 trigger. |
| `invite` | operator / tenant-admin only | absent (must be null) | NO | "An operator invited you; here are runs." No referrer, no ledger write. |

One record, one redemption path. The kind is fixed at issuance and immutable.

### §1.3 Issuers (D2)

| Issuer value | Who | Server enforcement (existing seams only) | Tenant scope of issued codes |
|---|---|---|---|
| `platform_admin` | store operator | `isStoreOperator(login)` (`src/agents/routes/agenticPayments.ts`, env + store lists, #2680) | `null` — redeemable in any tenant |
| `tenant_admin` | tenant admin | KV membership read: `lookupInternalUserIdByLogin` (`src/security/iaaaMigration.ts`) → `createKvMembershipStore(sessionStore(ctx.env))` → `getMembershipsByUser` → new pure helper `isTenantAdminForTenant(memberships, tenantId, nowMs)` mirroring `isPlatformAdmin` (`src/security/iaaaAdminOverview.ts`: role `tenant-admin`, membership tenant match, not revoked, not expired). Unmapped login (no internal user id) → 403, the `platformUsers.ts` precedent. | the named tenant ONLY; redemption enforces the redeemer's resolved tenant equals it (§3.3) |
| `user` | any verified login | session login; issuer = caller; `kind` forced to `referral`, `referrerUserId` = caller | `null` — redeemable in any tenant |

Notes:

- The `tenant_admin` enforcement READS IAAA state; it writes none. IAAA writes stay CISO-owned. No new role system is introduced: the check reuses the one role model (`src/security/authorization.ts` catalog + `roleGrants.ts` semantics).
- A caller who is both a store operator and a tenant admin issues under whichever rule they name; the rule's `issuer` decides which check runs. No caller issues under a rule whose issuer check they fail.
- The #3289 §3.5 table named two issuers (`platform_admin` | `tenant_admin`). This design ADDS `user` — Mars's 2026-11-11 decision makes issuer configurable, and the issue's open questions name user-generated referral codes explicitly. The table was never built, so the extension costs nothing.

### §1.4 Balances and the free-run counter (D6, D11)

- **Code-runs balance:** one row per login (`agent_code_run_balances`, §2.3), `runsRemaining`, family-agnostic. Spent ONLY by the gate step in §4 (conditional decrement, applied-check) and credited ONLY by redemption (§3.3). No other writer. No expiry, no negative balance, no tenant column (mirrors `agent_runs_pack_balances` exactly).
- **Free-run counter:** untouched. Code-run spends never call `consumeFreeRun` and never increment `agent_free_run_counts`. The counter remains the monthly Free allowance, and only the allowance step reads it. Rationale: the counter is per (login, family, month) with a monthly reset; code runs are a persistent granted balance with code-level expiry. Merging them would corrupt the monthly allowance accounting, break the "at the limit" semantics (the offer triggers on real exhaustion), and make a code a way around the allowance cap "by another name" — the exact abuse the issue forbids. Separation keeps each mechanism auditable on its own terms.
- **Offer interaction:** none. The at-limit offer fires on real 402s and ambient state; a user with code runs remaining does not 402, so no offer fires — the gate is the single source of truth, and no offer-eligibility change is needed. The offer's referral mention (§3.8 of the #3246 design) keeps reading `ReferralCreditPort` only; it never reads code state.

### §1.5 What codes never do

- Never confer tier, `tierSource`, included runs, or credits.
- Never change a price, an approval, a flag, or a secret.
- Never write the journal (no money event), the native ledger, or a credit claim.
- Never write IAAA/membership state.
- Never read #3247 state. Never depend on #3247 landing.
- Never promise anything in UI copy beyond runs ("X free runs", never "free access", never a discount).

## §2 — Data model

ADR 0002, port-first: record types + port interfaces + pure helpers in `src/data/referralCodePorts.ts` (new); D1 + in-memory adapters; ONE composition root (`src/data/createReferralCodePorts.ts`). No SQL outside adapters. No store client in domain code. A structural test pins the import rule (the `lifecyclePorts.ts` pattern).

### §2.1 Rules table — `agent_referral_code_rules` (D1, D1b, D10)

One row per (`productId`, `issuer`). The rule is the ONLY source of issuance/redemption terms; there is no code-constant fallback. A missing row, or an inactive row, disables codes for that (product, issuer) entirely — issuance refuses, redemption refuses, the UI shows codes as unavailable.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | server-generated (`coderule-<uuid8>`, the `d1ProductAdapter` id idiom). |
| product_id | TEXT NOT NULL | FK by convention to `agent_products.id` (no enforced FK — the D1 discipline elsewhere). Rules survive version changes: versions are never keyed. |
| issuer | TEXT NOT NULL | `platform_admin` \| `tenant_admin` \| `user` (§1.3). |
| runs_per_code | INTEGER NOT NULL | positive integer. Runs one redemption credits. |
| reusable | INTEGER NOT NULL | 0 = one-time (a login redeems a given code at most once; replay returns the existing redemption), 1 = reusable (a login may redeem the same code repeatedly, subject to the per-login cap). |
| expiry_days | INTEGER NULL | code lifetime from issuance; null = no expiry. |
| attribution_mode | TEXT NOT NULL | `ledger` \| `none`. Governs referral-kind codes under this rule: `ledger` writes attribution (§3.4); `none` writes nothing even for referral codes. Invite codes never attribute regardless. (This finalizes the #3289 §3.5 `attribution` text field into an enum.) |
| max_redemptions_per_code | INTEGER NULL | null = uncapped. Enforced at redemption (§3.3). |
| max_redemptions_per_login | INTEGER NULL | null = uncapped. Per (code, login) count. |
| global_cap | INTEGER NULL | null = uncapped. Total redemptions across all codes under this rule. |
| active | INTEGER NOT NULL DEFAULT 0 | 0 = codes disabled under this rule. Seeds land inactive (§2.4). |
| created_at_ms / updated_at_ms | INTEGER NOT NULL | Standard. |

Unique index on (`product_id`, `issuer`). A `redemption_count` denormalized counter on the rule row backs the global cap's conditional increment (§3.3) — add column `redemption_count INTEGER NOT NULL DEFAULT 0`.

**Refinement vs #3289 §3.5 (stated, not silent):** the key gains `issuer` (D1b); `issuer` gains the `user` value (D2); `attribution` becomes the `attribution_mode` enum (D8); `active` defaults to 0 (D10). The #3289 table was never built, so these are design finalizations, not migrations of shipped shape.

### §2.2 Codes table — `agent_referral_codes`

One row per issued code. The code VALUE is never stored — only its SHA-256 hash (§3.1).

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | server-generated (`code-<uuid8>`). |
| code_hash | TEXT NOT NULL UNIQUE | hex SHA-256 of the normalized code value. The redemption lookup key. |
| display_prefix | TEXT NOT NULL | first group (4 chars) — operator listing + user display without revealing the full code. |
| rule_id | TEXT NOT NULL | the rule whose terms this code carries (snapshot: terms are copied onto the code row at issuance, §2.2 note). |
| product_id | TEXT NOT NULL | denormalized from the rule (audit + listing without a join). |
| kind | TEXT NOT NULL | `referral` \| `invite` (D3). Immutable. |
| issuer_login | TEXT NOT NULL | verified session login that issued the code. |
| issuer_kind | TEXT NOT NULL | `platform_admin` \| `tenant_admin` \| `user` — the check that authorized issuance. |
| referrer_user_id | TEXT NULL | required when `kind = referral`; must be null when `kind = invite`. |
| tenant_scope | TEXT NULL | null = any tenant; non-null = redeemable only by accounts in that tenant (§1.3, §3.3). Set ONLY by tenant-admin issuance (the tenant the caller admins); platform/user issuance always null. |
| runs | INTEGER NOT NULL | runs one redemption credits — snapshotted from the rule at issuance, so a later rule edit never reprices outstanding codes. |
| reusable | INTEGER NOT NULL | snapshotted from the rule at issuance. |
| expires_at_ms | INTEGER NULL | issuance time + `expiry_days`, or null. Snapshotted; a later rule edit never extends outstanding codes. |
| revoked_at_ms | INTEGER NULL | set by revoke; a revoked code never redeems. Revocation never claws back credited balances (D11). |
| redemption_count | INTEGER NOT NULL DEFAULT 0 | denormalized; backs the per-code cap's conditional increment. |
| created_at_ms | INTEGER NOT NULL | |

**Snapshot rule:** runs, reusability, and expiry are copied onto the code row at issuance. Rule edits affect only codes issued AFTER the edit. This is the version-immutability discipline (#3289) applied to codes: outstanding bearer tokens keep the terms they were issued under. Caps (`max_redemptions_per_code`, `max_redemptions_per_login`, `global_cap`) are read LIVE from the rule at redemption — caps are abuse controls, and an operator tightening a cap must affect outstanding codes immediately. (If the rule row is deleted — operators deactivate, never delete; no delete method exists — outstanding codes keep redeeming under their snapshots with caps read from the missing rule treated as uncapped? NO: a missing rule row fails closed — redemption refuses. Rules are deactivated, never deleted; the port has no delete.)

### §2.3 Redemptions + balances

**`agent_code_redemptions`** — one row per redemption (the audit + idempotency record):

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `red-<uuid8>`. |
| code_id | TEXT NOT NULL | the code redeemed. |
| redeemer_login | TEXT NOT NULL | verified session login. |
| redeemer_tenant_id | TEXT NOT NULL | resolved server-side at redemption (session/account). |
| product_id | TEXT NOT NULL | denormalized (audit without a join). |
| runs_granted | INTEGER NOT NULL | runs credited by this redemption (the code's snapshot). |
| attribution_written | INTEGER NOT NULL | 1 when this redemption wrote a `source: "code"` attribution row. |
| created_at_ms | INTEGER NOT NULL | |

Index on (`code_id`, `redeemer_login`) — the one-time replay lookup. Index on (`redeemer_login`, `created_at_ms`) — the user's redemption history read. (The per-login CAP is not enforced by counting these rows — count-then-insert races. It is enforced by the counter table below.)

**`agent_code_redemption_counts`** — one row per (code, login), the per-login cap's conditional-increment counter (the same shape as the code/rule counters):

| Column | Type | Notes |
|---|---|---|
| code_id | TEXT NOT NULL | part of the PK. |
| redeemer_login | TEXT NOT NULL | part of the PK. |
| redemption_count | INTEGER NOT NULL DEFAULT 0 | incremented only while `< maxRedemptionsPerLogin`. |
| updated_at_ms | INTEGER NOT NULL | |

PK on (`code_id`, `redeemer_login`). The row is created on first redemption by that login (upsert-with-conditional-increment, the `consumeFreeRun` upsert shape); the increment is the enforcement, the redemption rows remain the audit.

**`agent_code_run_balances`** — one row per login (D11):

| Column | Type | Notes |
|---|---|---|
| login | TEXT PK | |
| runs_remaining | INTEGER NOT NULL DEFAULT 0 | never negative; conditional decrement only. |
| updated_at_ms | INTEGER NOT NULL | |

Mirrors `agent_runs_pack_balances` (migration 0063) column-for-column in shape. No tenant, no product, no expiry.

### §2.4 Migration + seeds

- **One migration, next free number at build time.** Latest on main at design time is **0063** (runs packs); #3247 builds first and may claim 0064 — the build measures the registry, never assumes. Prerequisites: 0058 (`agent_products`, for the seed product ids). Five tables: rules, codes, redemptions, redemption counts, balances (§2.1–§2.3). The registry test (`tests/migration_registry.test.ts`) is the canonical "latest" owner — a well-formed migration passes with zero updates (§9).
- **Seeds (INSERT OR IGNORE, inactive):** one rule row per per-run product (`prod-per-run-stock`, `prod-per-run-goal`, `prod-per-run-options`, `prod-per-run-strategy` — the deterministic ids from `perRunProductId`, seeded by 0058) × issuer `platform_admin`, with PROPOSED defaults: `runs_per_code 5`, `reusable 0`, `expiry_days 30`, `attribution_mode "ledger"`, `max_redemptions_per_code 1`, `max_redemptions_per_login 1`, `global_cap NULL`, `active 0`. No seed rows for `tenant_admin` or `user` issuers — the operator creates those rules in the UI when the business wants them. Seeds are operator data: an operator edit survives re-ensure (INSERT OR IGNORE, the allowance/referral-rule discipline). The seed values are PROPOSED starting points, not owner decisions — the operator changes them in the UI before activating.
- **No seed codes, no seed balances.** Codes exist only by issuance; balances exist only by redemption.
- **Drizzle schema:** `src/data/drizzleSchema.ts` gains the five tables; mapping-vs-DDL agreement follows the existing pin-test pattern (the #3289 §3.9 discipline).

### §2.5 Ports

```ts
// src/data/referralCodePorts.ts (new) — types + interfaces + pure helpers only.
export type ReferralCodeIssuer = "platform_admin" | "tenant_admin" | "user";
export type ReferralCodeKind = "referral" | "invite";
export type ReferralCodeAttributionMode = "ledger" | "none";

export interface ReferralCodeRule { id; productId; issuer; runsPerCode; reusable; expiryDays: number | null; attributionMode; maxRedemptionsPerCode: number | null; maxRedemptionsPerLogin: number | null; globalCap: number | null; redemptionCount: number; active: boolean; createdAtMs; updatedAtMs; }
export interface ReferralCode { id; codeHash; displayPrefix; ruleId; productId; kind; issuerLogin; issuerKind; referrerUserId: string | null; tenantScope: string | null; runs; reusable; expiresAtMs: number | null; revokedAtMs: number | null; redemptionCount: number; createdAtMs; }
export interface CodeRedemption { id; codeId; redeemerLogin; redeemerTenantId; productId; runsGranted; attributionWritten: boolean; createdAtMs; }

export interface ReferralCodeRuleStore {
  getRule(productId: string, issuer: ReferralCodeIssuer): Promise<ReferralCodeRule | null>;
  listRules(productId: string): Promise<ReferralCodeRule[]>;   // the per-product panel read
  upsertRule(input: {...}): Promise<ReferralCodeRule>;          // operator-only at the route; validates via assert functions
}
export interface ReferralCodeStore {
  createCode(input: {...}): Promise<{ code: ReferralCode; plaintext: string }>; // plaintext returned ONCE, never stored
  getCodeByHash(codeHash: string): Promise<ReferralCode | null>;
  listCodes(productId: string): Promise<ReferralCode[]>;        // operator list (hashes never leave the server; rows carry displayPrefix only — see §5)
  revokeCode(codeId: string): Promise<ReferralCode | null>;     // sets revokedAtMs; idempotent
  incrementCapCounts(input: { codeId: string; redeemerLogin: string; ruleId: string;
    maxPerCode: number | null; maxPerLogin: number | null; globalCap: number | null; }): Promise<{ ok: true } | { ok: false; failed: "per_login" | "per_code" | "global" }>;
    // The three conditional increments, in order (login count, code count, global count).
    // Each is a single conditional UPDATE with an applied-check; a null cap skips that
    // increment. The FIRST failed increment stops the sequence; increments that already
    // landed stand (documented residual, §3.3 step 6 — caps err toward refusal).
}
export interface CodeRedemptionStore {
  findRedemption(codeId: string, redeemerLogin: string): Promise<CodeRedemption | null>; // one-time replay lookup
  recordRedemption(input: {...}): Promise<CodeRedemption>;
  countRedemptionsByLogin(codeId: string, login: string): Promise<number>;
  listRedemptionsForLogin(login: string): Promise<CodeRedemption[]>;
}
export interface CodeRunsBalancePort {                          // the gate's port (mirrors RunsPackBalancePort)
  getBalance(login: string): Promise<number>;
  addCodeRuns(login: string, runs: number): Promise<number>;
  consumeCodeRun(input: { login: string }): Promise<{ allowed: boolean; remaining: number }>; // single conditional UPDATE, runsRemaining > 0 + .returning(), the consumePackRun shape
}
```

Pure helpers in the port file (shared by both adapters so they cannot drift): `assertReferralCodeRuleInput`, `assertCodeRuns` (positive integer), `normalizeCodeValue` (uppercase, strip dashes/spaces, Crockford-alphabet validation), `hashCodeValue` (SHA-256 hex — WebCrypto, available in Workers; the in-memory adapter uses the same helper), `generateCodeValue` (10 random bytes → 16 Crockford chars in 4×4 groups), `isCodeExpired`, `isCodeRedeemable` (active rule + not revoked + not expired — pure over the rows).

Adapters: `src/data/d1ReferralCodeAdapter.ts` (Drizzle D1) + `src/data/inMemoryReferralCodeAdapter.ts`. Composition root `src/data/createReferralCodePorts.ts` (null when AGENT_DB unbound; callers keep their fail direction — §4/§5).

**Attribution extension (D8):** `ReferralCreditPort.recordAttribution` gains an additive optional input `source?: "operator" | "code"`, defaulting to `"operator"`. Both adapters stamp `input.source ?? "operator"`. The operator route passes nothing — its behavior is byte-identical. The redeem service passes `"code"` for referral-kind redemptions under a `ledger` rule. No other `ReferralCreditPort` method changes; no ledger table changes; no earning/vesting/redemption change.

## §3 — Mechanics

### §3.1 Generation (D4)

- Server-side only, at issuance. `generateCodeValue()`: 10 bytes from `crypto.getRandomValues` → 16 Crockford base32 characters (alphabet `0-9A-HJKMNP-TV-Z`, excluding `I`, `L`, `O`, `U` — no ambiguous glyphs), rendered as 4 groups of 4 joined by dashes (e.g. `7KQ2-9MXD-4P8R-2WJH`). 80 bits of entropy; guessing is infeasible, and no rate-limit bypass exists because redemption is an authenticated, audited POST (§5).
- The adapter stores ONLY `SHA-256(normalized value)` + the display prefix (first group). The plaintext is returned once in the issuance response and never persisted, never logged, never rendered again. An operator who loses a code revokes it and issues a new one.
- Uniqueness: the `code_hash` unique index + generation retry (bounded, 5 attempts, then a 500 — a collision at 80 bits is a store-corruption signal, not a retryable event).
- No vanity/custom codes in v1: operator-chosen values would be guessable, enumerable, and uneven-entropy. (Deferred, §7 — a vanity program needs its own abuse design.)
- Normalization at redemption: uppercase, strip dashes/spaces, reject any character outside the Crockford alphabet with the generic invalid response (D5). Case-insensitive, dash-optional input.

### §3.2 Issuance

One service, `issueReferralCode` (pure-terms + store writes; the route does auth + audit). Steps:

1. Load the rule for (`productId`, `issuer`). Missing or inactive → 409 `FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE` (new catalog code, §9). Issuance under a disabled rule is impossible.
2. Enforce the issuer check for the rule's `issuer` (§1.3). Failure → 403. For `tenant_admin`, the request names `tenantId`; the caller must hold tenant-admin in THAT tenant; the code's `tenantScope` is set to it. For `platform_admin`/`user`, any client-supplied tenant is ignored (scope null).
3. Validate kind: `user` issuance forces `kind: "referral"` with `referrerUserId` = caller. Operator/tenant-admin issuance accepts `kind` + optional `referrerUserId` (required iff referral, forbidden iff invite — 400 otherwise).
4. Snapshot terms from the rule (runs, reusable, `expiresAtMs` = now + `expiry_days`, or null). Generate the code value, hash, store the row. `count` param (1–50, operator/tenant-admin only): the service loops, returning the list of plaintext values once; one audit event per batch + one row per code. User self-service issuance ALWAYS mints a fresh code (revoking nothing): the plaintext is never stored, so a "get-or-create" that re-displays an existing code is impossible — the UI tells the user to copy it now. No "one active code per login+product" rule is enforced; a user may hold several codes, each independently redeemable under the rule's caps.
5. Audit `commercial.referral_code.issued` (rule, product, kind, issuer, tenant scope, display prefix — never the value or hash).

Revocation: operator/tenant-admin (same issuer check, tenant-scoped for tenant admins: a tenant admin revokes only codes scoped to their tenant) or the issuing user for their own codes. Sets `revokedAtMs`; idempotent; audited `commercial.referral_code.revoked`. No clawback (D11).

### §3.3 Redemption (D5)

Route: `POST /payments/agentic/commercial/referral-codes/redeem`, body `{ code: string }`. Verified session login only. Steps, in order, in ONE service (`redeemReferralCode`):

1. **Normalize + hash** the submitted value. Lookup by hash. No row → generic failure (step 7).
2. **Code validity:** revoked → generic failure. Expired (`expiresAtMs <= now`) → generic failure. (Expired and unknown share the response — an attacker guessing codes learns nothing redeemable.)
3. **Rule validity:** load the code's rule (by `ruleId`). Missing or inactive → generic failure. (Deactivating a rule instantly disables outstanding codes — the operator kill-switch.)
4. **Tenant scope:** if `code.tenantScope` is non-null, resolve the redeemer's tenant server-side (`resolvePlatformIdentity`, session only) and require equality → else 403 with the generic message. (A tenant-scoped code redeemed from another tenant fails exactly like an invalid code to the caller; the audit records the scope reason.)
5. **Self-redemption:** a referral code whose `referrerUserId` equals the redeemer → generic failure (no self-referral — the ledger's rule, applied here too). Audited distinctly.
6. **Replay / caps:**
   - One-time code (`reusable = 0`): if a redemption row exists for (`code_id`, redeemer) → return it (200, `replayed: true`, runs NOT credited again). This is the idempotency contract.
   - Caps, via `incrementCapCounts` — three conditional increments in order, each a single conditional UPDATE with an applied-check; the count never exceeds the cap:
     a. per-login: the (`code_id`, login) counter row iff `< maxRedemptionsPerLogin` (when non-null);
     b. per-code: the code row's `redemption_count` iff `< maxRedemptionsPerCode` (when non-null);
     c. global: the rule row's `redemption_count` iff `< globalCap` (when non-null).
     The FIRST failed increment stops the sequence → 409 `FAILURE_REFERRAL_CODE_CAP_EXCEEDED`, no further writes. Residual (documented, fail-closed): increments that succeeded before a later one failed stand as phantom counts — caps err toward refusal, never toward over-grant, and the counts are visible on the code/rule rows for operator reconcile. The in-memory adapter mirrors the same order.
   - Concurrent double-redeem of a one-time code: the per-code conditional increment (cap 1 in the seeded default) refuses the loser with 409 — no double credit. Sequential replay returns the existing row (200). Both are correct; only the status differs.
7. **Attribution (referral kind + rule `attribution_mode = "ledger"` only):** check-first — `getAttribution(redeemer)`; if attributed to a DIFFERENT referrer, skip the write, audit `commercial.referral_code.attribution_conflict`, proceed. If unattributed, `recordAttribution({referrer, referred, tenant, source: "code"})`; a concurrent-write conflict throws → catch, audit, proceed. If attributed to the SAME referrer, no-op. **An attribution outcome never fails a redemption** — the code's promise is runs; the ledger's set-once rule is authoritative for the link. (§3.4.)
8. **Credit:** insert the redemption row, then `addCodeRuns(login, code.runs)`. The balance credit is LAST — a failure before it leaves no redemption row and no credit; a failure AT it (after the row insert) leaves a redemption row with no credit, visible for operator reconcile (the pack `claim_stuck` discipline: audit `commercial.referral_code.credit_stuck`).
9. **Audit + respond:** `commercial.referral_code.redeemed` (code id, product, kind, redeemer, tenant, runs, attribution flag). Response: `{ runsGranted, balance, productId, replayed }`. The response never echoes the code value.

**Generic failure (steps 1–3, 5):** HTTP 400, catalog code `FAILURE_REFERRAL_CODE_INVALID`, business message "That code can't be redeemed. Check the code and try again." — no distinction between unknown/expired/revoked/self/disabled-rule in the response. The audit/log carries the specific reason (server-side only). Cap exhaustion (step 6) is the ONLY specific redemption failure surfaced: 409 `FAILURE_REFERRAL_CODE_CAP_EXCEEDED`, "That code has reached its redemption limit." (The redeemer already proved the code exists by redeeming it, so specificity leaks nothing.)

### §3.4 Attribution reuse (D8)

- The ONLY ledger interaction is `recordAttribution` with `source: "code"` (§2.5) + the pre-check `getAttribution`. No earning is written by #3307, no vesting is touched, no redemption of USD credit is touched.
- The referrer's earning follows the EXISTING trigger (`src/agents/routes/agenticPayments.ts`, #2657: on submit, flag ON, attribution present, tenant match → `recordFirstPaidRunEarning`, idempotent per referred user, best-effort). **The trigger is unchanged.** Inherited semantics, stated honestly: the trigger fires on the referred user's first flag-ON run and does not distinguish `paidVia` — a first run covered by code runs (or allowance) triggers the earn exactly as an operator-attributed user's first run does today. Whether "paid" should exclude free-covered runs is a #2657 question, not a #3307 decision; this slice does not re-decide it.
- Referral credit (USD, `agent_referral_earnings`) and code runs (runs, `agent_code_run_balances`) and failure credits (USD, `agent_credit_claims`) are three separate balances in three separate tables under three separate ports. No code path converts between them. The UI never renders them in one number.
- Invite codes: no attribution write, no ledger read, no referrer anywhere in the row.

### §3.5 Expiry and revocation

- Expiry is evaluated at redemption (`expiresAtMs <= now` → refuse). There is no sweep job in v1 — expired rows are inert (they refuse, they cost one indexed lookup). A retention sweep is deferred (§7), like the quota/counter retention sweep.
- Revocation is immediate and permanent (no un-revoke; issue a new code). Revocation never claws back credited balances or deletes redemption rows.

## §4 — Gate interaction (D7, D12)

### §4.1 The exact step

The gate order today (`src/services/nativeMonetization.ts`, `check()`, verified on `d02e043a`):

```
verified identity → already-paid → flag OFF → approved-free quota → free-run allowance
→ grant fall-through → PRICE RESOLUTION (throws fail-closed) → subscription_included
→ runs_pack → credits → 402 / skip
```

#3307 inserts ONE step. New order:

```
… → PRICE RESOLUTION → subscription_included → CODE_RUNS → runs_pack → credits → …
```

The step mirrors `readPackCoverage` line-for-line in discipline:

```ts
// NativeMonetizationGate config gains:
codeRunsBalance?: CodeRunsBalancePort | null;   // optional; absent = no code coverage, today's behavior

private async readCodeRunsCoverage(login: string): Promise<"code_runs" | null> {
  const port = this.config.codeRunsBalance ?? null;
  if (!port) return null;
  try {
    const consumed = await port.consumeCodeRun({ login });
    return consumed.allowed ? "code_runs" : null;
  } catch (err) {
    logAspectEvent({ aspect: "ReferralCode", operationName: "gate-code-runs-check",
      code: "FAILURE_CODE_RUNS_UNAVAILABLE", level: "warn",
      message: "Code-runs balance store read failed; falling through to packs/credits (fail-closed).",
      error: ..., metadata: { login } });
    return null;
  }
}
```

And the coverage chain becomes (the pack read must ALSO be skipped when code runs covered — never spend two balances for one run):

```ts
const hasIncludedRuns = account.tier === "Subscribed" && account.includedRunsRemaining > 0;
const codeCovered = !hasIncludedRuns && (await this.readCodeRunsCoverage(account.userId)) !== null;
const packCovered = !hasIncludedRuns && !codeCovered && (await this.readPackCoverage(account.userId)) !== null;
const coverage = hasIncludedRuns ? "subscription_included"
  : codeCovered ? "code_runs"
  : packCovered ? "runs_pack"
  : account.creditsUSD >= priceUSD ? "credits" : null;
```

- The `byRun` row and the paid outcome carry `priceUSD` (the resolved price), `paidVia: "code_runs"`, `productId`, `versionId` — the per-charge recording (#3289 §3.9) records WHICH priced version the run consumed, exactly like `runs_pack`. The price is the quote, not a charge: no money moved.
- **NQ7 generalized:** price resolution precedes the step and throws on a missing/unapproved family price BEFORE any code run is spent. A code never covers a run whose family price is not approved. (The price-0 branches — quota, allowance, grant — keep their existing exemption; code runs are a PRICED branch, like packs.)
- **Free-before-paid:** code runs (free grants) spend before runs packs (paid purchases) and before credits. Included runs (the subscription's own) still spend first — the subscription the user holds is consumed before any grant balance, the existing order's logic.
- **Scheduled runs:** a code-covered scheduled run is covered like any other coverage — no checkout, no skip. The coverage-required 402/skip branch is unchanged (it fires only when NO coverage exists).
- **No other gate change.** No new branch before price resolution, no change to quota/allowance/grant, no change to the checkout mint, no change to `priceFor`/`resolveChargePricing`.

### §4.2 Wiring

`src/workflows/paymentWorkflow.ts` — the ONLY production gate-construction site — wires the balance port best-effort, mirroring the runs-pack block verbatim in discipline: `createReferralCodeAdapters(env)` → `ensureReferralCodeSchema` → `codeRunsBalance`, with a loud `logAspectEvent` warn + null on failure. An unbound AGENT_DB or a schema failure leaves the gate exactly as today. **Console ceiling:** the #3515 ratchet pins `paymentWorkflow.ts` — the wiring block uses `logAspectEvent`, never `console.*` (the runs-pack block's own comment states the ceiling; the build re-checks it).

`consumeCoverage` (`paymentWorkflow.ts`) gains the `code_runs` no-op arm beside `runs_pack` — the run was spent at decision time; nothing more is consumed. (The quota/allowance arms are the same shape.)

### §4.3 No journal, no ledger, no claim

A code-covered run posts NO journal entry, NO native-ledger row, and NO credit claim. The redemption (audit + redemption row) is the complete record of the grant; the gate decision (byRun row + `payment.covered` audit, the existing covered-path audit) is the complete record of the spend. Posting a $0 journal entry would fabricate a money event; posting the resolved price would fabricate revenue. Neither happens.

### §4.4 Failed code-covered runs (D12)

`src/workflows/paymentWorkflowFlow.ts` calls `deps.issueFailureCredit(runRequestId, priceUSD, …)` unconditionally when the screener fails after a paid start — and `issueFailureCredit` (`paymentWorkflow.ts`) mints a USD-denominated credit claim + journal credit entry for any positive price. For a code-covered run, `priceUSD` is the resolved catalogue price (> 0): without a guard, a failed FREE run would mint a USD claim — converting a grant into money. **The flow gains a `paidVia` guard: when `paidVia === "code_runs"`, the `issue-failure-credit` step is SKIPPED** — no USD claim, no journal credit, no balance re-credit in v1. The flow returns an honest failure status distinct from `screener_failed_credit_issued` (recommended: `screener_failed_no_credit`; the build checks for status-string collisions and pins the choice in tests). The failure itself is still recorded and traced. The existing $0-run edge (allowance/grant-covered failures throwing inside `issueFailureCredit`) is NOT touched — it stays a carried open edge, owned elsewhere.

### §4.5 Gate tests (§9 details)

Order pins (code runs after included, before packs, before credits; never read when included covers; never read when the port is unbound; never spent when the price is unapproved — the throw precedes the read); fall-through pins (empty balance, unbound port, store error → packs/credits/402 exactly as today); `consumeCoverage` no-op pin; failure-credit skip pin (no claim row, no journal credit, honest status); byRun recording pin (`paidVia`, `productId`, `versionId`).

## §5 — Routes

All in `handleAgenticPaymentsRoutes` (`src/agents/routes/agenticPayments.ts`), after the runs-pack routes — the same file, the same `commercialLogin()` / `isStoreOperator` / `requireLifecycle` idioms, the same `ctx.audit("commercial.…", "payments", …)` convention. Route conditions are `path.endsWith(…)` + method checks, in registration order (§9 thin-router pin).

| # | Route | Method | Caller | Behavior / status codes |
|---|---|---|---|---|
| R1 | `/payments/agentic/commercial/referral-code-rules` | GET | store operator | `?productId=` → the product's rules (all issuers). 403 non-operator; 503 store unbound. |
| R2 | `/payments/agentic/commercial/referral-code-rules` | POST | store operator | Upsert one rule (body: productId, issuer, terms, active). Validates via the port asserts; 400 invalid; 403; 503. Audited `commercial.referral_code_rule.set`. (Tenant admins do NOT edit rules — rules are platform-wide operator data, like prices. Tenant admins issue under rules; they do not write them. This matches the selective-admin decision: price/rule data is platform operator data.) |
| R3 | `/payments/agentic/commercial/referral-codes/issue` | POST | per rule issuer (§1.3) | Body: productId, issuer, kind?, referrerUserId?, tenantId? (tenant-admin only), count? (1–50, operators only). Returns the plaintext code(s) ONCE. 400/403/409 (rule unavailable)/503. Audited `commercial.referral_code.issued`. |
| R4 | `/payments/agentic/commercial/referral-codes` | GET | store operator | `?productId=` → code rows WITHOUT hashes (id, displayPrefix, kind, issuer, tenant scope, runs, expiry, revoked, counts, created). Listing never returns a value or a hash. 403/503. |
| R5 | `/payments/agentic/commercial/referral-codes/revoke` | POST | issuer-authorized (§3.2) | Body: codeId. Idempotent. 403/404/503. Audited `commercial.referral_code.revoked`. |
| R6 | `/payments/agentic/commercial/referral-codes/redeem` | POST | any verified login | Body: `{ code }`. §3.3. 400 generic invalid / 403 tenant-scope / 409 cap / 503. Audited (redeemed + conflict + stuck variants). |
| R7 | `/payments/agentic/commercial/referral-codes/mine` | GET | any verified login | Own codes (display prefixes + terms + counts, no values/hashes) + own redemption history + own balance. Own-or-operator read (the `/referral/balance` precedent: `?userId=` self or operator). |
| R8 | `/payments/agentic/commercial/referral-codes/mine` | POST | any verified login | Self-service issuance: body `{ productId }` → mints a referral code under the product's `user`-issuer rule (403/409 when no active user rule). Returns the plaintext ONCE. Audited. |
| R9 | `/payments/agentic/commercial/referral-codes/mine/revoke` | POST | any verified login | Revoke own code. Body: codeId. 403 when the code is not the caller's. Audited. |
| R10 | `/payments/agentic/commercial/referral-codes/balance` | GET | own or operator | `{ runsRemaining }` for `?userId=`. The billing-tab read (mirrors `/referral/balance`). 401/403/503. |

**No new route file, no new router delegation.** Ten new inventory conditions (R1–R10 as separate `endsWith` blocks; R1/R2 and R7/R8 share a path but are separate conditions — the inventory counts conditions, §9). Counts are MEASURED at build, never assumed.

**Error-body discipline:** route errors return `{ error }` with the catalog `businessMessage` for user-facing failures (the existing commercial-route pattern); server-side detail goes to the log/audit only. Redemption failures never echo the submitted code.

## §6 — UI

### §6.1 Operator: per-product rules panel (in the Products section)

Inside `ProductDetail` in `src/client/ProductsSection.tsx` (1369 lines; the panel is a new component in the same file, or a sibling file imported by it — the build decides by the file's existing component structure; either way it renders INSIDE the product's view, never as a new tab). Fields, all UI-editable, per (product, issuer):

- Issuer selector (`platform_admin` / `tenant_admin` / `user`) — one rule form per issuer, or a tabbed/sectioned form; the build picks the shape that fits `ProductDetail`.
- Runs per code (positive integer), one-time vs reusable (toggle), expiry days (integer or "no expiry"), attribution mode (`ledger` / `none`, referral codes only — shown disabled with an explanation for invite-only reading), abuse limits (max per code, max per login, global cap — each integer or "uncapped"), active toggle.
- Save via R2; the panel reads via R1. Inactive rules render as "codes disabled" with the stored terms visible. No rule row renders as "no code program for this issuer" + a create form with the §2.4 PROPOSED starting values pre-filled (display-only initial values; the saved row is the only behavioral source).
- Copy rule: no `#NNNN` issue references in rendered text (token ratchet, §9). Refer to "issue 3307" without the hash if a reference is ever needed in copy — prefer no reference at all.

### §6.2 Operator: code management (in the Products section)

Beside the rules panel, per product:

- Issue form: kind selector, referrer login (referral kind only), tenant scope (tenant-admin issuance — the operator form shows the scope field only when issuing under a `tenant_admin` rule; store operators issuing under `platform_admin` rules get scope null), count (1–50). The issued plaintext codes render ONCE in a copyable list with a "copy now — codes are never shown again" notice. The list is never persisted client-side (no localStorage of code values).
- Code list (R4): display prefix, kind, issuer, tenant scope, runs, expiry, revoked state, redemption count. Revoke action per row (R5, with confirm). No code value is ever rendered here.
- The panel is operator-only by the route gating (403s render as the section's standard forbidden state); no client-side role check is an enforcement point.

### §6.3 User: redeem + balance + own referral code (billing tab)

In `src/client/BillingServicingPanel.tsx` (`?tab=billing` — the unconditional user servicing surface that already renders the referral-credit balance; the #3246 referral mention links here). A new `ReferralCodesSection` (sibling component file, following the `OfferRulesSection`/`TopUpLimitsSection` pattern):

- **Balance line:** "Code runs available: N" (R10), rendered beside — never merged with — the referral-credit balance. Distinct labels, distinct units (runs vs USD).
- **Redeem form:** one input + button (R6). Success: "N free runs added. You now have M code runs." Failure: the catalog business message verbatim. No code value is retained after submit.
- **My referral code:** when the product's `user`-issuer rule is active, a "Get my referral code" action (R8) rendering the fresh code once with copy + the rule's runs-per-code ("Anyone who redeems your code gets N free runs"). The user's existing codes list (R7: prefixes + counts + revoke). When no user rule is active for any product, this block renders nothing — no dead affordance.
- **Why the billing tab, not checkout, not a new tab:** redemption is servicing, not a purchase (checkout is the purchase surface; a code grants runs without payment, and putting it in checkout would imply a price). A new top-level tab would move five pin files (left-nav, admin panel, admin page, nav-config-data, thin-router) for a single form. The billing tab is already the user's money-adjacent home, already renders referral state, and is reachable without admin rights. The redeem surface is therefore one section in an existing panel: zero pin-file churn (§9).

### §6.4 What the UI never does

- Never renders a full code value except once, at issuance, in the issuing session.
- Never stores a code value client-side (no localStorage/sessionStorage).
- Never shows hashes, never shows another user's codes (R7/R8/R9 are own-or-operator; the operator list R4 shows prefixes only).
- Never promises codes in offer surfaces (the #3246 boundary, §0.1 item 3).

## §7 — Boundaries and deferrals

**In scope (this issue, these slices):** rules config + codes + redemption + attribution reuse + code-runs balance + the one gate step + the failure-credit guard + operator panel + billing-tab redeem + doc updates (§10).

**Explicitly OUT (not slices, separate decisions):**

- **#3247 mechanics** (free-access grants). No shared code. If #3247 lands first, #3307 still reads none of it.
- **Offer changes.** No offer-eligibility, payload, or mention change. The offer derivation never reads code state.
- **Invite links / magic-link auto-redeem.** Redemption is an authenticated POST. A clickable link that grants on open is a CSRF/abuse surface and needs its own design (signed links, single-use tokens).
- **Vanity / custom code values.** Server-generated only (D4).
- **Per-product / per-family balances.** One family-agnostic balance (D11). A per-family partition would need a second gate rule and leaves subscription-product codes unspendable.
- **Balance expiry, balance transfer, balance clawback.** No expiry on credited balances; no transfer between logins; revocation never claws back.
- **Failure-credit re-credit for code runs.** D12: no compensation in v1. (A "refund the code run on failure" behavior is a separate decision — it needs the failure-credit step to distinguish grant balances, which is the $0-edge family.)
- **The $0-run failure-credit edge** (allowance/grant failures throwing in `issueFailureCredit`). Untouched; carried open.
- **Earn-trigger changes.** The #2657 trigger is inherited verbatim (§3.4).
- **IAAA writes.** Reads only, via existing seams. No membership/role grant/revoke.
- **Journal / ledger / claim writes for code runs.** None, ever (§4.3).
- **Retention sweeps** (expired codes, old redemptions). Rows are inert; a sweep is a later slice, like the quota/counter sweep.
- **Referral-code mention in offers.** The #3246 mention reads `ReferralCreditPort` only; a future mention linking to the billing-tab redeem surface is a #3246-follow-up decision, not this slice's.
- **Any Stripe object, any price, any approval, any flag or secret change.** None.
- **Chat/NLQ paid path** (`TRADING_PAID_SERVICES`, F3). The code-runs step lives in the native gate only; the chat path's divergence is a #3241 conformance item, untouched.

## §8 — Slice split

**Recommendation: TWO sequential PRs, no sub-issues (D13).** The work spans a data model + ports/adapters + ten routes + a gate step + a failure-credit guard + two UI surfaces. One PR would be ~25 files with the correctness-critical redemption/gate rules in the same change as the UI. Two PRs keep each go/no-go judgeable. **Do NOT file sub-issues** — the split is recorded here and in the PR bodies, with a claim comment on #3307 before each slice naming the slice and branch (the #3246 pattern; the gitops one-PR sizing rule is addressed by the claim comment's justification, as #3289 slice 2 was).

- **Slice 1 — Server: rules + codes + redemption mechanics (no gate touch, no UI).** Migration (next free number; five tables + seeds, §2.4); ports + D1/in-memory adapters + composition root; `recordAttribution` source extension (§2.5); issue/revoke/redeem/balance services; routes R1–R10; outcome-catalog codes (§9); thin-router pins; unit + route + adapter tests; changelog fragment. Shippable alone: rules, issuance, redemption, and balances work end-to-end via routes (balances accrue; nothing spends them until slice 2 — the gate step is the only consumer, and its absence is the safe default). No gate file touched, no client file touched, no doc touched.
- **Slice 2 — Gate step + failure-credit guard + UI + docs.** The `code_runs` gate step + wiring (§4.1–4.2); `consumeCoverage` no-op; the `paymentWorkflowFlow.ts` failure-credit guard (§4.4); the Products-section rules panel + code management (§6.1–6.2); the billing-tab redeem section (§6.3); gate/flow tests; the entitlements-01.md updates (§10, including the conditional freshness-fold carry); changelog fragment. Depends on slice 1.

**Overflow rule:** if slice 2 grows past judgeable size during build (the UI surfaces are the risk), split the billing-tab redeem surface (§6.3) into a slice 3 — decided by the builder at build time, recorded in the slice-2 claim comment. Do not pre-split: the redeem surface is one section in an existing panel.

**Per-slice file list (slice 1):**

New: `src/data/referralCodePorts.ts`, `src/data/d1ReferralCodeAdapter.ts`, `src/data/inMemoryReferralCodeAdapter.ts`, `src/data/createReferralCodePorts.ts`, `src/services/referralCodes.ts` (issue/redeem services — the build may fold the services into the route file if the route file's existing service pattern says so; ONE service home, not both), `tests/referralCodes.test.ts`, `tests/referralCodeRoutes.test.ts`, `changelog.d/<slug>.md`.
Modified: `src/data/migrationRunner.ts` (migration + seeds), `src/data/drizzleSchema.ts` (five tables), `src/data/lifecyclePorts.ts` + `src/data/d1LifecycleAdapter.ts` + `src/data/inMemoryLifecycleAdapter.ts` (additive `source` input only), `src/agents/routes/agenticPayments.ts` (R1–R10), `src/outcomes/outcomeCatalog.json` (new codes), `tests/thin_router_inventory.test.ts` (insert in registration order), `tests/outcome_catalog_2381.test.ts` + `tests/public_broker_3990.test.ts` (BOTH count pins, §9).

**Per-slice file list (slice 2):**

New: `src/client/ReferralCodesSection.tsx` (billing-tab section), `tests/referralCodeGate.test.ts` (or gate cases inside `tests/native_monetization_gate.test.ts` — the build follows the existing gate-test home; ONE home), `changelog.d/<slug>.md`.
Modified: `src/services/nativeMonetization.ts` (config + `readCodeRunsCoverage` + coverage chain ONLY), `src/workflows/paymentWorkflow.ts` (wiring + `consumeCoverage` arm), `src/workflows/paymentWorkflowFlow.ts` (failure-credit guard ONLY), `src/client/ProductsSection.tsx` (rules panel + code management), `src/client/BillingServicingPanel.tsx` (section mount), `docs/architecture/business/entitlements-01.md` (§10), `docs/architecture/business/platform-entity-capability-map.md` (code-rules/codes/balance entities — the #3289 Product-entity precedent).
Never touched: `tests/actor-ports-conformance.test.ts` (escalate, don't edit); no other lane's in-flight work; no flag/price/grant/secret change; no #3247 file (none exists yet — and if #3247 lands first, slice 2 still touches none of its files).

**PR mechanics (both slices):** opened FULL (`draft:false`, per the 2026-11-13 directive). Bodies carry: repo-qualified Related (`OpenAIMP/cfagent#3307`, never bare `#3307`), the `## Agent #CBO-mlops` hashtag, a `Process documentation impact:` line, and an `Out of scope:` line (Policy Gate (a)/(c)/(h)/(k)). Labels `auto-merge` + `lane:cbo-mlops` (set via `issue_write`, never `update_pull_request`). Changelog fragment in `changelog.d/` (first non-empty line `### ` + bullet; never edit CHANGELOG.md). Go/no-go per the #3246 pattern: green CI on the current head → ready + queue → merge → §18. Claim comment on #3307 before each slice.

## §9 — Tests and pins

**Measure, never assume.** Every count below was measured on main `d02e043a`; the build re-measures on its base and greps the WHOLE `tests/` tree for the OLD literal before pushing (the #4286 lesson, `~/AGENTS.md`).

- **Outcome catalog: 141 → measured.** `src/outcomes/outcomeCatalog.json` gains the new commercial codes: `FAILURE_REFERRAL_CODE_INVALID` (400), `FAILURE_REFERRAL_CODE_CAP_EXCEEDED` (409), `FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE` (409). Aspect-only log code `FAILURE_CODE_RUNS_UNAVAILABLE` follows the runs-pack precedent (added to the catalog iff the precedent's codes are catalog members — the build checks `FAILURE_RUNS_PACK_UNAVAILABLE`'s membership and mirrors it). BOTH pins move together: `tests/outcome_catalog_2381.test.ts` AND `tests/public_broker_3990.test.ts` (the missed-second-pin failure of #4286 shard 3/4 must not recur — grep for `toHaveLength(141)` across `tests/`).
- **Thin-router inventory: 458 → measured.** `tests/thin_router_inventory.test.ts` `EXPECTED_INVENTORY` is an exact ordered array (`toEqual`); insert the R1–R10 conditions in REGISTRATION order (the order the `endsWith` blocks appear in `handleAgenticPaymentsRoutes`). Expected +10 if all ten land as separate conditions — the build counts the array, never assumes.
- **Migration registry: zero changes expected.** `tests/migration_registry.test.ts` is the canonical "latest" owner; a well-formed migration passes as-is. The build verifies the new migration's number is strictly greater than the registry's latest AT BUILD TIME (#3247 may have claimed 0064).
- **Admin/nav pins: NO changes expected.** No new Platform Admin tab, no new nav item, no new icon: the rules panel lives inside the existing Products section and the redeem surface inside the existing billing tab. The build still greps for `PLATFORM_ADMIN_TABS` / `free-runs` / nav-config pins to CONFIRM zero impact (the #3315/#3115 lesson) — a grep that returns "no pin moved" is the evidence, not an assumption.
- **Gate tests** (§4.5): order, fall-through, unbound-port, store-error, NQ7 (unapproved price throws before any spend), `consumeCoverage` no-op, failure-credit skip, byRun recording. Gate tests live in the existing gate-test home.
- **Redemption tests:** replay idempotency (sequential + concurrent-shape via the conditional increment); each cap independently (per-code, per-login, global) incl. boundary (cap reached exactly → refuse; cap-1 → allow); expiry (boundary ms); revocation; tenant scope (match/mismatch/unscoped); self-redemption refusal; rule deactivation kill-switch; attribution write + conflict-proceed + same-referrer no-op + invite-no-write + `none`-mode-no-write; snapshot semantics (rule edit after issuance does not reprice outstanding codes; cap tightening DOES apply live); hash discipline (no plaintext persisted — assert the stored row carries only the hash; no hash/value in any route response except the one-time issuance return).
- **Adapter-parity tests:** D1 + in-memory adapters share the port-file validators/helpers; the conditional-increment semantics are tested against BOTH (the runs-pack adapter-test pattern).
- **Attribution-extension tests:** the operator route stamps `operator` when no source is passed (byte-identical behavior — a regression test on the existing route); `source: "code"` stamps `code`; replay preserves the original source.
- **Pre-push ratchet sweep (the #4217 lesson):** run the cheap whole-tree scan tests before pushing even though CI runs the shards — `tests/ux_token_coverage_ratchet.test.ts` (no `#NNNN` in rendered JSX, no raw color literals), the console-migration ratchet (no new `console.*` in the touched files — the wiring block uses `logAspectEvent`), the migration-pin checks, and `lint-changed` on the touched files (dead `react-hooks` directives in touched files are removed in-slice, the #4126 landmine).
- **Policy Gate local repro** before pushing, against the single-parent commit matching the eventual PR head (never a merge commit), with the real body/title/labels — the `~/AGENTS.md` recipe.

## §10 — Doc updates

- **Slice 2, own content only:** `docs/architecture/business/entitlements-01.md` §2.1 step 7 gains the `code_runs` clause (after `subscription_included`, before `runs_pack`; price-approved precondition; `paidVia: "code_runs"`), and §4 gains a short codes paragraph (separate balance, allowance-first, no tier/credits, attribution reuse). The doc's "Verified against" line is NOT bumped (the freshness-fold discipline). The §3 matrix's "Covers it" `paidVia` list gains `code_runs` ONLY if the matrix's own wording requires it — the build reads the matrix before editing it.
- **Freshness fold (NOT this design's payload):** the 4-line freshness fix (`~/workspace/cbo-3246/entitlements-freshness-2026-11-12.md`, Mars's fold decision 2026-11-12) rides with #3247, which builds first. IF — verified by reading the doc at slice-2 build time — #3247 did not carry it (e.g. #3247's slice never touched the doc), then the #3307 slice-2 PR carries the fold: re-read the four lines against current main, update the #3246 clause to "shipped/closed", keep line 84 (triggered trigger, still unbuilt), do not bump "Verified against". The fold is never a standalone PR and never rides a slice that doesn't otherwise touch the doc.
- **Entity map:** `docs/architecture/business/platform-entity-capability-map.md` gains the code-rules / codes / redemptions / code-runs-balance entities (slice 2, the #3289 Product-entity precedent).
- **No other doc updates.** The lifecycle doc needs no #3307 row (no new lifecycle surface). The #3246 design is not retro-edited (its §3.8 boundary already anticipates this slice).

## §11 — What genuinely needs Mars before build

**Nothing.** Every open question from the issue body is answered on recommendation in §0.3 (D1–D13), each with its reasoning and its precedent. The build proceeds on the 2026-11-13 directive. Two facts are recorded for the debrief, not as blockers:

1. The seeded defaults (5 runs, one-time, 30-day expiry, caps 1/1, no global cap) are PROPOSED starting values in INACTIVE seed rows — the operator activates and edits them in the UI. No seed is live until an operator turns it on.
2. The inherited earn-trigger semantics (§3.4): a referred user's first flag-ON run triggers the referrer's $0.50 earning whether or not that run was code-covered. That is #2657's existing behavior, inherited verbatim — re-deciding it is a #2657 question, and this design does not smuggle the re-decision in.

---

**Predecessors, all DONE and verified on main `d02e043a`:** #3289 product versions (placement + `productId` contract, slices merged, issue closed); #3357 plans (per-user-within-tenant scoping); #3305 free-run counter (the allowance mechanism codes stack on top of, never inside); #3263 approved-free quota (the gate-order precedent); #3246 runs packs (the balance + conditional-decrement + gate-step + checkout/confirm precedent, migration 0063); #2208/#2657 referral-credit ledger (the attribution + earning store this design reuses, never rebuilds); #3243 trial (the sign-up path codes stack on top of); #3245 grant (the operator path codes stack on top of).
