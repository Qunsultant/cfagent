# #3121 Slice S0 — Scheduling feature inventory + target design + parity harness

- **Program:** Qunsultant/cfagent#3121 — consolidate scheduled implementations and
  schedule surfaces into one scheduler and one surface family, losslessly.
- **Slice:** S0 only — inventory + target design + parity-test harness.
  No migration, no behavior change, no file deletions.
- **Verified against:** fresh `main` at `3c352390`
  (`docs(3241): free vs paid screen entitlements definition`), 2026-11-05.
- **Baseline compared against:** the 2026-11-04 verification behind the #3121
  body and comment 6628479442, and the #2366 seed inventory (main `f61128c`,
  2026-10-29).
- **Parity harness:** `tests/schedule-3121-s0-parity.test.ts` — every inventory
  item below carries a test id (`S0-Pxx`). A feature not on this inventory is
  a defect in the inventory, not permission to drop it.
- **Related:** #2366 (this program consolidates into #2366's target: one
  scheduler + one run ledger; S0 inventory shared, no duplicate work),
  #2299 (Back to Basics convergence), #1972 (workflows are execution, not
  scheduling), #2461 (ET-aware timing rides the consolidated scheduler after
  parity), #2489 (wipe/recreation), #2457 (cross-tenant rules), #3264 (the
  null-trigger run-ledger gap this program closes).
- **S1 amendment (Slice S1, #3121):** O4 decided below (§4, "O4 decision
  (S1)": `trigger` sits ALONGSIDE `triggeredBy`, it does not supersede
  it); O1 located (§7: the hung-timeout mechanism is the Agents SDK's
  `cf_agents_jobs.hung_timeout_seconds`, SDK default 30s — the #2366
  seed claim stands, corrected to SDK 0.32.0); O2 enumerated + wired
  (§7: the four `schedule.goal.*` lifecycle audit events). O3 resolved
  in S3 (§7: per-tick budget accounting matches `onCron` exactly). The §4 ledger columns are implemented in S1 on the
  `job_run_records` shape (extended, not rewritten); `mas_async_jobs`
  gains no columns in S1 — follow-up minting stamps linkage into the
  job payload/result instead, and the workflow-run record's existing
  trigger evidence is untouched. `mas_opportunity_scans` likewise
  gains no columns in S1; joining its rows to the ledger is filed as
  sub-issue #3314 (B-L-03). Reconciliation to the owner "one of
  everything" mandate (#3121 comment 6660031391) is in §3 ("S1
  reconciliation"): one engine / one agent / one workflow mapped onto
  the §3 answers, hexagonal + AOP + standards checked — no genuine
  conflict found, so no open owner decision is recorded. Two
  correctness fixes found by the full-suite run ride in S1: the
  goal-audit orchestrator stub is built lazily inside the audit call
  (an eager stub 500d every `/api/schedule/*` route in envs without
  the SEARCH_AGENT binding); duplicate detection compares payloads
  with the top-level `provenance` key removed
  (`src/services/scheduleDedupe.ts`), so S1-created schedules stay
  idempotent under #2071 — provenance is creation metadata, not
  criteria.
- **S2 amendment (Slice S2, #3121):** the §8.3 home is implemented:
  `?tab=schedules` renders the consolidated home directly from the
  shell (`src/client/SchedulesHome.tsx` — list / runs / goals / queue
  views), de-hubbed (the `ETradeTradingHub` schedules branch is gone;
  the route is no longer `retain`). U-02 redirects to the home; U-04
  redirects to `view=goals`; U-05 redirects to `view=runs`; U-06
  redirects to `view=queue` (same platform-admin overview gate,
  `ScheduleQueueView`). U-03 is retired *as a schedules address* but
  NOT redirected: the OptionsHub schedules mode is options-research
  state (one-shot run form #2545, autonomous-runs record #223,
  activity log #1162), not a schedules listing, and in-hub tab clicks
  write the same `?view=` URL a redirect would match — see §8. The
  preview-trade candidate prefill is lost in the de-hub (hub-local
  order state); filed as sub-issue #3361. No file is deleted in S2;
  the two retired admin tabs and the IAAA Queue tab are removed from
  their panels (their mount sites move to the home), not renamed.
- **U-03 amendment (redirect slice, #3121):** the U-03 address now
  redirects to the home (owner decision, #3121 comment 6669207975,
  2026-11-05), reversing S2's keep-as-is. The OptionsHub schedules
  mode is gone (tab, mode, deep link, legacy `?research=schedules`
  surface all removed); its options-research content relocated to
  the Options Runs tab (`?tab=options&view=options-runs`,
  `ResearchRunsPanel`) — lossless + additive (#3121 comment
  6669238775). See §8 U-03.
- **S4 amendment (Slice S4, #3121):** follow-up chains are ledger-stamped onto
  the S1 primitives as the async-job kind (§3 Q(c)):
  `scheduleScreenerFollowups` stays the chain minter; every follow-up row
  and every run record the chain produces carries the §4 linkage. The
  planners already stamped it in S1 (`followupLedgerLinkage`: trigger
  `async-chain`, the run's schedule/workflow ids, the chain-parent main
  job id — S1-P13 still holds at plan time); S4 restamps `asyncJobId` to
  the row's OWN `job_id` at the minter (`submitAsyncJob` — the only place
  that knows the minted id; the parent link rides `parent_job_id`,
  unchanged), stamps the main job's payload linkage through
  `buildLedgerLinkage` (the run's own trigger, never `async-chain` — the
  main job is the chain root, not a chain step), and stamps each completed
  step's result flat (the same four fields as the bridged main job's
  result). Retry resubmits the recorded payload verbatim + `retryOf` and
  restamps only the id; recovery re-arms at the remaining delay and leaves
  the stored payload untouched. `mas_async_jobs` gains no columns (B-L-02
  holds — payload/result stamping). `recordJobOutcome` checked: the
  bridged-run path stamps `trigger`; the sink contract carries `trigger`
  only and no chain path in `executeAsyncJob` calls it, so the chain's
  linkage rides the async-job rows, not the outcome sink. `executeAsyncJob`
  writes no `job_run_records` rows — a chain step's run record IS its
  `mas_async_jobs` row (payload + result). S4 stamps from what the outcome
  ALREADY carries — threading originating ids into the outcome stays #3313
  (open). No file is deleted in S4.
- **S3 amendment (Slice S3, #3121):** goal schedules are migrated onto
  the S1 primitives as the tick-evaluated kind (§3 Q(a)): `onCron`
  evaluates through the S1 re-exported `isDue` / `isValidCron` /
  `zonedDateParts` (one implementation, never reimplemented); the tick
  write site resolves its §4 linkage through `buildLedgerLinkage`
  (schedule id IS the goal id, trigger derives from `triggeredBy`,
  async job id rides the job-creating branches, workflow id null);
  materialized goals carry system provenance (`synthesized-
  materialization`); the lifecycle audit moves into the
  `ScheduledAgent` mutation methods — the one DO-side sink (#3312
  fixed: route, A2A, and mesh-door entry paths all emit through it,
  the route threads the session actor instead of posting); the goals
  view renders provenance per goal and its run history from the one
  consolidated ledger read (`listGoalRuns`, the runs view's read —
  no second read path). Tick semantics preserved verbatim (23h guard,
  `"0 */6 * * *"` never-due quirk, one budget check per goal per
  firing, in-flight claim, governed halt, materialization before
  firing, `pipeline:` in ONE firing, one tick entry per `onCron`
  call). O3 resolved in §7 (per-tick budget accounting matches
  `onCron` exactly — tenant scopes the halt read only, never the
  budget bucket). Lossless+additive (owner directive, #3121 comment
  6669238775): §9 seeds the running capability-coverage map from this
  inventory; two capabilities with no home were found in the S3 comb
  and filed, not dropped — #3393 (direct one-shot synthesized firing
  leaves no ledger row) and #3394 (B-T2-07 named gap: SDK firings of
  internal-only callbacks leave no per-run record). No file is deleted
  in S3; the store stays the DO `goals` key until #3123 unifies it
  (Phase 2).

## 1. Re-verified inventory (fresh main)

Counting rule (unchanged): a *type* is a distinct mechanism, not each
schedule instance.

### 1.1 Implementation types (4 — confirmed, no new type, none removed)

| # | Type | Home | Timing / dispatch |
|---|------|------|-------------------|
| T1 | Worker cron triggers (3) | `wrangler.jsonc` `triggers.crons`, dispatched by `src/server.ts` `scheduled()` | `0 3 * * *` token renewal; `*/30 * * * *` ScheduledAgent tick + piggyback dispatches; `0 4 * * *` retention |
| T2 | Agent SDK alarm schedules | `src/agents/routes/schedules.ts` (`/api/schedules`, DO alarm rows) | 4 timing forms: cron, interval (`scheduleEvery`), one-shot at a date, delay |
| T3 | Tick-polled goal schedules | `src/agents/scheduled-agent.ts` (`ScheduledAgent.onCron`, `isDue`) | `*/30` tick arrives via Worker cron as RPC `onCron()`; never via the SDK scheduler — the class registers no schedule callbacks |
| T4 | Async-job follow-up chains | `src/agents/orchestrator/asyncJobs.ts` `scheduleScreenerFollowups` → `mas_async_jobs` rows | Outcome-chained delivery work; no alarms involved |

Instances, not types (they ride the above): TickerAgent `pushTicks`
(`src/agents/ticker-agent.ts`, `TICKER_PUSH_CALLBACK = "pushTicks"`,
a T2 `scheduleEvery` instance) and the stale sweep
(`src/agents/orchestrator.ts`, `STALE_SWEEP_INTERVAL_SECONDS = 6h`,
`scheduleEvery(..., "sweepStaleLedgerTasks", ...)` — a T2 instance).
Cloudflare Workflows (`src/workflows/`) are the execution layer scheduled
work can run through, not a scheduler.

### 1.2 The `*/30` tick fan-out (T1 detail — see §2 drift item D1)

One tick dispatches, in order: the ScheduledAgent `onCron()` RPC, then five
piggyback dispatches, all unconditional from `scheduled()` — fire/no-fire is
decided inside each route/job by its own durable guard:

| Dispatch | Route / job | Guard (decides fire/no-fire) |
|----------|-------------|------------------------------|
| ScheduledAgent tick | `SCHEDULED_AGENT` stub `onCron()` | `isDue` per goal + budget + in-flight claim (T3) |
| Research | `POST /research/scheduled-tick` (#354) | `src/services/researchScheduleGuard.ts`: weekday Mon–Fri, ≥ 21:00 UTC, not already fired today (`mas_settings` key `research_scheduled_last_run`) |
| Reflection | `POST /reflection/run` (#705) | Sunday + not already fired this week (durable guard in `mas_settings`) |
| Adaptation | `POST /adaptation/weights/run` (#754) | ISO-week guard + adaptation kill switch in `mas_settings` |
| Corpus sync | `POST /knowledge/corpus-sync` (#1169 S4-4) | Weekly guard + durable marker in `mas_settings` |
| Digest pass | `POST /payments/agentic/commercial/lifecycle/digest/run-due` (#2659) | Once per UTC day (durable marker in `agent_digest_pass_days`) |

Per-tick trace (#2037): one trace per tick; research/reflection/adaptation
dispatches carry a child span and a failure observer that records a
`scheduled_job.outcome` row in `mas_events` (`src/observability/
scheduledJobOutcomes.ts`, `SCHEDULED_JOB_OUTCOME_TYPE =
"scheduled_job.outcome"`, outcomes `ran | skipped | failed`) and alerts on
streak threshold. Corpus sync and the digest pass ride the same tick with
no failure observer — their outcomes are visible only in their own routes.

Identity gate (#2331 slice 2, fail-closed): the `*/30` tick and the `0 4`
retention dispatch run only while a service user is configured
(`SERVICE_USER_LOGIN`) AND provisioned for the platform tier; otherwise
`scheduled()` logs and returns, and scheduled goals pause. The `0 3`
token-renewal pass asserts no identity (it enumerates every stored token)
and runs either way.

### 1.3 Surfaces (4 over 2 backends — confirmed)

| # | Surface | Backend | Capabilities (all verified on fresh main) |
|---|---------|---------|-------------------------------------------|
| S1 | `SchedulesPanel` (`src/client/SchedulesPanel.tsx`) | `GET /api/schedules`, `POST /api/schedules/:id/trigger`, `POST /api/schedules/:id/pause|resume`, `PUT /api/schedules/:id`, `GET /api/schedules/:id` (detail), `DELETE /api/schedules/:id` | List (incl. paused items merged back from the paused store), trigger, pause/resume, delete, detail, edit. Creation gated by the `creatableCallbacks` allow-list |
| S2 | `ScheduledOptionsManager` (`src/client/ScheduledOptionsManager.tsx` + `scheduledOptionsManager/`) | Same `/api/schedules` backend as S1 | Own form; `POST /api/schedules/create`; `POST /api/schedules/cancel`; pause/resume/detail as S1; system-job triggers `trigger-screen`, `trigger-options-analysis`, `trigger-discovery` (`TRIGGER_ROUTES` in `scheduledOptionsManager/systemJobs.ts`); audit read (`GET /api/audit?limit=40`) |
| S3 | `ScheduledGoalsPanel` (`src/client/ScheduledGoalsPanel.tsx` via `src/client/scheduleApi.ts`) | Separate API family: `GET /api/schedule/goals`, `POST /api/schedule/goals` (add), `POST /api/schedule/goals/:id/enabled`, `POST /api/schedule/goals/:id/trigger`, `DELETE /api/schedule/goals/:id`, `GET /api/schedule/ticks`, `GET /api/schedule/operations`, + the #1922 SessionStore resource-goals preset | List goals, tick history, add-goal form, enable toggle, manual trigger, remove, preset add |
| S4 | Admin Queue tab (`AdminQueueWipePanel`, `src/client/AdminQueueWipePanel.tsx`) | `GET /api/schedules` (dump), `POST /api/schedules/cancel-all`, `POST /api/maintenance/clear-table`, `POST /api/maintenance/kv-wipe`, `GET /api/maintenance/events-export`, `POST /api/clear`, `POST /api/schedules/create` (Track 1 recreation) | Management, not creation: dump, cancel-all, clear-table, KV wipe, events export, purge, Track 1 recreate. No behavior change in this program (#2489 owns wipe/recreation) |

Read-only run history (`JobsPanel`, Autopilot, `WorkflowRunsPanel`) shows
outcomes, not schedules, and is out of scope except that it must keep
reading the consolidated ledger. The unified Jobs surface
(`src/services/scheduleSystems.ts` `UNIFIED_JOBS_UI`, #2964) already merges
the *management surface* (goals + orchestrator schedules + worker crons
read-only) while the stores stay separate — S0 builds on that description,
it does not re-inventory it.

### 1.4 Behavior inventory (every behavior, traced to a parity test)

**T2 — SDK alarm schedules (`/api/schedules`).**

- B-T2-01 — Four timing forms resolve: cron → `ctx.schedule(cron, …,
  { idempotent: true })`; interval → `ctx.scheduleEvery(intervalSeconds,
  …)`; one-shot date → `ctx.schedule(new Date(…), …)`; delay →
  `ctx.schedule(delayInSeconds, …)`. List filters `?type=cron|interval|
  delayed|scheduled`. [S0-P02]
- B-T2-02 — Creatable callbacks are allow-listed: exactly
  `autonomousOptionsAnalysis`, `autonomousMarketScreen`,
  `autonomousStrategyDiscovery`, `autonomousGoalScreen`
  (`CREATABLE_SCHEDULE_CALLBACKS`, `src/agents/orchestrator/
  scheduleCallbacks.ts`); anything else is rejected by
  `POST /api/schedules/create`. [S0-P03]
- B-T2-03 — Idempotent creates: cron creates pass `{ idempotent: true }`;
  `POST /api/schedules/create` suppresses exact duplicates
  (`findDuplicateSchedule`: same callback + canonical payload + cadence)
  and audits `schedule.duplicate_suppressed` instead of minting a second
  row. [S0-P04]
- B-T2-04 — Pause/resume/trigger/delete/detail/update: pause cancels the
  SDK schedule and stores a paused record
  (`src/services/scheduleManagement.ts`, `SqlPausedScheduleStore`); resume
  re-creates it (new schedule id); trigger manually dispatches the
  schedule's own callback; delete removes a paused record too; update
  re-creates. List merges paused items back, flagged `paused`. [S0-P05]
- B-T2-05 — System-job trigger routes (no schedule row needed):
  `trigger-screen`, `trigger-renew`, `trigger-options-analysis`,
  `trigger-retention` (#255), `trigger-iv-collection` (#15),
  `trigger-discovery` (#126). [S0-P06]
- B-T2-06 — Per-schedule audit events (via the `ctx.audit` funnel):
  `schedule.created`, `schedule.cancelled`, `schedules.cancelled.all`,
  `schedule.paused`, `schedule.resumed`, `schedule.triggered`,
  `schedule.updated`, `schedule.duplicate_suppressed`. [S0-P07]
- B-T2-07 — Per-run records (#2964): every firing of the four creatable
  callbacks (SDK or manual) is recorded by
  `src/agents/orchestrator/scheduleCallbackRunRecords.ts`
  (`recordScheduleCallbackRun`) into `job_run_records` with the outcome
  the callback itself reports (success/failure/skipped); a throwing
  delegate records failure and the throw still propagates; recording
  never breaks the callback. Manual triggers of non-creatable callbacks
  via the generic trigger route are recorded invocation-level. Named gap
  (carried, not fixed here): SDK firings of internal-only callbacks
  (`executeAsyncJob`, `expireStaleOrderDraft`, `collectIvHistory`,
  `autoRenewETradeTokens`) leave no per-run record. [S0-P08]
- B-T2-08 — Baseline reconciliation on agent start:
  `removeUnownedBaselineSchedules` removes baselines not owned by the
  instance. [S0-P09]

**T3 — Tick-polled goal schedules.**

- B-T3-01 — Tick evaluation: each `*/30` tick iterates every stored goal;
  disabled goals are skipped unless forced; `isDue(goal.cron,
  goal.lastRun, now, goal.timeZone)` gates firing. Disabled or not-due
  goals leave no per-run record — no run happened. [S0-P10]
- B-T3-02 — `isDue` semantics (`src/schedule.ts`): UTC mode is the
  historical minimal parser (`"minute hour * * *"`, day fields ignored)
  with a 23-hour anti-double-fire guard; timezone mode matches wall-clock
  parts in the goal's IANA zone with lists/ranges/steps/weekdays;
  `isDue` never throws (unparseable cron or unknown zone → `false`).
  Preserved quirk (pin, do not fix): `"0 */6 * * *"` (opportunity-hunt)
  maps the hour through `Number()` to `NaN` and is therefore NEVER due
  in UTC mode. [S0-P11]
- B-T3-03 — Budget gate: every due goal passes a PaymentsAgent budget
  check (`budgetCents`, bucket `AGENTIC_SPEND_AGENT_ID`, #2327) exactly
  once per firing; a rejection records a `skipped` run with the reason
  and creates no job. [S0-P12]
- B-T3-04 — In-flight firing guard (#2840): a second submission while a
  firing runs is answered "already in flight" with the first run's id,
  never a duplicate firing; the claim goes stale after
  `GOAL_FIRING_STALE_MS` (30 min, `src/services/goalFiringClaims.ts`).
  [S0-P13]
- B-T3-05 — Pipeline goals (#1224): a goal whose operation names a
  `pipeline:` runs ordered stages back-to-back in ONE firing, under the
  single budget check; unknown pipeline ids fail closed (goal stays due,
  no job). Manual `triggerGoal` runs the same branch as a cron firing.
  [S0-P14]
- B-T3-06 — Synthesized schedules must materialize first and fire via
  `onCron` (`materializeSynthesizedSchedule`); direct firing is refused.
  [S0-P15]
- B-T3-07 — Goal store: ScheduledAgent DO SQL, key `goals`; seeded from
  `DEFAULT_SCHEDULES` (`src/schedule.ts`) only when storage is empty.
  The 8 shipped goal ids are `daily-qa-sweep`, `opportunity-hunt`,
  `daily-social-post`, `resource-daily-rollup`, `resource-cap-alert`,
  `resource-dashboard-comparison`, `index-refresh-wikipedia`,
  `index-refresh-holdings`. `daily-social-post` (#1077 Phase 5b) ships
  DISABLED (`enabled: false`, cron `0 9 * * 1-5`, `America/New_York`,
  `social.publish` via the social goal executor, not an Orchestrator
  job). [S0-P16]
- B-T3-08 — Per-run records (#2964): every goal firing that reaches a
  terminal point records a `job_run_records` row (system
  `scheduled-agent-goal`, `triggeredBy` `scheduled | manual`,
  three-valued outcome, skip reason in `detail`, error text on failure).
  [S0-P08]

**T1 — Worker cron duties.**

- B-T1-01 — Renewal (`0 3 * * *`): `renewAllStoredETradeTokens`
  enumerates every stored token; asserts no identity; runs either way.
  [S0-P17]
- B-T1-02 — Tick (`*/30 * * * *`): the fan-out in §1.2, including the
  #2331 provisioning gate and the #2037 per-tick trace. [S0-P17]
- B-T1-03 — Retention (`0 4 * * *`): dispatches
  `POST /api/schedules/trigger-retention` under the service identity;
  the retention pass enforces the window and records one `mas_events`
  row per run; the audit chain is verified before any prune and a failed
  verification skips the prune, preserving evidence
  (`src/agents/routes/schedules.ts` trigger-retention branch). [S0-P18]
- B-T1-04 — Piggyback research guard (#354): the daily options-research
  run rides the tick behind `shouldFireResearchTick` — fires exactly
  once per weekday at/after 21:00 UTC; `weekend | too-early |
  already-fired` otherwise; the durable marker is the `mas_settings`
  key `research_scheduled_last_run`. No fifth cron trigger exists: the
  account is at the Workers Free ceiling of 5 triggers per account
  (error 10072) and a fifth entry fails the deploy. [S0-P19]
- B-T1-05 — Retention constants: `MAS_EVENTS_RETENTION_DEFAULT_DAYS =
  365`, `MAS_MEMORY_RETENTION_DEFAULT_DAYS = 365`
  (`src/security/storageRetention.ts`); the UI-advertised memory default
  is 90 days (`STORAGE_RETENTION_DEFAULT_DAYS = 90`); the retention cron
  is pinned as `STORAGE_RETENTION_CRON = "0 4 * * *"`; batch 500, max
  5000 per run. [S0-P18]

**T4 — Async-job follow-up chains.**

- B-T4-01 — `scheduleScreenerFollowups` records the finished run as the
  main async job and bridges it end-to-end (record + notify + report
  chain); `chainReport=false` records + notifies without the report
  chain. [S0-P20]
- B-T4-02 — Chain graph: rows carry `parent_job_id`, `job_kind`,
  `channel`, `stage`, `chain_id`, `not_before` (additive probed columns
  in `mas_async_jobs`, `src/data/doSqliteAsyncJobAdapter.ts`);
  deferred stages re-arm at their remaining delay on recovery
  (`recoverQueuedAsyncJobs` re-schedules via `ctx.schedule` with
  `idempotent: true, retry: { maxAttempts: 1 }`, `LIMIT 100` queued rows
  per pass). [S0-P21]
- B-T4-03 — Retry (#1277 C3): a failed job is resubmitted from its
  recorded payload verbatim; the failed row stays failed; the retry
  carries `retryOf` plus the original stage/chain identity; a second
  retry while an earlier retry is queued/running/completed is refused;
  audited as `async_job.retried`. [S0-P22]
- B-T4-04 — Recovery bounds: 30-day cutoff for stale queued rows
  (`asyncJobs.ts`); 2-hour stale threshold for started rows; stuck
  detection on the read path with a configurable threshold (default
  30 min, `src/config/stuckRunAlert.ts`) and a one-time
  `stuck_alerted_at` stamp; `async_job.stuck_detected` audit. [S0-P21]
- B-T4-05 — Keyless options runs are recorded (#3264 fix, on main):
  a run whose formats all failed still gets a canonical row, history
  row, and job-outcome row via `recordKeylessOptionsServe` — never a
  silent absence. [S0-P23]

**Run-ledger state today (the gap this program closes — see §4).**

- B-L-01 — `job_run_records` (`src/data/jobRunRecordPorts.ts`,
  `JOB_RUN_RECORD_FIELDS` in `scheduleSystems.ts`) carries `system,
  jobId, operation, started, finished, outcome, triggeredBy, error,
  detail, descriptor, artifactRefs`. It carries NO `scheduleId`,
  `asyncJobId`, or `workflowId` column, and `triggeredBy` is only
  `scheduled | manual`. Worker cron triggers never run as jobs and have
  no records. [S0-P24]
- B-L-02 — `mas_async_jobs` carries NO `scheduleId`, `workflowId`, or
  `trigger` column (linkage is `parent_job_id` / `chain_id` /
  `job_kind` / `channel` / `stage` only). [S0-P24]
- B-L-03 — `mas_opportunity_scans` carries NO `trigger`, `scheduleId`,
  `asyncJobId`, or `workflowId` column (columns are `id, generated_at,
  mode, model_version, user_login, summary_json, result_json`); any
  trigger value lives inside the JSON payloads, if recorded at all —
  this is the structural cause of the #3264 run `5fd079ec` being
  unjoinable to any schedule, workflow, or async job (all artifact
  keys/URLs/statuses/errors null, trigger null, no workflowId /
  asyncJobId / scheduleId on the row). [S0-P24]
- B-L-04 — Provenance (#2366 item 3) is NOT implemented on any schedule
  path: zero `origin` / `provenance` (user | system, creator identity,
  reason, creation time) on schedule payloads, listings, or dumps.
  [S0-P25]

## 2. Drift vs the 2026-11-04 baseline (honest delta)

The 4 types / 4 surfaces / 2 backends are confirmed unchanged. The
following are additions or corrections to the baseline inventory — each is
a defect in the old inventory, not permission to drop the feature:

- **D1 — The `*/30` tick gained four piggyback dispatches since the
  baseline named only the research run.** Reflection (#705), adaptation
  (#754), corpus sync (#1169 S4-4), and the digest pass (#2659) all ride
  the same tick behind their own durable guards, plus the #2037 per-tick
  trace and `scheduled_job.outcome` rows for research/reflection/
  adaptation. S1–S6 must preserve all five dispatches and their guards.
- **D2 — The ScheduledAgent tick gained guards the baseline did not
  name:** the #2840 in-flight firing claim, synthesized-schedule
  materialization, `pipeline:` goals (#1224), the #1922 resource-goals
  preset, and the #2331 slice-2 provisioning gate (tick + retention
  dispatch skip entirely until the platform tier is provisioned).
- **D3 — The per-run ledger (#2964) landed since the baseline.**
  `job_run_records` + the unified Jobs surface now exist; the baseline
  predates them. Their shape is inventoried in B-L-01, including the
  named gap for internal-only callbacks.
- **D4 — The #3264 keyless-record fix landed** (`recordKeylessOptionsServe`,
  merged as `831bbcb3`): a keyless options run is now recorded instead of
  silently absent. The ledger gap itself (B-L-03) is NOT fixed by it —
  the row still carries no trigger/scheduleId/asyncJobId/workflowId.
- **D5 — `daily-social-post` is a shipped goal instance** (#1077 Phase 5b,
  disabled by default). It is an instance of T3, not a new type.
- **D6 — #2366 seed item LOCATED in S1 (was UNVERIFIED in S0):** the
  seed claimed "SDK default 30s, per-job `hungTimeoutSeconds` option
  (verified in SDK 0.24.0 bundle)". The mechanism is the Agents SDK
  job queue: `DEFAULT_HUNG_TIMEOUT_SECONDS = 30`, per-job
  `hungTimeoutSeconds` on the queue insert into
  `cf_agents_jobs.hung_timeout_seconds`, scheduler-level
  `hungScheduleTimeoutSeconds` default 30 — verified in the installed
  SDK 0.32.0 bundle (see §7 O1). The claim STANDS, corrected to SDK
  0.32.0; cfagent sets no per-job timeout, so all cfagent schedules
  ride the 30s default. Nothing was silently dropped.
- **D7 — Hardcoded defaults are still hardcoded (#2366 item 1, untouched
  by S0).** `STALE_SWEEP_INTERVAL_SECONDS = 6h`, `RESEARCH_SCHEDULED_FIRE_HOUR_UTC = 21`,
  retention 365-day defaults, recovery `LIMIT 100`, 30-day cutoff,
  2-hour stale threshold, stuck threshold default 30 min, and the
  `*/30` / `0 3` / `0 4` cron literals are all literals in code today.
  Externalizing them is #2366 S1 work, fed by this inventory — S0 does
  not move them.

## 3. Target design (answers to the 3 open design questions)

### Q(a) — Tick-polled goal schedules: the consolidated scheduler gains tick semantics

**Answer: tick semantics move INTO the consolidated scheduler; goals do NOT
merge into SDK alarms.**

Evidence (proven, not assumed):

1. Goals deliberately register no SDK callbacks today
   (`src/agents/scheduled-agent.ts` header; `scheduleSystems.ts` Q&A).
   Merging would invent a registration the system was designed without.
2. One tick evaluates ALL goals under shared machinery that has no
   per-alarm equivalent: the single budget check per goal per firing
   (B-T3-03), the in-flight firing claim shared by cron and manual
   firings (B-T3-04), the governed-halt predicate, and one tick entry
   recording the outcome of the whole `onCron` call.
3. `isDue` is tick-evaluation semantics, not alarm semantics: the 23-hour
   anti-double-fire guard and the preserved `"0 */6 * * *"` → never-due
   quirk only make sense when a poller re-checks; an SDK alarm fires
   once at its time and never re-checks.
4. Synthesized schedules must materialize before firing via `onCron`
   (B-T3-06) and `pipeline:` goals run ordered stages in ONE firing
   (B-T3-05) — both are tick-batch properties.
5. Failure isolation differs: a per-goal alarm failure is one callback's
   retry; a tick failure is the whole batch's. Converting would change
   ordering, retry, and audit semantics.

**Design:** the consolidated scheduler has two firing kinds — *alarm*
(SDK `schedule` / `scheduleEvery`, for T2 callbacks) and *tick-evaluated*
(for T3 goals, evaluated by the consolidated tick with `isDue` + budget +
claim + materialization rules preserved verbatim). S3 migrates goal
schedules onto the tick-evaluated kind; the `*/30` Worker tick remains
the tick's wake-up (see Q(b)). Parity: same goals due on the same ticks,
same jobs created, same skip reasons, same per-run records.

### Q(b) — Worker crons: stay as Worker triggers dispatching into the consolidated scheduler

**Answer: the three crons STAY in `wrangler.jsonc` as Worker triggers; each
dispatches into a named consolidated-scheduler entry point. The cron
expressions do not move and do not change.**

Evidence:

1. The Workers Free ceiling (5 triggers/account, error 10072) forbids
   adding cron entries — consolidation cannot proceed trigger-side.
   The `0 21 * * 1-5` research trigger was already refused on exactly
   this ground (#354).
2. The duties are Worker-level fan-out, not single-schedule callbacks:
   the `*/30` tick fans out to six dispatches (§1.2); renewal
   enumerates tokens across ALL account DOs (a cross-DO sweep no
   single DO's alarm store can express); retention is a cross-DO POST
   into the orchestrator.
3. The crons are the platform wake-up layer: they exist before any DO
   is awake and are deployment configuration (`wrangler.jsonc`), not
   user schedules — creating one is an owner deployment action, not a
   user action (`scheduleSystems.ts`).
4. The #2331 provisioning gate and the #2037 per-tick trace both live in
   the `scheduled()` dispatch layer; moving the crons would have to
   re-home both.

**Design:** S5 gives each cron a named entry point on the consolidated
scheduler — `tick` (`*/30`), `renewTokens` (`0 3`), `retention`
(`0 4`) — and `scheduled()` becomes a thin dispatch (`event.cron` →
entry point) with the gate and trace preserved. Each dispatch writes a
ledger row (see §4; a cron run's `scheduleId` is its cron expression).
Parity: same cron strings, same dispatch order, same guards, same
skip-when-unprovisioned behavior.

### Q(c) — Follow-up chain: stays an async-job mechanism behind the same ledger

**Answer: the chain STAYS an async-job mechanism; it does NOT become a
scheduler kind. It becomes ledger-visible through the consolidated run
ledger.**

Evidence:

1. Follow-ups are outcome-chained delivery work, not time-based: they
   are minted by a finished run's outcome, with `parent_job_id` /
   `chain_id` graph linkage, `not_before` deferral, and per-stage retry
   (`retryOf`) — none of which are scheduler semantics.
2. Async jobs have a status lifecycle (`queued → running → completed |
   failed`), recovery re-arm at remaining delay, and stuck detection
   (B-T4-02–B-T4-04). SDK alarms have no lifecycle, no retry-of, no
   chain — converting would delete those behaviors.
3. The chain already has its own store (`mas_async_jobs`) with a probed
   additive-column migration pattern; the consolidation need is linkage
   and visibility, not a new execution mechanism.

**Design:** S4 keeps `scheduleScreenerFollowups` as the chain minter and
adds ledger stamping: every follow-up row and every run record it
produces carries `trigger`, `scheduleId` (the originating schedule, when
there is one), `asyncJobId` (its own `job_id`), and `workflowId` (when
the step runs through a workflow). Parity: same chain graph, same
delivery channels, same retry/refusal rules, same recovery behavior.

### S1 reconciliation — one of everything (owner mandate, #3121 comment 6660031391)

**Mandate (binding program law for S1 and every slice after it):** one UX
(the decided `?tab=schedules` home + sub-route scheme), one scheduling
engine (one firing contract for alarm + tick-evaluated kinds), one
scheduling agent (sub-agents only where a sub-task genuinely earns one),
one scheduling workflow (one durable execution path for scheduled work);
hexagonal architecture with no exceptions (the scheduler core must not
use Cloudflare directly — Worker crons, DO alarms, the Agents SDK
scheduler, Cloudflare Workflows, Queues, D1/DO storage sit behind ports,
reached only through adapters); full AOP (externalized config, coded
messages in the outcome catalog, exception handling through the AOP seam,
audit as a cross-cutting concern); standards with no exceptions (SOLID,
GoF, GRASP, 15-factor, TDD with pins in the same PR, no UX drift, no
architecture drift). Reconciliation duty: show how one-engine /
one-agent / one-workflow maps onto the §3 answers above; a genuine
conflict is recorded as an open owner decision and that piece stops — a
deviation without an owner decision is a review finding.

**Mapping — the §3 answers are mechanisms behind adapters; the mandate
is one core behind ports. No genuine conflict exists, so no open owner
decision is recorded and no piece is stopped:**

- **One engine / one firing contract — Q(a), Q(b), Q(c).** Q(a) already
  designs two firing *kinds* under one scheduler (alarm + tick-evaluated),
  not two engines; S1 supplies the contract's shared pieces in
  `src/services/consolidatedScheduling.ts`: one timing classifier
  (`resolveTimingForm` — the four timing forms resolve through it),
  one tick-evaluation semantics (`isDue` / `isValidCron` /
  `zonedDateParts` re-exported verbatim, never reimplemented), one
  ledger (the §4 four columns on every run row), one lifecycle/audit
  vocabulary. Q(b)'s Worker crons are trigger *ports* (adapters)
  dispatching into named scheduler entry points — a wake-up layer, not
  an engine. Q(c)'s follow-up chain is the one durable execution path's
  async-job mechanism, behind the same ledger. Alarm + tick are kinds
  of the one engine, distinguished by kind, never by separate engines.
- **One agent.** `ScheduledAgent` (T3) is the one scheduling agent. S1
  adds no agent and no sub-agent; the goal-audit poster is a function,
  not an agent. S3 migrates goal schedules onto the tick-evaluated kind
  within the same agent.
- **One workflow.** One durable execution path for scheduled work: the
  follow-up chain (async-job) + the ledger. Workflow submissions stamp
  `workflowId` linkage in S1 so a workflow's runs join to their
  schedule; S1 introduces no second workflow.
- **One UX.** Out of S1's scope by the program plan: the home URL is
  decided and the sub-route scheme is the S2 decision to implement
  (see §6 sequencing). S1 touches no UI.
- **Hexagonal.** The S1 core (`consolidatedScheduling.ts` + the ledger
  builder in `src/services/jobRunRecords.ts` + the ledger ports in
  `src/data/jobRunRecordPorts.ts`) uses Cloudflare nowhere: its imports
  are app-relative modules only, and the S1 diff adds zero new
  `agents` / Cloudflare imports anywhere under `src/` (pinned by
  S1-P17). Cloudflare surfaces sit behind the existing ports/adapters:
  `SqlJobRunRecordStore` over `SqlStorage`, the goal-audit POST through
  the orchestrator audit route (`POST /api/audit/event`, the same
  `mas_events` sink the T2 events use), SDK schedule objects passed in
  as data. This follows the ADR 0006 port-first spine
  (`docs/architecture/adr/0006-cloudflare-feature-flags.md`: zero
  Cloudflare types in the core interface, no env lookups in business
  logic). S1 adds no feature flag and invents no second flag spine.
- **AOP.** Externalized config: S1 adds no decision-values.
  `WORKER_TICK_CRON` names the existing `wrangler.jsonc` tick
  expression as one named constant (the expression itself lives in
  `wrangler.jsonc` and in `WORKER_CRON_TRIGGERS_INVENTORY`);
  `SDK_HUNG_TIMEOUT_DEFAULT_SECONDS` pins the SDK's mechanism default,
  not a decision — S1 chooses no timeout. Coded messages: S1 adds no
  outcome-catalog entries because it changes no outcomes; the goal
  audit events are event types in the existing `mas_events` funnel,
  validated by `validateStrictAuditWrite`. Exception handling through
  the seam: the goal-audit poster never throws (mirrors the `this.audit`
  swallow rule — an audit failure must never fail the mutation it
  records); the record builder throws fail-closed on invalid input
  (the existing builder contract); recording never breaks the callback
  (the `storeRecord` swallow, pre-existing). Audit as a cross-cutting
  concern: the O2 events go through the shared audit primitive, and
  the lifecycle map is the single source S2 migrates the routes onto;
  the A2A-path DO-side sink gap is filed as sub-issue #3312.
- **Standards / no drift.** Checked against
  `docs/compliance/multiple-implementations.md`: S1 creates no new
  parallel implementation — it reuses `isDue` / `isValidCron` /
  `zonedDateParts` by re-export, one timing classifier, one linkage
  resolver set, one audit funnel. The goal-audit POST is the same
  `mas_events` sink reached through the only transport available at
  the server layer, not a second audit system. No UX drift (no UI
  touched). No architecture drift (no boundary bypass: no direct SQL
  outside the adapters, no fat routers, no PDP-seam bypass). TDD pins
  in this PR: S1-P01–S1-P17 plus the S0 pin updates.

## 4. Consolidated run ledger (acceptance item carried from #3264)

**Requirement (non-negotiable, from incident #3264): the consolidated run
ledger MUST carry `trigger`, `scheduleId`, `asyncJobId`, and `workflowId`
on every run row.** Run `5fd079ec-3ab2-4b69-96f8-ad08bd1767a3` was
unjoinable to any schedule, workflow, or async job precisely because no
run store carried all four — the gap is structural, and this program
closes it.

**Schema (target, to be implemented in S1 on the `job_run_records` shape,
extended — not in S0):**

| Column | Type / values | Null meaning (a recorded fact, not a missing column) |
|--------|---------------|------------------------------------------------------|
| `trigger` | `scheduled \| manual \| worker-cron \| async-chain \| unknown` | `unknown` = the producing path predates trigger stamping (legacy rows only). S1 stamps at write time, so no NEW row is ever `unknown` or null. |
| `scheduleId` | SDK schedule id, goal id, or Worker cron expression (for cron runs, the cron string IS the schedule identity) | `null` = no originating schedule exists (e.g. a pure async-chain step with no schedule parent). Recorded, not missing. |
| `asyncJobId` | `mas_async_jobs.job_id` | `null` = this run neither is nor links to an async job. Recorded. |
| `workflowId` | Cloudflare Workflow instance id | `null` = this run did not execute through a workflow. Recorded. |

**Null-handling rules (part of the design, not an afterthought):**

1. The four columns exist on EVERY ledger row, including legacy rows.
   A `null` is a value the ledger stores and the read path renders
   (`trigger: unknown`, others as "— / not applicable"), never a reason
   to drop the row from a listing. The #3264 failure mode — a run
   invisible because its linkage was absent — must be impossible by
   construction: absence of linkage is itself displayed.
2. No silent backfill: legacy rows keep their nulls. S1 must not invent
   a trigger, schedule, job, or workflow for a row that never recorded
   one. Provenance for a legacy row is "not recorded", stated as such.
3. Write-time stamping is the fix: S1–S6 stamp all four fields at every
   write site (SDK firings, manual triggers, tick evaluations, cron
   dispatches, follow-up minting, workflow submissions). A write site
   that cannot determine a field records the null explicitly with the
   reason in the audit event, so the gap stays visible until closed.
4. The ledger is the single query surface for "what ran, when, as whom,
   with what outcome" (#2366 acceptance) — the read-only history
   surfaces (`JobsPanel`, Autopilot, `WorkflowRunsPanel`) read it, and
   the per-schedule audit events (§1.4 B-T2-06) remain the lifecycle
   trail alongside it.

### O4 decision (S1): `trigger` sits ALONGSIDE `triggeredBy` — it does not supersede it

**Decision (pinned in S1, before any write-site change):** the §4
`trigger` column is ADDITIVE. `triggeredBy` (`scheduled | manual`) is
retained exactly as today — required, validated by
`buildJobRunRecord`, rendered by `JobsPanel` / `WorkflowRunsPanel`,
and typed into the #2840 in-flight firing claim
(`goalFiringClaims.ts`). `trigger` is the five-valued ledger
vocabulary (`scheduled | manual | worker-cron | async-chain |
unknown`) that distinguishes firings `triggeredBy` cannot express.

Why alongside, not supersede:

1. Superseding would be a migration, not a primitive: every stored
   row (DO SQLite `job_run_records` + ScheduledAgent KV
   `jobRunRecords` arrays) carries `triggeredBy` and no `trigger`;
   the claim guard, both panels, and the builder all type on the
   two-valued field. Rewriting them in the primitives slice would
   risk behavior change in exactly the slice that must have none.
2. The two fields answer different questions. `triggeredBy` is the
   human-facing origin a reader already understands (did the cadence
   fire it, or did a person press trigger?). `trigger` is the
   joinable ledger vocabulary (which producing path — cadence,
   manual, Worker cron, async chain — made this row?).
3. Derivation is total, so no new row is ever `unknown` or null: a
   write site stamps `trigger` explicitly when it knows its path
   (worker-cron at cron dispatches, async-chain at chain minting);
   otherwise the builder derives it from `triggeredBy`
   (`scheduled` → `scheduled`, `manual` → `manual`). `unknown` is
   legacy-rows-only, produced only by the read normalizer for rows
   written before S1.
4. Retiring `triggeredBy` is S6 territory at the earliest: only
   after every reader (panels, claims, audit) has moved to `trigger`,
   and then by deprecation only — never by deletion in this program.

**Derivation rule (normative, implemented in
`src/services/consolidatedScheduling.ts` `resolveLedgerTrigger`):**
explicit valid `trigger` on the firing payload wins, except an
explicit `"unknown"` (a payload may never stamp legacy); an invalid
or absent explicit trigger falls back to the `triggeredBy`
derivation; a write site that cannot determine either records the
derivation and the reason in the audit event, so the gap stays
visible until closed.

**#2366 convergence:** the same S1 implements #2366 items 3–4 on the
consolidated path — provenance (`origin` user | system, creator identity,
reason, creation time) travels in the schedule payload (the SDK-owned
table schema is untouched; framework-internal rows such as recovery
re-arms carry `origin: system / recovery`), and the ledger above is the
one run ledger. #2366 item 1 (externalize hardcoded defaults, §2 D7)
and item 2 (default-daily classification: existing explicit-cadence jobs
— Track 1 hourly options + twice-daily stocks — keep their explicit
settings as their explicit setting; the once-daily default governs new
jobs and jobs without an explicit cadence) are fed by this inventory and
land as #2366 slices on the consolidated scheduler, not in S0.

## 5. Parity-test harness

`tests/schedule-3121-s0-parity.test.ts` pins the inventory against current
main. Conventions follow `tests/schedule-systems-488.test.ts` (source-text
pins for inventories whose live home is config or another module) and
`tests/research-schedule-guard.test.ts` (pure-function pins). Every test
name carries its inventory item (B-Tx-yy / D-n). The harness asserts
current behavior — including the preserved quirks (B-T3-02 NaN quirk,
B-L-01–B-L-03 missing columns) — so that a migration slice which changes
any of them fails loudly instead of silently.

S1–S6 extend this harness per slice (same firing times, same payloads,
same audit events, same pause/resume/trigger semantics); old paths stay
live until their slice's parity tests are green, then are deprecated by
rename only (gitops §22; ledger at
`docs/architecture/transition/deprecations.md`).

## 6. Sequencing (unchanged from the program plan)

S0 (this slice) → S1 shared timing / pause-resume-trigger / audit /
ledger primitives (incl. the §4 columns + write-time stamping) → S2
`/api/schedules` surfaces → S3 goal schedules per Q(a) → S4 follow-up
chain per Q(c) → S5 Worker cron duties per Q(b) → S6 deprecate-by-rename
with ledger entries. Post-parity only: #3124 (single alarm scan + single
ledger read path, measured) and #3123 (one schedule store, one run ledger,
one management code path), then Phase 3 #3122 (agentic scheduling on the
unified store, PDP-authorized, approval-bound for consequential schedules,
audited in the consolidated ledger).

## 7. Open items (not settled by S0)

- **O1 (S1) — RESOLVED in S1 (located, not dropped):** the
  hung-timeout mechanism is the Agents SDK's job-queue hung check,
  not cfagent code. Verified in the installed SDK (agents@0.32.0,
  `node_modules/agents/dist/lifecycle-v1rKHV2C.js`):
  `DEFAULT_HUNG_TIMEOUT_SECONDS = 30`; a per-job `hungTimeoutSeconds`
  option on the job-queue insert lands in
  `cf_agents_jobs.hung_timeout_seconds`; the scheduler passes its own
  `hungScheduleTimeoutSeconds` option (default 30) as that per-job
  value on schedule inserts. The #2366 seed claim ("SDK default 30s,
  per-job `hungTimeoutSeconds` option") STANDS, corrected from SDK
  0.24.0 to 0.32.0 and from "verified in the bundle" to the located
  bundle symbols above. cfagent never sets `hungTimeoutSeconds`
  anywhere under `src/` — every cfagent schedule rides the SDK 30s
  default — and the mechanism is visible in-repo through
  `src/data/frameworkQueueIndexSchema.ts`, which indexes
  `cf_agents_jobs.hung_timeout_seconds` for the hung-recheck MIN.
  D6 below is closed by the same finding. S1 pins the default as
  `SDK_HUNG_TIMEOUT_DEFAULT_SECONDS` in
  `src/services/consolidatedScheduling.ts`; a slice that ever sets a
  per-job timeout must use that constant and pin the change.
- **O2 (S1) — RESOLVED in S1 (enumerated + wired):** the
  per-schedule audit events for the goal-schedule lifecycle are
  `schedule.goal.added`, `schedule.goal.enabled`,
  `schedule.goal.triggered`, `schedule.goal.removed` — the same
  `schedule.<verb>` funnel shape as B-T2-06, goal-qualified so they
  cannot collide with the T2 events (`schedule.triggered` etc.).
  Enumerated in `src/services/consolidatedScheduling.ts`
  (`GOAL_SCHEDULE_AUDIT_EVENTS`) with a shared event builder, and
  wired at the `/api/schedule/goals` route funnel in `src/server.ts`:
  each mutation best-effort POSTs its event to the orchestrator's
  `POST /api/audit/event` (the same mas_events funnel B-T2-06
  writes through `ctx.audit`), never failing the mutation when the
  audit write fails — the `this.audit` swallow rule. Tracked gap:
  the A2A dispatch path (`handleA2A` → DO methods directly) bypasses
  the server.ts funnel, so agent-driven goal mutations leave no
  lifecycle audit event — filed as sub-issue #3312 (DO-side sink;
  natural home S3).
- **O2 — RESOLVED in S3 (#3312 fixed, see the S3 amendment):** the
  sink moved INTO the `ScheduledAgent` mutation methods
  (`addGoal` / `removeGoal` / `setGoalEnabled` / `triggerGoal` in
  `src/agents/scheduled-agent.ts`) — the one funnel every entry
  path flows through. The route funnel is retired: the route
  threads the session actor into the methods instead of posting,
  so each mutation still emits exactly one event with the same
  shape S1 pins; the A2A path threads the edge-authenticated
  caller (`a2a-credential:<surface>`) as actor; the mesh door
  threads its identified chat user. Same `mas_events` funnel, same
  best-effort swallow rule — no second audit system. #3312 stays
  open until live proof (an A2A-path event visible via GET
  /api/audit alongside the route-path events).
- **O3 (S3) — RESOLVED in S3 (confirmed, not papered over):** the
  consolidated tick's per-tick budget accounting matches `onCron`
  exactly, because the consolidated tick IS `onCron` — there is no
  second budget pass to diverge. One tick over N due goals issues
  exactly N budget checks, one per goal per firing (operation +
  the goal's `budgetCents` + bucket `AGENTIC_SPEND_AGENT_ID`),
  including exactly one check for a whole `pipeline:` firing; a
  rejection skips only its own goal. Tenant never changes the
  accounting: the tick's `tenantId` scopes the governed-halt read
  and the chain-leg projection only — two ticks over identical
  goals with different tenants issue identical budget-check calls
  (pinned in `tests/schedule-3121-s3-parity.test.ts`, S3-P02).
  The premise's limit is recorded honestly: goals carry no tenant
  field and live in one DO instance's `goals` key, so a tick
  evaluates one instance's goals; cross-tenant management is
  #2457's scope (instances are per login, the tenant-to-login
  mapping is still undesigned there) — the consolidated surface
  enforces the same gates #2457 sets, it does not invent a
  mapping.
- **O4 (S1) — RESOLVED in S1 (decision pinned in §4 above):** `trigger`
  sits ALONGSIDE `triggeredBy`; it does not supersede it. Derivation
  rule and rationale are in §4 ("O4 decision (S1)"); the implementation
  is `resolveLedgerTrigger` in
  `src/services/consolidatedScheduling.ts`.

## 8. URL inventory: where schedules live today

Verified against fresh `main` at `90fb058b` (PR #3303 merged), 2026-11-05.
Every URL item below carries a test id (`U-Pxx`) in the same parity
harness (`tests/schedule-3121-s0-parity.test.ts`). A URL not on this
inventory is a defect in the inventory, not permission to drop the surface.

Two verified facts about the shell, which the table relies on:

- The URL is the source of truth for navigation (`src/client/Chat.tsx`
  comment, #1808): `?tab=<id>` selects the top-level tab, `?view=<id>`
  selects the inner view of a page (`src/client/router.ts`
  `parseViewFromSearch`, #1804 S2 / #2027). `handleSelectTab` routes
  through `navigateToTab`, which `pushState`s the new `?tab=`.
- Selecting a hub sub-tab navigates the top-level `?tab=` to that
  sub-tab's id (`ETradeTradingHub` `onSelectSubTab` → `handleSelectTab`).
  The hub ALSO keeps a local `subTab` state (`useState`, synced from the
  `activeSubTab` prop) — a mirror of the URL-driven value, not a
  separate address.

### 8.1 The table (U-01..U-10)

| # | URL | Renders | Backend | Addressability | Review note (the problem it has as a home) |
|---|-----|---------|---------|----------------|--------------------------------------------|
| U-01 | `https://agent.openaimp.com/?tab=schedules` | `SchedulesHome` — the consolidated home: list (`SchedulesPanel` + embedded `ScheduledOptionsManager`), runs/ledger (`ScheduleRunLedgerPanel`), goals (`ScheduledGoalsPanel`), queue (`ScheduleQueueView`) | `/api/schedules` + `/api/schedule/goals` (goals on the S1 primitives since S3; the store unifies in #3123) | URL-driven (top-level tab + `?view=` sub-routes) | S2: de-hubbed — renders directly from the shell (`Chat.tsx` `TAB_CONTENT`), no longer through the retained `ETradeTradingHub` (route no longer `retain`; `mapTabToTradingSubTab` has no `schedules` case; the hub has no schedules branch). Sub-routes `view=list\|runs\|ledger\|goals\|queue` + `schedule=<id>` / `run=<id>` deep links. S3: the goals view renders provenance per goal and its run history from the one consolidated ledger read. |
| U-02 | `https://agent.openaimp.com/?tab=screeners&view=schedules` | (retired) | `/api/schedules` | URL-driven (tab + view) | S2: RETIRED — redirects to `?tab=schedules` (`legacySchedulesRedirect`, replace not push). The nav active logic no longer activates the Schedules item for any screeners address. |
| U-03 | `https://agent.openaimp.com/?tab=options&view=scheduled-screening` | (retired) | `/api/schedules` (runs record reads) | URL-driven (deep link) | U-03 redirect slice: REDIRECTED to `?tab=schedules` (owner decision, #3121 comment 6669207975, 2026-11-05), reversing S2's keep-as-is — the address no longer renders anything. Lossless + additive (comment 6669238775): the options-research content relocated to `?tab=options&view=options-runs` (`ResearchRunsPanel`): one-shot run form (#2545), autonomous-runs record (#223), screening activity log (#1162). The OptionsHub schedules mode is gone (tab, mode, deep link, legacy `?research=schedules` surface all removed). What the address was: the `OptionsHub` schedules mode — options-research state, NOT a schedules listing; no schedule CRUD (the mode's own note pointed schedule management at the Schedules tab). |
| U-04 | `https://agent.openaimp.com/?tab=platform-admin&view=scheduled-goals` | (retired as an address) | `/api/schedule/goals` (separate family) | URL-driven (tab + view) | S2: RETIRED — redirects to `?tab=schedules&view=goals` (`legacySchedulesRedirect`, replace not push). The Platform Admin tab and panel are gone; the left-nav entry links straight to the home (nav-config.json deep-link override). |
| U-05 | `https://agent.openaimp.com/?tab=platform-admin&view=jobs` | (retired as an address) | Run-ledger reads (`job_run_records`) | URL-driven (tab + view) | S2: RETIRED — redirects to `?tab=schedules&view=runs` (`legacySchedulesRedirect`, replace not push). The Platform Admin tab and panel are gone; the left-nav entry links straight to the home (nav-config.json deep-link override). |
| U-06 | `https://agent.openaimp.com/?tab=platform-admin&view=iaaa-admin&iaaaTab=queue` | (retired as an address) | `/api/schedules` (dump, cancel-all) + `/api/maintenance/*` | URL-driven via a nested third-level param `?iaaaTab=` (deep links #2776) | S2: RETIRED — redirects to `?tab=schedules&view=queue` (`legacySchedulesRedirect`, replace not push), gated at the route by the same platform-admin overview probe (`ScheduleQueueView`). The IAAA Queue tab and its mount are gone; the queue's only mount site is the home. |
| U-07 | `https://agent.openaimp.com/?tab=queues` | Queues — async jobs, the dead-letter queue, and trade approvals (nav entry "Queues") | `mas_async_jobs` | URL-driven (top-level tab) | The T4 follow-up chain lives here, disconnected from the schedules that minted it. |
| U-08 | `https://agent.openaimp.com/?tab=workflow-runs&run=<id>` | `WorkflowRunsPanel`, one run's record (`?run=` deep link, #3163) | Workflow-runs ledger | URL-driven | Deep-links a run but carries no schedule linkage — the #3264 gap on the read path. |
| U-09 | `/api/schedules/runs?scheduleId=<id>` (API only — no page URL) | Per-run records for one schedule (`jobsApi.ts` `listScheduleRuns`) | `/api/schedules/runs` | API param only | S2: joined by page URLs at last — `?tab=schedules&schedule=<id>` deep-links one schedule (list detail) and `?tab=schedules&view=runs&schedule=<id>` filters the ledger to it; `?tab=schedules&view=runs&run=<id>` deep-links one job's run history. |
| U-10 | (no URL — does not exist) | Chat Scheduler sub-view (#3122, planned): conversational schedule management as a third `ChatSubView` | — | — | The agentic home is planned only; only General Copilot and Options Copilot exist in the chat shell. A second home must not be built by accident. |

### 8.2 Review (five findings)

1. **`?tab=schedules` is the only real top-level schedules address, but
   it renders through the retained `ETradeTradingHub`.** The shell keeps
   the hub mounted and maps the tab into it, so the schedules home is a
   broker-branded surface today. That is in tension with the
   broker-neutral program #3216: the home for all schedules should not
   be hosted inside one broker's hub.
2. **The name `"schedules"` is overloaded.** It is a top-level tab id
   (`nav-config.json` route), a hub sub-tab (`TradingSubTab`), and an
   options host-tab value (`OptionsHub` `TAB_TO_MODE`, `MODE_TO_TAB`).
   A bare `?tab=schedules` does not say which of these it means, and
   any sub-view added later has to fight those existing meanings for
   the same string.
3. **Two addresses exist for the same surface — three counting options.**
   `?tab=schedules` and `?tab=screeners&view=schedules` both land on
   the `SchedulesPanel` (the nav active logic accepts both), and
   `?tab=options&view=scheduled-screening` lands on the same schedules
   scoped to options. One surface, three addresses.
4. **Goal schedules and the admin queue sit under Platform Admin.**
   The goals panel and the Jobs view are `?view=` sections of the
   admin page, on a separate backend family; the queue is reachable
   only through a third-level nested param (`?iaaaTab=queue`) inside
   the IAAA admin panel. The outposts are addressable — they are
   simply not part of any schedules home.
5. **No page URL carries a schedule id.** Schedules and runs are not
   deep-linkable to each other: the only `scheduleId` in any URL is the
   API param on `/api/schedules/runs`, and the run deep link
   (`?tab=workflow-runs&run=<id>`) carries no schedule linkage. This
   is the #3264 gap as a URL fact.

### 8.3 Home (DECIDED — owner-approved 2026-11-05)

**Decision: `https://agent.openaimp.com/?tab=schedules` IS the home for
schedules**, with three conditions, also decided. The address itself is
sound — it is the only top-level schedules address, it is already the
nav item's address, and it follows the app's existing `?tab=` + `?view=`
deep-link pattern. What is wrong is not the address but what renders
behind it and what is missing around it.

- **(i) De-hub it.** The consolidated surface renders directly from
  the shell, not through the retained `ETradeTradingHub`. The home for
  all schedules must be broker-neutral (program #3216); hosting it
  inside the E*TRADE hub makes the hub the home by accident. Recorded
  as an S2 requirement.
- **(ii) Sub-route scheme
  `?tab=schedules&view=list|runs|ledger|queue&schedule=<id>&run=<id>`,
  following the app's existing tab+view deep-link pattern, and retire
  `?tab=screeners&view=schedules` as a duplicate address (redirect to
  `?tab=schedules`).** The sub-route scheme is what makes the home a
  home instead of a single panel: a list view, a per-schedule view
  deep-linkable by `schedule=<id>`, a runs/ledger view deep-linkable
  by `run=<id>`, and a role-gated queue view. `?view=` is already how
  the platform-admin page and the workflow-runs page do this; the
  schedules home uses the same mechanism, not a new one.
- **(iii) Fold the outposts in as views of the one home.** Goal
  schedules become `view=goals`, backed by `/api/schedule/goals`
  until S3 merges them onto the consolidated backend (S3 MERGED:
  the goals view now runs on the S1 primitives — tick evaluation
  through the re-exported `isDue`, linkage through
  `buildLedgerLinkage`, provenance, the DO-side audit sink, one
  ledger read; the store itself unifies in #3123, Phase 2); the run ledger
  becomes `view=runs` / `view=ledger`, backed by the consolidated
  ledger (§4); the admin queue becomes `view=queue`, role-gated at
  the route (it stays a privileged operation even when it gains a
  first-class address).

**One UX (owner mandate, 2026-11-05, #3121 comment 6660031391):** the
decided home is the ONE schedules surface. No second schedules surface,
no hub-hosted duplicate, no admin-area outpost acting as a home. The
duplicate addresses in §8.1 (U-02, U-03) are retired, not kept as
alternates; the outposts (U-04, U-05, U-06) become views of the one
home per condition (iii), never homes in their own right. (The
engine/agent/workflow and hexagonal/AOP parts of the same mandate are
S1 design law, not §8 content.)

**Fallback (recorded, not preferred):** if de-hubbing is too big for
S2, `?tab=schedules` stays E*TRADE-hub-hosted until the hub is retired
— record that as a known limitation, not a design choice. The address
does not change either way; only what renders behind it does.
**S2 outcome: the fallback was NOT needed — de-hubbing landed in S2**
(the home renders from the shell; see the S2 amendment at the top of
this document and the U-01 row above).

**U-03 outcome: the redirect landed after S2** (owner decision,
#3121 comment 6669207975): `?tab=options&view=scheduled-screening`
redirects to the home, and the mode's options-research content
relocated to `?tab=options&view=options-runs` (lossless + additive,
comment 6669238775) — see the U-03 row above and the U-03 amendment
at the top of this document.

**Scope note:** the home URL and the three conditions above are DECIDED
(owner-approved 2026-11-05). The sub-route scheme in (ii) is the S2
decision to implement; this section records the home-URL decision, it
does not implement the scheme. S2 owns the view ids, the redirect, and
the role gate; this inventory only records the current addresses so S2
can retire them without losing one. **S2 implemented the scheme**
(`src/client/SchedulesHome.tsx` + `src/client/schedulesHome.ts`):
view ids `list | runs (= ledger) | goals | queue`, the four redirects,
and the route-level queue gate — the U-rows above are the as-built
record.
## 9. Capability-coverage map (running, seeded in S3)

**Rule (owner directive, #3121 comment 6669238775 — program law from
S3 onward): the consolidation is LOSSLESS AND ADDITIVE.** The
consolidated engine carries the UNION of all existing capabilities —
every firing contract, schedule kind, and surface behavior,
front-end and back-end. Not a minimal subset, not an intersection.
Any existing capability with no home in the consolidated engine is
a defect, not a quiet drop: it is filed as its own sub-issue under
#3121 at identification time and stays open until it lands or the
owner explicitly retires it.

**How this map works:** one row per S0 inventory item (§1). The
"home" names where the capability lives in the consolidated engine
(module / route / view) or the slice that will home it; "status" is
the slice that landed it, the slice that owns it next, or the filed
sub-issue. Each slice extends this map for the capabilities it
touches and files what it finds homeless; S6 final parity proves
the map complete against §1 before the program closes. A row whose
home is a later slice is scheduled work, not a defect; a row with
no home and no filed issue is a defect in the map.

### 9.1 Implementation types (§1.1) and the tick fan-out (§1.2)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| Worker cron triggers (3), dispatched into named scheduler entry points | T1, Q(b) | `wrangler.jsonc` crons → `scheduled()` dispatch → named entry points | S5 (planned) |
| `*/30` tick fan-out: ScheduledAgent tick + 5 piggyback dispatches, guards preserved | §1.2, D1 | `src/server.ts` `scheduled()` + `src/agents/scheduled-agent.ts` `onCron` | S3 (tick kind landed); S5 (named entry points) |
| Agent SDK alarm schedules (4 timing forms) | T2, B-T2-01 | `resolveTimingForm` (`src/services/consolidatedScheduling.ts`) + `/api/schedules` routes | S1 (classifier); S2 (surfaces) |
| Tick-polled goal schedules | T3, Q(a) | Tick-evaluated kind: `ScheduledAgent.onCron` via the S1 re-exports | S3 — landed |
| Async-job follow-up chains | T4, Q(c) | `scheduleScreenerFollowups` behind the same ledger | S4 — landed |
| Cloudflare Workflows as execution (not scheduling) | §1.1 | One durable execution path; `workflowId` linkage on ledger rows | S1 (linkage); S4 (chain stamping) — landed |

### 9.2 Surfaces (§1.3)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| `SchedulesPanel` (list/trigger/pause/resume/delete/detail/edit) | S1 (§1.3) | `?tab=schedules&view=list` (`SchedulesHome`) | S2 — landed |
| `ScheduledOptionsManager` (own form, system-job triggers, audit read) | S2 (§1.3) | Embedded in `view=list` | S2 — landed |
| `ScheduledGoalsPanel` (list/ticks/add/toggle/trigger/remove/preset) | S3 (§1.3) | `?tab=schedules&view=goals` on the S1 primitives | S3 — landed |
| Admin Queue tab (dump/cancel-all/wipe/export/Track 1 recreate) | S4 (§1.3) | `?tab=schedules&view=queue` (`ScheduleQueueView`) | S2 — landed |
| Unified Jobs UI (goals + schedules + crons, read-only merge) | §1.3 | `JobsPanel` over `listGoals` + `listGoalRuns` + `listScheduleRuns` | S0 — preserved (reads the S1 ledger) |
| Read-only run history (`JobsPanel`, Autopilot, `WorkflowRunsPanel`) | §1.3 | Consolidated ledger reads | S1/S2 — landed |

### 9.3 Tick-polled goal behaviors (B-T3)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| Tick evaluation: every stored goal, disabled skipped unless forced, `isDue` gates firing | B-T3-01 | `onCron` via S1 re-exported `isDue` | S3 — landed |
| `isDue` semantics + preserved `"0 */6 * * *"` never-due quirk + 23h guard | B-T3-02 | `src/schedule.ts` (source of truth), re-exported by `consolidatedScheduling.ts` | S1 (re-export); S3 (tick wired through it) |
| Budget gate: one PaymentsAgent check per due goal per firing, bucket `AGENTIC_SPEND_AGENT_ID` | B-T3-03 | `onCron` budget check (O3 pinned S3-P02) | S3 — landed |
| In-flight firing claim, shared by cron and manual firings | B-T3-04 | `src/services/goalFiringClaims.ts` + `onCron` claim/release | S3 — landed (preserved verbatim) |
| `pipeline:` goals run ordered stages in ONE firing, single budget check | B-T3-05 | `onCron` pipeline branch | S3 — landed (preserved verbatim) |
| Synthesized schedules materialize first, fire via `onCron`; direct firing refused for recurring | B-T3-06 | `materializeSynthesizedSchedule` + governed `onCron` branch | S3 — landed (+ system provenance on materialization) |
| Direct one-shot synthesized firing | B-T3-06 | `fireSynthesizedSchedule` (firing preserved) — but NO ledger row | **Filed #3393 (open)** — firing has a home, its ledger visibility does not |
| Goal store: DO `goals` key, seeded from `DEFAULT_SCHEDULES` only when empty; 8 shipped ids | B-T3-07 | `ScheduledAgent` DO storage (unchanged) | Phase 2 #3123 (one schedule store) |
| Per-run records for every goal firing terminal point | B-T3-08 | `recordGoalRun` → `buildJobRunRecord` via `buildLedgerLinkage` | S1 (columns); S3 (resolver) — landed |
| Goal lifecycle audit events (`schedule.goal.*`) on every entry path | O2 | DO-side sink in the mutation methods | S1 (enumerated + route funnel); S3 (DO sink, #3312 fixed) — landed |
| Goal creation provenance (user/system, creator, reason, time) | B-L-04 / S1-P09 | Route stamp (user) + `addGoal` validation + materialization stamp (system) | S1 (route/addGoal); S3 (materialization) — landed |
| A2A scheduled operations (list/ticks/add/remove/enable/trigger) | #2223 | `dispatchScheduledA2A` + `handleA2A` (actor threaded) | S3 — landed (audited) |
| Mesh-door goal list/trigger | #2331 door | `triggerScheduledGoalViaDoor` (actor threaded) | S3 — landed (audited) |
| Resource goals, index-refresh goals, social publish + pipeline, delivery pass | #1819/#1980/#1077/#1224 | `onCron` branches (unchanged) | S3 — landed (preserved verbatim) |
| SessionStore resource-goals preset + delegation-contract preview | #1922/#1773 | `ScheduledGoalsPanel` (unchanged) | S3 — landed (preserved) |

### 9.4 SDK alarm behaviors (B-T2) and Worker cron duties (B-T1)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| Four timing forms resolve (cron/interval/date/delay) | B-T2-01 | `resolveTimingForm` | S1 — landed |
| Creatable-callback allow-list (4 callbacks) | B-T2-02 | `CREATABLE_SCHEDULE_CALLBACKS` + create route | S2 — landed |
| Idempotent creates + duplicate suppression + audit | B-T2-03 | `findDuplicateSchedule` + `schedule.duplicate_suppressed` | S1 (dedupe fix); S2 — landed |
| Pause/resume/trigger/delete/detail/update | B-T2-04 | `scheduleManagement.ts` + routes | S2 — landed |
| System-job trigger routes (7) | B-T2-05 | Trigger routes | S2 — landed |
| Per-schedule audit events (8, B-T2-06 funnel) | B-T2-06 | `SCHEDULE_LIFECYCLE_AUDIT_EVENTS` + `ctx.audit` | S1 (map); S2 — landed |
| Per-run records for creatable callbacks + manual triggers | B-T2-07 | `recordScheduleCallbackRun` → `job_run_records` | S1 — landed |
| Per-run records for SDK firings of internal-only callbacks | B-T2-07 (named gap) | — no home — | **Filed #3394 (open)** |
| Baseline reconciliation on agent start | B-T2-08 | `removeUnownedBaselineSchedules` | S2 — landed |
| Renewal (`0 3`), tick (`*/30`), retention (`0 4`) incl. #2331 gate + #2037 trace | B-T1-01..03 | `scheduled()` dispatch | S5 (planned) |
| Piggyback research guard (#354) + retention constants | B-T1-04..05 | `researchScheduleGuard.ts` + `storageRetention.ts` | S5 (planned) |

### 9.5 Follow-up chain (B-T4) and ledger state (B-L)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| `scheduleScreenerFollowups` bridge (record + notify + report) | B-T4-01 | Async-job chain minter | S4 — landed |
| Chain graph (`parent_job_id`, `chain_id`, `not_before`, recovery re-arm) | B-T4-02 | `mas_async_jobs` + `recoverQueuedAsyncJobs` | S4 — landed |
| Retry (`retryOf`, refusal, `async_job.retried` audit) | B-T4-03 | Async-job retry | S4 — landed |
| Recovery bounds + stuck detection + audit | B-T4-04 | Recovery/stuck machinery | S4 — landed (preserved verbatim) |
| Keyless options runs recorded (never silently absent) | B-T4-05 | `recordKeylessOptionsServe` | S1 — landed |
| `job_run_records` carries the §4 columns on every new row | B-L-01 | `buildJobRunRecord` + `normalizeJobRunRecord` | S1 — landed |
| `mas_async_jobs` linkage (no §4 columns; payload stamping) | B-L-02 | Follow-up payload linkage | S4 — landed (payload/result stamping); #3313 (outcome stamping, open) |
| `mas_opportunity_scans` joinability | B-L-03 | — join key undecided — | **Filed #3314 (open)** |
| Provenance on schedule payloads | B-L-04 | `buildScheduleProvenance` et al. | S1/S3 — landed |

### 9.6 URL inventory (§8)

| Capability | S0 id | Consolidated home | Status |
|------------|-------|-------------------|--------|
| `?tab=schedules` home + sub-routes (`list/runs/goals/queue`, `schedule=`/`run=` deep links) | U-01 | `SchedulesHome` | S2 (home); S3 (goals on primitives) — landed |
| Retired duplicate addresses → home redirects | U-02/U-04/U-05/U-06 | `legacySchedulesRedirect` | S2 — landed |
| `?tab=options&view=scheduled-screening` (U-03) | U-03 | Redirect to the home (owner-decided 2026-11-05) | U-03 redirect slice (parallel, not S3) |
| Queues tab (async jobs, DLQ, approvals) | U-07 | `?tab=queues` (T4 lives here until S4) | S4 (planned) |
| Workflow-runs deep link | U-08 | `WorkflowRunsPanel` (no schedule linkage — #3264 gap on the read path) | S4/S6 (planned) |
| Per-run records API (`/api/schedules/runs?scheduleId=`) | U-09 | Joined by home deep links in S2 | S2 — landed |
| Chat Scheduler sub-view (#3122, planned) | U-10 | Third `ChatSubView` | Phase 3 #3122 (planned) |
