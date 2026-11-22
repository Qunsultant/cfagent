# Why so many tables? — job/run/screening record inventory + rationalization

**Researched:** 2026-11-21 ~16:40–17:05 EST, live main `e7101819c`
("[Enhancement] #5894: wipe-and-reseed to the needed set (reset to defaults)").
**Method:** `git grep` over the main tree at `e7101819c` (via the
`~/workspace/cfagent-6003/repo` clone; FETCH_HEAD only — the working
tree was left on the #6003 branch untouched): every `doTableSql("…")`,
every `schema.do.…create_table`, every ORM-adapter table, every
`sqliteTable("…")` in `src/data/drizzleSchema.ts`, plus
`wrangler.jsonc` bindings and the run-view readers. Adapter header
comments are quoted as the "why" evidence; classifications by table
name are marked `?` where the header did not confirm them.
**Starting point:** `~/workspace/cfagent-runlog-research/report.md`
(live main `dc021d3e`, 2026-11-21 morning) — the 10 stores the runs
view reads. This file extends it to the full inventory.
**Filing only:** no code, no PR, no §15. One sub-issue filed under
#3123 (see §6).

## 1. Headline counts

| Scope | Count | What it is |
|---|---|---|
| DO-SQLite tables in the codebase (all purposes) | **79** | Union of `doTableSql`, the `schema.do.*` registry, and the ORM adapters |
| D1 tables in the codebase (all purposes) | **106** `sqliteTable` definitions in `drizzleSchema.ts`, of which **86** are `agent_*` tables in the D1 catalogue (`src/data/schemaComponent/d1Catalogue.ts`) | Everything: billing, referrals, products, market data, governance, … |
| **Physical stores holding job/run/screening records or direct run-lifecycle state** | **63** | **29 DO-SQLite + 31 D1 + 2 DO-storage KV halves + 1 R2 bucket** (tiers A–C below) |
| Logical stores behind those 63 physical stores | **~51** | Several logical stores exist twice — once per residency (DO + D1, same port/shape) |
| Total tables in the codebase | **~185** (79 DO + 106 D1) | The 63 above are about a third; the rest are config, market data, billing, identity, etc. |

So the user's instinct is right about the run-record half — 63 physical
stores is a lot — but two thirds of the ~185 tables are *not* run
records at all. The rationalization scope is the 63, not the 185.

### The 10 the runs view reads today (from the morning report)

`job_run_records` (DO) + ScheduledAgent KV `listJobRuns` (DO-storage
KV) + `mas_async_jobs` + `mas_screening_activity` +
`mas_job_outcomes` + `mas_reports` + `mas_opportunity_scans` +
`mas_discovery_runs` + ScreenerAgent feed (DO-storage KV) + D1
`job_run_records`. Four endpoint reads, three merges. The inventory
below shows these 10 are a subset: the pipeline family, the run
registry, the per-stage datasets, research, copilot, goal outcomes,
and the claims/locks were never counted before.

## 2. The inventory (tiers A–D)

### Tier A — the run record itself: one row per run, the "one table" candidate

| Store | Residency | Writer | Reader | Shape / note |
|---|---|---|---|---|
| `job_run_records` | DO-SQLite (OrchestratorAgent) | Run recorder (`doSqliteJobRunRecordAdapter.ts:24`) | `GET /api/ledger/runs` merge; #3946 seam | The ledger run row |
| `job_run_records` | D1 (`drizzleSchema.ts:1894`, migrations 0047/0072/0073/0076) | `d1JobRunRecordAdapter.ts` — "same port, same table, same record shape — the workflow-hosted residency" | #3946 seam, Workflow Runs | Same logical store as the DO half; pipeline runs have no host DO to borrow SQLite from, so they record here |
| `mas_async_jobs` | DO-SQLite | `startScreenBridge` / chain dispatch (bridge row per engine run, #3787) | `get_async_job`, Workflow Runs, stuck sweep #3784 | **Job tree + checkpoints, no stages.** The MCP contract ("tool calls return job IDs") |
| `agent_async_jobs` | D1 (`drizzleSchema.ts:1929`) | Projection of `mas_async_jobs` (#4116) | `d1RunLedgerAdapter.ts` | "The D1 mirror of `mas_async_jobs`" (`migrationRunner.ts:1365`) |
| `mas_runs` + `mas_run_aliases` | DO-SQLite | Run registry (`doSqliteRunRegistryAdapter.ts`, #5175 slice 2) | `resolve_id` (MCP), call-site migration | **Record-once registry:** check-then-insert, INSERT OR IGNORE backstop; aliases never overwritten, first mapping wins; "THE REGISTRY NEVER MINTS" |
| `job_pipeline_instances` | DO-SQLite **and** D1 (same shape both residencies, migration 0046) | Pipeline J1 (#3534/#3548) | Engine / pipeline control | "Live job instance state, one row per job id: management state, the resume-cursor view, and the stage-runner checkpoint ledger (#3549)" |
| ScheduledAgent jobRunRecords | DO-storage KV (NOT a Cloudflare KV namespace — `wrangler.jsonc` declares no KV binding, #606/#415) | `getKvJobRuns` (legacy) + `fetchLedgerRuns` (shared ledger) | `listJobRuns` (`scheduled-agent.ts:842`), `GET /api/ledger/runs` merge | The "KV half" of the ledger merge; KV entries, not a table |
| ScreenerAgent feed | DO-storage KV (ScreenerAgent instance) | ScreenerAgent run | `GET /api/runs` five-store merge (`runSummaryFromScreenerRun`, `runSummaries.ts:522`) | `ScreenerRunResult` — the legacy screener's latest/history feed |

Tier A count: **5 DO tables + 3 D1 tables + 2 KV halves = 10 physical stores
for ~7 logical stores** (job_run_records ×2 residencies,
job_pipeline_instances ×2, mas_async_jobs/agent_async_jobs mirror,
mas_runs registry, 2 KV halves).

### Tier B — per-run facts that are not the run row

| Store | Residency | What it holds / why it exists |
|---|---|---|
| `mas_job_outcomes` (+ `mas_job_outcomes_meta` watermark) | DO | **Outcome sink.** "ADR D-0 ruled this family DO-resident" (`jobOutcomePorts.ts`); 8 write sites; 90-day retention, 500-row cap; no tenant column (per-login instance IS the scope). Supplies "the run-level facts a job tree does not carry: the trigger, the scan counts, the coded error, the artifact keys, and the per-channel delivery states" (`workflowRuns.ts`) |
| `mas_screening_activity` | DO | Stage transitions (skipped/held + WHY). Convergence target: engine D1 stage model — **#6008** (the D1 stage table does not exist yet) |
| `job_stage_events` | DO (ScheduledAgent owns the pipeline) | Stage events, `event_key` UNIQUE so a re-delivered publication is ignored (#4360). The *newer* stage-event store — alongside, not instead of, `mas_screening_activity` |
| `mas_reports` | DO | Canonical report store (`doSqliteCanonicalReportStoreAdapter.ts`, ADR 0022 D-A). A report is a document with its own lifecycle, not a run row |
| `agent_reports` | D1 | D1-side report rows ? (mirror/projection of `mas_reports` — verify at build time) |
| `mas_opportunity_scans` | DO | Per-kind opportunity scans (`doSqliteScanRunAdapter.ts:46-48`). Convergence: **#3314** (already filed) |
| `mas_discovery_runs` | DO | Per-kind discovery runs. Convergence: **#6007** |
| `mas_enrichment_runs` | DO | Enrichment-stage runs (#1888, #1976 step 2) |
| `mas_outcomes` | DO | Goal/scenario outcomes (`doSqliteGoalScenarioAdapter.ts`) |
| `mas_outcome_tracking` | DO | Outcome-tracking events, joined to `mas_outcomes` (#2356, #1976 step 4c; feeds the research track record) |
| `mas_report_confirmations` | DO | Report delivery confirmations — delivery metadata only (#2359, #1976 step 4d) |
| `mas_discovery_setup_runs` | DO | Discovery setup runs |
| `mas_discovery_alerts` | DO | Discovery alerts |
| `research_runs` / `research_evaluations` | DO | ResearchAgent-private store: nightly research runs + their evaluations (#2361, #1976 step 4e) |
| `stock_copilot_activity` | DO | Copilot cycle activity log, display-grade JSON, "always read back whole, never queried by symbol" (#3422) |
| `agent_chains` / `agent_chain_audit` | D1 | Chain runs + their audit ? |
| `agent_shard_jobs` | D1 | Sharded jobs ? |
| `agent_synthesized_schedules` | D1 | Synthesized schedules ? |
| `agent_data_captures` | D1 | "The capture log" (`migrationRunner.ts:417`) — D1-side capture log ? |
| `agent_proposals` / `agent_proposal_transitions` | D1 | Proposal engine runs (#2901 — proposals only, never executes) ? |
| `agent_work_item_events` | D1 | Work-item events ? |
| `agent_trace_records` / `agent_mesh_trace_hops` / `agent_mesh_eval_results` / `agent_mesh_proposals` | D1 | Mesh traces / evaluations / proposals ? |
| `agent_dead_letter_records` | D1 | Dead-letter records (DLQ) ? |
| `agent_audit_chain` | D1 | Audit chain ? |
| `agent_runs_pack_balances` / `agent_runs_pack_drafts` / `agent_runs_pack_versions` | D1 | Runs-pack balances/drafts/versions (billing-adjacent) ? |
| `agent_usage_events` | D1 | Usage events ? |
| `agent_tenant_projection_carriers` | D1 | Projection carriers (#4116 — the DO→D1 projection mechanism) ? |

Tier B count: **15 DO tables (+1 watermark) + 20 D1 tables = 35 physical stores.**
`?` marks classifications by name + catalogue context only; each is
verified at build time by its own slice.

### Tier C — per-stage persisted data (the #2870 ALL-DATA model) + blobs

These are **not duplicate run tables** — they are the durable handoff
between stages. Every stage persists ALL its data before the next
stage picks it up; the consumer reads persisted data, never
data-in-message, never re-derived.

| Store | Residency | What it holds |
|---|---|---|
| `job_analyzed_datasets` / `job_enriched_datasets` / `job_generated_datasets` / `job_delivery_datasets` | DO **and** D1 (same shapes both residencies) | Per-stage datasets: analyzed / enriched / generated / delivery |
| `job_pipeline_definitions` / `job_pipeline_definition_versions` | DO **and** D1 | Pipeline job definitions (current) + append-only version history for replay (#5865, #4467) |
| `job_pipeline_artifacts` | DO **and** D1 | Persisted step hand-off artifacts, one row per (run, artifact key) |
| `mas_data_captures` | DO | Immutable feed captures, metadata only — "stored-data-only via immutable mas_data_captures" (§10); blobs in R2 |
| `mas_feed_snapshots` | DO | Feed snapshots (consolidation #1236); INSERT + keep-per-symbol prune as one unit |
| `mas_feed_datasets` | D1 | Feed datasets (D1 side) ? |
| R2 `REPORTS_BUCKET` ("screener") | R2 (one bucket binding) | Report asset blobs + capture blobs (`r2CaptureBlobAdapter.ts`); metadata in DO storage. Content-addressed blobs, not rows |

Tier C count: **9 DO tables + 8 D1 tables + 1 R2 bucket = 18 physical stores
for ~10 logical stores** (the `job_*` family exists in both residencies).

### Tier D — run-lifecycle state (adjacent, not run records; NOT counted in the 63)

| Store | Residency | Why it stays separate |
|---|---|---|
| `screen_run_locks` | DO | Run lock — instance-local synchronous guard (#1993 design note lives on the port). Ephemeral, not a record |
| `mas_stage_claims` / `mas_delivery_claims` / `mas_cancel_previews` / `mas_ladder_states` | DO | Exactly-once claims and order-lifecycle states (delivery claims, cancel previews, bracket-ladder states). Claim semantics, not run history |
| `mas_events` | DO | Append-only hash-chained audit event log (DO residency D-0 (a),(b),(e)); "hash-chain evidence rows ONLY". Different integrity property from a run row |
| `mas_learnings` / `stock_copilot_learnings` | DO | Learnings (copilot critic verdicts, #5034). Read back into behaviour (or, today, half-built — stored, never read) |
| `mas_autopilot` | DO | Autopilot control-state blob (raw value only; shape/merge live in the legacy module) |
| `unified_schedules` | DO | The one ScheduleStore (#3121 Phase 2, #3123) — schedule records, the parent of runs, not runs |
| `agent_breaker_state` / `agent_governance` / `agent_conformance_cells` | D1 | Breaker / governance / conformance state ? |

### Not run records at all (the other ~120 tables — counted, not analyzed)

Config/reference: `mas_settings`, `mas_screener_presets`,
`mas_data_providers`, `mas_data_provider_routes`, `mas_index_lists`,
`mas_iv_history` (market data), `mas_goals` / `mas_scenarios`,
`mas_challengers*`, `mas_strategy_*` (strategy bank), `mas_policy_verdicts`,
`mas_comparison_arm_outcomes`, `mas_adaptation_audit`,
`iaaa_audit_events`, `usage_events`, `user_request_quota_*`,
`research_settings`, `research_task_store`, `mas_agent_workspace_files`,
`kv_store` (session), `paused_schedules`, `pending_schedule_approvals`,
`mas_memory`, `mas_messages`, `mas_transactions`, `mas_do_schema_marker`,
`mas_schema_migrations`, `stock_copilot_control`, `stock_copilot_positions`.
D1: billing, referrals, ads, products, subscriptions, credits,
journals, market nodes/edges, thesis, calibration, digest,
notifications, onboarding, profiles, and the rest of the 86 `agent_*`
tables. Plus framework substrate: `cf_agents_jobs` (Cloudflare Agents
SDK alarm substrate — not ours), `_migrations`.

## 3. Why so many — the short answer

**Three different systems grew three different "job" tables, and then
every programme slice added its own per-kind table instead of
extending the shared one.**

1. **Three eras, three job models.** The legacy sync screener kept
   per-kind rows (`mas_reports`, `mas_opportunity_scans`,
   `mas_discovery_runs`) because each kind had its own reader and its
   own shape. MCP added the job tree (`mas_async_jobs`: checkpoints,
   no stages — the "tool calls return job IDs" contract). The engine
   added pipeline instances (`job_pipeline_instances`: live state +
   resume cursor + stage checkpoints). None replaced the previous
   one; each new system wrote beside the old one.
2. **Two residencies, same logical store twice.** Execution happens
   in two places: agent-hosted (DO SQLite, per-login instance) and
   workflow-hosted (D1 — a pipeline run has no host DO to borrow
   SQLite from). The port pattern gives the *same shape in two
   physical tables* (`job_run_records`, `job_pipeline_*`,
   `job_*_datasets` in both; `mas_async_jobs` → `agent_async_jobs`
   mirror). "The same table" does not exist across residencies —
   that is a design fact, not an oversight. #5852 ruled D1 default
   with DO only as a named exception, but the migration has not
   happened; the port was the compromise.
3. **Shape differences were real at first write.** A job tree
   (checkpoints, no stages) is not an outcome (trigger, counts,
   coded error, no tree) is not a run row (one row per run, ledger
   shape) is not a report (a document with its own lifecycle).
   Each table was the right shape for its first reader. The
   duplication is that the *second* reader never reused the first
   table — it added its own.
4. **The #2870 rule *requires* some of the tables.** Per-stage
   datasets, captures, and snapshots are the durable handoff between
   stages, not duplicate run rows. Collapsing them into the run row
   would break the producer/consumer model (consumer reads persisted
   data, never re-derived). Tier C is defensible by design.
5. **Ownership is the security boundary.** A DO-SQLite table has no
   tenant column because the per-login instance IS the scope; a D1
   table needs tenant columns + owner-scoped reads everywhere.
   Moving a DO table to D1 is not a rename — it changes who can read
   whose rows. That is why the #5852 inventory classifies each use
   (44 movable / 37 exception) instead of moving tables wholesale.
6. **Lock-step producer writes.** `mas_async_jobs` is EXCEPTION in
   the #5852 inventory because the instance's own producers write
   job-tree/stage transitions lock-step (doSqliteAsyncJobAdapter,
   (b)+(e)+(f)). Its retirement (#5963) must solve that write
   pattern, not just move the table. Same logic applies, in smaller
   form, to the bridge rows and the claim tables.

## 4. Trade-offs: one table vs the split

**For one table (the #5852 direction — already decided, not re-decided here):**
one read path; one status; one sweep (the #5963 motivation); no
client-side merge fan-out; no twin-less kinds (corpus / reports /
trading / feed rows invisible in one view and visible in another);
no per-kind drift; every new surface reads the same record.

**Against — the real costs, stated honestly:**
- **Write contention.** DO SQLite is serialized per instance; one hot
  table becomes the contention point for every producer (8 outcome
  writers + bridge rows + claims). D1 handles concurrent writers
  better, but a DO→D1 move turns a local write into a network call
  from the DO — latency + availability change, and the lock-step
  producers lose the serialization they rely on.
- **Retention and cap rules differ per kind.** Outcomes: 90 days /
  500 rows. Reports: kept longer (canonical record). Captures:
  immutable, never pruned. One table forces one retention policy or
  a per-kind policy column — either way the simplicity is partly
  illusory.
- **Query shapes differ.** Ledger: newest-first by job. Outcomes:
  by kind + trigger. Pipeline: resume cursor + checkpoints. One
  table needs indexes for all three, or the readers stay slow.
- **Migration cost and blast radius.** 8 outcome write sites, bridge
  rows, the MCP `get_async_job` contract, the stuck sweep, the
  checkpoint projection (#3963). One table = one failure domain: a
  bad migration breaks every surface at once. Per-kind migration
  (the #6006/#6007/#6008 pattern) bounds the blast radius.
- **Tenant scoping.** D1 needs tenant columns + owner-scoped reads
  on every query; DO gets it free from instance isolation. Every
  moved table must prove the scoping, not assume it.

**Where one table is clearly right:** the run record + its
directly-attached facts (outcome, stage transitions, trigger,
counts, coded error) — one D1 table (`job_run_records`, extended
with the outcome fields) + the one read seam. That is what #6005–
#6008 already do, slice by slice.

**Where a split is defensible:** per-stage datasets and captures
(Tier C — stage handoffs, not run rows); R2 blobs (content-addressed
artifacts, metadata in the run row); `screen_run_locks` (ephemeral
guard); `mas_events` (hash-chained audit evidence — a different
integrity property); schedule records (the parent, not the run).

## 5. Recommendation (with justification)

**Converge the record tier (A + B) into the one run source; keep
Tier C, locks, audit chain, and schedules separate.**

Order, building on what is already filed (do not re-file):
1. **#6005** (runs view reads one source, under #5854) — the read half; lands first so every later convergence is verifiable against one view.
2. **#6006** (`mas_job_outcomes` → one source, under #3123) — the write half of #2606; the re-point's `codedError`/`origin` field-parity delta closes only here.
3. **#6007** (`mas_discovery_runs` → one source, under #3123).
4. **#6008** (`mas_screening_activity` → engine D1 stage model, under #3123) — **builds the D1 stage table first** (it does not exist yet); `job_stage_events` (ScheduledAgent) folds into the same model, not a second one.
5. **#5963** (`mas_async_jobs` retirement, under #3123, already filed) — the hard one; solves the lock-step producer writes, then retires by deprecation, never delete.
6. **#3314** (`mas_opportunity_scans` → one run source, already filed).
7. **This issue's follow-ons (filed as sub-issues under it, one PR each):** `mas_runs`/`mas_run_aliases` registry → run-source id resolution; `mas_reports` stays the canonical report store and is *projected* into the run source (not merged — a report is a document); `mas_enrichment_runs`, `mas_outcomes`/`mas_outcome_tracking`, `research_runs`/`research_evaluations`, `stock_copilot_activity`, `mas_report_confirmations`, `mas_discovery_setup_runs`/`mas_discovery_alerts` → one source, each its own slice; D1 `agent_*` run-adjacent tables (chains, shards, proposals, traces, DLQ, runs-packs) inventoried per table at slice time — several are mirrors/projections, not independent stores, and must not be "converged" twice.
8. **Keep separate, by design:** Tier C datasets + captures + R2 blobs; `screen_run_locks`; `mas_events`; `unified_schedules`; `mas_autopilot` control state. Each keeps its own store with the justification in §4.

**Decisions still needed (not made by this issue):**
- Owner approval for the **ADR 0020 R9 revision** — gates every single-store build (per the #5852 ruling). No build lands before it.
- Whether the D1 stage model (#6008) carries stage *events* or only *transitions* — decides whether `job_stage_events` folds in or stays.
- Whether `mas_reports` projection (recommended) vs merge is accepted — a report's lifecycle (confirmations, delivery states) argues for projection.
- The #5852 81-use inventory lives only in ruling comments on #5852, not in the repo — this issue should pin the inventory (or its pointer) in the repo so the next count does not start from zero.

## 6. Sub-issue filed

**#6056** — "[Rationalization #3123] Why so many job/run tables — full inventory (63 stores), trade-offs, and the one-table recommendation", sub-issue of #3123, labels enhancement + lane:cfo-qunso, read-back verified open with `has_parent: true`. Filing only — no build authorized. Body drafted from this file (`issue-e-tables-rationalization-body.md`).
