> **Correction 2026-11-12:** the "S6 is in flight" statements in this report (§2, §5 Dependencies, §6.3) are STALE. S6 (PR #4117, branch `feat/3121-s6-final-parity`) merged 2026-11-11T13:11Z — an hour after the "S6 build starting" comment this report relied on. S2 of the monthly change therefore coordinates with #4253 only; there is no S6 goal-inventory collision. #3121 itself stays open (programme issue stays open until all slices land).

# Feed-job schedules to monthly — survey + design (CDO lane, read-only)

Surveyed against `origin/main` (`b2026c5b`, 2026-11-12 11:09 ET) in the mirror at
`/home/hatch/workspace/w3667/wt-ship-4250`. No code changed, nothing written to GitHub.
All claims cite `file:line` on that base. SDK claims cite the installed
`node_modules` (`agents` 0.32.0 line, `@cloudflare/think` line) — that `node_modules`
is the worktree's own copy; re-verify against a fresh install at build time.

Owner decision (2026-11-12, confirmed): feed-job schedules go **monthly, per-job
schedules only — the hourly goal dispatch is removed**. Standing rule: no multiple
scheduling mechanisms; any schedule that exists must be managed through the UI.

## 0. Bottom line

- **Monthly is expressible, but exactly at the platform cap.** `every 43200 minutes`
  (= 30 days) is the longest interval the Agents SDK allows
  (`node_modules/agents/dist/scheduler-FIHv2-kJ.js`: `MAX_INTERVAL_SECONDS = 720*60*60`,
  throws when `intervalSeconds > 2592000`). A calendar-month (31-day) interval would
  be refused. "Monthly" in this change means **every 43,200 minutes**, no longer.
- **Changing the code default moves nothing that exists.** Every stored schedule is
  operator configuration, preserved across re-definitions by `withSchedulePreserved`
  (`src/services/jobPipelineEngine.ts:427-443`; applied for feeds at
  `src/services/feedPipelineJobs.ts:419`). A defaults-only change is a silent no-op
  for the 26 live jobs — each stored schedule must be rewritten via `configureJob`.
- **The stale threshold is a compulsory companion change, not an optional one.**
  `staleAfterMinutes` defaults to 180 (`src/services/feedJobs.ts:303`); staleness is
  `ageSeconds > staleAfterMinutes * 60` (`src/services/feedJobs.ts:2869`). With a
  43,200-minute cadence and a 180-minute stale threshold, every dataset reads STALE
  ~29.9 days out of 30, the screener falls back to live bars for technicals, and the
  sentiment column goes dark (see §6). The issue must move `staleAfterMinutes` with
  the cadence (recommended: 44,640 = 31 days, i.e. just over the maximum gap).
- **Goal removal is two-part or it is not durable.** Removing the `feed-refresh`
  entry from `DEFAULT_SCHEDULES` (`src/schedule.ts:215-230`) does **not** remove the
  stored goal in production — goals seed from that list only when storage is empty
  (`src/schedule.ts:83-89`; `src/agents/scheduled-agent.ts:547-564`). The stored goal
  must also be deleted via `removeGoal` (`src/agents/scheduled-agent.ts:2418`), and
  the re-add paths must be closed (see §2). Durable goal removal is the subject of
  open CEO-lane issue #4253 — coordinate, don't duplicate.
- **While Worker crons are off (#4112), this change is config-only.** The crons are
  commented out in `wrangler.jsonc` (owner direction #4112), so the tick never fires
  and the goal dispatch never runs. The per-job Think tasks are DO-alarm-backed and
  independent of Worker crons — whether they are currently armed/firing in production
  is **unverified** (open question §7). Either way the monthly change is safe to land
  now; it takes live effect at the next task reconciliation.

## 1. Inventory — the 26 feed jobs

Count pinned by tests: `tests/feed_pipeline_host_3543.test.ts:162`
(`pipelineJobIds()` length 26), `tests/feed_pipeline_jobs_3535.test.ts:261,287,485`
(26 raw definitions, 26 registrations), `tests/feed_job_tools_3535.test.ts:181`.

25 come from `buildFeedJobRegistry` (`src/services/feedJobs.ts:374`) as listed in
`FEED_PIPELINE_CATALOG` (`src/services/feedPipelineJobs.ts:87`); the 26th is the
Nasdaq-100 universe job, built beside the catalog
(`src/services/feedPipelineJobs.ts:368-380`, `NASDAQ100_UNIVERSE_JOB_ID =
"nasdaq-nasdaq100-universe"`, `src/services/feedPipelineJobs.ts:70`).

**Cadence for all 26: 60 minutes today.** Every job resolves its cadence as
`resolveFeedJobCadenceMinutes(env, jobId, FEED_JOB_DEFAULTS.cadenceMinutes)`
(`src/services/feedJobs.ts:249-256,301-304`; `FEED_JOB_DEFAULTS =
{cadenceMinutes: 60, staleAfterMinutes: 180}`). There are **no literal per-job
overrides in code** — the only override is the env knob
`FEED_JOB_<JOB_ID_SNAKE_UPPER>_CADENCE_MINUTES`, read by `knobKey`
(`src/services/feedJobs.ts:232-247`; invalid/non-positive values fall back to 60).
Production env overrides are not visible from the repo — open question §7.

| # | Job id | Source / dataset | Cadence today |
|---|--------|------------------|---------------|
| 1 | `yahoo-nasdaq100-quotes` | yahoo / quotes, Nasdaq-100 | 60 |
| 2 | `yahoo-nasdaq100-fundamentals` | yahoo / fundamentals (parameterized universe) | 60 |
| 3 | `yahoo-nasdaq100-technicals` | yahoo / technicals, daily bars (parameterized) | 60 |
| 4 | `yahoo-nasdaq100-sentiment` | yahoo / sentiment, news (parameterized) | 60 |
| 5 | `yahoo-sp100-quotes` | yahoo / quotes, S&P 100 | 60 |
| 6 | `yahoo-sp500-quotes` | yahoo / quotes, S&P 500 | 60 |
| 7 | `yahoo-dow-quotes` | yahoo / quotes, Dow | 60 |
| 8 | `yahoo-sp400-quotes` | yahoo / quotes, S&P MidCap 400 | 60 |
| 9 | `yahoo-sector-energy-quotes` | yahoo / quotes, Energy | 60 |
| 10 | `yahoo-sector-materials-quotes` | yahoo / quotes, Materials | 60 |
| 11 | `yahoo-sector-industrials-quotes` | yahoo / quotes, Industrials | 60 |
| 12 | `yahoo-sector-consumer-discretionary-quotes` | yahoo / quotes, Cons. Disc. | 60 |
| 13 | `yahoo-sector-consumer-staples-quotes` | yahoo / quotes, Cons. Staples | 60 |
| 14 | `yahoo-sector-health-care-quotes` | yahoo / quotes, Health Care | 60 |
| 15 | `yahoo-sector-financials-quotes` | yahoo / quotes, Financials | 60 |
| 16 | `yahoo-sector-information-technology-quotes` | yahoo / quotes, Info. Tech. | 60 |
| 17 | `yahoo-sector-communication-services-quotes` | yahoo / quotes, Comm. Services | 60 |
| 18 | `yahoo-sector-utilities-quotes` | yahoo / quotes, Utilities | 60 |
| 19 | `yahoo-sector-real-estate-quotes` | yahoo / quotes, Real Estate | 60 |
| 20 | `alpaca-nasdaq100-quotes` | alpaca / quotes, Nasdaq-100 | 60 |
| 21 | `etrade-nasdaq100-quotes` | etrade / quotes, Nasdaq-100 | 60 |
| 22 | `public-nasdaq100-quotes` | public / quotes, Nasdaq-100 | 60 |
| 23 | `etrade-options-chains` | etrade / options-chains | 60 |
| 24 | `alpaca-options-chains` | alpaca / options-chains | 60 |
| 25 | `public-options-chains` | public / options-chains | 60 |
| 26 | `nasdaq-nasdaq100-universe` | nasdaq / universe (stored index list) | 60 (inherits yahoo-nasdaq100-quotes cadence, `feedPipelineJobs.ts:389`) |

**Where each stored schedule lives.** The stored pipeline definition's root schedule:
`schedule: { enabled: true, interval: "every ${cadenceMinutes} minutes" }`,
built at `src/services/feedPipelineJobs.ts:355-364` (universe job at `:376`) from
`buildAllFeedPipelineJobDefinitions` (`:381+`), persisted as the job's definition
in the host's DO SQLite definition store (`defineJob`, `src/services/jobPipelineEngine.ts:602-617`).
The panel reads exactly this stored schedule
(`src/client/DataProvidersPanel.tsx:177-181` — "the STORED pipeline definition's
schedule, the configuration that actually schedules the job") and edits it through
`POST /data-providers/:id/feed-jobs/:jobId/schedule`
(`src/agents/routes/dataProviders.ts:15,799-803,1061+`; client
`src/client/dataProvidersApi.ts:281-283`).

**Why a defaults change cannot move them.** `ensureFeedPipelineJobs`
(`src/services/feedPipelineJobs.ts:400-435`) re-defines each job from the built raw
but first applies `withSchedulePreserved(raw, existing)` (`:419`), which replaces
the incoming root schedule with the stored one. If cadence were the only drift,
the effective raw equals the stored raw and ensure is a no-op (`:421-429`). The
schedule is operator configuration by design ("a job's schedule is OPERATOR
configuration (set through configureJob), not a re-derivable default",
`src/services/jobPipelineEngine.ts:427-431`). Only `configureJob`
(`src/services/jobPipelineEngine.ts:621-625`, merge patch into stored raw config,
re-resolve, store as next definition version) rewrites it.

## 2. The FEED_REFRESH_OPERATION goal — what it is, what depends on it, what removal entails

**Definition.** `FEED_REFRESH_OPERATION = "feed.refresh_all"` (`src/schedule.ts:78`).
Built-in goal `feed-refresh` in `DEFAULT_SCHEDULES` (`src/schedule.ts:215-230`):
cron `0 * * * *`, `operation: feed.refresh_all`, `budgetCents: 1`, `enabled: true`,
UTC. Comment states the design: dispatches hourly "on the existing */30 tick; no
new scheduler, no new wrangler cron triggers", `lastRun` never stamped (isDue's 23h
guard would suppress an hourly goal), hourly dedup in the goal's latest run record.

**What it dispatches.** On each tick, `ScheduledAgent` evaluates the goal
(`src/agents/scheduled-agent.ts:1973-2060`): it reads the latest goal run and skips
if a successful dispatch happened within 55 minutes (`:2000-2009`); otherwise it
dispatches **every** feed job via `dispatchScheduledPipelineJob(ctx, jobId, "")`
(`:2013-2031`, iterating `pipelineJobIds()` — the 26 ids). Partial failure records
success with failures named as tick errors; total failure records failure and
stays due for the next tick. A queued dispatch's run outcome is visible through
`get_feed_job_status`, not the goal record.

**What else depends on it — full list (nothing hidden found):**

| Dependent | Location | Effect of removal |
|-----------|----------|-------------------|
| Goal dispatch branch in `onCron` | `src/agents/scheduled-agent.ts:1973-2060` | Branch + `FEED_REFRESH_OPERATION` import become dead; remove. `dispatchScheduledPipelineJob` itself stays — it is also the per-job Think-task handler path (§3). |
| `DEFAULT_SCHEDULES` entry | `src/schedule.ts:215-230` | Remove the entry. Alone this does **not** remove the stored goal (§0). |
| `SCHEDULED_GOAL_IDS_INVENTORY` (test-pinned mirror of `DEFAULT_SCHEDULES` ids) | `src/services/scheduleSystems.ts:77-90` (`"feed-refresh"` at `:88`) | Drop the id; update `tests/schedule-3121-s0-parity.test.ts:392-394` (pins length 9) and `tests/schedule-systems-488.test.ts:63` (pins equality with live ids). |
| Built-ins served to the goals UI | `GET /api/schedule/builtin-goals` → `src/client/jobsApi.ts:150-158` ("canonical definitions live in `DEFAULT_SCHEDULES`… read from this server endpoint") | Removing the `DEFAULT_SCHEDULES` entry removes it from the seed-all list automatically. |
| `addGoal` acceptance + dashboard listing | `src/orchestrate.ts:140-148` — catalog entry `agent: "feed"`, `operations: ["feed.refresh_all"]`, "the catalog entry exists so addGoal accepts the operation and the dashboard can list it" | Remove the catalog entry, or `addGoal` keeps accepting `feed.refresh_all` and an operator can re-add the goal by hand — removal not durable. |
| Agent-schedulable operations | `src/services/agentScheduleCapability.ts:106` — `"feed.refresh_all"` in `AGENT_SCHEDULABLE_GOAL_OPERATIONS` | Remove, or Copilot/NLQ agents can re-schedule the operation. |
| Capability registry entry | `src/agentic/capabilityRegistry.ts:205-214` — `feed-refresh-all`, "Hourly dispatch of every J2 feed job…", owner #3787, verification `tests/pipeline_scheduled_goals.test.ts` | Remove/annotate the entry (it describes the removed mechanism). |
| Copilot introspection text | `src/services/stockCopilotIntrospection.ts:761` — "Feed datasets are produced by the feed-refresh goal (#3787)" | Update the text (it becomes false). |
| Test suites pinning the goal | `tests/feed_refresh_goal_3787.test.ts` (whole suite); `tests/goal_compiler.test.ts:316-318`; `tests/schedule_api_builtin_3996.test.ts:18,54,59`; `tests/scheduled_goals_builtin_3996.test.ts`; `tests/scheduled_goals_panel_3996.test.tsx`; `tests/screener_chain_stuck_3787.test.ts`; `tests/pipeline_scheduled_goals.test.ts` | Delete or rewrite as removal pins (goal absent from defaults + stored goal removed + `addGoal` refuses the operation). |

**What does NOT depend on it.** Chains and Copilot do **not** call the goal dispatch:
chains run through `control.runJob` directly
(`src/mcps/openaimp/chainJobCommands.ts:53` — "through the job pipeline… control
plane"); the per-stage Think-task handler in `declarePipelineTasks` calls
`dispatchScheduledPipelineJob` per job (`src/agents/scheduledTasksPipeline.ts:807`),
not the goal. `src/orchestrate.ts:140` states explicitly that `feed.refresh_all`
is "NOT an orchestrator job". On-demand Run now (`POST /data-providers/:id/feed-run`
→ `runPipelineJob`, `src/agents/scheduled-agent.ts:917+`) is unaffected.

**Removal durability.** `removeGoal(id, actor)` exists and deletes the stored goal
record (`src/agents/scheduled-agent.ts:2418-2433`, via `saveGoals` which removes
records not in the wanted set, `:580-600`; removal is audited as
`schedule.goal.removed`, #3121 S3). It is exposed through the goals API
(`:2489`, `:3044`) and the ScheduledGoalsPanel remove action. So durable removal =
(1) delete the `DEFAULT_SCHEDULES` entry (fresh deployments never seed it),
(2) `removeGoal("feed-refresh")` on the running deployment (stored record gone;
seed rule only fires when storage is empty, `src/agents/scheduled-agent.ts:547-564`,
so it cannot come back on its own), (3) close the re-add paths (catalog entry +
agent-schedulable list, above). **#4253 (open, CEO lane, Size Medium, Priority High:
"[3121] Externalize DEFAULT_SCHEDULES to config — built-in goals configurable,
removal durable") states the same problem** ("the nine built-in goals… are hardcoded
in code today and cannot be durably cancelled") — the goal-removal half of this
change must coordinate with #4253 rather than invent a second removal mechanism.
The CEO lane's S6 build started 2026-11-11 (comment on #3121) — coordinate the
sequencing with that lane before shipping S2.

## 3. The per-job Think scheduled tasks

**How they are declared.** `ScheduledAgent.getScheduledTasks()` returns
`declarePipelineTasks(...)` (`src/agents/scheduled-agent.ts:882-884`). That function
(`src/agents/scheduledTasksPipeline.ts:756-830`) first ensures all pipeline jobs,
then calls `control.registerSchedules(recordingHost)`; the engine's `registerSchedules`
(`src/services/jobPipelineEngine.ts:873-904`) walks every **stored** definition and,
for each node whose `schedule.enabled` is true, records `{jobId, nodePath, cron?,
interval?}`. Each becomes a Think task with id
`pipeline-job:<jobId>[:<nodePath>]` (`PIPELINE_TASK_ID_PREFIX = "pipeline-job:"`,
`src/agents/scheduledTasksPipeline.ts:141`), `schedule` = the stored interval
string, and a handler that calls `dispatchScheduledPipelineJob` for that job
(`:803-817`). "Re-declaring is a no-op shape-wise (Think reconciles by task id +
schedule)" and "the declaration reconciles on every boot" (`:756-760`).

**How a stored-schedule change propagates.** (a) The panel/route edit calls
`door.configurePipelineJob(jobId, {root: {schedule}})` → engine `configureJob`
merges the patch into the stored raw config and saves the next definition version
(`src/services/jobPipelineEngine.ts:621-625,628-646`). The panel immediately reads
back the new stored schedule (`src/agents/routes/dataProviders.ts:1150-1160`,
audited as `data_provider.feed_job_schedule`). (b) The **registered Think task**
updates at the next reconciliation: Think reconciles declared tasks on startup
automatically, and exposes `internal_reconcileScheduledTasks()` for "after changing
app-owned data that `getScheduledTasks()` reads"
(`node_modules/@cloudflare/think/dist/think.js:2828-2837`). **Nothing in the repo
calls that reconcile after a pipeline `configureJob`** — the only caller is
`src/agents/orchestrator.ts:1489` (OrchestratorAgent's own tasks). So today a
schedule edit takes effect on the **next ScheduledAgent boot**, not immediately;
until then the old interval's task keeps firing. (Whether that gap matters while
crons are off is §4.) The issue should either accept boot-time propagation or add
an explicit reconcile call after `configurePipelineJob` — flag as a design point,
not assumed.

**Monthly interval form — verified, exactly at the cap.**
- Think DSL: `every ${number} minute(s)|hour(s)`; parser regex
  `/^every ([1-9]\d*) (minute|minutes|hour|hours)$/` with singular/plural enforced
  (`node_modules/@cloudflare/think/dist/think.js:1097-1111`; type
  `ThinkIntervalSchedule` in `index-DDnny6kt.d.ts:925-928`).
- `every 43200 minutes` parses to `intervalMs = 43200 * 60000` = 2,592,000,000 ms.
- Agents SDK cap: `MAX_INTERVAL_SECONDS = 720*60*60` = 2,592,000 s (30 days);
  `validateIntervalSeconds` throws only when `intervalSeconds > 2592000`
  (`node_modules/agents/dist/scheduler-FIHv2-kJ.js:14,62-66`). 43,200 minutes =
  2,592,000 s = **exactly the cap, allowed** (`>` not `>=`). Any longer "monthly"
  (e.g. 31 days = 44,640 min = 2,678,400 s) is **refused**.
- Route validation imposes no upper bound: `intervalMinutes` must only be a
  positive integer (`src/agents/routes/dataProviders.ts:1106-1112`); the panel
  parses `every (\d+) minutes` back (`src/client/DataProvidersPanel.tsx:202,246`).
  A test pin should assert 43,200 is accepted and 44,640 is refused at the
  Think/SDK boundary.
- First firing after (re-)arming is one interval from arming (SDK `parseInterval`:
  first execution one interval from now). After the change, each job's next run is
  up to 30 days out unless a cutover refresh is run (see §4).

## 4. How to move the 26 stored schedules to monthly — options

Constraint from §1: only `configureJob` (or an equivalent direct stored-definition
rewrite) moves a stored schedule; `ensure`/`defineJob` with a new default cannot.

| Option | Mechanism | Pros | Cons | Verdict |
|--------|-----------|------|------|---------|
| **A. 26 `configureJob` calls via the existing schedule route** | `POST /data-providers/:id/feed-jobs/:jobId/schedule` with `{intervalMinutes: 43200}` (and `staleAfterMinutes` handled separately — see below) per job; each call is validated, audited (`data_provider.feed_job_schedule`), and returns the stored schedule as read back. Drivable by a script through the authenticated API or by hand in the panel (26 edits). | Uses the shipped, UI-shaped, audited mechanism — the standing rule ("managed through the UI") in its purest form; no new code; each write independently verifiable (read-back per job); reversible per job. | 26 calls; needs an authenticated session (the app requires sign-in); each job's Think task updates only on next host boot (§3). | **Recommended.** |
| **B. Code migration that rewrites stored definitions** | New one-shot migration (admin route or boot-gated rewrite) that loads each stored feed definition and applies the monthly schedule + stale threshold, then removes itself / marks completion. | One deploy, no 26 manual calls; atomic-ish. | **No precedent exists** — no definition-migration mechanism was found in `scheduledTasksPipeline.ts` / `jobPipelineEngine.ts` (grep `migrat` empty there); new privileged write path, new failure modes, must be designed, pinned, and removed; bypasses the audited route; contradicts "managed through the UI" if it becomes the way schedules change. | Not recommended for this change. Reconsider only if the 26 calls prove infeasible in production. |
| **C. UI edits by hand (26 panel edits)** | Same route as A, driven by the operator in the Data Providers panel. | Zero new code; the owner sees each change. | Tedious and error-prone at 26 jobs; no script, no read-back log beyond the audit events. | Acceptable fallback; A-scripted is the same mechanism with a record. |
| **D. Defaults-only code change** | Change `FEED_JOB_DEFAULTS.cadenceMinutes` 60 → 43200 (and stale default) and ship. | One-line change. | **Does not work for existing jobs**: `withSchedulePreserved` makes ensure a no-op for them (§1). Only new jobs (none planned) would pick it up. | Rejected as the mechanism. Still needed as a companion change so any future job starts monthly (see issue draft). |

**Recommendation: A, plus the compulsory companions.** (1) Code PR: `FEED_JOB_DEFAULTS`
(`cadenceMinutes` 60 → 43200, `staleAfterMinutes` 180 → 44640) + goal-removal
code + test updates (see §5). (2) Data step: 26 route calls setting
`intervalMinutes: 43200` on every feed job (script through the authenticated API,
per-job read-back logged, or 26 panel edits). (3) Cutover refresh: run all 26 jobs
once after the change so the monthly clock starts from fresh data (otherwise the
next run of each job is up to 30 days out and the panel shows month-old data
meanwhile). **Stale threshold note:** the schedule route accepts only
`enabled | intervalMinutes | cron` (`src/agents/routes/dataProviders.ts:1095-1100`)
— `staleAfterMinutes` is **not** settable through it; it rides the registry
definition (code default + env knob `FEED_JOB_<ID>_STALE_MINUTES`). So the stale
move (180 → 44640) must be the code-default change, and the per-job env knobs
must be checked for overrides in production (open question §7).

**What the change does / does not do while crons are off (#4112).** Worker crons
are commented out in `wrangler.jsonc` ("Issue #4112 (owner direction): NO schedules
and NO triggers… no ScheduledAgent tick, no nightly research run, no retention
pass"). Consequences: (i) the goal dispatch does not run today, so removing the
goal changes no live firing; (ii) the monthly stored schedules change config only
until a firing mechanism returns; (iii) the per-job Think tasks are DO-alarm-backed
and do not depend on Worker crons — **whether they are armed/firing in production
right now is unverified** (open question §7). If they are firing, the monthly
change takes live effect at the next host boot after the writes; if not, it takes
effect when schedules return. The change is safe to land in either case, but the
issue's acceptance must include a live firing check rather than assuming.

## 5. Draft issue body (gitops §5) — for filing under #3121

**Recommended parent: #3121 (CEO one-scheduler, open).** Evidence: the change is
a scheduling-consolidation change (one mechanism, remove a goal) — #3121's scope,
not a feed-feature change; the goal-removal durability question is owned by #4253,
itself a #3121 sub-issue, so this belongs beside it for coordination; #3530 (feed
programme) is **closed**; #798 (RSI-Data plan) is a plan umbrella, too broad for
an execution slice. Link #3530, #798, #4112, #4253 (dependency) as Related.
**Size: Medium. Priority: Medium** (no live firing today under #4112; becomes High
when schedules return — the owner may bump it). Split into two slices in the
issue: S1 feed cadence + stale threshold, S2 goal removal (coordinate S2 with
#4253 / CEO S6).

---

## Agent
#CDO-mha7

## Type
- [ ] `[Bug] - <title>`
- [x] `[Enhancement] - <title>` + `enhancement`

## Size
- [ ] Small
- [x] Medium — 26 stored-schedule writes + defaults + goal removal across ~6 files + pinned-test updates; no new architecture
- [ ] Large

## Priority
- [ ] Low
- [x] Medium — no live firing today (Worker crons off, #4112); becomes High when schedules return
- [ ] High

## Problem
Feed jobs refresh every 60 minutes (`FEED_JOB_DEFAULTS.cadenceMinutes = 60`,
`src/services/feedJobs.ts:301-304`), and they refresh through **two** mechanisms:
per-job Think scheduled tasks (`pipeline-job:` prefix, declared by
`declarePipelineTasks`) and the hourly `feed-refresh` goal
(`FEED_REFRESH_OPERATION`, `src/schedule.ts:215-230`) dispatching all 26 jobs on
the tick. Owner direction 2026-11-12: feed schedules go **monthly, per-job
schedules only — the hourly goal dispatch is removed**; standing rule: no multiple
scheduling mechanisms, any schedule that exists must be managed through the UI.
Two traps make a naive change a no-op: (1) stored schedules are operator
configuration preserved across re-definitions (`withSchedulePreserved`), so
changing the code default does not move the 26 live jobs; (2) removing the goal
from `DEFAULT_SCHEDULES` does not remove the stored goal in production (seed
only when storage is empty). Monthly is also exactly at the platform's 30-day
interval cap, and the 180-minute stale threshold would label every dataset STALE
~29.9 days out of 30 unless it moves with the cadence.

## Outcome
All 26 feed jobs run on `every 43200 minutes` through their per-job Think
scheduled tasks, managed in the Data Providers panel; the `feed-refresh` goal is
gone from code, from the running deployment, and from every re-add path; the
panel shows a monthly cadence with a matching stale threshold and no STALE badge
on a fresh monthly copy.

## User journey
Journey: Operator keeps the platform's market-data copies fresh from the Data
Providers panel and trusts the Job outcomes feed.
User: The platform operator (owner).
How value surfaces in UX: Data Providers panel — each feed job's schedule editor
shows `every 43200 minutes`; no STALE marker on a fresh monthly copy; the
`feed-refresh` goal no longer appears in the schedules home goals list.
Journey impact — REQUIRED before/after statement:
- Journey today: 26 feed jobs refresh hourly through two mechanisms (per-job
  tasks + hourly goal dispatch); datasets are at most an hour old.
- Journey after this change: the same 26 jobs refresh monthly through the
  per-job tasks only; datasets are up to 30 days old; the hourly goal is gone.
- What the user sees/does differently: schedule editors read monthly; run
  history is monthly; the screener reads month-old persisted copies (technicals
  fall back to live bars when stale, sentiment shows a named gap when stale —
  see Risks).

## Existing / similar issues (required — search BEFORE creating)
- [x] I searched existing issues (open and closed) for the same or similar work before creating this issue.
- Same or similar issues found:
  - #3121 — parent (one scheduler; this is its sub-issue). The goal half of this change is in #3121's inventory (tick-polled goal schedules + ScheduledGoalsPanel); the per-job schedule editor was flagged as an inventory gap on #3121 (owner-approved 2026-11-12).
  - #4253 — `[3121] Externalize DEFAULT_SCHEDULES to config` (open, CEO lane) — owns durable goal removal; this issue coordinates its S2 with it rather than duplicating it.
  - #3530 — feed-jobs programme (closed) — the jobs, their schedules, and the schedule route this change edits.
  - #4112 — owner direction, Worker crons commented out — the reason nothing fires on a schedule today.
  - #3787 — the incident that created the `feed-refresh` goal (parent #3781).
  - #4304 — 2026-11-12 host-restart orphan follow-up (sub-issue of #3976) — unrelated mechanism, noted only because it proves host death kills in-process runs.
- Search terms used: "feed-refresh", "FEED_REFRESH_OPERATION", "DEFAULT_SCHEDULES", "pipeline-job:", "monthly", "withSchedulePreserved" (GitHub issue search + repo grep on origin/main b2026c5b).

## Related issues
Parent: Qunsultant/cfagent#3121 (this issue is its sub-issue)
Blocks / Blocked by: S2 (goal removal) blocked on coordination with #4253 (CEO lane) and the #3121 S6 build in flight; S1 (cadence) blocked by nothing.
Related: #3530 (closed, the jobs), #798 (RSI-Data plan), #4112 (crons off), #3787 (goal origin), #4171 (workflow residency — unaffected, not a dependency).
Supersedes: none

## Scope
Included:
- S1 — Feed cadence to monthly: `FEED_JOB_DEFAULTS.cadenceMinutes` 60 → 43200
  and `staleAfterMinutes` 180 → 44640 (31 days, just over the maximum gap);
  26 stored schedules rewritten to `every 43200 minutes` via `configureJob`
  (schedule route, per-job read-back logged); cutover refresh (run all 26 once
  so the monthly clock starts from fresh data); Red pins on the 60-minute
  defaults first, Green after.
- S2 — Goal removal: delete the `feed-refresh` entry from `DEFAULT_SCHEDULES`;
  `removeGoal("feed-refresh")` on the running deployment; drop
  `"feed-refresh"` from `SCHEDULED_GOAL_IDS_INVENTORY`; remove the
  `feed.refresh_all` catalog entry (`src/orchestrate.ts`) and the
  `AGENT_SCHEDULABLE_GOAL_OPERATIONS` entry; remove/annotate the
  `feed-refresh-all` capability-registry entry; update the Copilot
  introspection text; rewrite the goal-pinning tests as removal pins.
Excluded:
- Any change to the J3–J7 chain schedules, the enrich/analyze/generate/deliver
  job schedules, or the index-refresh goals — separate decisions.
- Workflow residency (#4171) — untouched; monthly runs stay in the host.
- A bulk definition-migration mechanism — deliberately not built (see §4 option B).
- Restoring Worker crons (#4112) — out of scope; this change is config + code
  only and takes live effect when schedules return.
Scope discipline: every item excluded from this issue gets its own sub-issue under this issue, created at the time it is identified and linked under Related issues — never left as a follow-up note.

## Requirements
- R1. Every one of the 26 feed jobs (25 catalog + `nasdaq-nasdaq100-universe`)
  carries a stored root schedule `every 43200 minutes`, enabled, verified by
  per-job read-back.
- R2. `FEED_JOB_DEFAULTS` is `{cadenceMinutes: 43200, staleAfterMinutes: 44640}`;
  no per-job literal cadence override is introduced; env knobs
  (`FEED_JOB_<ID>_CADENCE_MINUTES` / `_STALE_MINUTES`) keep working.
- R3. The `feed-refresh` goal is absent from `DEFAULT_SCHEDULES`, from the
  running deployment's stored goals, from the schedules-home goals list, and
  from the built-ins endpoint; `addGoal` refuses `feed.refresh_all`.
- R4. The per-job Think tasks reconcile to the monthly interval on the next
  host boot (or an explicit reconcile is added — see Test plan); no task fires
  on the old 60-minute interval after reconciliation.
- R5. No second firing mechanism remains: the `FEED_REFRESH_OPERATION` branch,
  constant, and capability entry are removed; `dispatchScheduledPipelineJob`
  stays (it is the per-job task path, not the goal path).
- R6. Panel truth: each job's schedule editor shows the monthly interval; a
  fresh monthly copy shows no STALE badge; the job's next-run reflects the
  monthly cadence.

## Acceptance criteria
- [ ] All 26 stored schedules read `every 43200 minutes` (read-back log attached to the PR).
- [ ] `FEED_JOB_DEFAULTS` pins pass at 43200 / 44640; the 60-minute pins fail before the change (Red) and pass after (Green).
- [ ] `every 43200 minutes` is accepted by the Think DSL and the 30-day SDK cap; `every 44640 minutes` is refused at the boundary (pin).
- [ ] `feed-refresh` is absent from `DEFAULT_SCHEDULES`, `SCHEDULED_GOAL_IDS_INVENTORY` (length 8), the stored goals, the built-ins endpoint, and the schedules home; `addGoal` with `feed.refresh_all` is refused.
- [ ] Live check after deploy: the 26 Think tasks reconcile to monthly on the next host boot (or immediately if an explicit reconcile lands); no 60-minute firing is observed.
- [ ] Cutover refresh run for all 26 jobs settles with fresh artifacts.
- [ ] Section-15 completion report posted.

## Test plan
Per-slice TDD in the #3530/#3543 harness idiom. Red: existing pins on 60-minute
cadence (`tests/feed_jobs_s2_3530.test.ts:321,341`,
`tests/chain_pipeline_jobs_3540.test.ts:366,378`,
`tests/feed_pipeline_host_3543.test.ts:181`,
`tests/feed_schedule_config_3530.test.ts:104`,
`tests/feed_copilot_outcomes_3530.test.ts:470,500`) and on the goal
(`tests/feed_refresh_goal_3787.test.ts`, `tests/schedule_api_builtin_3996.test.ts:18,54,59`,
`tests/schedule-3121-s0-parity.test.ts:392-394`,
`tests/schedule-systems-488.test.ts:63`) fail against the new defaults/removal.
Green: same suites updated to 43200/44640 and to goal-absence; new pins:
monthly interval accepted at the Think/SDK boundary, 44,640 refused; stored
schedule preserved across ensure after the rewrite (no silent revert); removal
pins (goal absent from defaults + stored goals + built-ins; `addGoal` refuses).
Regression: full feed + pipeline + schedule planes vs a pristine control; the
26-count pins (`tests/feed_pipeline_host_3543.test.ts:162`,
`tests/feed_pipeline_jobs_3535.test.ts:261,287,485`) still pass.

## Dependencies
- #4253 (CEO lane, open) — durable goal-removal design; S2 coordinates with it and with the #3121 S6 build in flight. Do not ship S2 in a way that conflicts with S6's goal inventory.
- #4112 — crons off: no scheduled firing happens until schedules return; the monthly change is config + code until then. Acceptance's live firing check waits on a host boot / schedule return.
- #3121 — parent; the per-job schedule-editor inventory gap was flagged there (owner-approved 2026-11-12).

## Rollout
S1 first (cadence + stale + 26 writes + cutover refresh), then S2 (goal removal)
after #4253 coordination. Rollout is config-first: code PR (defaults + removal
code + pins), then the 26 route calls with per-job read-back, then the cutover
refresh. No deploy-time migration, no wrangler change (crons stay commented out
per #4112).

## Rollback plan
Per-job: re-post the previous interval (`every 60 minutes`) through the schedule
route for any job (audited, reversible per job). Code: revert the defaults PR.
Goal: re-add `feed-refresh` to `DEFAULT_SCHEDULES` and seed it via the built-ins
endpoint (`addBuiltinGoals`) — the goal's definition is preserved in git history
and in this issue. Rollback does not restore already-fired monthly runs.

## Risks
- **Stale data is the product cost of monthly.** Datasets are up to 30 days old.
  Technicals: the screener ignores stale persisted bars and falls back to live
  bars (`src/agents/screener-agent.ts:1455-1472` — works, but the persisted-copy
  value is lost most of the month). Sentiment: persisted sentiment is the PRIMARY
  source and a stale copy leaves the column a named gap ("—"), never a heuristic
  (`src/agents/screener-agent.ts:1473-1500`). If the owner wants the sentiment
  column live between refreshes, monthly is the wrong cadence for the sentiment
  job — flag, don't silently accept.
- **Monthly sits exactly on the SDK's 30-day interval cap.** Any future ask for
  a longer interval (calendar month, 31 days) is refused by the platform; the
  only longer forms are wall-clock schedules (`every day/week at …`), a different
  mechanism.
- **Schedule edits apply on next host boot, not immediately** (§3) — no explicit
  reconcile is called after `configureJob` today. If the owner expects immediate
  effect, the issue must add the reconcile call.
- **Per-job task firing while crons are off is unverified** (open question §7).
  If the tasks are not armed, the monthly change has no live effect until
  schedules return — and the acceptance live check must say so honestly.
- **S6 collision.** The CEO lane's #3121 S6 build is in flight; shipping S2
  without coordination risks conflicting goal-inventory edits.

## Traceability
- Owner decision 2026-11-12: monthly, per-job schedules only, hourly goal removed; standing rule: one mechanism, UI-managed.
- Survey: `~/workspace/w3667/monthly-survey.md` (this report; base origin/main b2026c5b).
- Decision pins: `tests/feed_residency_decision_3992.test.ts` is unaffected (residency unchanged).
- #3121 inventory gap flag: owner-approved 2026-11-12, posted after this issue is filed (monthly first).

#CDO-mha7

---

## 6. What would change the owner's decision (flags, not blockers)

1. **The sentiment column goes dark ~29.9 days a month unless the stale threshold
   moves with the cadence.** `src/agents/screener-agent.ts:1473-1500` — persisted
   sentiment is PRIMARY; a stale copy leaves the column a named gap ("—"). The
   draft issue moves `staleAfterMinutes` to 44,640 with the cadence, which avoids
   this; if the owner instead wants the threshold left at 180, the sentiment job
   (and the technicals persisted-bars path) effectively stop working between
   monthly refreshes. That is a product decision, not a scheduling detail.
2. **"Monthly" cannot mean a calendar month.** The 30-day SDK cap (§3) forbids
   any interval over 43,200 minutes. If the owner meant "on the 1st of the month",
   that is a wall-clock schedule (`every month on …` does not exist in the Think
   DSL; the available forms are `every day/week at …` or a cron) — a different
   design, not this change.
3. **The goal-removal half depends on the CEO lane.** Durable removal is #4253's
   subject and S6 is in flight. If the CEO lane lands a conflicting goal
   inventory first, S2 must rebase onto it. This does not block S1.
4. **Nothing in this change restores scheduled firing.** Crons stay off (#4112).
   If the owner expected monthly refreshes to start firing on deploy, that
   expectation is wrong — firing resumes only when schedules return (or if the
   per-job Think tasks are already armed — unverified, §7).

## 7. Open questions

1. **Are the per-job Think tasks armed/firing in production right now?** The
   mechanism (DO alarms via `getScheduledTasks` reconciliation on boot) is
   independent of Worker crons, but no live schedule-row or run-record check was
   possible from this survey (no live route; app requires sign-in). Needs a live
   check: recent scheduled (non-manual) run records for any feed job, or the DO's
   schedule rows. Determines whether the monthly change has live effect at the
   next boot or only when schedules return.
2. **Production env overrides for cadence/stale?** `FEED_JOB_<ID>_CADENCE_MINUTES`
   / `_STALE_MINUTES` knobs exist per job (`src/services/feedJobs.ts:232-256`).
   If any are set in production, the code-default change does not move those jobs;
   the 26-write step must cover them (the route writes the stored schedule
   regardless of env, but a later ensure re-derives the raw from env and
   `withSchedulePreserved` keeps the stored schedule — so the route write still
   wins; verify at build time).
3. **Does the owner want an explicit reconcile after `configureJob`?** Today a
   schedule edit applies on next host boot; `internal_reconcileScheduledTasks`
   exists but is not called for pipeline jobs (§3). One-line design choice for
   the build slice.
4. **Should the sentiment job (or technicals) keep a shorter cadence?** See §6.1.
   The owner decided "monthly" for feed jobs as a whole; a per-job exception is
   a scope question for the issue, not the survey.
5. **Goal run history after `removeGoal`?** `removeGoal` deletes the goal record
   (`src/agents/scheduled-agent.ts:2418-2433` via `saveGoals`, `:580-600`); whether
   the goal's historical run records are purged or retained was not verified.
   Minor; confirm at build time if the schedules-home history must keep the
   feed-refresh rows.
