# #4282 Survey — Externalize all DDL and DML

**Base:** origin/main `ec614e69` (`[One engine] #3550 S-stage-visibility`, PR #4357), verified by mirror fetch in `~/workspace/w3667/wt-ship-4250`. Read-only survey; no code changes, no GitHub writes.
**Issue:** #4282 (sub-issue of #798; Size Large / Priority Medium; body `~/workspace/wrecreate/issue-data-layer-recreation.md`). User directive: "no code creates its own schema — the schema must be created outside the code that uses it; all DDL/DML externalized with statement codes and AOP-logged; DDL removed from using code only after the component proves it."
**Method:** `git grep` / `git show` against the exact tip in the mirror (no worktree). Counts are **grep-line counts** unless marked "executable". A line counts once per pattern even if the statement spans lines; a statement assembled from template interpolation (`CREATE TABLE IF NOT EXISTS ${TABLE}`) counts only if the literal pattern appears on the line — see §1.4 for what this misses.

## 0. Verdict in one paragraph

The DDL estate is larger and more fragmented than the issue's filing measure, but it is already **port-shaped and mostly single-homed per family** — the component has real seams to build on. D1 is owned by one versioned runner (`migrationRunner.ts`, 96 tables); DO tables are owned per-adapter through `ensureSchema()` with **no versioned runner at all**; the ORM core owns 12 shared tables with a drift pin; and 17 more tables live in services/orchestrator/ports/trading/enrichment stores. Raw-SQL DML is concentrated in the DO adapters (133 lines) while D1 is Drizzle-builder-dominant (134 builder vs 32 raw) — the two planes need **different catalogue entry shapes**, and that shape decision belongs to #3260, which is still open. The Data Lifecycle surface (#3250) already implements the exact operator contract the recreate operation needs (preview → confirm → audit), and the seed pattern already exists as guarded, idempotent operator routes. The load-bearing risks are: template-assembled DDL invisible to grep pins, `ALTER TABLE` reconciliation DDL the census never named, a silent-degrade index path, and the non-SQL layers (Vectorize re-index, corpus seed bytes, queues) that **cannot** be recreated from a route today and must report honestly.

## 1. DDL census (re-measured on ec614e69)

### 1.1 Totals — confirming the movement

| Measure | Issue filing (Nov 12) | 059a4794 (#4312 merge, Nov 12) | **ec614e69 (this survey)** |
|---|---|---|---|
| Files with `CREATE TABLE` | 71 | 71 | **71** |
| `CREATE TABLE` lines | 205 | 206 | **210** |
| `CREATE INDEX` lines (plain) | 103* | 94 | **95** |
| `CREATE UNIQUE INDEX` lines | (in the 103*) | ~9 | **9** |
| Files with any of the three | — | — | **76** |
| Files with `CREATE INDEX` (plain) | — | 33 | **33** |
| `ALTER TABLE` lines | not counted | not counted | **95 (14 files)** |

\* The issue's "103 CREATE INDEX" is reproducible only as **plain + UNIQUE index lines combined**: 94 + 9 = 103 at 059a4794. On the tip the same methodology gives **95 + 9 = 104**. The parent brief's "210 / 95" is plain-`CREATE INDEX` only. Both are reported here so the next measurement can be compared either way.

**What moved between 059a4794 and ec614e69: +4 TABLE, +1 INDEX, all in `src/data/migrationRunner.ts`** (92→96 TABLE, 44→45 INDEX; same 71/33 file sets; adapter-owned DDL unchanged). The 4 new tables: `agent_free_access_grants`, `agent_runs_pack_balances`, `agent_runs_pack_drafts`, `agent_runs_pack_versions`; the +1 index: `agent_free_access_grants_login_idx`. (All four are the #4357-adjacent agent-runs-pack migrations; the survey did not re-derive their migration numbers.)

### 1.2 Executable vs comment/log mentions

Of the 210 `CREATE TABLE` lines, **25 are comment mentions** (block-comment `*` / `//` lines naming a statement, e.g. in `ormSchema.ts`, `ormFacade.ts`, `migrationRunner.ts` headers) → **≈185 executable TABLE lines**. Of the 95 plain `CREATE INDEX` lines, **4 are comments** → **≈91 executable**. Of the 9 `CREATE UNIQUE INDEX` lines, **1 is a log message** (`doSqliteCanonicalReportStoreAdapter.ts:146`) → **8 executable**. **Executable DDL total ≈ 284 lines** (185 + 91 + 8), plus 95 `ALTER TABLE` lines (see §1.4).

### 1.3 Family breakdown (grep-line counts, comments included)

| Family | Files | CREATE TABLE | CREATE INDEX | CREATE UNIQUE INDEX |
|---|---|---|---|---|
| D1 authority — `migrationRunner.ts` | 1 | 96 | 45 | 7 |
| DO adapters/stores (`doSqlite*`, `doSession*`, `doSchema*`) | 48 | 76 | 35 | 2 |
| D1 adapters (`d1*.ts` with DDL) | 7 | 9 | 0 | 0 |
| ORM shared `mas_*` — `ormSchema.ts` | 1 | 9 (7 real + 2 comments) | 0 | 0 |
| ORM-only tables — `ormFacade.ts` | 1 | 6 (5 real + 1 comment) | 0 | 0 |
| Services stores | 5 | 5 | 2 | 0 |
| Other `src/data` | 3 | 3 | 0 | 0 |
| Orchestrator | 2 | 2 | 1 | 0 |
| Ports/config | 2 | 2 | 0 | 0 |
| Enrichment store | 1 | 1 | 0 | 0 |
| Trading store | 1 | 1 | 0 | 0 |
| Index-schema modules | 4 | 0 | 12 | 0 |
| **Totals** | **76** | **210** | **95** | **9** |

Per-file leaders: TABLE — `migrationRunner.ts` 96, `ormSchema.ts` 9, `ormFacade.ts` 6, `doSqliteJobPipelineAdapter.ts` 5, `doSqliteResearchStoreAdapter.ts` 4, `doSqliteChallengerAdapter.ts` 4. INDEX — `migrationRunner.ts` 45, `frameworkQueueIndexSchema.ts` 5, `doSqliteAsyncJobAdapter.ts` 4, `masRetentionIndexSchema.ts` 3, `doSqliteGoalScenarioAdapter.ts` 3.

**Table-name overlap:** `migrationRunner.ts` declares 94 distinct tables; adapter DDL (excl. migrationRunner/ormSchema/ormFacade) declares 47 distinct names; only 5 overlap — `quote_source_setting`, `resource_alert_state`, `resource_comparison_reports`, `resource_daily_rollups`, `resource_sql_ops` (all D1 resource family). 42 adapter-only names, mostly `mas_*` DO tables. **Interpretation: migrationRunner is the D1 authority; DO tables are adapter-only — no DO migration runner exists.**

D1-adapter DDL files (7): `d1AuditReportAdapter.ts` 1, `d1FeedDatasetAdapter.ts` 1, `d1IndexListAdapter.ts` 1, `d1ProfileAdapter.ts` 1, `d1QuoteSourceAdapter.ts` 1, `d1ResourceRollupAdapter.ts` 3, `d1ResourceUsageAdapter.ts` 1. The other 46 `d1*.ts` files (of 53) carry **no DDL** — they run Drizzle builder calls against migrationRunner-owned tables.
Index-schema modules (4 files, 12 INDEX, 0 TABLE): `frameworkQueueIndexSchema.ts` 5, `masRetentionIndexSchema.ts` 3, `unifiedScheduleIndexSchema.ts` 2, `jobRunRecordIndexSchema.ts` 2.

### 1.4 What a literal grep pin misses (census corrections)

1. **`CREATE UNIQUE INDEX` is not matched by a `CREATE INDEX` grep** (9 lines, 2 files). Any grep pin must list all three patterns (TABLE / INDEX / UNIQUE INDEX) — the issue's acceptance ("zero CREATE TABLE/INDEX in using code") is ambiguous on UNIQUE; the pin must name it explicitly.
2. **Template-assembled DDL is invisible to the grep.** `doSqliteCanonicalReportStoreAdapter.ts:56` builds the mas_reports table as `` `CREATE TABLE IF NOT EXISTS ${TABLE} (...)` `` — the literal `CREATE TABLE IF NOT EXISTS mas_reports` never appears. The census counts it (the `CREATE TABLE` literal is on the line), but a **name-based** reconciliation (does the catalogue contain `mas_reports`?) would miss it, and so would a pin that greps for table names. The catalogue must hold the `${TABLE}`-parameterized form, or the adapter must be rewritten to a literal. Same shape in `src/agents/routes/orchestratorMigration.ts` (`` `INSERT OR REPLACE INTO ${table} (...)` `` — DML, §2.4).
3. **`ALTER TABLE` is DDL the census never named: 95 lines, 14 files.** DO adapters reconcile shape additively (`ALTER TABLE … ADD COLUMN …`, e.g. `doSqliteAsyncJobAdapter.ts` adds `parent_job_id`, `job_kind`, `channel`, `not_before`; `doSqliteCanonicalReportStoreAdapter.ts:127` drops/recreates the generation index). The catalogue must own these reconciliation statements too, with their ordering rules (base CREATE first, then ALTERs, then indexes).
4. **The `mas_reports` home moved since #389.** `ormSchema.ts`'s header still says mas_reports DDL "lives only in `src/services/scheduledReports.ts`" — stale. Today `scheduledReports.ts` holds only the seam (`ensureScheduledReportsTable` → `storePorts(sql).write.ensureSchema()`, `scheduledReports.ts:155-179`); the DDL lives in `doSqliteCanonicalReportStoreAdapter.ts:55-56` (`ensureSchema`), with the guarded tenant-scoped generation UNIQUE index at `:142` and a `DROP INDEX` of the pre-#2398 global shape at `:127`. The header comment must be corrected in the build, not the survey.
5. **Drizzle-mapped tables don't create themselves.** `drizzleSchema.ts` (1857 lines) maps tables via `sqliteTable` but creates none; mapping↔DDL agreement is pinned by a test (see §3.2). Its header's "migration 0001" phrasing is stale — the runner now has migrations 0001–0065.

### 1.5 Full census table (file, family, counts)

| File | Family | CREATE TABLE | CREATE INDEX | CREATE UNIQUE INDEX |
|---|---|---|---|---|
| `src/data/migrationRunner.ts` | D1-authority | 96 | 45 | 7 |
| `src/data/ormSchema.ts` | ORM-shared | 9 | 0 | 0 |
| `src/data/doSqliteCanonicalReportStoreAdapter.ts` | DO-adapter | 2 | 2 | 2 |
| `src/data/doSqliteGoalScenarioAdapter.ts` | DO-adapter | 3 | 3 | 0 |
| `src/data/doSqliteJobPipelineAdapter.ts` | DO-adapter | 5 | 1 | 0 |
| `src/data/ormFacade.ts` | ORM-only | 6 | 0 | 0 |
| `src/data/doSqliteAsyncJobAdapter.ts` | DO-adapter | 1 | 4 | 0 |
| `src/data/frameworkQueueIndexSchema.ts` | Index-schema | 0 | 5 | 0 |
| `src/data/doSqliteChallengerAdapter.ts` | DO-adapter | 4 | 0 | 0 |
| `src/data/doSqliteResearchStoreAdapter.ts` | DO-adapter | 4 | 0 | 0 |
| `src/data/doSqliteUnifiedScheduleAdapter.ts` | DO-adapter | 2 | 2 | 0 |
| `src/data/d1ResourceRollupAdapter.ts` | D1-adapter | 3 | 0 | 0 |
| `src/data/doSqliteIndexListAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteIvHistoryAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteJobOutcomeAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteJobRunRecordAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteProviderCaptureAdapter.ts` | DO-adapter | 1 | 2 | 0 |
| `src/data/doSqliteProviderConfigAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteScanRunAdapter.ts` | DO-adapter | 2 | 1 | 0 |
| `src/data/doSqliteStockCopilotSurfaceAdapter.ts` | DO-adapter | 3 | 0 | 0 |
| `src/data/doSqliteStrategyReviewAdapter.ts` | DO-adapter | 1 | 2 | 0 |
| `src/data/masRetentionIndexSchema.ts` | Index-schema | 0 | 3 | 0 |
| `src/services/learnings.ts` | Services-store | 1 | 2 | 0 |
| `src/agents/orchestrator/asyncJobs.ts` | Orchestrator | 2 | 0 | 0 |
| `src/data/doSessionStoreAdapter.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/doSqliteAdaptationAuditAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteAnalyzedDatasetAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteDeliveryDatasetAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteDiscoveryRunAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteDiscoverySetupAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteEnrichedDatasetAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteEnrichmentAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteFeedSnapshotAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteGeneratedDatasetAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqlitePausedScheduleAdapter.deprecated.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/doSqlitePendingScheduleApprovalsAdapter.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/doSqlitePolicyVerdictAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteScreeningActivityAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteStrategyPolicyAdapter.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/doSqliteStrategyProfileAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteStrategyWeightsAdapter.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/doSqliteUsageEventAdapter.ts` | DO-adapter | 1 | 1 | 0 |
| `src/data/doSqliteUserRequestQuotaAdapter.ts` | DO-adapter | 2 | 0 | 0 |
| `src/data/jobRunRecordIndexSchema.ts` | Index-schema | 0 | 2 | 0 |
| `src/data/unifiedScheduleIndexSchema.ts` | Index-schema | 0 | 2 | 0 |
| `src/agents/orchestrator/alarmInventory.ts` | Orchestrator | 0 | 1 | 0 |
| `src/config/schemaMigrationModes.ts` | Ports/config | 1 | 0 | 0 |
| `src/data/d1AuditReportAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/d1FeedDatasetAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/d1IndexListAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/d1ProfileAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/d1QuoteSourceAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/d1ResourceUsageAdapter.ts` | D1-adapter | 1 | 0 | 0 |
| `src/data/deliveryClaimsStore.ts` | Other-data | 1 | 0 | 0 |
| `src/data/doSchemaMarker.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSchemaMigrations.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteAutopilotStateAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteComparisonLedgerAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteDiscoveryAlertAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteOrmAdapters.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteOutcomeTrackingAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteReportConfirmationAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteReselectionAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteScreenRunLockAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteScreenerPresetAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteStockCopilotStoreAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/doSqliteWorkspaceStoreAdapter.ts` | DO-adapter | 1 | 0 | 0 |
| `src/data/indexListPorts.ts` | Other-data | 1 | 0 | 0 |
| `src/data/stageClaimsStore.ts` | Other-data | 1 | 0 | 0 |
| `src/enrichment/enrichmentStore.ts` | Enrichment-store | 1 | 0 | 0 |
| `src/ports/schemaMigration.ts` | Ports/config | 1 | 0 | 0 |
| `src/services/asyncJobGate.ts` | Services-store | 1 | 0 | 0 |
| `src/services/cancelPreviewStore.ts` | Services-store | 1 | 0 | 0 |
| `src/services/feedSnapshotStore.ts` | Services-store | 1 | 0 | 0 |
| `src/services/ladderStateStore.ts` | Services-store | 1 | 0 | 0 |
| `src/trading/options/scanRunStore.ts` | Trading-store | 1 | 0 | 0 |
| **TOTALS** | all | **210** | **95** | **9** |

## 2. DML inventory per family

Method: lines matching `INSERT INTO|INSERT OR|DELETE FROM|UPDATE <table> SET|REPLACE INTO` (raw SQL) and lines matching `.insert(|.update(|.delete(` (Drizzle builder) — **line counts, not statement counts**; a multi-line statement counts once per matching line, and `INSERT OR REPLACE INTO` matches two raw patterns at once. Builder counts are an **upper bound** — `.delete(` is polluted by Map/KV deletes (e.g. `actorSessionStore.ts`) and by non-DB builder uses elsewhere in src/. Family globs are disjoint; `ALL src` totals include files outside the families.

| Family | Raw-DML lines | Drizzle-builder lines | Idiom |
|---|---|---|---|
| D1 adapters (`src/data/d1*.ts`, 53 files) | 32 | 134 | **Drizzle-dominant** |
| DO adapters (`doSqlite*` + `doSession*` + `doSchema*`, 51 files) | 133 | 8 | **Raw-SQL-dominant** |
| ORM core (`src/data/orm*.ts` + `src/orm/*`) | 2 | 3 | Mixed, tiny |
| Ports / createPorts (`*Ports.ts`) | 14 | 1 | Named raw statement templates |
| Other `src/data` stores | 25 | 15 | Mixed |
| Services stores (`*Store*.ts`) | 5 | 1 | Raw-leaning |
| Orchestrator (`src/agents/orchestrator/*`) | 1 | 2 | Mostly moved to ports already |
| Trading (`src/trading/**`) | 0 | 13 | Builder-only |
| Enrichment (`src/enrichment/*`) | 0 | 0 | No SQL DML |
| **ALL src/** | **224** | **376** | — |

### 2.1 The three mechanisms (#3260) — confirmed on the tip

#3260 (OPEN) names the same three-way split, measured on 07f6df65 (2026-11-05) and still true on ec614e69:

1. **Drizzle adapters** — 57 files in src/ import `drizzle-orm`; all D1 adapters. `d1*.ts` also carry 27 `sql\`` template-tag lines (raw fragments inside builder calls).
2. **Bespoke mini-ORM** — ~2,100 lines (`ormRepositoryCore.ts`, `ormFacade.ts`, `ormSchema.ts`, `createOrmPorts.ts`, `doSqliteOrmAdapters.ts`, `inMemoryOrmAdapters.ts`); 13 files build on it; serves the generic repository-shaped families identically over D1, DO SQLite and in-memory stores.
3. **Hand-written SQL adapters** — the DO-plane families with named statement templates, plus a few D1 adapters on the raw prepare API (`d1ResourceRollupAdapter`, `d1ResourceUsageAdapter`, `d1QuoteSourceAdapter` — the exact three #3260 names as accidental divergence).

DO execution idiom (verified in `doSqliteAsyncJobAdapter.ts`): `this.sql.exec(\`…\`)` against the DO `SqlStorage` executor, `ensureSchema()` per adapter as "the family's ONE schema home", DML via raw strings with `rowsWritten` cursor checks (`claim()`'s guarded `AND status = 'queued'` UPDATE, verified by the cursor — audit R-7). No `prepare(` API in the DO adapters; the earlier "10" count for prepare/run/sql-tag was a broken-awk artifact and is withdrawn.

### 2.2 Which families use what

- **D1 plane: builder-first.** 134 builder vs 32 raw lines. The 32 raw lines are concentrated in the three raw-prepare adapters above plus `sql\`` fragments. DML catalogue entries for D1 should be **builder-shaped** (or the raw-prepare adapters migrate to the builder first per #3260).
- **DO plane: raw-first.** 133 raw vs 8 builder lines. Catalogue entries for DO should be **named raw statement templates**, following the existing pattern in the `*Ports.ts` files (e.g. `ACTIVE_JOB_PAYLOADS_SQL`, `LIST_RUNNING_SQL` in `asyncJobPorts.ts` — 14 raw lines in Ports files are exactly these templates).
- **ORM core: neither dominant.** 2 raw / 3 builder — the mini-ORM generates its statements; its DML is the repository methods, not SQL strings. Catalogue entries here are method-level (operation + table + predicate), not SQL text.
- **Trading: builder-only** (13 builder, 0 raw). **Enrichment: no SQL DML at all.**

### 2.3 Seed DML lives inside the migrations

`migrationRunner.ts` carries **5 executable seed-DML lines** inside migration SQL strings, plus ~7 comment mentions: `INSERT OR IGNORE INTO agent_referral_rules …` (default rule), `INSERT OR IGNORE INTO agent_free_run_allowances …`, `UPDATE agent_subscription_plans SET approval_status = 'approved' …`, `INSERT OR IGNORE INTO agent_approved_free_quotas …`, `INSERT OR IGNORE INTO agent_approved_free_quota_settings …`. The runner's own comments state the rule these seeds follow: seeded DATA, never a code constant; `INSERT OR IGNORE` never overwrites, so an operator edit survives. The catalogue must **separate seed DML from schema DDL** (different entry kind, different recreate semantics: seeds are idempotent inserts, DDL is schema).

### 2.4 DML outside the store families (must be swept too)

- `src/agents/routes/maintenance.ts` — real DML strings in a route: `deleteRows(sql, "DELETE FROM mas_job_outcomes_meta")` and `deleteRows(sql, "DELETE FROM mas_events")` (the clear-table / Data Lifecycle delete path). Route-held DML the catalogue must own.
- `src/agents/routes/orchestratorMigration.ts` — template-assembled `` `INSERT OR REPLACE INTO ${table} (${cols…}) VALUES …` ``; a static catalogue cannot hold it verbatim — needs a **parameterized statement entry** (table + columns as parameters).
- `src/agents/routes/agenticPayments.ts` — 2 comment mentions only (`INSERT OR IGNORE` in comments).
- `src/data/migrationRunner.ts` — seed DML, §2.3.

## 3. Seams the component builds on (with file:line)

### 3.1 DDL authority — `src/data/migrationRunner.ts` (2634 lines)

- 64 `MIGRATION_*` consts, versions 1–65 (max 65; 0053 absent from the list seen; some out of order in file, e.g. 0026/0027/0029/0034 after 0035, 0048/0049 swapped); `ALL_MIGRATIONS` registry at `:2484`; `_migrations` bookkeeping table owned by the runner.
- Idempotent, marker-last; deliberately NOT wrapped in a multi-statement transaction (D1 `batch()` is the atomic primitive); statements split on `;`, so no semicolons in string literals.
- **Seam:** the runner is already the D1 plane's single executor with a versioned registry — the component catalogues the runner's statements and the runner delegates to the catalogue (or the catalogue absorbs the registry; the issue's acceptance names `migrationRunner.ts` as an allowed remainder, so delegation keeps the acceptance literal).
- **Pin:** `tests/migration_registry.test.ts` owns the "latest" pin (gitops §7 rule 5) — any catalogue change that adds a migration must keep this pin green.

### 3.2 Mapping discipline — `src/data/drizzleSchema.ts` (1857 lines) + `src/data/ormSchema.ts` (208 lines) + `src/data/ormFacade.ts` (746 lines)

- `drizzleSchema.ts` maps D1 tables via `sqliteTable`; mapping↔DDL agreement is pinned by a test (the survey did not re-derive the test's name; the pin discipline is recorded in the file's header and in #1976's conformance story).
- `ormSchema.ts`: canonical DDL strings for 7 shared `mas_*` tables (`mas_messages`, `mas_events`, `mas_memory`, `mas_referrals`, `mas_ads`, `mas_watchlists`, `mas_transactions`) + `ensureSharedTable` / `ensureAuditChainColumns`; drift pin `tests/schema_single_source.test.ts`; documents per-DO coverage (OrchestratorAgent `getOrm()` is the only production `initializeSchema` caller; ORM-only tables `mas_categories`, `mas_external_ads`, `webhook_replay_nonces`, `mas_trades`, `mas_options_chain_cache` live in `ormFacade.ts`).
- `src/orm/index.ts` is a pure re-export shim (0 CREATE TABLE).
- **Seam:** the two drift pins are the pattern the schema-equality pin extends — the component's proof step is a third pin of the same kind, run against a clean instance instead of the source tree.

### 3.3 AOP seams — `src/aspects/loggingAspect.ts` (277 lines) + `src/aspects/transactionAspect.ts` (394 lines)

- `loggingAspect.ts`: `withAspects(context, fn)` — operationName, structured logging via `createStructuredLogger` + observability sink, sandbox URL guard, error translation, sensitive-data sanitization (key/secret/token/password…). **No statement-code registry exists** — the component must supply codes as operationNames (the catalogue's `code` field is the operationName).
- `transactionAspect.ts`: `withTransaction` — DO leg (`storage.transactionSync`, sync-only) + D1 leg (`batch()`, write-only buffered); nested calls join the ambient unit via AsyncLocalStorage; cross-store refused with `TX_CANNOT_HONOUR`.
- **Gap:** `transactionAspect` is **exercised only by `tests/transaction_proof_2288.test.ts`; NO production surface consumes it yet.** The schema component's recreate would be its first production consumer — that is a design decision, not a free seam: the first consumer must also prove the aspect under the recreate's failure modes (partial DDL + partial seed), not merely call it.
- The aspects dir contains only: `errorCodes.ts`, `loggingAspect.ts`, `nodeAsyncHooks.d.ts`, `transactionAspect.ts`.

### 3.4 Operator surface — #3250 Data Lifecycle (`src/agents/routes/dataLifecycle.ts`, 2041 lines)

- Routes: `POST /api/data-lifecycle/clean-state` (preview/confirm), `GET /api/data-lifecycle/export` (pre-wipe bundle), `POST /api/data-lifecycle/tenant-bootstrap` (preview/confirm). Preview→confirm binding via SHA-256 previewToken; platform scope needs confirmText `"CLEAN PLATFORM"` + auditConfirm; audit AFTER writes.
- Clean targets: `TENANT_CLEAN_TARGETS` + `PLATFORM_CLEAN_TARGETS` (KV namespaces, queues, tables). Selective tools keep contracts: `kvWipe` (`routes/kvWipe.ts`), clear-table (`maintenance/clear-table`), queue wipe (`AdminQueueWipePanel`, `adminTenantQueues`).
- UI: `src/client/DataLifecyclePanel.tsx` (preview/export/clear + tenant bootstrap), `src/client/dataLifecycleApi.ts`, `PlatformAdminPage.tsx`.
- **Seam:** the recreate operation slots into this surface as a third operation following the same contract (preview the plan → confirm with token → audit after writes). The issue states the gap this fills: "after a clean-state reset (#3250) the seed data does not come back."
- **Note:** the maintenance route's `deleteRows` DELETE strings (§2.4) are the same surface's delete path — the catalogue owns them, the route calls the catalogue.

### 3.5 Seed pattern — already exists, guarded and idempotent

- `src/data/seedGovernanceRoute.ts` — guarded operator route (POST, platform-admin only; 401 unauthenticated / 403 non-admin with no data; idempotent by construction, second run is a no-op returning `seeded:false`); wired in `src/server/routes/auth.ts:694`; tested by `tests/governance_seed_route.test.ts`. Seed writes the mirror row only, never the DO setting.
- `src/agents/orchestrator/governanceSeed.ts` + `src/agents/orchestrator/canonicalReportSeed.ts` — both mirror DO → AgentDB (governance halt; mas_reports → `agent_reports`), both idempotent no-op on second run, both throw when `AGENT_DB` is unbound ("the caller surfaces the error, never a fabricated result").
- **Seam:** the recreate/seed operation follows this exact shape (guarded route + idempotent execution + honest throw on unbound dependency). No new pattern needs inventing.

### 3.6 Conformance coverage per family (what exists)

Per-family conformance suites exist for most adapter families: async jobs (`tests/async_jobs_step4a_conformance_2358.test.ts`), orchestrator tables (`tests/orchestrator_tables_step4d_conformance_2359.test.ts`), payments (`tests/payments_step4d2_conformance_2360.test.ts`), agent private stores (`tests/agent_private_stores_step4e_conformance_2361.test.ts`), D1 regularization (`tests/d1_regularization_step4f_conformance_2362.test.ts`), ORM (`tests/orm_step3a_conformance_2345.test.ts`), evidence satellites (`tests/evidence_satellites_step4c_conformance_2356.test.ts`), data-provider ports (`tests/data_provider_ports_conformance_2303.test.ts`), options discovery (`tests/options_discovery_ports_conformance_2337.test.ts`), retrieval (`tests/retrieval-ports-conformance.test.ts`), settings (`tests/settings_step4g_conformance_2390.test.ts`), plus agent/actor-ports/observability/feature-flags/mesh suites. **Gap: no conformance suite covers the schema-creation/recreate operation itself** — no suite asserts "recreate from the component reproduces the live schema". That suite is a phase-1/phase-4 deliverable, not an existing seam.

## 4. Gaps (numbered, for the phase plan)

1. **No DO migration runner.** DO tables are created per-adapter via `ensureSchema()` with no versioning, no registry, no ordering. The component must decide: versioned DO registry (new) or delegation of the existing `ensureSchema` calls into the catalogue (no versions). Unresolved — see phase P2.
2. **No schema-equality pin.** Nothing proves a from-scratch build reproduces the live schema. The issue requires it (acceptance: schema-equality pin on a clean instance).
3. **No DDL grep pin in src/.** `tests/` holds DDL only as fixtures (200 `CREATE TABLE` lines in test files, context only). The acceptance grep pin ("0 outside the component + migrationRunner.ts") does not exist yet.
4. **No statement-code registry.** `loggingAspect` takes free-form operationNames; the catalogue's `code` field must be the registry, and the red-team pin ("an uncoded statement cannot execute") needs an enforcement point — today nothing enforces it.
5. **`transactionAspect` has no production consumer** (§3.3). Recreate as first consumer needs its own proof.
6. **Template-assembled DDL/DML** (§1.4.2, §2.4) — `mas_reports` `${TABLE}`, orchestratorMigration `${table}`. The catalogue needs a parameterized-entry form.
7. **`ALTER TABLE` reconciliation** (§1.4.3) — 95 lines, 14 files, additive-only by convention, unordered across adapters. Catalogue must own ordering.
8. **Silent-degrade index path** — `doSqliteCanonicalReportStoreAdapter.ts:142-146`: the generation UNIQUE index failure is logged and execution continues without it. That conflicts with the issue's honest-failure requirement (multi-write atomic or honestly failed, never partial). The component must surface this as a recreate failure (or record the degradation in the recreate report with the reason, never silently).
9. **Stale single-source claims in comments** — `ormSchema.ts` header on mas_reports (§1.4.4); `drizzleSchema.ts` "migration 0001" (§1.4.5). Both must be corrected where the build touches them.
10. **`#3260` open — DML entry shape undecided per plane.** The DML catalogue cannot be written in one style: D1 wants builder-shaped entries, DO wants named raw templates, ORM wants method-level entries. Landing DML before #3260's ADR risks cataloguing the accidental divergence (notably the three raw-prepare D1 adapters).
11. **DO `ensureSchema` callers are scattered** — each adapter owns its own call site; there is no single "ensure all DO schemas" door. The component needs an inventory of call sites (a sub-task of P2), not just of statements.

## 5. Non-SQL layers

| Layer | Binding / instance | What exists in code today | Creatable from a route? |
|---|---|---|---|
| **R2** — `screener` bucket | `REPORTS_BUCKET`, `wrangler.jsonc:50` | `src/services/blobStoreR2Adapter.ts` is the ONLY module calling R2 APIs (put/get/delete/list); everything else goes through the `BlobStore` port (`blobStorePorts.ts`). Report blobs + corpus objects share the bucket (`knowledge/` keys = corpus, excluded from the #1168 orphan sweep by design). `reportBlobStore.ts`, `knowledgeCorpus.ts`, `providerCapturePorts.ts` are consumers. | **Partially.** Objects can be re-put from surviving sources, but there is no "recreate bucket contents" flow. The bucket itself is deploy-time provisioning (wrangler binding), not code. |
| **Vectorize** — `vector-memory` | `wrangler.jsonc:264-267` | `src/memory/vector-memory.ts` (`VectorMemory` class); used via `compositionMemory.ts`, `retrieval/createRetrievalPorts.ts`, `retrieval/vectorMemorySearchAdapter.ts`, chat turn helpers. Index is deploy-time provisioned. | **No.** No re-index / rebuild flow exists. Recreate would mean re-embedding from source rows — no route, no job. Must report honestly as uncreatable (or a re-embed design lands as its own sub-issue). |
| **Queues** | `JOB_PIPELINE_EVENTS` (+DLQ), `SCREENER_EVENTS` (+delivery, +DLQs), `wrangler.jsonc:80-92` | Deploy-time provisioned. Data Lifecycle has a queue-*wipe* tool (`adminTenantQueues`, `AdminQueueWipePanel`) but no queue recreate. | **No — by design.** Queues are provisioning, not content; a route can purge, not provision. Recreate reports them as deploy-time (purgeable, not recreatable). |
| **AI Search** — `screener-search`, namespace `default` | `ai_search_namespaces` binding in wrangler.jsonc; `AI_SEARCH_ENDPOINT` deleted (#3342); consumers via `searchAiSearchNamespaceChunks` (`src/agents/aiSearchPaths.ts`) + `AiSearchAgent` door (`src/agents/aiSearchAgent.ts`, `src/agents/aiSearchDispatch.ts`); store-time index hook `reportAiSearchIndex.ts` (#2246) | R2-backed (`index_source`): the index follows R2 contents. No route can recreate the index directly; it rebuilds from the bucket. Corpus leg blocked on owner uploads (see §6). | **Indirectly only** — via R2 contents + the store-time hook. No direct recreate; report as derived-from-R2. |

## 6. Seeding sources — how they run today

| Source | What it is | How it runs today |
|---|---|---|
| `docs/knowledge-corpus-seed-manifest.json` | Corpus manifest: 4 entries with sha256 + sourceUrl (FINRA 4210 verified 299,665 B; OCC ODD verified 621,097 B; SEC order-types verified 52,750 B; NVIDIA 10-K **blocked-by-source-bot-gate**, sha256 null). | Ingestion via admin upload route `POST /api/knowledge/corpus`: upload bytes from sourceUrl, confirm returned contentHash matches the manifest sha256. **Seed bytes are NOT in the repo** — only hashes + URLs. Owner uploads from the Corpus tab (#1169 tail, owner's action). |
| `src/agents/orchestrator/canonicalReportSeed.ts` | Mirrors current `mas_reports` rows (DO) → AgentDB `agent_reports`. | Invoked as an operator seed; idempotent second-run no-op; throws when `AGENT_DB` unbound. Bounded to current rows, no historical backfill. |
| `src/agents/orchestrator/governanceSeed.ts` + `src/data/seedGovernanceRoute.ts` | Mirrors the governance halt setting (DO) → AgentDB mirror row. | Guarded operator route (POST, platform-admin only), wired `src/server/routes/auth.ts:694`, tested `tests/governance_seed_route.test.ts`. Idempotent, mirror-row only. |
| `migrationRunner.ts` seed DML (§2.3) | 5 executable `INSERT OR IGNORE` / `UPDATE` seed lines inside migrations (referral rules, free-run allowances, subscription plans, free quotas). | Run as part of migrations on D1; `INSERT OR IGNORE` preserves operator edits. |

**Consequence for recreate:** the component can rebuild schema + repo-held seeds + DO→D1 mirrors, but **cannot** restore the corpus from the repo (bytes absent; NVIDIA 10-K not even fetchable automatically). The recreate report must list the corpus as uncreatable-from-repo with the manifest as the source of truth and the upload route as the remedy — an honest-report case, not a gap to paper over.

## 7. Phase proposal (one-PR-sized slices; gitops §5)

Gitops §5 (line 363): "size each sub-issue so all its relevant work completes in a SINGLE PR. If the work does not fit one PR, split the sub-issue — not the PR." Each phase below is one sub-issue under #4282 (native sub-issue relationship, not a body link alone), one PR, in this serial order. The load-bearing sequence from the issue is preserved: externalize + catalogue → prove reproduction → remove DDL → externalize DML per family.

### P0 — Substrate: component + catalogue format + AOP logging + pins (red first)
- **Files:** new `src/data/schemaComponent/` (catalogue types + registry, statement codes, executor, AOP-logged execution via `withAspects`, recreate planner/report); new `tests/schema_component_*` (catalogue-format + grep pins + equality-harness tests). **Must NOT touch** any DDL/DML site, any adapter, migrationRunner, or the Data Lifecycle routes.
- **Size:** ~6 new files; 0 statements migrated. The pins are written **red first**: the grep pin fails on the unmigrated tree (by design — it names the component as the only allowed home), the equality harness runs and reports the full diff.
- **Acceptance pin:** catalogue format reviewed (entry = code + plane + table + constraint/index + statement text + seed-vs-schema kind + parameterized form); `withAspects` operationName = catalogue code on every execution; grep pin exists and enumerates the current violations; equality harness executes against a clean instance and produces a diff report.
- **Unclear:** the catalogue's storage form (in-repo TS module vs a data file the component loads) — resolve by proposing the TS-module form in the sub-issue (it keeps the Gitleaks/typecheck gates) and letting review confirm.

### P1 — D1 catalogue: migrationRunner delegates to the catalogue
- **Files:** `src/data/migrationRunner.ts` + new catalogue D1 section + `tests/migration_registry.test.ts` (latest pin must stay green). **Must NOT touch** DO adapters, `drizzleSchema.ts`, or any DML site.
- **Size:** ~148 statements (96 TABLE + 45 INDEX + 7 UNIQUE) + 5 seed-DML lines catalogued as seed-kind entries; 1 implementation file + catalogue.
- **Acceptance pin:** schema-equality pin green for the D1 plane (catalogue output byte-identical to the runner's current output on a clean D1); `migration_registry` latest pin green; runner still the single D1 executor (delegation, not absorption — the issue's acceptance names migrationRunner as an allowed remainder).
- **Unclear:** none structural; the migration-number ordering quirks (0053 absent, out-of-order consts) are preserved as-is, not repaired here.

### P2a — ORM + index-schema catalogue
- **Files:** `src/data/ormSchema.ts`, `src/data/ormFacade.ts`, 4 index-schema modules, catalogue DO/ORM section; `tests/schema_single_source.test.ts` stays green. **Must NOT touch** the 48 DO adapters or migrationRunner.
- **Size:** ~15 statements (7 + 5 real TABLE, 12 INDEX) + the shared-table / audit-chain helpers as catalogue entries.
- **Acceptance pin:** schema-equality pin green for the ORM-shared + index-schema scope; drift pin green; `ensureSharedTable` / `ensureAuditChainColumns` delegate to the catalogue.

### P2b — DO adapters delegate to the catalogue (mechanical, delegate-only)
- **Files:** the 48 DO adapter/store files + catalogue DO section. **Must NOT touch** migrationRunner, D1 adapters, or any DML statement (delegate-only: `ensureSchema()` bodies become catalogue calls; no logic change, no statement-text change).
- **Size:** ~112 statements (76 TABLE + 35 INDEX + 1 UNIQUE, real counts); 48 files. Large but mechanical — if review finds it unreviewable in one PR, split by adapter group (job-pipeline family / dataset family / remaining) as serial sub-issues under P2b, each with the same acceptance pin.
- **Acceptance pin:** schema-equality pin green per DO (each adapter's `ensureSchema` output identical before/after); all per-family conformance suites green (§3.6); the `ensureSchema` call-site inventory (§4.11) is recorded in the PR.
- **Unclear:** the DO versioning question (§4.1) — P2b as scoped does **not** introduce DO versions; if review requires versions, that becomes a P2c sub-issue (versioned DO registry) before P2b merges. Flag the decision in the sub-issue body.

### P3 — Remaining DDL + reconciliation DDL + parameterized entries
- **Files:** 7 D1-adapter DDL files, 5 services stores, 2 orchestrator files, ports/config files, trading + enrichment stores, catalogue remainder; plus the `ALTER TABLE` reconciliation catalogue (95 lines) and the parameterized entries for `mas_reports` `${TABLE}` and orchestratorMigration `${table}`. Correct the two stale comments (§4.9). **Must NOT touch** migrationRunner's registry or any DML site.
- **Size:** ~26 statements + 95 ALTER lines as ordered reconciliation entries; ~17 files.
- **Acceptance pin:** the grep pin goes green — **zero `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` / `ALTER TABLE` lines outside the component + migrationRunner.ts** (the issue's acceptance, extended to UNIQUE + ALTER per §1.4). Any remaining occurrence is a named exemption with a sub-issue, not a silent pass.

### P4 — Prove reproduction (clean-instance equality + no-op + tenant isolation)
- **Files:** tests only (`tests/schema_equality_*`, `tests/schema_recreate_tenant_*`) + the recreate planner's report format (from P0). **Must NOT touch** any implementation file.
- **Size:** test-only slice.
- **Acceptance pin:** schema-equality pin green on a clean instance for **all** planes (D1 + DO + ORM + index schemas); recreate run twice → second run is a no-op report (zero statements executed, report lists zero changes); tenant-isolation red-team pin green (a recreate in one tenant cannot create/alter another tenant's tables); the silent-degrade index path (§4.8) is either fixed or reported as a recreate failure — never silently continued.
- **Unclear:** the clean-instance harness (fresh D1 + fresh DO per test run) needs a fixture decision — reuse the existing testkit (`tests/async-job-testkit.ts` pattern) or a new minimal harness; resolve in the sub-issue.

### P5 — Recreate UI + route (extends the Data Lifecycle surface)
- **Files:** `src/agents/routes/dataLifecycle.ts` (new recreate operation), `src/client/DataLifecyclePanel.tsx` (new section), `src/client/dataLifecycleApi.ts`, `PlatformAdminPage.tsx` wiring. **Must NOT touch** the clean-state / export / tenant-bootstrap operations' behavior.
- **Size:** ~4 files.
- **Acceptance pin:** UI-driven recreate (preview → confirm → audit, §3.4 contract) rebuilds schema + seeds; second run is a no-op report in the UI; uncreatable layers (Vectorize re-index, corpus bytes, queues) are **reported in the UI with reasons**, never faked as recreated; every statement executed is AOP-logged with its catalogue code.
- **Unclear:** whether the recreate preview lists per-statement codes in the UI or a summary count — propose summary + expandable detail in the sub-issue.

### P6+ — DML per family, sequenced with #3260 (one sub-issue per family)
- **Order:** (a) D1 builder DML → catalogue (builder-shaped entries); (b) DO raw DML → catalogue (named raw templates, Ports pattern); (c) ORM-core DML (method-level entries); (d) route-held DML (`maintenance.ts` DELETEs, orchestratorMigration parameterized entry); (e) migrationRunner seed DML as seed-kind entries (already catalogued in P1 — P6e only removes the inline copies if P1 kept them).
- **Files per slice:** 5–15 files each; **must NOT touch** other families' DML or the DDL catalogue entries.
- **Size per slice:** D1 ~166 lines (134 builder + 32 raw), DO ~141 lines (133 raw + 8 builder), ORM ~5 lines, routes ~3 lines + 1 parameterized entry.
- **Acceptance pin (per family):** grep pin for that family goes green — zero inline raw DML outside the catalogue for the family; conformance suites green; the red-team pin holds (an uncoded statement cannot execute).
- **BLOCKED ON #3260's ADR** for the entry-shape decision (§4.10): file the ADR sub-issue first (or confirm #3260's per-plane standard), and scope P6a to the planes whose standard is already settled. If #3260 is still open when P5 lands, P6 waits — DDL removal (P3) does not depend on it, DML does.

### Phase order summary

| Phase | Slice | Depends on | One-PR size |
|---|---|---|---|
| P0 | Substrate + catalogue + pins (red) | — | ~6 new files |
| P1 | D1 catalogue (migrationRunner delegates) | P0 | 1 file + catalogue, ~153 statements |
| P2a | ORM + index-schema catalogue | P0 | ~6 files, ~15 statements |
| P2b | DO adapters delegate | P0 (+ P2a pattern) | 48 files, ~112 statements |
| P3 | Remaining DDL + ALTER + parameterized | P0–P2b | ~17 files, ~26 + 95 lines |
| P4 | Prove reproduction (tests only) | P3 | test-only |
| P5 | Recreate UI + route | P4 | ~4 files |
| P6a–e | DML per family | P5 + **#3260 ADR** | 5–15 files each |

## 8. Risks and notes for the build

- **Grep-pin methodology is load-bearing and was already bitten twice in this survey's lineage:** `git grep -c` output is `<rev>:<path>:<count>` — `awk -F: '{s+=$2}'` sums the path, not the count (use `| wc -l` for occurrences or `$NF` for counts). And `CREATE UNIQUE INDEX` / `ALTER TABLE` / template-assembled DDL each defeat a naive `CREATE TABLE|CREATE INDEX` pin — the pin must enumerate all five forms (TABLE, INDEX, UNIQUE INDEX, ALTER TABLE, parameterized `${TABLE}`/`${table}` DDL/DML).
- **The "0 outside the component + migrationRunner.ts" acceptance is the P3 gate, not the P0 gate.** P0's pins are red by design; the tree goes green only at P3. Do not declare the acceptance met at P1/P2.
- **Tests carry 200 `CREATE TABLE` lines** (fixtures + testkit). The grep pin must scope to `src/` (and the named route files), or the test fixtures need a documented exemption — decide in P0, don't discover it at P3.
- **Census/baseline discipline (AGENTS.md):** the equality pin's baseline must be seeded and gated from a CLEAN main checkout, never the candidate worktree — the P4 harness must construct its clean instance from the tip, not from the branch.
- **#3260 sequencing is the only cross-issue dependency that can stall the programme:** P0–P5 proceed without it; P6 does not. If #3260's ADR is slow, the DDL half still ships end-to-end.
- **No GitHub writes were made by this survey.** The phases above are proposals for sub-issues under #4282; filing them is the parent's / next step's work.
