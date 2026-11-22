# Run-logging research — Autopilot outcomes, J-stack residency, duplicate logging capabilities

**Researched:** 2026-11-21 ~07:16–07:35 EST, live main `dc021d3e` (verified: `~/workspace/cfagent-2606/repo` on `dc021d3e`, origin/main also `dc021d3e`).
**Starting point:** `~/workspace/cfagent-2606/reconciliation.md` (the three read paths, twin-less kinds). This report is the storage layer beneath it.
**Filing only:** no code, no PR, no §15. Four sub-issues filed, all read-back verified.

## Q1 — Where does Autopilot store its job outcomes? Which table, is it D1, is it in the run ledger?

**`mas_job_outcomes`, DO-SQLite, NOT D1.** It lives in the owning OrchestratorAgent Durable Object instance's own SQLite, per-login scope, no tenant column.

- Port header, `src/data/jobOutcomePorts.ts`: "ADR D-0 ruled this family DO-resident behind a port (audit §3): the feed reader is the owning instance's Autopilot Control (property (e) at write). The family owns TWO tables — mas_job_outcomes AND the mas_job_outcomes_meta prune watermark." Adapters: `doSqliteJobOutcomeAdapter.ts` (production), `inMemoryJobOutcomeAdapter.ts` (test double). "No tenant column exists on either table — the per-login instance IS the scope."
- Adapter, `src/data/doSqliteJobOutcomeAdapter.ts`: `DoSqliteJobOutcomeStore`, `ensureTables()` runs `doTableSql("mas_job_outcomes")` + index `idx_mas_job_outcomes_created`.
- The `sql` handle is the OrchestratorAgent DO's `this.ctx.storage.sql` (`src/agents/orchestrator.ts:2001-2015`, `ensureTables()` → `ensureOrchestratorTables(this.ctx.storage.sql)`; `recordFeedJobOutcome` writes into "THIS instance's job-outcome sink").
- Retention: 90 days, 500-row cap (`JOB_OUTCOMES_RETENTION_DEFAULT_DAYS`, `JOB_OUTCOMES_KEEP_ROWS`, `jobOutcomePorts.ts`).

**Eight write sites** (`recordJobOutcome`, `src/services/jobOutcomes.ts:59`):

| Kind | Writer |
|---|---|
| stock (bridge) | `src/agents/orchestrator/asyncJobs.ts:1710` |
| options | `src/services/optionsServeRecord.ts:267` (`recordOptionsRunOutcome`) |
| goal | `src/services/goalScreenReports.ts:185` (`recordGoalRunOutcome`) |
| discovery | `src/services/scheduledTasks.ts:913` (`recordDiscoveryOutcome`) |
| corpus | `src/agents/routes/knowledgeCorpus.ts:281` |
| reports | `src/agents/routes/reports.ts:308` |
| trading | `src/services/tradingRunOutcome.ts` (`order:<orderId>`, #3812) |
| feed | `src/services/feedJobOutcomes.ts` / `recordFeedJobOutcome` (`src/agents/orchestrator.ts:2015`) |

**Is it in the run ledger? No — not in either ledger merge. It reaches one view through a third read:**

- `GET /api/ledger/runs` (`src/server/routes/trading.ts:108` → `readMergedLedgerRuns` → `mergeLedgerRuns`, `src/services/unifiedLedger.ts:79`): merges only the two DO halves (OrchestratorAgent DO-SQLite `job_run_records` + ScheduledAgent KV `listJobRuns`). Never reads `mas_job_outcomes`; header states the sink "stays the outcome sink — this module never writes either".
- `GET /api/runs` (`src/agents/routes/reports.ts:1313`): merges five stores — `mas_reports`, `mas_opportunity_scans`, `mas_discovery_runs`, ScreenerAgent feed, engine D1 job records. `mas_job_outcomes` is not among them. The four screen families appear here via their canonical `mas_reports` twin; the twin-less kinds (corpus, reports, trading, feed) do not appear at all.
- `GET /api/workflow-runs` (Workflow Runs model, `src/services/workflowRuns.ts`): **does** read it — "mas_job_outcomes supplies the run-level facts a job tree does not carry: the trigger, the scan counts, the coded error, the artifact keys, and the per-channel delivery states. An outcome whose id names a job in a run is that run's outcome; an outcome with no job twin is its own run … rather than being dropped."

## Q2 — Is Autopilot on the J-stack? What runs its jobs? If not, why not?

**Short answer: the jobs Autopilot shows run through the engine when the dispatch gate passes, and through the legacy sync dispatch when it does not. Autopilot itself — its control surface and its logging — is NOT on the J-stack: it has no engine workflow, and it reads/writes the DO-SQLite outcome sink, not the engine's D1 records.**

What runs Autopilot's jobs: the scheduled firer in `src/services/scheduledTasks.ts` (Autopilot is the automation surface over scheduled runs; there is no separate "Autopilot runner" and no "autopilot" in `src/workflows/`).

- Stock scheduled screens: the one engine seam `runStockScreenViaEngine` (#4278, `scheduledTasks.ts:1972`) — "the monolithic scheduled run goes through the one engine seam (was getScreenerAgent(userLogin).runScreen)".
- Options scheduled screens: `runScheduledFirerPanelViaHost` (`scheduledTasks.ts:4741`, `:5029`) behind the #4854 host dispatch gate.
- Strategy: `runStrategyScreenViaEngine` (`scheduledTasks.ts:3374`).
- Options sharded chain: **#4780 is CLOSED** — routed through the one engine (the summary's "still open" is stale; verified live 2026-11-21).
- Goal + strategy landing: **#3552 is OPEN** with all six sub-issues completed (100%) — done in substance, parent not closed out.
- Copilot is separate: the autonomous loop is the Think task `stock-copilot-paper-cycle` (`src/agents/orchestrator/scheduledTasksCopilot.ts:82`, `:304`).

**Why not fully — recorded reasons, from code/issue text, not invented:**

1. The #4854 gate's sync fallbacks (`scheduledTasks.ts:533-568`): route "host" (engine) only when the broker pair derives + residency bindings are configured + no snapshot input. Otherwise the unchanged sync dispatch: no broker stage input → sync; snapshot input → sync ("a snapshot input rides along, so the run executes on its stored snapshot — the snapshot does not travel on the job definition"); residency bindings not configured → sync.
2. #4859 (`scheduledTasks.ts:660-664`): a host-path screen "is not addressable by per-stage control from the copilot turn until control moves to the durable stores".
3. The outcome sink: the engine's D1 records carry no trigger/counts/coded error (Workflow Runs header: D1 record "with an honest empty stage list"), so even engine runs still log their Autopilot-visible facts into the DO-SQLite sink — via the serve-layer outcome writers and the mesh/chain bridge row (`startScreenBridge`, #3787, starts an engine workflow run AND writes a `mas_async_jobs` bridge row).
4. #3552 still OPEN (close-out is a separate call).

**Could NOT be established:** whether the #4854 gate's "host" route is actually reached in the deployed production environment (whether the residency bindings are configured there). That is a deployment fact, not visible in code.

## Q3 + steer — Which tables does the run ledger surface? Is it one source? What duplicates exist?

### The runs view (`?tab=schedules&view=runs`) — pinned, not guessed

`ScheduleRunLedgerPanel.refresh()` (`src/client/ScheduleRunLedgerPanel.tsx:336-375`) makes **four endpoint reads** and composes them client-side (`mergedRuns`, `:391-397`):

| # | Read | Stores surfaced |
|---|---|---|
| 1 | `listAllRuns` → `GET /api/ledger/runs` (`src/client/jobsApi.ts:322`) | `job_run_records` (DO-SQLite, OrchestratorAgent, `doSqliteJobRunRecordAdapter.ts:24`) + ScheduledAgent KV `listJobRuns` |
| 2 | `GET /api/workflow-runs?limit=100` → Workflow Runs model | `mas_async_jobs` + `mas_screening_activity` + `mas_job_outcomes` (DO-SQLite) + engine D1 job records; folded by `attachWorkflowRuns` as `system: "workflow-runs"` |
| 3 | `GET /api/runs?kind=all&limit=100` → five-store merge | `mas_reports` + `mas_opportunity_scans` + `mas_discovery_runs` (DO-SQLite) + ScreenerAgent feed + engine D1 job records; folded by `attachReportRuns` as `system: "report-runs"` |
| 4 | `GET /api/options/latest` | JOIN only (symbols/actionable setups by timestamp, #4332) — not a row source |

Plus on-demand `/api/runs/details` for the detail modal. **Total: ten stores, three merges, four reads. It is NOT one source today.**

Physical-store inventory (all verified on `dc021d3e`): DO-SQLite — `job_run_records`, `mas_async_jobs`, `mas_screening_activity`, `mas_job_outcomes`, `mas_reports` (`doSqliteCanonicalReportStoreAdapter.ts`), `mas_opportunity_scans` (`doSqliteScanRunAdapter.ts:46-48`), `mas_discovery_runs` (`doSqliteDiscoveryRunAdapter.ts:41`); ScheduledAgent KV (`jobRunRecords` key); ScreenerAgent feed store (`ScreenerRunResult`, `runSummaries.ts:15`); D1 — engine job records (`d1JobRunRecordAdapter.ts`, migration 0047).

### The single source is decided — no new decision issue

- #5852 **RULED** 2026-11-20: one store (option C), D1 is the default store, DO only as a named exception, zero exceptions after the programme. ADR 0020 R9 revision (owner approval) still gates any single-store build.
- #3946 **CLOSED** (Option B): the one read seam merges D1+DO (`src/services/jobRunRecordReads.ts`).
- #4116 **CLOSED**: DO run ledgers projected into D1.
- #5854 (OPEN, sub-issue of #5852) is the read-seam gap; its stated blocker (the #5852 ruling) has landed. Its scope: "one merged-read implementation shared by the run ledger, Workflow Runs, `/api/runs`, and `/api/runs/details`".

### Duplicate logging capabilities and their convergence targets

| Duplicate | Physical store | Convergence target |
|---|---|---|
| Outcome sink | `mas_job_outcomes` (+ watermark), DO-SQLite | D1 job records + canonical `mas_reports` rows → **#6006** |
| Job-tree tracking/checkpoints | `mas_async_jobs`, DO-SQLite | Engine D1 → **#5963 (already filed, not re-filed)** |
| Per-kind opportunity scans | `mas_opportunity_scans`, DO-SQLite | One run source → **#3314 (already filed, not re-filed)** |
| Per-kind discovery runs | `mas_discovery_runs`, DO-SQLite | One run source → **#6007** |
| Stage transitions (skipped/held WHY) | `mas_screening_activity`, DO-SQLite | Engine D1 stage model (does not exist yet — must be built) → **#6008** |
| Ledger merge halves | `job_run_records` (DO-SQLite) + ScheduledAgent KV | D1 via the one read (projection #4116) → **#6005** (view half) |
| The three merges themselves | ledger merge vs #3946 seam vs `/api/runs` five-store merge | One merged-read implementation → **#5854 (already filed)**; view half → **#6005** |
| Per-kind outcome writers (8 sites) | write sink + (sometimes) canonical row | One write into the one source → **#6006** |

## Sub-issues filed (all read-back verified: open, has_parent true, correct parent)

| # | Title | Parent | Scope in one line |
|---|---|---|---|
| [#6005](https://github.com/Qunsultant/cfagent/issues/6005) | [Sub-issue #5854] Runs view reads one source: ScheduleRunLedgerPanel through the one read seam, not four endpoint reads | #5854 | View reads one endpoint; the three client-side attaches + ledger fan-out go; lossless proof incl. #6003's options |
| [#6006](https://github.com/Qunsultant/cfagent/issues/6006) | [Convergence #3123] mas_job_outcomes outcome sink into the one run source (D1 job records + canonical rows) | #3123 | Eight write sites + two readers move to the one source; sink retires on parity |
| [#6007](https://github.com/Qunsultant/cfagent/issues/6007) | [Convergence #3123] mas_discovery_runs per-kind store into the one run source | #3123 | Discovery runs recorded once; per-kind table retires on parity |
| [#6008](https://github.com/Qunsultant/cfagent/issues/6008) | [Convergence #3123] mas_screening_activity stage transitions into the engine D1 stage model | #3123 | D1 gains the stage-transition record (must be built); DO table retires on parity |

Bodies: `~/workspace/cfagent-runlog-research/issue-a-view-one-source-body.md`, `issue-b-job-outcomes-body.md`, `issue-c-discovery-runs-body.md`, `issue-d-stage-transitions-body.md`.

**Parent rationale:** #6005 goes under #5854 because its point is the read seam (#5854's scope is the one merged-read implementation; #6005 is its view half, and #5854's #5852 blocker has landed). #6006/#6007/#6008 go under #3123, the unify programme parent (sibling of #5963), because each is a store convergence, not a read-seam point.

**Not re-filed (with the covering issue):** the one-source decision itself — #5852 RULED; the two-merge unification — #5854 OPEN; mas_async_jobs retirement — #5963 OPEN; mas_opportunity_scans — #3314 OPEN; options-runs folding — #4259 OPEN / #4332 CLOSED; #3124 OPEN is the scheduler-side one-read-path sibling (efficiency, post-#3123), not the view enforcement. Prior searches: "mas_job_outcomes" 0 results; "mas_discovery_runs" 0 results; "mas_screening_activity stage transition" 7 hits, none covering the table's convergence; "run ledger single source one source" 20 hits, listed in the report above.

## Impact on #6003 / #2606

- **#6003** (ledger Autopilot/Copilot options, builder running): its options land on the composed view today; once #6005 lands, its counts must come from the one source. #6005's scope says landing it must not drop those options. No change to the #6003 build — but its lossless proof should be re-run against the one source after #6005.
- **#2606** (Autopilot re-point, HELD pending #6003): #6006 is its write half — the re-point's field-parity delta (`codedError`/`origin` absent from `RunSummary`) can only close once the outcome facts land in the one source. The re-point stays held pending #6003 as decided; #6006 is the follow-on that makes the re-point render fully.
