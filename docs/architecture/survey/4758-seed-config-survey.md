# SURVEY-RECONCILIATION — #4758: seed values into config

- **Issue:** #4758 (sub-issue of #4282, DDL/DML externalization programme)
- **Base:** `474230f9b398850361a960b9fd0414778f27e873` — `docs(platform): pin login-scoped receipts boundary (#4601)`, latest tag on main `v0.1.1850`
- **Worktree:** `~/workspace/w4282/wt-seedcfg` (clean at end of survey — `git status` 0 changes; read-only scans only, no tests run, no node_modules linked)
- **Evidence:** `scan-seeds.mjs` + `scan-seeds.txt` in this directory
- **Issue state:** open, parent #4282, **zero comments** (checked 2026-11-15 — no lane claims)

## 1. Inventory — EVERY hardcoded seed default (verified on the base)

### 1a. Catalogue seeds — 12 entries (11 D1 + 1 route)

All in `src/data/schemaComponent/d1Catalogue.ts` unless noted. `form: "literal"` on all 11 D1 seeds.

| # | Code (line) | Table | Literal values | Already a named constant? |
|---|---|---|---|---|
| 1 | `seed.d1.agent_referral_rules.insert_default_rule` (:715) | agent_referral_rules | `('default', 0.5, 604800000, 'pay-per-run', 0)` — earn $0.50, vesting 7 days, scope pay-per-run | No |
| 2 | `seed.d1.agent_free_run_allowances.insert_default_allowances` (:1788) | agent_free_run_allowances | 10 runs × families stock/goal/options/strategy | No |
| 3 | `seed.d1.agent_subscription_plans.update_approve_proposed` (:1954) | agent_subscription_plans | `approval_status = 'approved' WHERE 'proposed'` — no tunable value (state transition) | N/A |
| 4 | `seed.d1.agent_approved_free_quotas.insert_default_quotas` (:2183) | agent_approved_free_quotas | cap 10 runs × 4 families | No |
| 5 | `seed.d1.agent_approved_free_quota_settings.insert_default_settings` (:2195) | agent_approved_free_quota_settings | `('default', 'month', 'upgrade_or_buy_credits', 0, NULL)` | No |
| 6 | `seed.d1.agent_products.insert_per_run_products` (:2280) | agent_products | ids `prod-per-run-{stock,goal,options,strategy}` + `prod-free` ('Free', subscription) | No |
| 7 | `seed.d1.agent_products.insert_subscription_products` (:2294) | agent_products | SELECT-derived from agent_subscription_plans (no literal values; prefix `'prod-sub-'` is structural) | N/A (derived) |
| 8 | `seed.d1.agent_subscription_plans.update_assign_product` (:2369) | agent_subscription_plans | Derived identifiers only: `'prod-sub-'` prefix, segment `'default'`, `CASE 365 → 'annual' ELSE 'monthly'` | N/A (derived) |
| 9 | `seed.d1.agent_price_catalogue.insert_from_legacy` (:2431) | agent_price_catalogue | SELECT-derived from agent_price_catalogue_legacy (no literal values; segment `'default'`, version `1` structural) | N/A (derived) |
| 10 | `seed.d1.agent_products.update_free_rank` (:2712) | agent_products | `rank = 1 WHERE id = 'prod-free'` | No (rank 1 is a value) |
| 11 | `seed.d1.agent_referral_code_rules.insert_default_rules` (:2949) | agent_referral_code_rules | 4 rows: `coderule-seed-prod-per-run-{family}`, issuer `platform_admin`, 5 runs/code, reusable 0, 30-day expiry, `ledger`, 1/1 caps | No |
| 12 | `seed.route.orchestrator_migration.insert_or_replace` (`remainderCatalogue.ts:551`) | orchestrator_migration | **None** — `form: "parameterized"`, statement is a template (`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`); values arrive as parameters. The recreate planner skips it (`SEED_FORM_CODE`, pinned in `tests/schema_recreate_runner.test.ts`). | N/A |

Net tunable literals in the catalogue: entries 1, 2, 4, 5, 6, 10, 11 (7 statements). Entries 3, 7, 8, 9 carry no tunable default (a state transition + three SELECT-derived statements); entry 12 carries no literals at all.

### 1b. Named-constant seed families — 5, not 1 (the body's inventory is incomplete)

All are seeded via Drizzle `onConflictDoNothing()` (INSERT OR IGNORE semantics) in adapter `ensure*Schema` paths, NOT via catalogue entries. The in-memory twins use the same constants (single source per family).

| Family | Constant (file) | Values | Marking | Consumers |
|---|---|---|---|---|
| Billing policy | `PROPOSED_SEED_BILLING_POLICY` + `PROPOSED_SEED_OFFER_RULES` (`src/data/billingPolicyPorts.ts:163,189`) | monthly default; periods [monthly, annual]; dunning [1,3,7]; grace 7d; downgrade period_end; proration create_prorations; repurchase grandfather; top-up $1–$500; annual discount 15%; offer rules (all on, 7-day cooldown) | PROPOSED, NOT owner-approved | `d1BillingPolicyAdapter.ensureBillingPolicySchema`, `inMemoryBillingPolicyAdapter` |
| Prices | `PROPOSED_SEED_PRICES` (`src/data/priceCataloguePorts.ts:58`) | stock $0.02, goal $0.10, options $0.05, strategy $0.10 | PROPOSED ("operator data, not in code") | `d1PriceCatalogueAdapter`, `inMemoryPriceCatalogueAdapter` |
| Refund policy | `PROPOSED_SEED_POLICY` (`src/data/refundPorts.ts:208`) | window 30d, approver `operator_hitl`, allowPartial false, effects revoke_immediately / keep_access / none / none, approvedKinds [] | PROPOSED, NOT owner-approved | `d1RefundAdapter`, `inMemoryRefundAdapter` |
| Journal chart | `MINIMAL_CHART` (`src/data/journalPorts.ts:64`) | 5 accounts: 1000 Funds received (asset), 2000 Customer credits outstanding (liability), 2100 Deferred revenue (liability), 4000 Revenue — screener runs (income), 5000 Refunds contra-revenue (expense) | None (no PROPOSED marking) | `d1JournalAdapter.ensureJournalSchema`, `inMemoryJournalAdapter` |
| Audit policy | `AUDIT_POLICY_BLOCKING_ACTIONS` + `AUDIT_POLICY_NON_BLOCKING_ACTIONS` (`src/data/auditPolicyPorts.ts:65`) | blocking: payment.charge, payment.refund, subscription.change, credit.issue (blockOnAuditFailure=1); non-blocking: audit.read, payment.read | PENDING CISO+CDO sign-off; "the gate consults the operator rows, never this constant, at runtime" | `d1AuditPolicyAdapter.ensureAuditPolicySchema`, `inMemoryAuditPolicyAdapter` |

### 1c. Sweep — other seed defaults

- **DO adapters: NONE.** Grep over `src/data/doSqlite*.ts` finds only runtime INSERTs (parameterized, caller-supplied values). The issue body's "e.g. `ensureSchema` seeds in DO adapters" example finds nothing — the ensureSchema seeds are all D1-side.
- **mas_settings: NONE.** Only a one-time cutover seed in `governedHalt.ts:164` (migration, not a default).
- **Migrations: NO second copy.** `migrationRunner.ts` delegates: "a migration's statement text lives in exactly one place — its catalogue entries in `d1Catalogue.ts` — and each const below assembles its `sql` from those entries via `d1MigrationSql`. P6e decision: the inline seed copies do NOT remain." Verified: no literal seed VALUES in `migrationRunner.ts` (only a comment mention). The adapter comments agree ("The defaults live only in migration 0055's rows" / "The seed value lives only in migration 0044's rows" — and those migrations assemble from the catalogue).
- **Tests quoting literal seed values: 8 files** (`604800000` / `pay-per-run` / `upgrade_or_buy_credits` / `coderule-seed`): `approved_free_quota_3263`, `approved_free_quota_gate_3263`, `approved_free_quota_routes_3263`, `approved_free_quota_ui_3263`, `billing_servicing_2740`, `billing_subtab_tab_chrome_4691`, `billing_subtabs_4638`, `cancel_refund_policy_2662_routes`. These are second copies under the config rule and need updating to read config (per the commercialDefaults pattern).

## 2. Config home — proposed: NEW file, not an extension

**Proposed home: `config/seed-defaults.json` + `src/config/seedDefaults.ts` (typed `SEED_DEFAULTS`).**

Why new, not extending `commercialDefaults.ts`:
- `commercialDefaults.ts` is a typed re-export of `config/commercial-defaults.json` with a deliberate single purpose: pagination limits (50/100). Its own header says what is NOT there by design (top-up bounds, refund windows, prices). Seed rows are a different domain (commercial reference data, not pagination).
- The pattern is directly reusable and already established twice: `config/commercial-defaults.json` + `src/config/commercialDefaults.ts`, and `config/social-rewards.json` + `src/config/socialRewardLimits.ts`. Both are JSON data + a typed TS module; the doc header names the single source of truth and the pins read the config, never a second copy. `src/config/environment.ts` shows the same JSON-backed shape for environment config (`environment.config.json`).
- One home, not one per table: all 7 literal-bearing catalogue statements + all 5 constant families live in the one JSON, grouped per family, with the `proposed`/sign-off marking carried as data (see Q3).

Cycle analysis (checked on the base):
- `src/config/*` files import from `../data/*` (ports/models/services) and `../services/*` — **none imports `schemaComponent`**. The three data-importing config files import `jobPipelinePorts`, `jobPipelineConfig`, `socialRewardModel` only.
- `src/data/*` already imports from `../config/*` (`schemaMigrationModes`, `environment`) — the data→config direction is precedented.
- A new `seedDefaults.ts` that imports **only its JSON** is cycle-free by construction; the catalogue importing it adds no cycle.

## 3. Mechanism (precise)

1. **Config:** `config/seed-defaults.json` holds every tunable value (7 catalogue statements' values + 5 constant families), grouped per family; `src/config/seedDefaults.ts` exposes a typed `SEED_DEFAULTS` (same shape as `COMMERCIAL_DEFAULTS`).
2. **Catalogue:** the 7 literal-bearing seed entries' `statement` fields become module-scope builder calls, e.g. `statement: referralRuleSeed(SEED_DEFAULTS)` returning the exact INSERT string. `D1_CATALOGUE_ENTRIES` stays a const array; `buildD1Catalogue()` is untouched; `D1_MIGRATION_CODES` (string code lists) is untouched.
   - `form` stays `"literal"`: the built value is still a plain string, so catalogue validation is unchanged (non-empty, starts with a DML verb, no placeholders, names its table — `catalogue.ts:99`).
   - No executor, validation, planner, or migration-assembler changes.
3. **Flow-through (the key point):** migrations assemble their SQL from the catalogue via `d1MigrationSql`, and the recreate planner selects all `kind === "seed"` entries. Config-built statements therefore reach BOTH the ensure/migration path and the recreate path with no further change. The recreate test's real-SQLite harness (`tests/schema_recreate_runner.test.ts`, executes steps on `node:sqlite` and reproduces the model) is the base for the comparison test.
4. **Derived seeds stay as-is (disclosed):** entries 3, 7, 8, 9 (state transition + SELECT-derived) and the route template (entry 12) carry no tunable default and are not moved. The pin defines "literal default" to exclude derived identifiers (`'prod-sub-'` prefix, `'default'` segment, `'annual'`/`'monthly'` period names) — otherwise it can never pass. The `'prod-sub-'` prefix is shared by 3 seeds; it is structural (changing it breaks product-id joins), not a default.
5. **Constant families:** values move into the JSON; the ports modules keep their named exports as thin re-exports from config (e.g. `PROPOSED_SEED_BILLING_POLICY = SEED_DEFAULTS.billingPolicy`), so adapter/twin call sites do not change. The PROPOSED / pending-sign-off markings are preserved (Q3: as config data vs TS-only).
6. **Semantics preserved:** statements keep `INSERT OR IGNORE`; Drizzle paths keep `onConflictDoNothing()`; the service reads the store after seeding (billing-policy pattern). Operator edits in the store still survive re-ensure — the existing no-overwrite tests stay green.
7. **Byte-identical proof (two layers):** (a) statement-text identity — capture the 11 built statement strings from the current catalogue as a golden and assert the config-built strings are identical (catches typos); (b) row snapshot — execute the seed steps on a fresh in-memory SQLite DB before/after and assert identical rows (catches semantic drift). Layer (a) alone is insufficient (a typo can preserve shape); layer (b) alone is insufficient (two different statements can land the same rows only if the values match — actually (b) does catch value changes; (a) is the cheap tripwire).

## 4. Reconciliation vs the #4758 body

| Body claim | Verdict on current main |
|---|---|
| 11 D1 seed entries | **Confirmed** (codes at d1Catalogue.ts:715, 1788, 1954, 2183, 2195, 2280, 2294, 2369, 2431, 2712, 2949). Note: my first scan pass found 10 — the 11th is `update_assign_product` (:2369), whose multi-line statement exceeded the scan window; verified by direct read. |
| Route seed in remainderCatalogue.ts | **Confirmed** (:551) — with the correction that it carries **no literal values** (parameterized template; values arrive as parameters). Nothing to externalize there. |
| Billing-policy constants are the partial exception | **Confirmed but understated** — there are **five** constant families, not one: billing policy, prices, refund policy, journal chart, audit policy (§1b). The body names only billing policy. |
| "e.g. ensureSchema seeds in DO adapters" | **Finds nothing.** The ensureSchema seeds are all D1-side (Drizzle adapters + catalogue-assembled migrations). No DO-adapter seed defaults exist. |
| "no config file, no named constant, no env knob" | **Confirmed** for the catalogue literals (no config file references the seed tables/values; no env vars). The named-constant half is the 5 families in §1b. |
| `src/config/` exists but references no seed values | **Confirmed.** |
| Size: Small | **Stale — Medium** (see §5). The sweep expanded the scope from "11 + 1 + billing policy" to "7 literal catalogue statements + 5 constant families + 8 test files". |
| Priority: Medium | No evidence to dispute; leave as filed. |
| Parent #4282, sub-issue | **Confirmed** (parent read-back: #4282, OPEN). |
| Zero comments / no lane claims | **Confirmed** (comments read: 0). |

## 5. Size + file count + test plan

**Size: Medium** (the body's Small predates the sweep).

Estimated files (~20):
- New (3): `config/seed-defaults.json`, `src/config/seedDefaults.ts`, `tests/seed_defaults_4758.test.ts` (comparison + pin) + changelog fragment.
- Modified, catalogue (1): `d1Catalogue.ts` (7 seed statements → builders).
- Modified, ports constants (5): `billingPolicyPorts.ts`, `priceCataloguePorts.ts`, `refundPorts.ts`, `journalPorts.ts`, `auditPolicyPorts.ts` (values → config re-exports).
- Modified, adapters/twins (0 expected if re-exports hold — call sites keep importing from ports; verify in build: `d1BillingPolicyAdapter`, `d1RefundAdapter`, `d1PriceCatalogueAdapter`, `d1JournalAdapter`, `d1AuditPolicyAdapter` + 5 in-memory twins).
- Modified, tests (8): the files in §1c quoting literal seed values → read config.

Test plan shape:
- New `tests/seed_defaults_4758.test.ts`: (a) statement-text golden (11 catalogue seed statements identical before/after), (b) row snapshot on fresh SQLite (seed steps executed, rows identical), (c) literal-free pin (no tunable literal in seed statements; derived identifiers exempted by name), (d) config-coverage pin (every seed default has exactly one home — the JSON).
- Affected suite + full suite with exact delta vs pristine baseline (per gitops).

## 6. Open questions (need a user ruling before building)

- **Q1 — Scope split?** All five constant families in this slice, or catalogue seeds first and the constants as a second slice? (One config home either way; the home lands first.)
- **Q2 — Derived identifiers:** `'prod-sub-'` prefix (shared by 3 seeds), `'default'` segment, `'annual'`/`'monthly'` — config or leave as structural SQL? Recommendation: leave; pin exempts them by name.
- **Q3 — PROPOSED markings:** carry into config as data (e.g. `status: "proposed"` / `signOff: "pending"`) or keep the marking TS-only while values move? Recommendation: carry as data — the marking is part of the value's meaning.
- **Q4 — Size Medium** (not Small as filed) — confirm.
- **Q5 — The 8 literal-quoting test files:** update to read config in this slice (per the commercialDefaults "pins read config, never a second copy" rule) or leave them? Recommendation: update.
- **Q6 — JSON formatting:** pretty-printed for human review, or single-line like `commercial-defaults.json`? Recommendation: pretty-printed (~40 values; humans review seed changes).
- **Q7 — Display strings in the home?** The journal chart names ("Funds received", …) and audit action names are identifiers, not tunables — include them in the JSON anyway for one-home completeness, or keep them in the ports modules? Recommendation: include (one home means one home).
