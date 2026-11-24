# Survey — Data-layer normalization: PK / FK / constraints, and the road to 3NF

**Main tip:** `16d39b51448ba70567b8ca0ba295f7c34ba3bc54` — "Market definition refuses a goalScreen param by name (#5886)"
**Survey date:** 2026-11-22. Read-only; no issues filed, no code changed.
**Scope:** every persistent store (D1, DO SQLite, KV-table, R2, Vectorize, AI Search, Analytics Engine). Line numbers are on the tip.

## TL;DR answers

1. **Does the data layer conform to PK / FK / constraints?** Mostly PK, **no FK at all, almost no other constraints.** Every D1 table except one has a declared primary key (105/106); every DO table has one (70/70). There are **zero `REFERENCES` / `FOREIGN KEY` declarations in the entire codebase** — not in the Drizzle schema, not in any of the four DDL catalogues, not in the migration runner. No `PRAGMA foreign_keys` is ever enabled anywhere in `src/`. CHECK constraints: exactly one in the whole system (a singleton-row guard, `id INTEGER PRIMARY KEY CHECK (id = 1)`). UNIQUE: 7 unique indexes + 2 column-level UNIQUEs across 186 tables. So referential integrity is enforced nowhere by the store — only by application code, where it is enforced at all.
2. **Is it fully normalized (3NF)?** No. 1NF is broken by design in ~37 JSON-text columns on D1 and 55 `_json` column occurrences on DO (structured and multi-valued data inside single cells, including JSON arrays of foreign keys). 2NF is mostly clean for composite keys, except three encoded composite keys that pack several attributes into one TEXT column. 3NF is broken in three deliberate families (twin/projection stores, read-path denormalized columns, frozen snapshots) and several accidental ones (derived counters, duplicated tenant/user identity with no master table, mixed timestamp domains, an integer-vs-text run-id split).
3. **Why not?** Two different reasons, and they must not be conflated. The 3NF breaks in the projection/snapshot/read-path families are **deliberate and documented in code comments** (each serves a named read or audit pattern). The missing FKs / CHECKs / master tables are **accidental: normalization was never a design criterion** — the words "normal form", "3NF", "denormalized" appear nowhere in ADR 0022 or the data-model doc, and no recorded decision discusses foreign keys. The schema grew table-by-table (one migration per table, 0001–0078+) with no cross-table integrity rule.
4. **How big is the change?** Large programme, ~8 slices (see §6). The constraint half (FKs + CHECKs + master tables) is the bulk of the work and is mostly mechanical DDL + orphan cleanup + pin updates — but it touches every adapter family, and the DDL pin/harness freezes current DDL byte-for-byte, so each slice must update the pins. The JSON-normalization half is smaller in table count but larger in code churn (join tables + query rewrites). The twin-store elimination is explicitly **not** this programme — #5852 owns it.

## 1. Store inventory

| Store | Binding / home | Tables / collections | PK | FK | Other constraints |
|---|---|---|---|---|---|
| D1 (Cloudflare D1) | `AGENT_DB` (`agentdb`), DDL in `src/data/schemaComponent/d1Catalogue.ts` (106 CREATE TABLE), mapped in `src/data/drizzleSchema.ts` (106 tables), migrations 0001–0078+ in `src/data/migrationRunner.ts` | 106 | 105/106 declared (18 composite, 87 single-col) | **0** | 7 unique indexes, 1 column UNIQUE (`code_hash`), 1 CHECK (`id = 1` singleton) |
| DO SQLite | per-instance `ctx.storage.sql`; DDL in `src/data/schemaComponent/doCatalogue.ts` (70 CREATE TABLE counted — the header says 69, stale by one, same class of drift #5025 fixed elsewhere), plus `ormCatalogue.ts` (13 shared `mas_*` tables) and `remainderCatalogue.ts` (8 tables) | 70 (+13 shared, +8 remainder; 186 distinct tables across the four catalogues) | 70/70 declared | **0** | 1 unique index, 1 column UNIQUE (`code_hash`), 0 CHECK |
| KV | **No Cloudflare KV namespace binding exists** (`wrangler.jsonc` has no `kv_namespaces`; `src/types.ts:1004` declares an optional unused `KV?: KVNamespace`). KV-shaped storage is the DO `kv_store` table (`ns, key` composite PK, `value TEXT`) + SessionStore DO | 1 table (`kv_store`) | composite (ns, key) | n/a — key-value by construction | none |
| R2 | `REPORTS_BUCKET` (bucket `screener`) | blobs only, no schema | n/a — blobs by construction | n/a | none (metadata pointers live in SQL tables) |
| Vectorize | `vector-memory` | vectors + metadata | n/a — vector store by construction | n/a | none |
| AI Search | `screener-search`, namespace `default` | indexed documents | n/a — search index by construction | n/a | none |
| Analytics Engine | `observability` dataset | append-only telemetry events | n/a — event stream by construction | n/a | none |

Notes:
- The DDL pin/harness (`tests/schema_component_*`, the sha256 map in `tests/schema_component_do_catalogue.test.ts`) pins every catalogue statement byte-for-byte. Any FK/CHECK addition changes pinned DDL — the harness is a gate to update, not a blocker.
- D1 and DO overlap heavily: the job-pipeline family (`job_pipeline_*`, `job_run_records`, `job_*_datasets`), `mas_data_captures`, `mas_iv_history`, the marketplace tables, and `mas_reports` exist in both planes. Canonical-vs-projection roles were decided in #5040 (closed): e.g. `mas_reports` (DO) is canonical, `agent_reports` (D1) is the projected read replica; `mas_transactions` (DO) is the canonical payment ledger, `agent_native_ledger_rows` (D1) is its projection. The twin stores are therefore **named replicas, not accidental duplicates** — eliminating them is #5852's programme, not this one.
- No `tenants` or `users` master table exists anywhere. `tenant_id`, `user_login`, `user_id` are free-text columns repeated in nearly every table, with no reference target. Identity is owned by the identity plane (`src/security/identityBinding.ts` derives the internal user id from the (issuer, subject) pair); the data layer never gained a reference table for it.

## 2. Normalization findings

### 2.1 1NF — atomic values

**F1. JSON-text columns hold structured and multi-valued data (deliberate in most cases, accidental in none — but 1NF-violating regardless).**
- D1: **37 JSON-text columns out of 693 text columns** (`src/data/drizzleSchema.ts`). DO: **55 `_json` column occurrences** (`src/data/schemaComponent/doCatalogue.ts`).
- Multi-valued attributes stored as JSON arrays (repeating groups in a cell):
  - `agent_product_bundles.member_product_ids` — "a JSON array of catalog product ids" (`drizzleSchema.ts:668`) — an array of foreign keys to `agent_products` with no join table and no FK.
  - `agent_calibration_decisions.falsifying_outcome_ids_json` — an array of outcome ids (`drizzleSchema.ts:296`).
  - `mas_index_lists.members_json` (`drizzleSchema.ts:2119`) — the index's member list.
  - `agent_bulk_moves.target_version_ids_json` (`drizzleSchema.ts:1312`) — an array of version ids.
  - `agent_subscription_plans.features_json` (`drizzleSchema.ts:1067`) — display-only, genuinely opaque.
- Whole-document JSON (configuration values / snapshots / evidence — the column IS the value, not a relation):
  - `job_pipeline_definitions.definition_json` + `job_pipeline_definition_versions.definition_json` — "The definition persists as whole JSON (it is a configuration value, resolved by the config layer)" (`drizzleSchema.ts:1807`).
  - `job_pipeline_instances.checkpoint_json`, `stage_checkpoint_json`, `stage_desired_json` (`drizzleSchema.ts:1861-1863`).
  - `job_*_datasets.artifact_json` (5 dataset tables) — "The full artifact rides in artifact_json" (`drizzleSchema.ts:1984`).
  - `agent_mesh_eval_results.facts_json` / `failures_json` — "scalar evidence only (codes, ids, counts, booleans) — never payloads" (`drizzleSchema.ts:1694`).
  - `agent_calibration_decisions.snapshot_json` — frozen snapshot, part of the audit trail (`drizzleSchema.ts:284`).
- EAV (entity-attribute-value) tables — keys as data, values untyped:
  - `mas_settings` (DO): `key TEXT PRIMARY KEY, value TEXT NOT NULL` (`doCatalogue.ts:mas_settings`).
  - `agent_billing_policy` (D1): `key` PK, `value_json` (`drizzleSchema.ts:744-746`).
  - `otel_config_overrides` (D1): `(config_key, version)` PK, `value_json` NULL = tombstone (`drizzleSchema.ts:2119-2135`).

**F2. Composite keys encoded into a single TEXT column (the key is not atomic).**
- `job_pipeline_artifacts.id` = `` `${runId}\u0001${artifactKey}` `` (`src/data/jobPipelinePorts.ts:58-60`) — "the single-column id the foundation's Repository core addresses". The components are ALSO stored as `run_id` + `artifact_key` columns (`drizzleSchema.ts:1894`).
- `job_pipeline_definition_versions.id` = `` `${jobId}:${version}` `` (`src/data/d1JobPipelineAdapter.ts:165`, `src/data/doSqliteJobPipelineAdapter.ts:356`). `job_id` + `version` are also columns.
- `agent_price_catalogue.id` = `` `cat-${family}-${segment}-v${version}` `` (`src/data/productPorts.ts:80`). `family`, `segment`, `version`, `product_id` are also columns; a UNIQUE index on `(product_id, segment, version)` exists (`d1Catalogue.ts:2497`) — i.e. the natural key exists, but the PK is the encoded string.

**F3. One table has no primary key at all.**
- `resource_sql_ops` (D1): 11 columns, no PK (`d1Catalogue.ts` DDL: `CREATE TABLE IF NOT EXISTS resource_sql_ops (ts_ms INTEGER NOT NULL, ns TEXT NOT NULL, op TEXT NOT NULL, ...)` — no PRIMARY KEY clause; confirmed in `drizzleSchema.ts:1627` — the mapping declares no key either). It is a telemetry/observability sink, so the impact is limited to duplicate rows and no stable row identity — but it is the only PK-less table in the system.

### 2.2 2NF — partial dependencies on composite keys

Mostly clean. The 18 composite-PK tables were checked: non-key attributes depend on the full key in every case (e.g. `agent_shard_jobs (tenant, chain, job, version)` — status/stage/detail/result depend on the job version; `agent_reports (tenant, report, version)` — title/body depend on the report version; `agent_free_run_counts (user, family, month)` — `used` depends on the full key).
- The exception is F2: the encoded surrogate keys duplicate their components as columns, so the components are functionally dependent on part of what the key encodes — the key is not atomic, and the duplication is the 2NF smell. Fixing F2 fixes the 2NF case.

### 2.3 3NF — transitive dependencies and denormalized copies

**F4. Twin / projection stores (deliberate, decided — #5040 canonical roles; elimination is #5852, NOT this programme).**
- `agent_reports` (D1) is the projection of DO `mas_reports`; the twin link is heuristic: `linked_job_run_id` is "resolved at projection time by generation_id + run window, only when unambiguous" (`drizzleSchema.ts:4116` comment). No FK, and the link is a guess with a stated ambiguity rule.
- `agent_async_jobs` (D1) projects DO `mas_async_jobs` ("a stale projection write never overwrites a newer row", conditional upsert — `drizzleSchema.ts:1929` comment).
- `agent_usage_events` (D1) mirrors DO `usage_events` ("the ONE queryable tenant surface across the split DOs… The DO table stays authoritative", `drizzleSchema.ts:1968`).
- `agent_data_captures` (D1) vs `mas_data_captures` (DO); `agent_iv_history` (D1) vs `mas_iv_history` (DO); marketplace mirrors `agent_categories`/`agent_referrals`/`agent_ads`/`agent_external_ads` (D1) vs DO `mas_*` ("Column-for-column mirrors… so the same records flow over both residencies", `drizzleSchema.ts:1538`).
- Job-pipeline family and `job_run_records` exist in both D1 and DO. The #5852 exception list (81 DO uses: 44 movable, 37 exception; zero-exception end state ruled, 5 framework stores carved out as substrate) is the migration inventory for collapsing these.

**F5. Read-path denormalized columns (deliberate, each with a stated reason in the comment).**
- `job_enriched_datasets` / `job_analyzed_datasets` / `job_generated_datasets` / `job_delivery_datasets`: `status` and `rows_persisted` are denormalized "so latestUsable can filter without parsing every row" (`drizzleSchema.ts:1992`, `:2010`, `:2029`, `:2056`).
- `job_delivery_datasets.input_artifact_id`: "denormalized… so the resume lookup — what was already delivered for this exact input — is an exact query, never a scan" (`drizzleSchema.ts:2073`).
- `agent_credit_claims.family`: "carries family natively, so redemption never needs an audit-payload family join" (`drizzleSchema.ts:553`).

**F6. Frozen snapshots (deliberate, for audit/immutability — the snapshot IS the fact).**
- `agent_referral_codes`: "Terms are snapshotted at issuance" — `rule_id` + `product_id` + `runs` + `reusable` + `expires_at_ms` duplicate the rule row (`drizzleSchema.ts:1216`).
- `agent_code_redemptions`: `product_id`, `runs_granted` snapshot the code's terms (`drizzleSchema.ts:1241`).
- `agent_bundle_entitlements`: `user_id`, `tenant_id`, `product_id`, `period_start_ms`, `period_end_ms` duplicate the purchase row — written "in the SAME atomic batch as the purchase row" (`drizzleSchema.ts:723`).
- `agent_calibration_decisions.snapshot_json` + `prior_note` — the row IS the audit trail (`drizzleSchema.ts:288`).
- These should be **recorded as accepted denormalization**, not "fixed" — normalizing them would destroy the audit property.

**F7. Derived counters stored on the row (no derivation rule in the store; maintained by application code).**
- `agent_referrals.clicks` / `signups`, `agent_ads.impressions` / `clicks` / `earnings`, `agent_external_ads.impressions` / `clicks` / `earnings` (`drizzleSchema.ts:1550-1607`).
- `agent_referral_code_rules.redemption_count`, `agent_referral_codes.redemption_count` (`drizzleSchema.ts:1193`, `:1216`) — counters over `agent_code_redemptions`, maintained separately from the redemption rows.
- `agent_code_redemption_counts` — a dedicated counter table for the per-login cap.
- `agent_iv_history.dte` — derived from `expiry_date − date` (`drizzleSchema.ts:1511`); `expiry_date` is a non-key attribute, so `dte` is transitively dependent on it.

**F8. Referential columns with no target and no enforcement (the FK gap, enumerated).**
Every one of these is a TEXT column naming another table's row, with no `REFERENCES`, no FK, and no master table to reference:
- Identity: `tenant_id` in ~every table, `user_id` / `user_login` in ~every table — no `tenants` table, no `users` table (identity lives in the security plane, not the data layer).
- Commerce: `agent_subscriptions.plan_id` → `agent_subscription_plans.id`; `agent_subscriptions.user_id` → no users table; `agent_refunds.subscription_id` → `agent_subscriptions.id`; `agent_refunds.original_payment_ref` → payment ref (no table); `agent_bundle_purchases.bundle_id` → `agent_product_bundles.id`; `agent_bundle_entitlements.bundle_purchase_id` → `agent_bundle_purchases.id`; `agent_referral_codes.rule_id` → `agent_referral_code_rules.id`; `agent_code_redemptions.code_id` → `agent_referral_codes.id`; `agent_version_moves.from_version_id` / `to_version_id` / `bulk_move_id` → catalogue versions / `agent_bulk_moves.id`; `agent_runs_pack_drafts.version_id` → `agent_runs_pack_versions.id`; `agent_top_up_drafts` / `agent_cfpay_channel_purchases` payment refs → no table.
- Ledger: `agent_journal_entries.account_code` → `agent_journal_accounts.code`; `transaction_ref`, `run_request_id` → no table; `agent_native_ledger_rows.session_id`, `gateway_ref` → no table; `agent_credit_claims.credit_run_id` ↔ `agent_credit_redemptions.credit_run_id` (same key, two tables, no FK either way); `agent_referral_earnings.redeemed_by_run_id` → no table.
- Pipeline: `job_run_records.job_id` → `job_pipeline_definitions.job_id`; `job_pipeline_instances.current_run_id` → no table (and see F9); `job_pipeline_artifacts.run_id` → no table; `agent_async_jobs.parent_job_id` → `agent_async_jobs.job_id` (self-reference, unenforced); `agent_proposal_transitions.proposal_id` → `agent_proposals.id`; `agent_chain_audit.chain_id` → `agent_chains.chain_id` (nullable); `agent_thesis_realizations.report_id` / `chain_id` / `run_id` → no FKs.
- Data platform: `agent_data_provider_routes.primary_provider_id` / `gap_fill_provider_id` → `agent_data_providers.id`; `agent_data_captures.provider_id` / `run_id` → no FKs; `agent_data_captures.raw_blob_ref` → R2 key (cross-store pointer, no integrity).
- Deletes do not cascade anywhere: every `DELETE FROM` in the adapters deletes one table's rows only (e.g. `doSqliteAsyncJobAdapter.ts:144-505` deletes `mas_async_jobs` rows; nothing deletes the D1 `agent_async_jobs` projection of the same job, and nothing deletes children). Orphaned projection rows are therefore possible today; the projection's conditional-upsert rule only guards overwrites, not deletes.

**F9. Domain-integrity splits (same domain, different types / shapes).**
- Run identity: `job_run_records.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` in both D1 and DO, while every other run reference is TEXT (`job_pipeline_artifacts.run_id`, `job_pipeline_instances.current_run_id`, `agent_async_jobs.job_id`). The D1 `agent_reports.linked_job_run_id` is TEXT pointing at an INTEGER PK — a type mismatch between the link column and its target.
- Timestamps: two conventions with no rule — ISO-8601 TEXT (`agent_data_captures`, all job-pipeline tables, all DO `mas_*` tables) vs epoch-milliseconds INTEGER (most `agent_*` D1 tables). `agent_data_captures` notes it explicitly: "The timestamp columns are ISO-8601 TEXT by stated deviation" (`drizzleSchema.ts:1454`).
- Status vocabularies: 20 `status TEXT` + 6 `state TEXT` + 8 `kind TEXT` columns on D1 (17 + 2 on DO), all unconstrained TEXT. The vocabulary lives in code (Zod / enums), never in the store — an invalid status string is storable.
- Stale defaults contradicting the read path: `agent_tenant_settings.data_provider_id` defaults to `"etrade"` and `broker_id` to `"etrade"`, while the adapter default is alpaca — the comments call them "a pre-#3990 leftover" / "pre-#3937 leftover" and say "reads never see it" (`drizzleSchema.ts:347`). A default that no read can observe is a latent integrity defect.

## 3. Why — deliberate vs accidental, with evidence

| Class | Verdict | Evidence |
|---|---|---|
| Twin / projection stores (F4) | **Deliberate, decided.** Canonical roles recorded in #5040 (closed, PR #5553, pin `tests/canonical_stores_5040.test.ts`). Elimination is #5852's programme (zero-exception end state ruled; 5 framework stores carved out as substrate). | #5040 decision comment 6988755901; `drizzleSchema.ts` projection comments |
| Read-path denormalized columns (F5) | **Deliberate.** Each comment names the read it serves (filter without parsing; exact-query resume lookup; avoid a join). | `drizzleSchema.ts:1992`, `:2073`, `:553` |
| Frozen snapshots (F6) | **Deliberate.** The snapshot is the audit fact; normalizing it would destroy immutability. | `drizzleSchema.ts:1216`, `:723`, `:288` |
| JSON config values / evidence (part of F1) | **Deliberate.** Job definitions are configuration values, not relations; mesh evidence is scalar-only by rule. | `drizzleSchema.ts:1807`, `:1694` |
| JSON arrays of FKs (part of F1) | **Accidental / convenience.** No comment justifies the array form over a join table; the arrays exist because the writers are single-row upserts and a join table would need a second write. No reason evident in code. | `drizzleSchema.ts:668`, `:296`, `:2119`, `:1312` |
| Encoded composite keys (F2) | **Deliberate mechanism, accidental shape.** The Repository core needs a single-column id (`jobPipelinePorts.ts:58`); the `:` / `\u0001` / `cat-…-v…` encodings are the mechanism chosen. The shape (non-atomic key + duplicated components) was never evaluated against 1NF/2NF. | `jobPipelinePorts.ts:58-60`, `productPorts.ts:80` |
| Missing FKs / CHECKs / master tables (F8, F9) | **Accidental — never decided.** Zero `REFERENCES` in all DDL; zero `PRAGMA foreign_keys`; the terms "normal form", "3NF", "denormalized" appear **nowhere** in ADR 0022 (`docs/architecture/adr/0022-data-foundation.md`, 692 lines) or the data-model doc (`docs/architecture/data/data-model.md`). SQLite FKs are off by default and nothing ever turns them on. The schema grew one migration per table with no cross-table integrity rule. | greps over `src/data/schemaComponent/*.ts`, `src/data/drizzleSchema.ts`, `src/data/migrationRunner.ts`, ADR 0022, data-model doc |
| No-PK table (F3) | **Accidental.** `resource_sql_ops` is a telemetry sink added by regularization (#2362); nobody noticed it has no key. | DDL in `d1Catalogue.ts` |
| Stale defaults (F9) | **Accidental, known.** The comments themselves call them leftovers. | `drizzleSchema.ts:347` |
| EAV settings stores (F1) | **Deliberate-ish.** Settings are schemaless by nature (new keys without migrations); the EAV shape is the mechanism. Whether a settings store *should* be 3NF is a design question for the programme's decision slice, not a violation to fix blindly. | `mas_settings` DDL; `agent_billing_policy` comment |

## 4. What is NOT in scope

- **Framework-owned stores** (cannot be normalized by construction, and already carved out as substrate by the #5852 ruling): `cf_agents_jobs`, `cf_ai_chat_agent_messages`, `REPORTS_BUCKET`, `vector-memory`, `screener-search`.
- **Non-SQL stores** (R2 blobs, Vectorize, AI Search, Analytics Engine, the KV-shaped `kv_store` table): key-value / blob / vector / search shapes have no relational normal form to conform to. The `kv_store` table itself is already in 3NF for its shape (ns, key → value).
- **Twin-store elimination**: #5852's programme (44 movable DO uses, each its own slice). This programme adds constraints *within* each store and the projection-consistency rule; it must not re-decide canonical homes (#5040 already decided them) and must not assume a single home until a #5852 move lands.
- **JSON blobs that are genuinely opaque values** (job definitions, frozen snapshots, mesh evidence, display-only feature lists): recorded as accepted, with the rule that names them.
- **The DO-plane exception stores** (session/token/audit/bucket families that stay on DO per #5852): FKs still apply inside them, but their residency is not this programme's question.

## 5. Existing coverage — what is already covered, what is uncovered

| Work | State | Overlap with this programme |
|---|---|---|
| #5023 system data model (CLO-arsi) | **Closed.** 24 sub-issues, all closed. Survey found 13 gap clusters incl. dual stores and tenant-isolation gaps. | Covers the *documentation* of the model and several adjacent fixes (#5040 canonical stores, #5036 cross-plane ownership, #5038 tenant isolation, #5035 D1 tables without Drizzle objects). **Does not cover normalization, PK/FK, or 3NF** — no sub-issue names a normal form. The data-model doc is the home for this programme's decision record. |
| #5040 one store per family | **Closed** (PR #5553). Canonical roles decided + pinned. | Decides the twin-store question. This programme works *within* those decisions. |
| #3260 data-access harmonization | Open. One standard per plane (Drizzle / ORM core / hand-written SQL). | Mechanism, not shape. This programme's DDL must land in the right catalogue per plane (#3260's rule); #3260 does not add constraints. |
| #5852 one run-ledger store (+ #5853/#5854/#5856/#5857/#5858) | Open. D1 is the default store; DO only where D1 can't be used; zero-exception end state ruled. | Owns twin-store elimination and the inline-DML externalization (#5858, 232 non-exempt literals). **This programme must not duplicate it.** Overlap point: FK work on a twin table must be sequenced after (or with) that table's #5852 move, or the FK lands twice. |
| #5858 externalize inline DML | Open. 232 non-exempt inline DML literals. | The constraint DDL (FK/CHECK) is catalogued DDL; the DML that must *respect* the new constraints is #5858's scope. Sequence: constraints land with their own migrations; adapters that violate them are found by the orphan census, not by #5858. |
| **Normalization / 3NF / FK / referential integrity** | **Uncovered.** GitHub search for `"3NF"` returns 0 issues; no issue names foreign keys or referential integrity as its subject. | **This is the uncovered part. The programme below files only this.** |

## 6. Programme proposal

Parent issue (filed by the parent from this survey; gitops §5 + `## Reuse class` + `## Dependencies`):

- **Reuse class:** Enhancement — extends the #5023 data-model work (the data-model doc is the decision home) and the #4282 catalogue mechanism (DDL lands as catalogued statements, pinned by the existing harness); reuses the #5040 canonical-store decisions and the #5852 move inventory. No new mechanism.
- **Dependencies:** Blocking: #5852 (twin-store moves sequence the FK work on twin tables); #5858 (DML externalization — constraint-violating adapters are found by the orphan census). Related: #3260 (catalogue-per-plane rule for where the DDL lands); #5023 (closed — the data-model doc is the decision home); #5040 (closed — canonical roles, do not re-decide).

Slices (merge-first, one at a time; each one PR):

| # | Slice | Scope | Acceptance criteria | Size |
|---|---|---|---|---|
| S0 | Census + constraint policy (decision first) | Orphan census: for every F8 reference, count rows whose target does not exist (D1 + DO). Owner ruling: FK enforcement ON (with `PRAGMA foreign_keys` in the D1 + DO paths) vs FK declarations without enforcement; which F1/F5/F6 items are accepted denormalization (recorded in the data-model doc); the timestamp convention; the run-id domain decision. ADR 0022 / data-model doc update. | Census numbers published; ruling recorded; accepted-denormalization list named. | S |
| S1 | D1 referential spine | Add `REFERENCES` to the D1 DDL for the F8 spine (commerce → plans/products/purchases/bundles/rules; journal → accounts; data captures/routes → providers; proposals → transitions; async-job self-reference; reports → runs where the target exists), plus the `PRAGMA foreign_keys` enablement in the D1 path. Orphan cleanup per the S0 census (delete or repair, never silent). Pin/harness updates. | Zero orphan rows on the spine; a write violating a declared FK fails; pins green. | L |
| S2 | DO referential spine | Same as S1 for the DO catalogue (70 tables), incl. the shared `mas_*` tables and the `mas_reports` parameterized DDL. `PRAGMA foreign_keys` in the DO adapter path. | Zero orphan rows on the DO spine; FK-violating writes fail; pins green. | M |
| S3 | Key atomization | Replace the three encoded keys with composite PKs (or surrogate + UNIQUE natural key): `job_pipeline_artifacts (run_id, artifact_key)`, `job_pipeline_definition_versions (job_id, version)`, `agent_price_catalogue (product_id, segment, version)` (the UNIQUE index already exists — promote it). Update the Repository-core id helpers and all three adapters + in-memory adapter. Backfill is a no-op (components already stored as columns). | No `:` / `\u0001` / `cat-…` encoded keys remain; adapters + pins green. | M |
| S4 | Join tables for JSON arrays of FKs | `agent_product_bundles.member_product_ids` → `agent_bundle_members (bundle_id, product_id)`; `agent_calibration_decisions.falsifying_outcome_ids_json` → `agent_calibration_falsifying_outcomes`; `mas_index_lists.members_json` → `mas_index_members`; `agent_bulk_moves.target_version_ids_json` → `agent_bulk_move_targets`. Each with FKs both ways; migration backfills from the JSON; readers rewritten; JSON columns dropped after the backfill verifies. | JSON arrays gone; join tables carry FKs; backfill verified row-for-row. | L |
| S5 | Derived counters | Per counter (F7): either drop the column and compute at read, or keep it with a reconciliation pin (counter == recomputed). Click/impression/earning counters and `redemption_count` are the candidates; `dte` is computed or dropped. | No counter without a rule (computed or pinned); `dte` resolved. | M |
| S6 | Domain integrity | One timestamp convention (migrate the minority: ISO TEXT → epoch ms, or epoch ms → ISO — decided in S0); run-id domain unification (TEXT run ids vs INTEGER `job_run_records.id`; `linked_job_run_id` type fix); `tenant_id`/`user_id` reference tables *or* a recorded boundary decision (identity plane owns the master; data layer references it by key only — with the key format pinned). Stale `agent_tenant_settings` defaults corrected (data_provider_id/broker_id). | One timestamp type; one run-id domain; tenant/user reference rule recorded + enforced or explicitly bounded. | L |
| S7 | Status vocabularies + the PK gap | CHECK constraints (or FKs to small vocabulary tables) for `status`/`state`/`kind` per family, following the existing validate-by-name pattern; add a PK to `resource_sql_ops` (e.g. `(ts_ms, ns, op, caller)` or a surrogate — decided in S0). | Invalid status strings un-storable; every table has a PK. | S–M |
| S8 | EAV decision + close-out | Rule the settings stores (EAV keep vs typed columns per key family); record the accepted-denormalization list in the data-model doc; final census re-run (orphans, JSON arrays, PK-less tables, unconstrained vocabularies) proving the layer is at least 3NF except the named acceptances; §15 on the parent. | Final census clean except named acceptances; parent closed with §15. | S |

Sequencing notes: S0 first (decisions gate everything). S1 before S2 (D1 is the default store; the DO spine follows the same policy). S3 can run parallel to S1/S2 (disjoint files) but merges one at a time. S4 after S1 (join tables need the FK policy). S6's timestamp/run-id decisions come from S0 but the migration can land after S1. S8 last by construction.

## Appendix A — D1 table inventory (generated from `src/data/drizzleSchema.ts` + `src/data/schemaComponent/d1Catalogue.ts`)

106 tables. PK: single or composite as shown. FK: none on any table. UNIQUE/CHECK: only the rows noted; all other tables carry PK + NOT NULL only.


### D1 — 106 tables (PK / FK / UNIQUE-CHECK)

| table | PK | FK | UNIQUE / CHECK |
|---|---|---|---|
| `agent_governance` | id | none | — |
| `agent_chains` | id | none | — |
| `agent_shard_jobs` | COMPOSITE(tenantId, chainId, jobKey, version) | none | — |
| `agent_synthesized_schedules` | id | none | — |
| `agent_chain_audit` | id | none | — |
| `agent_reports` | COMPOSITE(tenantId, reportId, version) | none | — |
| `agent_market_nodes` | COMPOSITE(tenantId, nodeType, nodeKey) | none | — |
| `agent_market_edges` | COMPOSITE(tenantId, fromType, fromKey, relation, toType, toKey, ) | none | — |
| `agent_thesis_realizations` | COMPOSITE(tenantId, outcomeId) | none | — |
| `agent_calibration_decisions` | id | none | — |
| `_migrations` | version | none | — |
| `agent_commercial_accounts` | id | none | — |
| `agent_tenant_settings` | tenantId | none | — |
| `agent_tenant_channels` | tenantId | none | — |
| `agent_tenant_projection_carriers` | tenantId | none | — |
| `agent_onboarding_state` | userLogin | none | — |
| `agent_user_profiles` | userLogin | none | — |
| `agent_profile_idempotency_keys` | idempotencyKey | none | — |
| `agent_free_run_allowances` | family | none | — |
| `agent_free_run_counts` | COMPOSITE(userLogin, family, month) | none | — |
| `agent_approved_free_quotas` | family | none | — |
| `agent_approved_free_quota_counts` | COMPOSITE(tenantId, userLogin, family, period) | none | — |
| `agent_approved_free_quota_settings` | id | none | — |
| `agent_credit_claims` | creditRunId | none | — |
| `agent_paid_submissions` | workflowId | none | — |
| `agent_credit_redemptions` | creditRunId | none | — |
| `agent_refund_policy` | id | none | — |
| `agent_refunds` | id | none | — |
| `agent_subscriptions` | id | none | — |
| `agent_product_bundles` | id | none | — |
| `agent_bundle_purchases` | id | none | — |
| `agent_bundle_entitlements` | id | none | — |
| `agent_billing_policy` | key | none | — |
| `agent_cfpay_channel_purchases` | id | none | — |
| `agent_top_up_drafts` | id | none | — |
| `agent_billing_customers` | userId | none | — |
| `agent_journal_accounts` | code | none | — |
| `agent_journal_entries` | id | none | — |
| `agent_payment_proof_redemptions` | redemptionKey | none | — |
| `agent_native_ledger_rows` | id | none | — |
| `agent_referral_rules` | id | none | — |
| `agent_referral_earnings` | id | none | — |
| `agent_referral_attributions` | referredUserId | none | — |
| `agent_store_operators` | login | none | — |
| `agent_notification_preferences` | userId | none | — |
| `agent_digest_sends` | COMPOSITE(userId, day) | none | — |
| `agent_digest_subscriber_emails` | userId | none | — |
| `agent_digest_pass_days` | day | none | — |
| `agent_price_catalogue` | id | none | — |
| `agent_subscription_plans` | id | none | — |
| `agent_products` | id | none | — |
| `agent_offer_suppressions` | COMPOSITE(login, trigger) | none | — |
| `agent_runs_pack_versions` | id | none | — |
| `agent_runs_pack_balances` | login | none | — |
| `agent_runs_pack_drafts` | id | none | — |
| `agent_free_access_grants` | id | none | — |
| `agent_referral_code_rules` | id | none | — |
| `agent_referral_codes` | id | none | UNIQUE |
| `agent_code_redemptions` | id | none | — |
| `agent_code_redemption_counts` | COMPOSITE(codeId, redeemerLogin) | none | — |
| `agent_code_run_balances` | login | none | — |
| `agent_version_moves` | id | none | — |
| `agent_bulk_moves` | id | none | — |
| `agent_audit_policy_actions` | action | none | — |
| `agent_audit_policy_settings` | key | none | — |
| `agent_audit_chain` | id | none | — |
| `agent_trace_records` | id | none | — |
| `agent_proposals` | id | none | — |
| `agent_proposal_transitions` | id | none | — |
| `agent_fleet_registry` | agentKey | none | — |
| `agent_conformance_cells` | COMPOSITE(agentKey, dimension) | none | — |
| `agent_work_item_events` | COMPOSITE(source, externalId) | none | — |
| `agent_data_providers` | id | none | — |
| `agent_data_provider_routes` | capability | none | — |
| `agent_data_captures` | id | none | — |
| `agent_iv_history` | COMPOSITE(symbol, date) | none | — |
| `agent_categories` | id | none | — |
| `agent_referrals` | id | none | — |
| `agent_ads` | id | none | — |
| `agent_external_ads` | id | none | — |
| `quote_source_setting` | id | none | — |
| `resource_sql_ops` | NONE | none | — |
| `resource_daily_rollups` | COMPOSITE(day, ns, op, caller, trigger) | none | — |
| `resource_alert_state` | COMPOSITE(budget, day) | none | — |
| `resource_comparison_reports` | day | none | — |
| `agent_mesh_trace_hops` | COMPOSITE(traceId, spanId) | none | — |
| `agent_mesh_eval_results` | COMPOSITE(runId, taskId) | none | — |
| `agent_mesh_proposals` | id | none | — |
| `agent_dead_letter_records` | id | none | — |
| `dlq_depth_state` | id | none | — |
| `agent_breaker_state` | providerId | none | — |
| `breaker_trip_alerts` | transitionId | none | — |
| `job_pipeline_definitions` | jobId | none | — |
| `job_pipeline_definition_versions` | id | none | — |
| `job_pipeline_instances` | jobId | none | — |
| `job_pipeline_artifacts` | id | none | — |
| `job_run_records` | id | none | — |
| `agent_async_jobs` | jobId | none | — |
| `agent_usage_events` | id | none | — |
| `job_enriched_datasets` | id | none | — |
| `job_analyzed_datasets` | id | none | — |
| `job_generated_datasets` | id | none | — |
| `job_delivery_datasets` | id | none | — |
| `mas_feed_datasets` | id | none | — |
| `mas_index_lists` | id | none | — |
| `otel_config_overrides` | COMPOSITE(configKey, version) | none | — |

### DO — 70 tables (PK / FK / UNIQUE-CHECK)

| table | PK | FK | UNIQUE / CHECK |
|---|---|---|---|
| `iaaa_audit_events` | seq | none | — |
| `job_analyzed_datasets` | id | none | — |
| `job_delivery_datasets` | id | none | — |
| `job_enriched_datasets` | id | none | — |
| `job_generated_datasets` | id | none | — |
| `job_pipeline_artifacts` | id | none | — |
| `job_pipeline_definition_versions` | id | none | — |
| `job_pipeline_definitions` | job_id | none | — |
| `job_pipeline_instances` | job_id | none | — |
| `job_run_records` | id | none | — |
| `job_stage_events` | id | none | UNIQUE |
| `kv_store` | COMPOSITE(ns, key) | none | — |
| `mas_adaptation_audit` | id | none | — |
| `mas_agent_workspace_files` | COMPOSITE(user_login, path) | none | — |
| `mas_async_jobs` | job_id | none | — |
| `mas_autopilot` | key | none | — |
| `mas_challenger_approvals` | id | none | — |
| `mas_challenger_promotions` | id | none | — |
| `mas_challengers` | id | none | — |
| `mas_comparison_arm_outcomes` | id | none | — |
| `mas_data_captures` | id | none | — |
| `mas_data_provider_routes` | capability | none | — |
| `mas_data_providers` | id | none | — |
| `mas_discovery_alerts` | id | none | UNIQUE |
| `mas_discovery_runs` | id | none | — |
| `mas_discovery_setup_runs` | id | none | — |
| `mas_do_schema_marker` | id | none | — |
| `mas_enrichment_runs` | id | none | — |
| `mas_feed_snapshots` | id | none | — |
| `mas_goals` | id | none | — |
| `mas_index_lists` | id | none | — |
| `mas_iv_history` | COMPOSITE(symbol, date) | none | — |
| `mas_job_outcomes` | id | none | — |
| `mas_job_outcomes_meta` | k | none | — |
| `mas_opportunity_scans` | id | none | — |
| `mas_outcome_tracking` | id | none | — |
| `mas_outcomes` | id | none | — |
| `mas_policy_verdicts` | id | none | — |
| `mas_report_confirmations` | id | none | — |
| `mas_reports` | id | none | — |
| `mas_run_aliases` | alias | none | — |
| `mas_runs` | run_id | none | — |
| `mas_scenarios` | id | none | — |
| `mas_schema_migrations` | COMPOSITE(store, version) | none | — |
| `mas_screener_presets` | id | none | — |
| `mas_screening_activity` | id | none | — |
| `mas_settings` | key | none | — |
| `mas_strategy_bank_active` | id | none | — |
| `mas_strategy_bank_proposals` | id | none | — |
| `mas_strategy_gates` | strategy | none | — |
| `mas_strategy_profiles` | id | none | — |
| `mas_strategy_reviews` | id | none | — |
| `mas_strategy_weight_caps` | strategy | none | — |
| `mas_strategy_weight_versions` | id | none | — |
| `mas_strategy_weights_v2` | COMPOSITE(strategy, regime) | none | — |
| `paused_schedules` | id | none | — |
| `pending_schedule_approvals` | id | none | — |
| `research_evaluations` | id | none | — |
| `research_runs` | run_id | none | — |
| `research_settings` | key | none | — |
| `research_task_store` | key | none | — |
| `screen_run_locks` | COMPOSITE(user_login, universe) | none | — |
| `stock_copilot_activity` | id | none | — |
| `stock_copilot_control` | user_login | none | — |
| `stock_copilot_learnings` | id | none | — |
| `stock_copilot_positions` | id | none | — |
| `unified_schedules` | id | none | — |
| `usage_events` | id | none | — |
| `user_request_quota_charges` | COMPOSITE(tenant_id, user_login, window_kind, window_key, run_id) | none | — |
| `user_request_quota_overrides` | id | none | — |

### ORM catalogue — shared `mas_*` tables (PK / FK)

| table | PK | FK |
|---|---|---|
| `mas_ads` | id | none |
| `mas_categories` | id | none |
| `mas_events` | id | none |
| `mas_external_ads` | id | none |
| `mas_memory` | key | none |
| `mas_messages` | id | none |
| `mas_options_chain_cache` | id | none |
| `mas_promotions` | id | none |
| `mas_referrals` | id | none |
| `mas_trades` | id | none |
| `mas_transactions` | id | none |
| `mas_watchlists` | id | none |
| `webhook_replay_nonces` | nonce | none |

### Remainder catalogue — 8 tables (DDL lives here, not in the D1 catalogue)

| table |
|---|
| `job_pipeline_definitions` |
| `job_pipeline_instances` |
| `mas_cancel_previews` |
| `mas_delivery_claims` |
| `mas_feed_datasets` |
| `mas_ladder_states` |
| `mas_learnings` |
| `mas_stage_claims` |
