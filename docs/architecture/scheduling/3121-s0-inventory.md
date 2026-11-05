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
- **D6 — #2366 seed item NOT re-located:** the seed claimed "SDK default
  30s, per-job `hungTimeoutSeconds` option (verified in SDK 0.24.0
  bundle)". On fresh main there is no `hungTimeout` match anywhere under
  `src/`. The claim is carried as UNVERIFIED — S1 must locate the current
  hung-timeout mechanism or correct the seed, not silently drop the
  behavior. All other #2366 seed items re-verified: schedule/scheduleEvery
  ports, NLQ `scheduleEvery` port (`src/agents/nlq/execution.ts`), stale
  sweep (`STALE_SWEEP_INTERVAL_SECONDS = 6h`), retention constants,
  recovery `LIMIT 100` / 30-day cutoff / 2-hour stale threshold.
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

- **O1 (S1):** locate the current hung-timeout mechanism or correct the
  #2366 seed (§2 D6) — no `hungTimeout` exists under `src/` on fresh main.
- **O2 (S1):** per-schedule audit events for goal-schedule lifecycle
  (add/enable/trigger/remove) — the T2 audit funnel is inventoried
  (B-T2-06); the T3 lifecycle audit trail needs the same enumeration in S1.
- **O3 (S3):** confirm the consolidated tick's per-tick budget accounting
  matches `onCron` exactly when a tick evaluates goals across tenants
  (#2457 owns cross-tenant rules; the consolidated surface enforces the
  same gates).
- **O4 (S1):** the `unknown` trigger vocabulary vs the existing
  `triggeredBy: scheduled | manual` — S1 decides whether `trigger`
  supersedes `triggeredBy` (with a migration) or sits alongside it, and
  pins the choice in the ledger design before any write site changes.
