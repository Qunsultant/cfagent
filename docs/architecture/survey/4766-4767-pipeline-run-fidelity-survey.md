# SURVEY-RECONCILIATION — #4766 + #4767: pipeline run fidelity (mode per stage; three-way trigger)

- **Issues:** #4766 (record resolved execution mode per stage) and #4767 (split trigger into scheduled / triggered / manual), both sub-issues of epic #3533 (Copilot job pipeline)
- **Base:** `a0d2ec72a96fb554cd72d50d5b1636cf973036ac` — `feat(audit): uniform provenance tuple on run, delivery, denial, and fallback (#4615)`, latest tag on main `v0.1.1854`
- **Worktree:** `~/workspace/w3533/wt-fidelity` (clean at end of survey — `git status` clean; read-only scans only, no tests run, no node_modules linked)
- **Evidence:** `scan-fidelity.mjs` + `scan-fidelity.txt` in this directory
- **Issue state:** both open, parent #3533, **one comment each** — the user's scope direction (2026-11-16): generic mechanism, any run, not Yahoo-only (comments 6910294988 on #4766, 6910296392 on #4767). **Zero lane claims.**
- **Scope note (user 2026-11-16):** this is NOT Yahoo-only. Both issues are sized against the generic mechanism: every job definition/chain/family, every dispatch path, every run. Yahoo-specific code paths are called out explicitly below, and the generic change is sized separately from Yahoo-only surface work.

## 0. Generic-scope verification — one funnel

- **The engine is the single dispatch funnel for every chain.** All 13 real `runJob(` call sites (scan: 14 grep hits, one is a comment) go through `JobPipelineEngine.runJob` → `executeRun` → `execNode` per stage: host doors (`scheduled-agent.ts` runPipelineJob/Stage/Chain), schedule firing + downstream chain dispatches (`scheduledTasksPipeline.ts`), completion firing (`scheduledTasksCompletion.ts`), workflow residency (`jobPipelineWorkflowFlow.ts`), options screen engine (`optionsScreenEngine.ts`), screener workflow (`screenerWorkflow.ts`). A persistence fix in the engine covers every chain; a trigger fix in `executeRun` covers every dispatch path.
- **Definition families:** the static catalog holds exactly ONE family (`screener` in `JOB_DEFINITION_SPECS`, `src/config/jobDefinitionCatalog.ts:84`). Every other chain is built dynamically: feed jobs (`buildFeedJobRegistry` / `buildFeedPipelineJobDefinition`), enrich/analyze/generate/deliver stage jobs (`*PipelineJobs.ts`), per-run screener definitions (`ensureScreenerJob`). The definition count does NOT multiply the work — all definitions flow through `defineJob` → `resolveJobConfig` → the engine.
- **Yahoo-only surface work (separate from the generic change):** the five feed-job runners (`runFeedJob`, `runFeedFundamentalsJob`, `runFeedTechnicalsJob`, `runFeedSentimentJob`, `runFeedOptionsChainsJob` in `src/services/feedJobs.ts`), the feed pull step's hardcoded trigger (`src/services/feedPipelineJobs.ts:583` area), and the feed outcome's Last-run line (`src/client/DataProvidersPanel.tsx:149`). These are Yahoo feed paths; the generic mechanism is the engine + step context + run record. The step-context wiring (see §3) is generic; only the feed step's use of it is Yahoo.

## 1. #4766 — trace of the resolved mode (verified on the base)

### 1a. The path, end to end

1. **Definition config** — `resolveJobConfig` (`src/services/jobPipelineConfig.ts:308`) resolves the root mode: `executionMode: resolveExecutionMode(root.executionMode)` over the defaults (sequential, batch, async, monolith); per-node overrides are kept on the node (`:249-252`). `resolveExecutionMode` (`jobPipelineConfig.ts:119`) merges a partial mode over the defaults axis by axis and refuses invalid values.
2. **Dispatch, per node** — `effectiveMode(ctx, node)` (`src/services/jobPipelineEngine.ts:~2744`) merges `ctx.rootConfig.executionMode` with `node.executionMode` and asserts support. `execNode` calls it per stage. **The resolved per-stage mode IS computed at dispatch; it is simply never written anywhere.**
3. **Stage plan (partial)** — `stageForNode` (engine ~:2402) passes only `execution: mode.concurrency` and `pacing: mode.pacing` into the `StageRunnerStage` plan. Delivery and shape are consumed by the engine itself (shape → shard keys; delivery → sync/async dispatch contract). The plan does NOT carry the full mode.
4. **Checkpoint (no mode)** — `StageRunnerCheckpoint` (`src/workflows/stageRunnerPorts.ts:271`) is `{ runId, units: StageUnitCheckpoint[] }` — one entry per (stage, unit) with status/attempt/error/times. No mode anywhere. The checkpoint is persisted as an opaque JSON blob (`stage_checkpoint_json`) in all three instance adapters (`d1JobPipelineAdapter.ts:73`, `doSqliteJobPipelineAdapter.ts:176`, `inMemoryJobPipelineAdapter.ts:75` — `JSON.stringify`/`JSON.parse`). **No DDL and no adapter change is needed to add a field to the checkpoint object.**
5. **Stage view (live derivation, root-only)** — `projectStageViews` (engine ~:628) sets `executionMode: definition.config.executionMode ?? null` — the ROOT mode, re-derived from the CURRENT definition. Two gaps vs the issue: (a) a per-node override is invisible (the view shows the root mode, not the node's effective mode); (b) a definition change rewrites history. Two producers, both in the engine: the job-status view (:709) and the store-direct read (:2002).
6. **View mapping (drops the mode)** — `subJobStatusFromStageView` (`src/services/jobStageStatus.ts:58`) builds a fresh object with an explicit field list and does NOT carry `executionMode`. The jobStatus route's sub-job entries would not show the mode unless this mapper + `JobSubJobStatus` carry it.
7. **UI** — `JobStatusView.stages` (`JobStageView[]`) reaches the Data Providers chain view via the feed surface view (`buildFeedJobSurfaceView`, `feedPipelineJobs.ts`) and the jobStatus route (`src/agents/routes/jobStatus.ts`, pass-through serialization). `WorkflowRunsPanel.tsx` reads the separate `workflowRuns` service (its own `executionMode?: string | null`, a workflow-run field, not the pipeline stage mode) — likely no change; verify in build.

### 1b. Persistence design (the fork the build must settle)

- **Recommended home: a per-stage mode map on the checkpoint object** (e.g. `stageModes?: Record<stageId, JobExecutionMode>` on `StageRunnerCheckpoint`). Per-run granularity matches the checkpoint (a new dispatch replaces it); the blob needs no DDL; the three adapters pass it through untouched; the mas_async_jobs projection adapter simply omits it (absent = unknown, pre-tracking runs stay honest).
- **The write discipline matters.** The engine keeps an in-memory ledger and persists it via `persistLedger` (engine ~:2395), which constructs a FRESH `{ runId, units }` object — an extra checkpoint field would be DROPPED there unless `persistLedger` carries it. The other checkpoint writes (:1346/:1412/:1523/:1613) spread the read checkpoint (`{...ledger, units: ...}`), so they preserve an extra field. And on resume the ledger is rebuilt from the stored checkpoint — the map must be read back into the ledger at run start, or a resumed run's next `persistLedger` drops it. So the build must: (a) stamp the map in `execNode` (from `effectiveMode`), (b) carry it in `persistLedger`, (c) restore it into the ledger on resume.
- **Alternative home (heavier, not recommended):** a new field on `JobInstanceRecord` — needs column changes in all three adapters + the Drizzle schema + DO DDL (the `remainderAlterSql` precedent exists for `run_schedule_id` etc.), and the instance is per-job while the mode is per-run, so it would need the same replace discipline as the checkpoint anyway.

### 1c. Files to change — #4766 (~6–8 files)

| # | File | Change |
|---|---|---|
| 1 | `src/workflows/stageRunnerPorts.ts` | `StageRunnerCheckpoint` gains the optional per-stage mode map |
| 2 | `src/services/jobPipelineEngine.ts` | `execNode` stamps the effective mode; `persistLedger` + resume carry it; `projectStageViews` reads the stored map (absent → null/unknown) instead of `definition.config.executionMode` |
| 3 | `src/services/jobStageStatus.ts` | `subJobStatusFromStageView` + `JobSubJobStatus` carry the mode through to the jobStatus route |
| 4 | `src/client/DataProvidersPanel.tsx` | Render the per-stage mode in the chain view |
| 5 | `tests/job_pipeline_mode_per_stage_4766.test.ts` (new) | Pin: mode persisted per stage, equals the resolved mode; view reads the stored mode; pre-tracking run reads unknown |
| 6 | `changelog.d/4766-*.md` (new) | Fragment |
| — | `src/client/WorkflowRunsPanel.tsx`, `src/agents/routes/jobStatus.ts` | Verify in build; expected no change (route is pass-through; panel reads the separate workflowRuns service) |
| — | `src/data/d1JobPipelineAdapter.ts`, `src/data/doSqliteJobPipelineAdapter.ts`, `src/data/inMemoryJobPipelineAdapter.ts`, `src/data/drizzleSchema.ts` | NO change (opaque JSON blob) |
| — | Existing stage-view tests (~10 files: `analyze/enrich/generate/deliver/feed_pipeline_jobs_35xx`, `job_pipeline_3534`, `job_pipeline_foundation_3548`, `job_pipeline_stage_control_3549`, `chain_pipeline_proof_3540`) | Read-through only; the new field is optional, so existing assertions should pass unchanged — verify in build |

### 1d. Size verdict — #4766: SMALL (filed Medium — stale)

The filed Medium assumed "ports + stage checkpoint/unit adapters". The adapters do NOT change (blob), the ports need only a type addition, and the engine is a single funnel: one stamping point (`execNode`), one write point (`persistLedger`), one view point (`projectStageViews`). ~4 source files + 1 new test + 1 fragment. The only genuine complexity is the write discipline (persistLedger/resume carry-forward), which is a contained design point, not a large change.

### 1e. Test plan — #4766

- New `tests/job_pipeline_mode_per_stage_4766.test.ts`: (a) dispatch a run with a per-node mode override, read the checkpoint back, mode present per stage and equal to `effectiveMode`; (b) stage view reads the stored mode, not a re-derivation (change the definition after the run, view unchanged); (c) pre-tracking checkpoint (no map) reads unknown, never a fabricated mode; (d) resume carries the map forward.
- Affected suite (engine + stage-control + pipeline-jobs tests) + full suite with exact delta vs pristine baseline.

## 2. #4767 — trace of the trigger (verified on the base)

### 2a. The body is stale in a material way: THREE trigger vocabularies, not one

| Vocabulary | Type | Values today | Where |
|---|---|---|---|
| Instance `runTrigger` | `JobInstanceRecord.runTrigger` (`src/data/jobPipelinePorts.ts:222`) | `"scheduled" \| "manual" \| null` | Stamped at dispatch (`executeRun`, engine :2162 `runTrigger: opts.trigger`); read at settle (`:873/:940/:2064/:2090`, `?? "manual"`) |
| Record `triggeredBy` | `JobRunTrigger` (`src/data/jobRunRecordPorts.ts:54`) | `"scheduled" \| "manual"` | Comment: "scheduled = the cadence fired it; manual = a Run-now / trigger". Validated by `TRIGGERS` (`src/services/jobRunRecords.ts:64`) in `buildJobRunRecord` |
| Ledger `trigger` | `JobRunLedgerTrigger` (`src/data/jobRunRecordPorts.ts:66`) | `"scheduled" \| "manual" \| "worker-cron" \| "async-chain" \| "unknown"` | `LEDGER_TRIGGERS` + `isLedgerTrigger` + `resolveLedgerTrigger` (`src/services/consolidatedScheduling.ts:72-112`); derived from `triggeredBy` when not stamped explicitly; "unknown" is legacy-rows-only |
| (Separate ledger — out of scope pending ruling) | `WorkflowRunTrigger` (`src/services/workflowRuns.ts:81`) | `"manual" \| "scheduled" \| "autonomous" \| "webhook" \| "agent" \| "unknown"` | Workflow runs (ThinkWorkflow residency), surfaced in `WorkflowRunsPanel.tsx` (filter enumerates scheduled/manual/autonomous/webhook/unknown) |

The O4 decision (`docs/architecture/scheduling/3121-s0-inventory.md` §4, pinned): "`triggeredBy` stays the two-valued human-facing origin (scheduled | manual); `trigger` is the five-valued ledger vocabulary." The three-way split overturns the first half of O4 — the inventory doc must be updated in the same change.

### 2b. Dispatch sites — 13 engine `runJob(` sites, classified

| Site | Trigger today | Under the three-way split |
|---|---|---|
| Schedule firing (`dispatchScheduledPipelineJob`, `scheduledTasksPipeline.ts:709`) | `"scheduled"` (+ scheduleId threaded, #3310) | No change — this IS "scheduled" |
| Downstream chain dispatches (`scheduledTasksPipeline.ts:993/1039/1085/1131` — enrich/analyze/generate/deliver after feed completion) | `"scheduled"` | **Classification question (Q1)** — no clock fired them; they are chain firings |
| Completion firing (`scheduledTasksCompletion.ts:65`) | `"scheduled"` | **Same Q1** |
| Host door `runPipelineJob` (`scheduled-agent.ts:935`) — the feed-run route's Run now | hardcoded `"manual"` | **"triggered"** (when the job has a schedule) — the exact conflation the issue names |
| Host door `runPipelineChain` (`scheduled-agent.ts:1466`) | hardcoded `"manual"` | "triggered" when the job has a schedule, else "manual" |
| Host door `runPipelineStage` (`scheduled-agent.ts:963`) | param `trigger?: "manual" \| "scheduled"` | Type widens; same derivation rule per scope |
| Workflow residency (`jobPipelineWorkflowFlow.ts:77`) | `payload.trigger ?? "manual"`; payload type `:30` is `"manual" \| "scheduled"` | Type widens; derivation rule applies |
| Options screen engine (`optionsScreenEngine.ts:1019`) | `params.trigger ?? "manual"`; `:1200` hardcoded `"manual"` | Type widens; derivation rule applies |
| Screener workflow (`screenerWorkflow.ts:308`) | `runCommand.trigger` (`runBridge.ts:59`, `"manual" \| "scheduled"`) | Type widens; per-run chat jobs have no schedule → "manual" stays correct |
| Mesh doors (`meshScreenDoor.ts:568/659/1027`) | hardcoded `"manual"` on `WorkflowJobCommand` builds | No behavior change (per-run jobs, no schedule); literals stay valid under the widened type |
| Engine internal re-run (`jobPipelineEngine.ts:1032`, after clearing an instance) | hardcoded `"manual"` | **"triggered"** when the job has a schedule (a re-run IS manually triggering a scheduled job) — see Q4 |
| Feed-run route (`dataProviders.ts:1006` + 5 feed-job action sites + `:1656` chain site) | calls the door with no trigger (door hardcodes "manual") | No change IF the engine derives "triggered" (recommended); explicit stamping instead would touch all 7 call sites |

### 2c. The feed path has a SECOND trigger channel (Yahoo surface, generic mechanism)

- The five feed-job runners (`runFeedJob`, `runFeedFundamentalsJob`, `runFeedTechnicalsJob`, `runFeedSentimentJob`, `runFeedOptionsChainsJob` in `src/services/feedJobs.ts`) each take `RunFeedJobOptions.trigger?: "manual" | "scheduled"` (`:739`) and default it (`opts.trigger ?? "manual"` at :946/:1240/:1531/:1872/:2309). The feed outcome's trigger (`feedJobOutcomes.ts:85`, `trigger: settle.trigger`) is what the card's Last-run line renders (`DataProvidersPanel.tsx:149`, `lastRun.trigger`, typed `string` in `dataProvidersApi.ts` — no client change needed for a new value).
- **The feed pull step hardcodes it** (`src/services/feedPipelineJobs.ts`, `runOpts = { trigger: "manual" as const, runId: ctx.runId, ... }`). The step context (`JobStepContext`, `src/services/jobPipelineSteps.ts:21`) has NO trigger field. So fixing the engine's run-record trigger does NOT fix the card's Last-run line: the build must carry the run's trigger into the step context (engine → step ctx → feed step → `runOpts`), a generic wiring change whose only current consumer is the feed step.

### 2d. How "triggered" is detected (recommendation)

- **Recommended: the engine derives it at dispatch, in `executeRun`** (engine :2140-2162, where the definition is already in hand and `runTrigger: opts.trigger` is stamped). Rule: a dispatch whose trigger is NOT "scheduled" (no clock fired it) records "triggered" when the job's definition has a schedule enabled, else "manual". Evidence the schedule is available in-engine: `registerSchedules` (engine :1126-1145) already reads `definition.config.schedule` (root) and `node.schedule` (per-node) to register firings; feed definitions carry `schedule: { enabled: true, interval }` on the root (`buildFeedPipelineJobDefinition`, `feedPipelineJobs.ts:360`); the surface view already reads "the STORED definition's schedule" (`feedPipelineJobs.ts:737-743`). One place, all 13 dispatch sites covered, no caller changes.
- **Alternative (not recommended):** explicit stamping at each dispatch site — the door checks the definition, the workflow flow checks the payload's job, etc. Same rule reimplemented N times; the door today takes only `{ userLogin }` and would need the definition threaded through.
- **What "has a schedule" means:** the definition's schedule config enabled (root or the dispatched node's schedule), NOT `runScheduleId` (that records the schedule that dispatched the LAST run — a job whose schedule never fired yet has null) and NOT `scheduleId` on the run (absent on a Run-now by construction).

### 2e. Compat traps (must be in the build)

- **The read normalizer degrades unknown values to `"unknown"`** (`normalizeLedgerLinkage`, `consolidatedScheduling.ts:176`: `trigger: isLedgerTrigger(value.trigger) ? value.trigger : "unknown"`). If "triggered" is stored but NOT added to `LEDGER_TRIGGERS`/`isLedgerTrigger`, reads silently turn it into "unknown". Extending the ledger vocabulary is REQUIRED, not optional.
- **Write validation rejects unknown `triggeredBy`** (`buildJobRunRecord`, `jobRunRecords.ts:97`, against `TRIGGERS: ["scheduled", "manual"]`). Widening `JobRunTrigger` without widening `TRIGGERS` makes the new value unrecordable.
- **Old rows keep their meaning with no migration.** `run_trigger` (DO adapter columns map, `doSqliteJobPipelineAdapter.ts:57`), `runTrigger: text("run_trigger")` (Drizzle, `drizzleSchema.ts:1821`), and `triggerText` (D1 run records) are all TEXT — a third value needs no DDL. Old `"manual"` rows are NOT rewritten (per the issue's requirement 5); they stay "manual" even when they were in fact Run-nows — disclosed, not repaired.

### 2f. Files to change — #4767 (~14 source files + tests + doc + fragment)

| # | File | Change |
|---|---|---|
| 1 | `src/data/jobPipelinePorts.ts` | `runTrigger` gains `"triggered"` |
| 2 | `src/data/jobRunRecordPorts.ts` | `JobRunTrigger` gains `"triggered"`; `JobRunLedgerTrigger` gains `"triggered"` (six-valued) |
| 3 | `src/services/consolidatedScheduling.ts` | `LEDGER_TRIGGERS`, `isLedgerTrigger`, `resolveLedgerTrigger` derivation, `buildLedgerLinkage` |
| 4 | `src/services/jobRunRecords.ts` | `TRIGGERS` validation list (+ read-normalizer coverage via #3) |
| 5 | `src/services/jobPipelineEngine.ts` | `runJob` opts type; `executeRun` derives "triggered" from the definition schedule; terminal stamping (:873/:940/:2064/:2090) carries the widened type; re-run (:1032) under the derivation rule |
| 6 | `src/agents/scheduled-agent.ts` | Door trigger params widen (`runPipelineStage`); door `runPipelineJob`/`runPipelineChain` keep passing "manual"/nothing — the engine derives (no behavior change in the doors themselves; verify in build) |
| 7 | `src/services/jobPipelineSteps.ts` | `JobStepContext` gains the run's trigger |
| 8 | `src/services/feedPipelineJobs.ts` | Feed pull step passes `ctx.trigger` into `runOpts` instead of hardcoded `"manual"` |
| 9 | `src/services/feedJobs.ts` | `RunFeedJobOptions.trigger` gains `"triggered"` (5 runner functions, type only — the value arrives via the step) |
| 10 | `src/services/feedJobOutcomes.ts` | Settle trigger type pass-through (verify in build) |
| 11 | `src/workflows/jobPipelineWorkflowFlow.ts` | Payload `trigger` type widens |
| 12 | `src/workflows/optionsScreenEngine.ts` | `params.trigger` type widens (2 sites) |
| 13 | `src/workflows/screenerWorkflow.ts` + `src/agents/orchestrator/runBridge.ts` | `runCommand.trigger` type widens |
| 14 | `src/agents/scheduledTasksPipeline.ts`, `src/agents/scheduledTasksCompletion.ts` | Only if Q1 rules chain/completion firings off "scheduled" |
| 15 | `docs/architecture/scheduling/3121-s0-inventory.md` | O4 decision updated (triggeredBy two-valued → three-valued; derivation order) |
| 16 | `tests/pipeline_trigger_three_way_4767.test.ts` (new) | Dispatch-path tests (schedule fire → scheduled; Run now on scheduled job → triggered; Run now on unscheduled job → manual; ad-hoc UX → manual; re-run → triggered) + type pin (exactly the three values on `JobRunTrigger`/`runTrigger`; ledger six values) |
| 17 | `changelog.d/4767-*.md` (new) | Fragment |
| — | `src/agents/routes/dataProviders.ts` (7 door call sites), `src/agents/orchestrator/meshScreenDoor.ts` (3 "manual" literals) | No change under engine-derivation (verify in build); mesh literals stay valid |
| — | `src/client/DataProvidersPanel.tsx`, `src/services/runDetails.ts` | No change (trigger is `string` / `string \| null` — "triggered" renders as-is) |
| — | `src/client/WorkflowRunsPanel.tsx` + `src/services/workflowRuns.ts` | Only if Q3 brings workflow runs in scope (filter enumerates trigger values) |
| — | Existing trigger tests (~8–10 pipeline/feed files: `chain_firing_scheduled_agent`, `completion_trigger_4425`, `job-run-records-2964`, `job_pipeline_3534`, `job_pipeline_foundation_3548`, `pipeline_orphan_settle_4002`, `pipeline_orphan_settle_host_4002`, `feed_copilot_outcomes_3530`, `feed_jobs_routes_3530`) | Update assertions that pin the two-valued vocabulary; the raw grep counts (59 test files mention triggeredBy/runTrigger, 270 mention "manual") are mostly OTHER ledgers (options runs, screen submissions, NLQ) and are NOT in scope |

### 2g. Size verdict — #4767: MEDIUM (filed Medium — confirmed)

~14 source files + 1 new test + ~8–10 test updates + 1 doc + 1 fragment, but the size is driven by classification surface, not count: 13 dispatch sites to classify, three vocabularies to widen coherently, the step-context wiring, the O4 doc, and the derivation rule. No DDL, no new stores, no UI redesign, one engine funnel. Not Large.

### 2h. Test plan — #4767

- New `tests/pipeline_trigger_three_way_4767.test.ts`: one run of each kind through the engine (schedule fire, Run now on a scheduled job, Run now on an unscheduled job, ad-hoc UX run, re-run of a scheduled job), each asserting the recorded trigger on the instance, the terminal run record, and the feed outcome; pin on the trigger types (exactly three values on `JobRunTrigger`/`runTrigger`; six on the ledger); old-row test (a stored `"manual"` row reads back `"manual"`, never rewritten).
- Affected suite (engine + feed + run-record + completion/chain tests) + full suite with exact delta vs pristine baseline.

## 3. Reconciliation vs the issue bodies

### #4766

| Body claim | Verdict on current main |
|---|---|
| Mode derived at dispatch, not stored | **Confirmed** (`effectiveMode` per node; nothing persists it) |
| Stage view carries `definition.config.executionMode ?? null` | **Confirmed** (engine ~:649) — with the correction that it is the ROOT mode, not the per-node effective mode; node overrides are invisible in the view |
| "Persist … (ports + stage checkpoint/unit adapters + engine dispatch path)" | **Stale** — the adapters do NOT change (opaque JSON blob); the ports change is a type addition on the checkpoint; the engine + view mapping are the work |
| "Per stage, not just per run" | **Confirmed as the requirement** — `effectiveMode` already resolves per node; the persistence must preserve that per-node resolution |
| Size: Medium | **Stale — Small** (see §1d) |

### #4767

| Body claim | Verdict on current main |
|---|---|
| "The run record's `trigger` is two-valued" | **Stale** — the ledger `trigger` is FIVE-valued; the two-valued ones are `triggeredBy` and instance `runTrigger`. The split must widen all three coherently (see §2a) |
| "Three dispatch paths" (schedule / feed-run route / ad-hoc UX) | **Understated** — 13 engine `runJob` sites across 8 files, plus 5 feed runners, the feed step, mesh/bridge/workflow/options paths (see §2b) |
| "Run now on a scheduled job records `manual`" | **Confirmed** — door hardcodes `"manual"` (`scheduled-agent.ts:935`) AND the feed step separately hardcodes `"manual"` (`feedPipelineJobs.ts` runOpts) |
| "The `triggered` path must correctly detect 'this job has a schedule'" | **Confirmed as the crux** — answer: the definition's schedule config, read in-engine at dispatch (see §2d); `runScheduleId`/`scheduleId` are the wrong source |
| "Migration/compat for stored values" | **Confirmed, and no DDL** — all trigger columns are TEXT; the compat work is the normalizer + validation lists (§2e) |
| "Each dispatch site passes its trigger explicitly" (requirement 6) | **In tension with the recommended engine-derivation** — derivation means callers keep passing "manual"/nothing and the engine reinterprets. Needs a ruling (Q2): explicit stamping at each site vs one derivation rule in `executeRun` |
| Size: Medium | **Confirmed** (see §2g) |

## 4. Open questions (need a user ruling before building)

- **Q1 — Chain/completion firings (#4767):** downstream stage dispatches (enrich/analyze/generate/deliver after feed completion) and completion firings currently stamp `"scheduled"`, but no clock fired them. Keep `"scheduled"` (system-caused bucket), move them to the ledger's existing `"async-chain"`, or add a fourth run value? The user's three definitions do not cover system-fired non-clock runs.
- **Q2 — Derivation vs explicit stamping (#4767):** should the engine derive "triggered" at dispatch from the definition's schedule (recommended — one place, all 13 sites), or should each dispatch site stamp it explicitly (the issue body's requirement 6 as written)? Derivation contradicts requirement 6 as written.
- **Q3 — Workflow runs (#4767):** the separate `WorkflowRunTrigger` vocabulary (six-valued, own ledger, `WorkflowRunsPanel` filter) — in or out of the split? Recommendation: out — separate ledger, separate issue if wanted.
- **Q4 — Re-runs/retries (#4767):** the engine's internal re-run stamps `"manual"` today. Under the derivation rule a re-run of a scheduled job records `"triggered"`. Confirm: a re-run counts as manually triggering a scheduled job.
- **Q5 — Scoped stage runs (#4767):** `runPipelineStage` takes an explicit trigger param — does the same derivation rule apply per scope (the dispatched node's schedule, not just the root's)?
- **Q6 — Checkpoint home (#4766):** stages map on `StageRunnerCheckpoint` (recommended — no DDL, per-run granularity) vs a new instance-record field (heavier, needs adapter + DDL work). Confirm the checkpoint home.
- **Q7 — Mode shape in the view (#4766):** full `JobExecutionMode` per stage (recommended — one shape, no delta logic) or only the axes that differ from the run default?
- **Q8 — WorkflowRunsPanel (#4766):** it reads the separate workflowRuns service (own `executionMode` string). Does the pipeline per-stage mode belong there, or only on the Data Providers chain view + jobStatus route? Recommendation: chain view + jobStatus only.
