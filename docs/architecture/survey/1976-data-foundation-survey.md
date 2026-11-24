# #1976 Design Survey — Drizzle repo-wide data foundation

**Base:** main `972a1ddfe09b2c8075958e4f32e5e912bdfb12a8` (2026-10-29). Read-only survey; every claim cites code at this SHA.
**Inputs:** issue #1976 body (filed by #CAIO-quns) + its 5 comments (handover 6489956147; CDO design direction 6494857135, 6494975721, 6495004422, 6495037697). ADR 0002 (`docs/architecture/adr/data/0002-data-foundation-layer.md`, accepted) is the standing contract this programme extends.

## Headline findings

- **The naked-SQL surface is 94 `.sql.exec(` call sites across 16 files** (see discrepancy note D1 — the recorded direction says 14 files), plus a much larger *indirect* surface: dozens of store modules that receive `ctx.storage.sql` as a parameter and build SQL internally. Counting schema, there are **101 `CREATE TABLE` statements across 38 files** and roughly **90 distinct tables** repo-wide.
- **There are already THREE data-access idioms, not two:** (1) the `src/data/` port+adapter layer over D1 (the model citizen); (2) a hand-rolled repository ORM, `src/orm/` (`DatabaseORM` + generic `Repository<T>` over DO SQLite), which owns the shared `mas_*` tables and is imported by the orchestrator and most routes; (3) per-surface store modules taking a raw `SqlStorage` seam (options/discovery stores, data-provider platform stores, satellite `mas_*` service stores). #1976 is as much a consolidation of (2) and (3) behind (1)'s discipline as it is a Drizzle rollout.
- **Transactions are essentially absent.** `ctx.storage.sql` transaction primitives (`transactionSync`) have **zero** usages in `src/`. The only transactional code in the repo is one KV `storage.transaction(...)` call (screener scheduled-claim, `src/agents/screener-agent.ts:299`) — with a non-transactional get-then-put fallback when the primitive is missing. D1's prescribed atomic primitive, `batch()`, also has **zero** usages; `src/data` adapters avoid needing it via idempotent versioned inserts (PK-conflict = no-op). Multi-write atomicity today is a design pattern (idempotency), not a mechanism.
- **D1 migrations run 0001–0015, not 0001–0006** (discrepancy D2). 13 migrations are registered (`src/data/migrationRunner.ts:590` `ALL_MIGRATIONS`): versions 1–12 plus 15 — versions 13/14 do not exist in the sequence.
- **The intelligence/RSI substrate is fragmented across four stores** (per-DO `mas_events`, the KV-JSON IAAA audit log, D1 telemetry/ledger tables, Analytics Engine) with no unified trace record, no principal attribution on the main event table, and no proposal ledger as such — although two domain proposal flows (champion/challenger, strategy-bank reselection) already implement proposal state machines in the orchestrator DO. Detail in §5.

### Discrepancies between the recorded direction and main (flagged per brief)

- **D1 — file count.** Comment 6495004422: "94 `storage.sql.exec(...)` call sites across 14 files". Measured: 94 sites across **16 files** by `\.sql\.exec(`. The two extra files are pass-through shims: `src/actors/cfAgentsAdapter.ts:40` (exposes `storage.sql.exec` as a callback) and `src/mcp/commands.ts:1514` (one direct `DELETE FROM mas_memory`). Site total (94) is exact.
- **D2 — migration range.** Issue body and MEMORY-derived framing say "migrations 0001–0006". `migrationRunner.ts` registers 0001–0012 + 0015. The body's inventory premise is stale by nine migrations (commercial, subscriptions, journal, paid submissions, price catalogue, native ledger, lifecycle/referral landed after the body was written).
- **D3 — aspect home.** Comment 6494975721 places the founding AOP wrappers "under `src/aspects/`". In code, the higher-order wrappers `withLogging`/`withExceptionHandling`/`withSecurity` live in **`src/errors/errorAspects.ts:76,113,147`**; `src/aspects/` holds `loggingAspect.ts` (aspect *events* + `AspectContext`, :12) and `errorCodes.ts` (the catalog family). The idiom is split across two directories — the ADR must settle the transaction aspect's home explicitly (§6.2).
- **D4 — "DO SQLite transaction closures" as an exercised contract.** Comment 6494857135 names DO SQLite transaction closures as part of the least-common contract every store can honour. The platform offers them, but the codebase never calls them (zero `transactionSync`); the contract is currently honoured by *single-statement writes + idempotency*, not by closures. The ADR should state the contract in terms of what is actually exercised, or make the first slice prove the closure path.

---

## 1. Persistence inventory

### 1.1 The D1 layer (`src/data/`) — the existing foundation

- **Binding:** `AGENT_DB` → database `agentdb` (`wrangler.jsonc:26`). Role per ADR 0002 R9 (:134): a projection/shared store — "not a replacement" for DO storage or Vectorize.
- **Schema:** `src/data/drizzleSchema.ts` — Drizzle **sqlite-core** `sqliteTable` definitions, **27 tables**: `agent_governance`, `agent_chains`, `agent_synthesized_schedules`, `agent_shard_jobs`, `agent_chain_audit`, `agent_reports`, `agent_market_nodes`, `agent_market_edges`, `agent_thesis_realizations`, `agent_calibration_decisions`, `agent_commercial_accounts`, `agent_tenant_settings`, `agent_credit_claims`, `agent_paid_submissions`, `agent_credit_redemptions`, `agent_subscriptions`, `agent_journal_accounts`, `agent_journal_entries`, `agent_native_ledger_rows`, `agent_referral_rules`, `agent_referral_earnings`, `agent_notification_preferences`, `agent_digest_sends`, `agent_price_catalogue`, `agent_subscription_plans`, `agent_key`, `_migrations`.
- **Migrations:** code constants, not `.sql` files — `src/data/migrationRunner.ts` (DataMigration {version, name, sql:string}); 13 registered (versions 1–12, 15). Runner rules (header :1–31): DDL lives in exactly one migration; `_migrations` row written LAST as the commit marker; statements are `IF NOT EXISTS`/`OR IGNORE`-shaped so partial applies converge; **deliberately not wrapped in `db.transaction()`** (documented as sequential BEGIN/COMMIT on D1, not Postgres-equivalent atomicity); future multi-statement needs must use D1 `batch()` explicitly.
- **Ports/adapters:** 11 port families, each with a D1 adapter **and an in-memory adapter** (the two-adapter conformance pattern already exists): governance, chainSchedule, shardJob, auditReport, commercial, subscription, journal, nativeLedger, priceCatalogue, lifecycle, retention — `src/data/{*Ports,create*Ports,d1*Adapter,inMemory*Adapter}.ts` (56 files total in `src/data/`). Each D1 adapter constructs `drizzle(d1, {schema})` itself and applies migrations at construction (e.g. `d1AuditReportAdapter.ts:34–39` applies only MIGRATION_0004; `d1ChainScheduleAdapter.ts:49` applies ALL_MIGRATIONS) — migration application is per-adapter and overlapping, relying on runner idempotency.
- **Consumers outside `src/data/`:** orchestrator seed/reconcile helpers that throw when `AGENT_DB` is unbound (`src/agents/orchestrator/governanceSeed.ts:36`, `canonicalReportSeed.ts:53`, `shardJobReconcile.ts:57`), a chat-turn telemetry write (`chatTurnHelpers.ts:178`), ResearchAgent telemetry (`research-agent.ts:1050–1057`).
- **Telemetry into D1:** `src/telemetry/d1ResourceUsageAdapter.ts` self-creates `resource_sql_ops` in AGENT_DB (:33) outside the migration runner — an unversioned D1 table already exists outside the 0001–0015 story.

### 1.2 The hand-rolled ORM (`src/orm/`) — the de-facto DO data layer

- `src/orm/index.ts`: generic `Repository<T>` (:48) over a minimal `SqlStorage` interface (`exec(query, ...args)`, :30); `DatabaseORM` (:213) exposes **13 repositories**: categories, referrals, ads, externalAds, transactions, messages, memory, events, webhookReplay, trades, watchlists, optionsChainCache, reports (`mas_reports`, :343). 18 of the 94 exec sites are in this file — it is the single largest naked-SQL concentration, but already behind a repository seam.
- `src/orm/schema.ts`: canonical DDL for the shared tables (`SHARED_MAS_TABLES` :49, `SHARED_TABLE_DDL` :163, `ensureSharedTable`): `mas_messages`, `mas_events` (:80), `mas_memory`, `mas_referrals`, `mas_ads`, `mas_watchlists`, `mas_transactions` (:142), plus categories/external-ads/chain-cache/trades/webhook tables. Header (:8–33) records the single-definition-site discipline and the #783 removal of a dead second `mas_reports` copy.
- Constructed on the orchestrator's own SQL handle (`orchestrator.ts:658`, `:1321` `new DatabaseORM(this.ctx.storage.sql)`) and threaded into NLQ execution, async jobs, autopilot, routes (audit, agenticPayments, ads/referrals) — i.e. the ORM's tables all live in the **per-login OrchestratorAgent DO**.

### 1.3 Per-surface stores on a raw SqlStorage seam (DO SQLite)

Each takes `ctx.storage.sql` (or the ORM's `SqlStorage`) and self-creates tables with `CREATE TABLE IF NOT EXISTS` at first use:

| Store (file) | DO home | Tables | exec sites |
|---|---|---|---|
| scanRunStore.ts | Screener/orchestrator | `mas_opportunity_scans` (:168) | 12 |
| discoverySetupStore.ts | Screener/orchestrator | `mas_discovery_setup_runs` (:176) | 9 |
| discoveryRunStore.ts | Screener/orchestrator | `mas_discovery_runs` (:302) | 8 |
| ivHistoryStore.ts | Screener/orchestrator | `mas_iv_history` (:161) | 8 |
| enrichmentStore.ts | Orchestrator | `mas_enrichment_runs` (:38) + stage table | 8 |
| feedSnapshotStore.ts | Orchestrator | `mas_feed_snapshots` (:72) | 7 |
| strategyProfileStore.ts | Screener/orchestrator | `mas_strategy_profiles` (:42) | 7 |
| scheduleManagement.ts | Orchestrator | `paused_schedules` (:22) | 6 |
| discoveryAlertStore.ts | Screener/orchestrator | `mas_discovery_alerts` (:52) | 4 |
| captureStore.ts (#1116) | Orchestrator (shared) | `mas_data_captures` (:105); schema evolution via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` (:389–402) | via seam |
| providerConfigStore.ts (#1116) | Orchestrator (shared) | `mas_data_providers` (:45), `mas_data_provider_routes` (:336) + 1 | via seam |
| scheduledReports.ts | Orchestrator | `mas_reports` (:52, own DDL block :106 kept in the ORM's shape; `ALTER TABLE` evolution :100; multi-DDL history #308/#389/#584 noted :117), `usage_events` (:955) | via ORM/seam |

### 1.4 Satellite service stores (orchestrator DO, `src/services/`)

Single-purpose modules, each self-creating 1–4 tables in the orchestrator's DO: `mas_adaptation_audit` (adaptationAudit.ts), `mas_challengers`/`mas_challenger_approvals`/`mas_challenger_promotions`/`mas_strategy_bank_active` (championChallenger.ts), `mas_goals`/`mas_scenarios`/`mas_outcomes` (goalScenarioStore.ts), `mas_job_outcomes` (jobOutcomes.ts), `mas_learnings` (learnings.ts), `mas_outcome_tracking` (outcomeTracking.ts:40), `quote_source_setting` (quoteSourceSetting.ts), `mas_comparison_arm_outcomes` (recommendationKernel.ts), `screen_run_locks` (screenRunLock.ts), `mas_screening_activity` (screeningActivity.ts:30), `mas_settings` (screeningFlags.ts; also strategyWeightsV2.ts), `mas_strategy_bank_proposals` (strategyBankReselection.ts), `mas_strategy_weight_caps`/`mas_strategy_gates` (strategyPolicyState.ts), `mas_strategy_reviews` (strategyReviews.ts), `mas_strategy_weights_v2`/`mas_strategy_weight_versions` (strategyWeightsV2.ts), `resource_daily_rollups`/`resource_alert_state`/`resource_comparison_reports` (telemetry/resourceRollupStore.ts).
The orchestrator class itself creates 6 more in `orchestrator.ts`: `mas_async_jobs`, `mas_autopilot`, `mas_policy_verdicts`, `mas_report_confirmations`, `mas_screener_presets`, `mas_settings`. `asyncJobs.ts` adds 1 and `chainExecutor.ts:257` reads `mas_async_jobs` through a runtime SQL shim.

### 1.5 Other DOs

- **ResearchAgent DO** (`research-agent.ts`): `research_settings`, `research_runs`, `research_evaluations`, `research_task_store`.
- **ScreenerAgent DO**: no tables of its own in the exec census (1 shim site); its stores (§1.3) are constructed against whichever DO's SQL the caller passes — the same store code runs against screener or orchestrator storage depending on the call site (e.g. `orchestrator.ts:1977` constructs `SqlScanRunStore` on the orchestrator's SQL). **The ADR must treat store→DO placement as data, not as a property of the store module.**
- **SessionStore DO** (`src/security/sessionStore.ts`): single `kv_store` table, backing the durableKv facade (§1.6).
- **Think SDK storage**: `cf_ai_chat_agent_messages` (read in orchestrator.ts) — owned by the Agents/Think SDK inside each agent DO; not application schema.

### 1.6 KV-shaped access (durableKv)

`src/security/durableKv.ts` — a KV facade over the SESSION_STORE DO (one instance, logical buckets "sessions"/"etrade"/"payments", JSON protocol over `stub.fetch`), with legacy Workers-KV read fallback. Consumers: `session.ts`, `etradeOAuth.ts`, `publicOAuth.ts`, `apiKeys.ts` (all `src/security/`), `payments/draftOwners.ts`, `services/agenticPayments.ts`, `trading/channels/intake.ts`, social stores (`agents/social/durableStores.ts`). Header records the #329 origin and the #1819 correction (DO SQLite free-tier caps are real; this store holds sessions/credentials — the most availability-critical data in the system). The IAAA audit store (`src/security/iaaaAuditStore.ts`) sits on the same KV idiom but stores **the entire audit log as one JSON array under one key**, rewritten whole on every append (:129–137).

### 1.7 What stays OUT of the SQL layer (per issue scope)

- **R2** (`REPORTS_BUCKET` → bucket `screener`, `wrangler.jsonc:23`): report bodies + the knowledge corpus (`src/services/knowledgeCorpus.ts` — keys `knowledge/<category>/<sha256>`, hash-verified reads). Different idiom (object store); SQL rows hold metadata/pointers (`mas_reports`).
- **Vectorize** (`VECTOR_MEMORY` → index `vector-memory`, `wrangler.jsonc:148`): report semantic index (`src/services/reportSemanticIndex.ts:52` upsert) + orchestrator memory semantics. Not SQL; the row in `mas_reports` is the authority, the index is a projection.
- **AI Search instance**: report indexing leg (#2246, `reportAiSearchIndex.ts`) — an external index, flag-gated; likewise a projection of `mas_reports`.
- **Analytics Engine** (`OBSERVABILITY` dataset, `wrangler.jsonc:30`): fire-and-forget telemetry via `src/observability/` (`cfAnalyticsEngineAdapter.ts`, `aspects.ts` `withObservability` :81). No in-repo read port over AE was found — it is a write-only sink from the app's perspective (see §5).

### 1.8 Inventory totals

| Surface | Store | Tables | Naked-SQL posture |
|---|---|---|---|
| D1 AgentDB projection | D1 (`AGENT_DB`) | 27 schema tables (+1 unversioned telemetry table) | Drizzle only; migrations 0001–0015 (13) |
| Orchestrator DO core | DO SQLite via `src/orm` | 13 repositories / shared `mas_*` DDL | 18 exec sites inside the ORM |
| Orchestrator DO satellites | DO SQLite, per-service modules | ~25 tables | SQL inside each module |
| Screener/shared stores | DO SQLite via SqlStorage seam | 10 tables | 66 exec sites across 10 store files |
| Research DO | DO SQLite | 4 tables | module-local SQL |
| Session/KV | SessionStore DO + durableKv | `kv_store` + buckets | KV idiom, 2 exec sites |
| IAAA audit | durableKv JSON | 1 key (whole-log array) | KV idiom |
| SDK-owned | Agent DOs | `cf_ai_chat_agent_messages` | SDK |


---

## 2. Proposed port catalogue

Grouped as the brief requires. "Today" names the implementation site(s); multi-write operations are the transaction-aspect candidates (§3 gives the atomicity evidence).

### 2.1 Execution state (DO-authoritative; per-instance)

| Port (proposed) | Today | Multi-write operations |
|---|---|---|
| AsyncJobStore | `mas_async_jobs` DDL in orchestrator.ts + `agents/orchestrator/asyncJobs.ts`; reads via `agentic/chainExecutor.ts:257` | Job-tree create (parent + stage jobs), stage transitions with outcome writes |
| ScanRunStore | `trading/options/scanRunStore.ts` (`SqlScanRunStore`) | Run open → results → completion marking |
| DiscoveryStores (run/setup/alert) | `discovery{Run,Setup,Alert}Store.ts` | Run lifecycle writes across the three tables per discovery |
| IvHistoryStore | `ivHistoryStore.ts` | Batch point inserts per collection run |
| StrategyProfileStore | `strategyProfileStore.ts` | Profile upsert + versioning |
| ScreenerClaimStore | `screener-agent.ts:295` KV claim | Single-key claim (already transactional where available) |
| ScheduleStore | `services/scheduleManagement.ts` (`paused_schedules`), ScheduledAgent `ctx.storage` goals, D1 `agent_synthesized_schedules` (projection) | Pause/resume + projection sync |
| ResearchStore | `research-agent.ts` (4 tables) | Run + evaluations writes |
| Session/CredentialStore | durableKv over SessionStore DO | Single-key writes (low risk) |
| Enrichment/FeedStores | `enrichmentStore.ts`, `feedSnapshotStore.ts` | Run + stage rows |

### 2.2 Reports & content (DO-authoritative rows; R2/Vectorize/instance are projections)

| Port | Today | Multi-write operations |
|---|---|---|
| CanonicalReportStore | `mas_reports` via ORM `reports` repository + `scheduledReports.ts` store functions | **The riskiest fan-out in the system** — §3.1 |
| ReportIndexPorts (Vectorize / AI Search) | `reportSemanticIndex.ts`, `reportAiSearchIndex.ts` | Best-effort projection writes, never-throws by design |
| MemoryStore | ORM `memory` repository (`mas_memory`) | Single-table |
| WatchlistStore / MessageStore | ORM repositories | Single-table |
| KnowledgeCorpusPort | `knowledgeCorpus.ts` (R2) | Out of SQL layer; listed for completeness |

### 2.3 Config (per-DO tables + D1 tenant settings)

| Port | Today | Notes |
|---|---|---|
| DataProviderConfigStore | `providerConfigStore.ts` (`mas_data_providers`, `mas_data_provider_routes`) | Already port-shaped behind the #1116 platform; conformance kit exists there |
| CaptureStore | `captureStore.ts` (`mas_data_captures`) | Append-mostly; #1133 never-throws discipline |
| SettingsStore | `mas_settings` (multiple writers: screeningFlags, strategyWeightsV2, orchestrator) | **Multiple modules create/write the same table** — port must have one owner |
| TenantSettingsStore | D1 `agent_tenant_settings` (commercial ports) | Already in `src/data` |

### 2.4 Audit & evidence

| Port | Today | Multi-write operations |
|---|---|---|
| EventLog (mas_events) | ORM `events` repository; DDL `orm/schema.ts:80` | Append; retention prune (`security/storageRetention.ts`, #786: 365d) |
| IaaaAuditLog | `security/iaaaAudit.ts` (hash chain) + `iaaaAuditStore.ts` (KV whole-log JSON) | Chain append = read-tail + hash + append (§3.3) |
| PolicyVerdictLedger | `mas_policy_verdicts` (orchestrator.ts) | Signed verdicts; retention KEEP per storageRetention.ts |
| PaymentLedger | `payments/ledger.ts` → ORM `transactions` (`mas_transactions` on the **orchestrator** instance, written cross-DO from PaymentsAgent; fail-honest when SEARCH_AGENT unbound, ledger.ts:204) | Verified-payment record (idempotent by gateway ref, ledger.ts:254) + budget-guard reads of the same table |
| NativeLedger (D1) | `agent_native_ledger_rows` via nativeLedger ports | Already ported |
| AdaptationAudit / JobOutcomes / Learnings | satellite service stores | Append-mostly |

### 2.5 Intelligence read models (D1-first; the §5 requirements land here)

| Port | Today | Gap |
|---|---|---|
| Halt/Governance read | `src/data` governance ports (agent_governance) | Done — the template |
| ShardJob/Chain projections | `src/data` shardJob/chainSchedule ports | Done |
| AuditReport projection | `src/data` auditReport ports (agent_chain_audit, agent_reports) | Done |
| Telemetry/Calibration read models | `agent_calibration_decisions`, `agent_thesis_realizations`, `agent_market_*`; DO-side `resource_*` rollups + D1 `resource_sql_ops` | Split across DO and D1 with two rollup implementations |
| Trace substrate | **Does not exist** (§5.2) | New table family |
| Proposal ledger | Domain fragments only (§5.4) | New port + state machine |
| Fleet registry/matrix as data | Code + test pins only (§5.5) | New read model |

---

## 3. Transaction reality check

### 3.1 How atomicity actually works today

- **Single statements are the atomic unit.** SQLite (DO) and D1 both make a single statement atomic; the codebase overwhelmingly relies on this. Multi-statement flows have no wrapper: **zero** `transactionSync` usages, **zero** D1 `batch(` usages in `src/` (both verified by grep at this SHA).
- **Idempotency substitutes for transactions in the D1 layer by explicit design.** Migration 0003's header (`migrationRunner.ts:123–127`): the composite PK makes replay `ON CONFLICT DO NOTHING`, "the idempotency guarantee" for at-least-once delivery. The same pattern (versioned rows, latest-row reads) runs through chains/schedules/shard-jobs. The migration runner itself is deliberately non-transactional, with the `_migrations` row as commit marker (`migrationRunner.ts:12–25`).
- **The one real transaction** is KV-shaped: `ScreenerAgent.claimScheduledExecution` (`screener-agent.ts:299–313`) uses `storage.transaction` for a check-and-set claim — **and falls back to a racy get-then-put when `storage.transaction` is unavailable**. The fallback's race is bounded (duplicate scheduled screen, deduplicated downstream by slot keys in practice) but it is the codebase's only honest example of "degrade when the primitive is missing" — the pattern the aspect contract must NOT copy silently (direction comment 6494857135 requires honest failure, not silent shortfall).
- **D1 `db.transaction()` is documented in-repo as non-atomic-equivalent** (`migrationRunner.ts:19–25`; repeated in adapter headers, e.g. `d1GovernanceAdapter.ts:11`): sequential BEGIN/COMMIT over a request-per-statement API. Any ADR text that says "D1 transactions" without this caveat would contradict the repo's own recorded analysis.

### 3.2 Riskiest multi-write sites (ranked)

1. **Canonical report fan-out** — `scheduledReports.ts:342–470` (four store sites): `mas_reports` row write, then fire-and-forget (`void`) legs to R2 body, Vectorize (`indexCanonicalReport`), and the AI Search instance (`indexCanonicalReportInAiSearch`, :350/:374/:430). No atomicity across any pair; the design accepts index divergence (best-effort, re-runnable backfill) but the **row↔R2-body pair** is consistency-critical and currently protected only by ordering. A crash between row and body strands a searchable row with no body (mitigated today by the S4-1 honesty work, not by a transaction).
2. **Champion/challenger promotion** — `championChallenger.ts`: approval insert (`mas_challenger_approvals`) + challenger status update (:245) + promotion record + `mas_strategy_bank_active` switch are separate statements across four tables. The *authorization* invariants are carefully guarded in code (self-approval prohibited :353, system actors cannot approve :359) but the *state transition* is not atomic: a partial promote could leave an approval without its promotion, or the active bank switched without its promotion record.
3. **IAAA audit chain append** — §3.3.
4. **Payments ledger + budget guard** — the ledger write lands in another DO's table (`mas_transactions` on the orchestrator instance) from PaymentsAgent flows; guard reads and spend records must agree, and the write path crosses an RPC boundary, so no local transaction could cover it even in principle. Current protection: idempotency by gateway reference + fail-honest unbound behaviour. This is the clearest case where the aspect contract must be "atomic-or-honestly-failed" at the *port* level, not the storage level.
5. **Discovery lifecycle** — run/setup/alert rows across three stores per discovery run (plus `mas_discovery_runs`-keyed feed snapshots); a mid-run failure leaves partial lifecycle state that the stores' `failed` states (P4/#1999 work) now surface but do not roll back.
6. **Strategy weights v2** — `mas_strategy_weights_v2` + `mas_strategy_weight_versions` + `mas_settings` writes in one flow (strategyWeightsV2.ts): weights and their version record can diverge on partial failure.
7. **Halt consistency (already solved, instructive)** — the ADR-0002 motivating case: a halt written in the orchestrator's `mas_settings` did not reach the bare ScheduledAgent tick; the fix was a D1 projection (`agent_governance`) with fail-closed reads. It is the template for "execution state stays in DO, cross-instance truth moves to a projection with honest read semantics".

### 3.3 The IAAA chain-append problem (evidence for §5.3)

`iaaaAudit.ts` defines the chain (`previousEventHash`/`eventHash` :98–100; `verifyChain()` :35) and an "atomically chain" append contract (:127). The store, `iaaaAuditStore.ts:129–137`, implements append as: read the **entire** JSON array from one KV key, push, write the whole array back. Within one DO instance this is serialized by the runtime; but the log's growth makes every append O(n), and correctness depends entirely on all writers funneling through the single "kv" instance — there is no storage-level atomicity, and the chain's tail-read and append are not one operation. Q7 (#945) ratified the chain as the tamper-evidence *mechanism*; the *wiring* (mas_events through the chain + a verify entry point) is still a separate, unbuilt slice. The foundation should give the chain a real append substrate (single-writer port over an append-only table) rather than re-platforming the JSON array.

---

## 4. Schema / dialect seam

### 4.1 Today

- **D1 side:** one schema module (`drizzleSchema.ts`, sqlite-core), one runner (`migrationRunner.ts`), portable-subset rules recorded in migration headers (R2 of ADR 0002: dialect isolation in exactly one place; migration 0001 header: "`?` params only, epoch-ms integers, no dialect date functions, no RETURNING"). Migrations are TS string constants split on `;` (runner constraint: no semicolons inside string literals).
- **DO side:** no migration runner at all. Four schema-evolution idioms coexist:
  1. `CREATE TABLE IF NOT EXISTS` at store construction (dominant; ~90 tables).
  2. Canonical shared DDL with a single definition site (`orm/schema.ts` `SHARED_TABLE_DDL` + `ensureSharedTable`) — the best DO-side discipline, covering the shared `mas_*` set.
  3. Inspect-and-alter evolution: `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` (captureStore.ts:389–402; scheduledReports.ts:100).
  4. Historical multi-DDL drift, managed by comment discipline (mas_reports "#308/#389/#584 multi-DDL history", scheduledReports.ts:117; the #783 dead-copy removal in orm/schema.ts:33).
- **Retention/tenancy contracts** exist for the `mas_*` family only: `security/storageRetention.ts` is the recorded per-table decision record (#786: mas_events 365d prune, mas_messages 90d, mas_memory 365d, mas_transactions/mas_trades/mas_reports/mas_policy_verdicts KEEP) — nothing equivalent covers the D1 `agent_*` tables as a family (retention ports exist in `src/data` for the projection) or the satellite tables.

### 4.2 What the seam must become (evidence for the ADR)

- Shared column definitions → per-dialect tables: Drizzle's pg-core and sqlite-core expose parallel but distinct table APIs, so "derive" means a column-definition factory consumed by both dialect modules — the D1 schema's existing portability rules (epoch-ms, no dialect functions, no RETURNING) are already written as the shared subset, which is evidence the derivation is feasible without redesigning the tables.
- The DO side needs a versioned story *equivalent in discipline* to migrationRunner (versioned, idempotent, marker-last) even if the mechanism differs — today "the code is the migration" is true but unaudited: nothing records which DO instances have which schema generation, and idiom (3) means two code paths can disagree about a table's columns until runtime.
- `_migrations` exists only in D1. A DO-side analogue (per-instance schema-version row) is the smallest change that makes DO schema state queryable — and the fleet registry (§5.5) could report it.


---

## 5. Intelligence / RSI substrate map

The five requirements are from comment 6495037697. "Today" is what the code shows; "gap" is what the foundation must add. The loop's machinery itself (eval harness, proposal generation, self-healing analysis — #2225 G13, #798) is out of #1976 scope by the recorded boundary; only the substrate is mapped here.

### 5.1 Analytical read models / projections

- **Today:** the D1 projection family is real and growing — governance (halt), chains, synthesized schedules, shard jobs, audit reports, market graph (nodes/edges), thesis realizations, calibration decisions (migrations 0001–0006) plus commercial/journal/ledger projections (0007–0015). The pattern is established: DO-authoritative writes, versioned idempotent projection rows in D1, latest-row reads. Telemetry is split: DO-side rollups (`resource_daily_rollups` etc.) AND D1 `resource_sql_ops` written by a self-migrating adapter outside the runner.
- **Gap:** the projection set is accidental, not enumerated — nothing lists which cross-run questions the loop must answer and which projection serves each. Cost/latency aggregation exists in fragments (telemetry rollups, `mas_transactions` amounts, capture outcomes in `mas_data_captures`) with no unified cost read model across agents/workflows. The ADR should enumerate mandatory projections (per requirement 1) and retire the duplicate rollup path.

### 5.2 Unified trace substrate

- **Today:** three partial substrates, none unified:
  - `mas_events` (per-login orchestrator DO; DDL `orm/schema.ts:80`): `id, session_id, type, agent, payload (opaque TEXT), created_at`. Session-scoped, per-instance — a cross-agent trace cannot be reconstructed across DOs, and there is no correlation/causation field tying a workflow step in one DO to a call in another.
  - Analytics Engine (`OBSERVABILITY`): aspect-emitted data points (`src/observability/aspects.ts`, #1842) — fire-and-forget, no in-repo read port found; it cannot serve as replayable evidence for the loop.
  - D1 telemetry tables (resource usage) — operational metrics, not call traces.
  This matches the #2225 G13 survey finding (no unified trace record) — still true at this SHA.
- **Gap:** a foundation table family (D1 is the only store every agent can write and the loop can read) with one record shape per cross-agent call / workflow step: correlation id, acting agent, principal, operation, outcome code (catalog, per #1969), latency, cost fields — written with the capture discipline (#1133: never throws into the caller's path; failures recorded with stable codes, as `captureStore` already implements for data captures).

### 5.3 Append-only evidence with two-part attribution

- **Today:** attribution is fragmented. `mas_transactions` carries `proposer_did` + `authorizer_did` (DDL `orm/schema.ts:142`) — the G14 seed pattern, DID-shaped and payments-only. `mas_events.agent` names the acting agent but has **no principal column**. The IAAA log has the Q7-ratified hash chain but sits on the whole-log JSON KV store (§3.3) and covers identity events, not loop evidence generally. `mas_policy_verdicts` (signed compliance ledger, KEEP retention) is append-only by policy, not by mechanism.
- **Gap:** (a) schema fields for acting-agent + principal on every loop-relevant table family (events, traces, proposals, ledger) — a convention the ADR must pin once, in the G14 two-part shape; (b) an append substrate for chained evidence that is a table with single-writer port semantics, replacing the JSON-array store for new evidence; (c) the Q7 wiring slice (mas_events through the chain + verify entry point) remains a dependency — the foundation can host it, but it is not done by any current code.

### 5.4 Proposal ledger

- **Today:** no unified ledger, but two working domain fragments prove the shape:
  - Champion/challenger (`championChallenger.ts`): challengers with `source_proposal_id`, approvals table with approver-of-record, promotions table, self-approval + system-actor prohibitions enforced in code (:347–362) — a proposal lifecycle with a human gate, strategy-domain only.
  - Strategy-bank reselection (`mas_strategy_bank_proposals`, strategyBankReselection.ts) and adaptation audit (`mas_adaptation_audit`) — proposal/audit fragments for the weights system.
  - QA self-healing filings happen through an external script path (no ledger).
- **Gap:** the RSI pipeline's lifecycle (proposed → approved → applied → verified) as a foundation-level state machine: one table family + port, with the gate recorded as data (who/what approved, under which issue/PR), so "no self-merge / no silent promotion" is enforced by the substrate (a state transition that requires a recorded gate) rather than by each consumer's discipline. The champion/challenger guards are the requirements seed — generalize the *shape*, keep domain evaluation out.

### 5.5 Fleet registry / conformance matrix as data

- **Today:** the registry exists only as code and test-time artifacts: the A2A resolution map (`src/a2a/resolution.ts`, #2223), agent cards (`src/a2a/agent-cards.ts`), wrangler bindings, and the agent-conformance pins (tests parse wrangler + source). Nothing is queryable at runtime; the UI and the loop cannot read "which agents exist, with which bindings, migrations, and conformance status" from data. The #2253 completeness pin (in flight on another lane at survey time) mechanizes the check at test time only.
- **Gap:** a registry read model in the foundation (D1 table family + port): one record per agent (class, binding, instance scheme, migration tag, card operations, identity record per G14) and per-cell matrix status (IMPLEMENTED / NOT-APPLICABLE / GAP with its slice reference), populated by the build/conformance path and read by UI + loop alike. The foundation's job is the store + port; keeping records current is a conformance-path duty the ADR must assign.

---

## 6. ADR outline — decision points

Each point: options, evidence, recommendation. Points the issue body reserves to the owner are marked [OWNER GATE] — the ADR records them, it does not assume them.

### 6.1 DO-SQLite dialect path (issue body's question (a))
- **Options:** (i) custom Drizzle driver over `ctx.storage.sql`; (ii) Drizzle sqlite-proxy against DO storage; (iii) raw SQL behind ports for DO, Drizzle only where a dialect exists (D1 today, Postgres later).
- **Evidence:** Drizzle has no DO-SQLite dialect (issue body). Every DO store already sits behind a `SqlStorage`-shaped seam (`orm/index.ts:30`; the store constructors), and the highest-value DO surface (the ORM) already abstracts execution behind `Repository<T>`. A custom driver is unproven infrastructure the programme would own forever; sqlite-proxy assumes a request/response SQL endpoint shape DO storage doesn't naturally expose per instance.
- **Recommendation:** (iii) for the first slices — ports own the contract, DO adapters keep SQL (externalized into the layer, per the recorded end state), D1/Postgres adapters use Drizzle. Revisit (i) as a time-boxed spike only if the conformance suite shows adapter drift costing more than driver maintenance. This also matches the issue's own acceptance escape hatch ("recorded single-adapter exception with reason") — except the exception here is per-*store-class*, recorded once in the ADR.

### 6.2 Transaction aspect mechanics (AOP programme alignment, #1969)
- **Options:** home in `src/aspects/` (with `loggingAspect`/`errorCodes`) vs `src/errors/errorAspects.ts` (with `withLogging`/`withSecurity`/`withExceptionHandling`).
- **Evidence:** discrepancy D3 — the idiom is split; the wrappers the alignment comment cites live in `src/errors/`, the aspect-event/catalog family in `src/aspects/`.
- **Recommendation:** put `withTransaction` in **`src/aspects/`** beside the catalog family (its outcomes are catalog-emitted, and #1969's centre of gravity is there), implemented as a higher-order wrapper in the `errorAspects` shape (context object + wrapped port call), and have the ADR explicitly name the split so a future consolidation slice can unify the two homes. Contract per the recorded direction: unit-of-work at the port boundary; nested joins; a store that cannot honour the declared scope **fails honestly** (typed catalog code) — the screener-claim racy fallback (§3.1) is the anti-pattern the contract forbids. On D1, the aspect's atomic scope is implemented via `batch()`; on DO, via the storage transaction primitive — and the first slice must *prove* both paths with pins, since neither is exercised today (D4).

### 6.3 Port granularity
- **Options:** per-aggregate ports (the `src/data` pattern) vs a single data-facade.
- **Evidence:** 11 port families already work per-aggregate with per-family conformance; the DO side's natural aggregates are the §2 catalogue. A facade would recreate the ORM's monolith problem (`DatabaseORM` knows every table).
- **Recommendation:** per-aggregate ports, grouped as in §2; composition roots per DO (mirroring `create*Ports.ts`) wire adapters. One port may have several adapters (D1 + inMemory + DO-SQLite where applicable).

### 6.4 Enforcement pin design
- **Options:** source-scan test (grep-class) vs lint rule vs import-graph test.
- **Evidence:** the recorded end state demands a mechanical pin; ADR 0002 R1 already uses a structural test ("port modules import no store client; domain modules import no ORM") for `src/data`; tests in this repo routinely parse source/wrangler (agent-conformance pins; the #1387 string-aware parse).
- **Recommendation:** a source-scan conformance test in the existing pin style: fail if `\.sql\.exec(` or a storage-client import appears outside the layer's allow-listed directories (adapters + the migration runner + SDK shims like `cfAgentsAdapter`), with the allow-list in the test and shrink-only discipline (entries may be removed by slices, never added without ADR amendment). Roll out as warn-first on the current 16 files, turning red as each surface migrates — no big-bang.

### 6.5 Migration sequencing (which surface first)
- **Recommendation with evidence:** 
  1. **Data-provider platform stores first** (`providerConfigStore`, `captureStore`) — already seam-shaped, already conformance-tested by the #1116 kit, bounded blast radius; proves the DO-adapter + aspect pattern end-to-end.
  2. **Options/discovery store family** (scanRun/discovery/ivHistory/profile) — pure SqlStorage-seam stores, no cross-DO surprises; retires 66 of 94 exec sites.
  3. **The ORM core (`mas_*` shared tables)** — highest value, highest blast radius (orchestrator + every route); by now the pattern is proven twice.
  4. **Satellite service stores** — mechanical follow-ons, several per PR where they share a table owner (notably `mas_settings`, which needs a single-owner ruling first).
  5. **Session/durableKv + IAAA store last** — auth- and evidence-critical (#1819 history), migrated only with the pattern fully proven and with parallel-run/flag gating per the issue's failure/recovery criterion.
  Intelligence substrate (§5.2/5.4/5.5 table families) lands as *new* D1 tables early (no migration risk — additive), sequenced with (1)–(2) so the loop's consumers aren't blocked on the DO migrations.

### 6.6 The D1 projection's role / R9 disposition [OWNER GATE]
- **Options:** re-ratify R9 (D1 = projection/read-model store; DO stays authoritative for execution state) vs revise (move selected authority to D1).
- **Evidence:** every successful cross-instance pattern in the repo (halt, shard jobs, chains) uses D1 as projection with DO authority; the intelligence requirements (§5) *strengthen* D1's read-model role without needing its authority. Nothing in the recorded direction asks to move execution authority.
- **Recommendation:** re-ratify R9, restated in the new ADR as: "D1 hosts projections, read models, and the intelligence substrate; DO storage remains authoritative for execution state." The revision the owner is asked to approve is the *substrate addition* (traces/proposals/registry are new D1-native families, not projections of DO state) — name it as an explicit extension, per the issue's "only explicitly, never silently".

### 6.7 Postgres seam specifics
- Schema derivation: shared column-definition factories → sqlite-core (D1/DO-via-Drizzle-if-ever) and pg-core modules; the existing portable-subset rules (epoch-ms, no dialect date functions, no RETURNING, `?`-style params) are the derivation contract — record them in the ADR as binding on new schema.
- Migration runner: the runner's `MigrationDb` surface (`all`/`run` over Drizzle `sql`) is already store-shaped; a pg adapter implements the same surface. The tenancy/sharding mapping (per-instance DO → centralized PG) and Hyperdrive are switch-time work, per the recorded direction — the ADR names them, designs neither.
- [OWNER GATE] Postgres as the *second adapter now* (issue body's question (c)): the conformance-suite design (§6.3) makes "second adapter" cheap to prove with the existing in-memory adapters; a real PG adapter is a proof the owner may still want. Recommendation: satisfy the acceptance criterion with D1 + in-memory + DO-SQLite as the conformance trio now; record PG as designed-for, not built, unless the owner directs otherwise.

### 6.8 Explicitly out (record in the ADR)
R2 and Vectorize stay (issue scope exclusion) — the layer references them through projection ports (§2.2) but does not absorb them. AI Search instance likewise. Analytics Engine stays a telemetry sink; the trace substrate (§5.2) is a foundation table family, not an AE read layer. Think SDK storage (`cf_ai_chat_agent_messages`) is SDK-owned and excluded. The loop's machinery (#2225 G13/#798) consumes the substrate; it is not designed here.

---

## 7. Risks + open questions

**Risks (evidence-backed):**
- **R-1 Blast radius of the ORM core.** `DatabaseORM` is imported across the orchestrator, NLQ, async jobs, autopilot, and routes; a port migration there touches the chat hot path. Mitigated by sequencing (§6.5 step 3) and behaviour pins, but it is the programme's highest-risk slice by construction.
- **R-2 `mas_settings` multi-owner writes.** At least three modules create/write the same config table in the same DO (orchestrator.ts, screeningFlags.ts, strategyWeightsV2.ts). Until a single owner is ruled, any port over settings codifies a race.
- **R-3 Schema-state invisibility on DOs.** With no DO-side migration record, a slice cannot prove which schema generation a live instance runs; the first DO slice should land the version marker (§4.2) before moving tables.
- **R-4 The aspect contract vs reality.** Neither atomic primitive the contract needs (DO transactions, D1 `batch()`) has ever executed in this codebase. The first slice is therefore partly a platform proof; if DO transaction semantics differ from the documented shape under the Agents SDK's storage facade, the contract's DO leg needs redesign — schedule the proof before the catalogue migration, not inside it.
- **R-5 D1 free-tier/rows-read economics** (#1819 lesson, durableKv header): new substrate writes (traces per cross-agent call) multiply D1/DO read-write volume. The trace port needs a sampling/retention ruling in the ADR or the substrate becomes the next rows-read incident.

**Open questions (genuine decision points only):**
- **Q-1 [OWNER]** R9 disposition: re-ratify as restated in §6.6 (with the substrate extension named), or revise authority for named surfaces?
- **Q-2 [OWNER]** Postgres second adapter: build now as the conformance proof, or designed-for/deferred (§6.7)?
- **Q-3 [OWNER/CAIO]** D1 migration versions 13/14 are missing from the sequence (registered: 1–12, 15). Reserved, withdrawn, or lost? The ADR's migration story needs the answer recorded.
- **Q-4 [OWNER]** Trace-substrate retention + sampling: what volume of cross-agent trace does the loop actually need retained, and for how long? (Drives R-5 and the storageRetention extension; the #786 record is the template but has no trace row.)
- **Q-5** Q7 wiring (mas_events through the IAAA chain + verify entry point) — does it ride the foundation's audit-evidence slice (§5.3) or stay a separate security-lane slice that the foundation merely hosts? Needs a lane ruling (CDO vs CISO), not a design choice.
- **Q-6** Registry-as-data population duty (§5.5): the conformance path writes it — but which job/run owns the write in production (deploy-time seed vs scheduled sync, the S4-4 pattern)? Underdetermined by the recorded direction.

---

*Survey ends. Companion artifacts: `issue-body.json`, `comments.json` in this directory are the verbatim issue record the survey was checked against.*
