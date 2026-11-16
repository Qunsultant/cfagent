# SURVEY — #3530 remainders (scheduling slice + Copilot run/status slice)

Read-only survey against `origin/main` = `cd76eba29590b5e7d6cdcaa939a87fdd4d128cbe`
(2026-11-08 08:33 UTC, "docs(agentic): add MCP server inventory"). All refs are
`git show origin/main:<path>` / `git grep origin/main`. No GitHub writes made.

## HEADLINE — both remainders were substantially built by the pipeline plane

The premise of the two remaining #3530 slices ("feed jobs are not schedulable
yet; no Copilot tool runs/reports a feed job") is **no longer true on current
main**. Between the #3530 status-UX merge (PR #3631, 2026-11-07) and now, the
pipeline plane landed:

- **#3534 (J1)** — `JobPipelineControl` engine (`src/services/jobPipelineEngine.ts`),
  job definitions/instances/run records behind ports (`src/data/jobPipelinePorts.ts`,
  DO-SQLite + D1 + in-memory adapters).
- **#3543 (J1 host wiring)** — `src/agents/scheduledTasksPipeline.ts` +
  ScheduledAgent RPC doors (`src/agents/scheduled-agent.ts`).
- **#3535 (J2)** — feed jobs as pipeline jobs (`src/services/feedPipelineJobs.ts`)
  **including the Copilot tools** (`src/mcps/openaimp/feedJobCommands.ts`).
- **#3540 (J7)** — composed chains (`src/services/chainPipelineJobs.ts`) that also
  carry schedules.
- **#3578** — the S1 `POST /data-providers/:id/feed-run` route converged onto
  the pipeline door (no direct in-residency runs remain).

What is genuinely left is narrower: **(i)** no surface anywhere can *edit* a
feed job's schedule (cadence/enable) — the engine supports it, nothing exposes
it, and the host's ensure behaviour would clobber such an edit; **(ii)** feed
runs are invisible in the Autopilot Control Center "Job outcomes" feed (the
#3527 S5 sink) and in the unified Jobs panel. Details per question below.

---

## Q1 — SCHEDULING

### 1a. The #3530 layer alone has no scheduler (by design)

- `src/services/feedJobs.ts` — `FeedJobDefinition.cadenceMinutes` is declared
  with the comment *"Declared pull cadence — the scheduling slice's input"*;
  knobs resolve from env (`FEED_JOB_<JOB_ID>_CADENCE_MINUTES` /
  `_STALE_MINUTES`, `resolveFeedJobCadenceMinutes`, defaults 60/180 in
  `FEED_JOB_DEFAULTS`). `buildFeedJobRegistry(env)` registers 6 jobs:
  `yahoo-nasdaq100-quotes`, `yahoo-nasdaq100-fundamentals`,
  `yahoo-sp100-quotes`, `alpaca-nasdaq100-quotes`, `etrade-nasdaq100-quotes`,
  `public-nasdaq100-quotes`. Nothing in this module registers with any
  scheduler; cadence is consumed only for display
  (`src/agents/routes/dataProviders.ts:496`, `src/client/DataProvidersPanel.tsx:140`)
  and by the pipeline definition builders below.

### 1b. The pipeline layer registers feed jobs with a real scheduler — YES, they run unattended

- `src/services/feedPipelineJobs.ts`
  - `buildFeedPipelineJobDefinition(def)` — every feed job becomes a J1
    definition whose root carries `schedule: { enabled: true, interval:
    "every <cadenceMinutes> minutes" }`. A 7th job,
    `nasdaq-nasdaq100-universe` (`buildNasdaqUniverseJobDefinition`), runs the
    #1980 index-refresh producer for the stored Nasdaq-100 list.
  - `ensureFeedPipelineJobs(control, stores, env)` — defines all 7 on a
    control plane, skipping ones whose stored `rawConfig` already matches.
  - `createFeedStepRegistry(deps)` — the `feed.pull` step *is* the #3530 run
    (`runFeedJob` / `runFeedFundamentalsJob` under the pipeline run id);
    `feed.universe` runs the index refresh. Unwired provider/store ⇒ coded
    `FEED_JOB_NOT_CONFIGURED` refusal, never an uncaptured fetch.
  - `FEED_PIPELINE_CATALOG` + `resolveFeedJob(query)` — name/alias resolution
    shared by UX and Copilot.
- `src/agents/scheduledTasksPipeline.ts` (host wiring, #3543)
  - `ensureScheduledAgentFeedJobs(ctx, control)` (L387) →
    `ensureFeedPipelineJobs`; `ensureScheduledAgentPipelineJobs` (L438)
    ensures feed + enrich + analyze + generate + deliver + chains, and is run
    by **every host entry point** (every door call in `scheduled-agent.ts`
    calls it first).
  - `declarePipelineTasks(ctx)` — builds Think scheduled-task declarations
    from `control.registerSchedules(recordingHost)`; each (job, node) becomes
    one task `pipeline-job:<jobId>[:<nodePath>]` whose handler dispatches
    `dispatchScheduledPipelineJob` → `control.runJob(jobId, { trigger:
    "scheduled" })`.
  - `createScheduledAgentPipelineControl(ctx, userLogin?)` — control plane
    over the ScheduledAgent's DO SQLite (`createJobPipelineStoresFromSql`),
    run recorder = `jobRunRecorderFromStore(new SqlJobRunRecordStore(sql))`.
- `src/agents/scheduled-agent.ts:467` — `override async
  getScheduledTasks()` returns `declarePipelineTasks(...)`. This is the
  Agents/Think scheduler declaration hook: **the schedule is live in the
  agent's task set, not the Worker cron tick.**
- `src/services/jobPipelineEngine.ts:598` — `JobPipelineControl.registerSchedules(host)`
  walks every stored definition (root + sub-nodes) and registers each
  `schedule.enabled` node; firing maps to `runJob(jobId, { trigger:
  "scheduled", scopePath })`.

**Answer: YES — a feed job runs unattended today**, via ScheduledAgent Think
tasks derived from the stored pipeline definitions, at the declared cadence
(default every 60 min). Two qualifications, both evidenced in
`scheduledTasksPipeline.ts`'s header (L18–25):

- Scheduled firings act under the platform service identity
  (`SERVICE_USER_LOGIN`, `getServiceUserLogin`). With none configured, the
  per-login providers (**E*TRADE, Public**) refuse by name on their jobs;
  env-credentialed sources (Yahoo, Alpaca) fire unattended.
- Quotes feed jobs can fire **twice per cadence**: standalone on their own
  schedule *and* as chain heads — `src/services/chainPipelineJobs.ts` header
  (L9–14) + `buildChainPipelineJobDefinition` (root schedule
  `every <chain.cadenceMinutes> minutes`, L207): stage jobs "keep their own
  schedules and remain individually schedulable"; the chain root carries a
  second schedule in place of the feed job's own *inside the chain
  definition*. By design, but it doubles the effective pull rate for quotes
  lineages.

### 1c. The every-30-min tick does NOT dispatch feed jobs

- Worker crons are named entry points in `src/services/consolidatedCronEntries.ts`
  (moved verbatim from `src/server/routes/queue.ts handleScheduledEvent`;
  `src/server.ts:293-295` still dispatches `handleScheduledEvent`). The `tick`
  entry (`*/30 * * * *`, `WORKER_TICK_CRON` in
  `src/services/consolidatedScheduling.ts:271`) fires six internal POSTs —
  research, reflection, adaptation, corpus-sync, reports-index-backfill,
  digest. `git grep feed src/services/consolidatedCronEntries.ts` = no hits.
  Feed scheduling deliberately lives on the ScheduledAgent, not this tick.

### 1d. Per-job schedule/enable/cadence storage — exists, engine-only

- `src/data/jobPipelinePorts.ts:83-99` — `JobScheduleConfig { enabled,
  cron?, interval?, registrationId?, reason? }`, attached per node
  (`JobNodeConfig.schedule`, root schedule resolved onto
  `JobDefinition.config.schedule`, L147/156).
- Stores: `JobPipelineStores.definitions` — DO-SQLite adapter
  (`src/data/doSqliteJobPipelineAdapter.ts`, via
  `createJobPipelineStoresFromSql`) on the ScheduledAgent host; D1 adapter
  (`src/data/d1JobPipelineAdapter.ts`) for the workflow residency;
  definitions are versioned (`defineJob` bumps `version`).
- Engine mutation exists: `JobPipelineControl.configureJob(jobId, patch)`
  (`jobPipelineEngine.ts:370`) merges a patch into the stored raw config and
  re-resolves; `scheduleStage` / `rescheduleStage` (L1010/1065) manage
  per-stage registrations. **No route, door RPC, MCP tool, or client code
  calls any of them** (`git grep configureJob src/agents src/mcps src/client`
  = no hits).

### 1e. What #3527 S5 actually used for corpus sync + reports sweep

Not a job registry — two pre-existing idioms, both in the routes:

1. **Dispatch**: rides the tick's internal POSTs in
   `consolidatedCronEntries.ts` (`observeInternalDispatch("corpus-sync", …
   POST /knowledge/corpus-sync)` L393; `"reports-index-backfill"` L406),
   each with its own in-route guard (weekly marker for corpus sync).
2. **Run records (two sinks)**:
   - `recordScheduledJobOutcome` — `src/observability/scheduledJobOutcomes.ts`:
     mas_events type `scheduled_job.outcome` (`SCHEDULED_JOB_OUTCOME_TYPE`,
     L59), `ScheduledJobId` union = `reflection | research | adaptation |
     corpus-sync | reports-index-backfill` (L61-75), with failure-streak +
     Slack alerting. Wired in `src/agents/routes/knowledgeCorpus.ts`
     (`recordCorpusSyncOutcome`) and `src/agents/routes/reports.ts`
     (`recordReportsBackfillOutcome`).
   - `recordJobOutcome(sql, …)` — `src/services/jobOutcomes.ts:59` (shim over
     `src/data/jobOutcomePorts.ts` / `doSqliteJobOutcomeAdapter`, table
     `mas_job_outcomes`, the #1333 store): `recordCorpusSyncRun`
     (knowledgeCorpus.ts, kind `"corpus"`, id `corpus-sync:<ranAt>`) and
     `recordReportsBackfillRun` (reports.ts, kind `"reports"`). This is the
     row the Autopilot "Job outcomes" feed renders.

**Could feed jobs use the same registration?** For *scheduling*, they neither
need nor should use the tick idiom — they already have a strictly better one
(1b). For *Autopilot-feed visibility*, yes: the `recordJobOutcome` half is
directly reusable (see Q2/Q5). The `ScheduledJobId` mas_events sink is a
closed union owned by the #2037 tick-job idiom; feed jobs do not belong in it
without extending that union and its alerting semantics.

---

## Q2 — RUN RECORDS

A feed run today writes **two** records, neither of them the Autopilot
job-outcomes store:

1. **The dataset artifact** (the run's own record): `runFeedJob` in
   `feedJobs.ts` stores a `FeedDatasetArtifact` whose embedded
   `FeedDatasetRunRecord` carries runId, trigger (`manual`/`scheduled`),
   status, requested/received/failed, coded error — via
   `FeedDatasetStore` (D1 adapter `createFeedDatasetAdapter`). Pipeline runs
   keep this identical: the `feed.pull` step runs the same service under the
   pipeline run id, so the artifact's run id *is* the pipeline run id.
2. **The pipeline run record**: the engine's recorder
   (`jobRunRecorderFromStore(SqlJobRunRecordStore)` on the ScheduledAgent
   host; D1 store in the workflow residency) writes a `JobRunRecord` with
   `system: "job-pipeline"` (`src/services/jobRunRecords.ts` SYSTEMS list,
   #3534). Status surfaces read it through `control.getJob(jobId).latestRun`.

The manual route specifically: `POST /data-providers/:id/feed-run`
(`src/agents/routes/dataProviders.ts`, handler ~L938) no longer runs anything
in its own residency since #3578 — it dispatches
`door.runPipelineJob(def.id, { userLogin })` through
`feedPipelineDoorFor(ctx)` (L510, the `SCHEDULED_AGENT` DO stub named
"default"), then rebuilds the S1 `{ run, feed }` response from the run's
dataset artifacts (`feedRunViewFromArtifacts`). So **manual, scheduled,
Copilot, and panel runs all converge on the same dispatch and the same two
records** — this part of the #3530 design goal is met.

**NOT written** (evidence: no `recordJobOutcome` / `JobOutcome` reference in
`feedJobs.ts`, `feedPipelineJobs.ts`, `jobPipelineEngine.ts`,
`jobPipelineEvents.ts`, `scheduledTasksPipeline.ts`, or `scheduled-agent.ts`):

- `mas_job_outcomes` (#1333) — `JobOutcomeKind` in
  `src/data/jobOutcomePorts.ts:28-36` is `"stock" | "options" | "goal" |
  "discovery" | "corpus" | "reports"` — **no feed kind**. The Autopilot
  Control Center's "Job outcomes" card (`src/client/components/
  AutopilotControlCenter.tsx:1021-1032`, fed by `listJobOutcomes` in
  `src/agents/routes/autopilot.ts:114`) therefore never shows a feed run,
  despite #3527 having established that feed as the system's job surface and
  the #3530 brief naming it as the target surface.
- mas_events `scheduled_job.outcome` (#2037) — `ScheduledJobId` union has no
  feed id (see 1e), so feed failures also don't enter the streak/Slack
  alerting those five tick jobs get. (Feed failures do surface in the Data
  Providers panel, the Copilot status view, and a structured log
  `feed_job_run_failed`.)

---

## Q3 — COPILOT

### Both halves already exist — built by #3535

`src/mcps/openaimp/feedJobCommands.ts` (152 lines) defines four
`IMcpToolCommand`s:

| Tool | Dispatch |
|---|---|
| `run_feed_job {source}` | `runFeedJobViaDoor` → door `runPipelineJob` + status |
| `get_feed_job_status {source}` | `getFeedJobStatusViaDoor` → merged surface view |
| `list_feed_jobs {}` | `listFeedJobsViaDoor` → all 7 views, catalog order |
| `manage_feed_job {source, action}` | pause / resume / cancel / retry via the generic pipeline RPCs |

- Name resolution is the catalog's: `resolveFeedJob` accepts a provider
  ("yahoo", "alpaca", "etrade", "public"), a universe ("nasdaq100",
  "sp100"), "fundamentals", or an exact job id; ambiguous/unknown refuses by
  name (`resolveFeedJobOrThrow`, `src/agents/orchestrator/meshDoors.ts:443+`).
- Identity: tools take **no** login input; `context.actingLogin()` is
  required and the door refuses closed without it (`requireActingLogin`,
  meshDoors.ts) — same discipline as the mesh batch-A doors.
- Registration: **one catalog** — `McpToolFactory` in
  `src/mcps/openaimp/commands.ts:1827-1831` (`registerTool(new
  RunFeedJobCommand())` etc.), scopes declared in
  `src/mcps/openaimp/mcpPermissionPorts.ts:260` (`run_feed_job: "mcp:write"`,
  reads scoped likewise). The header of feedJobCommands.ts states the same
  catalog serves the General Copilot **and** the Stock Copilot, and
  `src/agents/registry.ts:875` records batch G (#3535) as serving identified
  external MCP callers through `/mcp` as well. There is no separate NLQ/chat
  intent handler for feed jobs, and none is needed — chat reaches the service
  exclusively through this tool catalog.
- Tests: `tests/feed_job_tools_3535.test.ts` drives the real commands over a
  faked ScheduledAgent namespace.

### The pattern to follow for anything new (concrete)

`feedJobCommands.ts` itself is the canonical example; its siblings
(`enrichJobCommands.ts`, `analyzeJobCommands.ts`, `generateJobCommands.ts`,
`deliverJobCommands.ts`, `chainJobCommands.ts`) are transpositions of it:

1. One `IMcpToolCommand` class per tool in `src/mcps/openaimp/<x>JobCommands.ts`
   (`name`, `description`, `jsonSchema`, `zodSchema`, `execute(input, context)`),
   audit-logging `mcp.tool_called` with ids only.
2. `execute` calls a typed door function in
   `src/agents/orchestrator/meshDoors.ts` (`<x>ViaDoor(env, actingLogin, …)`),
   which resolves the surface name against the family catalog and calls the
   `ScheduledAgentDoorStub` RPC interface (door-local interface over the
   agent's real RPC surface).
3. The RPC lands on `ScheduledAgent` methods (`src/agents/scheduled-agent.ts`,
   e.g. `runPipelineJob` L472, `getFeedJobSurfaceStatus` L567), which build
   the host control plane (`createScheduledAgentPipelineControl`), ensure
   definitions, and dispatch — the *same* `runJob` a scheduled firing and
   the UX routes make. No second engine entry anywhere.
4. Register in `McpToolFactory` (commands.ts) + declare the scope in
   `mcpPermissionPorts.ts`.

**What Copilot still cannot do for feed jobs:** anything about the
*schedule* — no tool reads a job's schedule as configuration (the status view
only estimates `nextScheduledRun` from last dispatch + cadence,
`buildFeedJobSurfaceView` in feedPipelineJobs.ts), and no tool can change
cadence, enable/disable a schedule, or pause a *schedule* (manage's "pause"
pauses a live *run* at a step boundary — a different thing).

---

## Q4 — SCHEDULE CONFIG SURFACE (UI)

- **A cadence editor exists — for a different job system.**
  `src/client/scheduledOptionsManager/CadenceModal.tsx` ("The one cadence
  editor (issue #2329)") edits `ScheduledTaskItem`s (scheduleType
  interval/cron) for the orchestrator's durable scheduled tasks / scheduled
  options screens, used by `ScheduledOptionsManager.tsx` and
  `SchedulesPanel.tsx`. Feed jobs are not `ScheduledTaskItem`s and **do not
  appear there**.
- **The unified Jobs panel doesn't know pipeline jobs.**
  `src/client/JobsPanel.tsx` header: "one management surface for all three
  schedule systems" — ScheduledAgent *goals*, orchestrator durable
  schedules, and Worker cron triggers (read-only). Its API client
  (`src/client/jobsApi.ts`) reads `/api/schedule/*` and `/api/schedules/*`
  only. Pipeline jobs (and therefore feed jobs) are absent — including their
  `system: "job-pipeline"` run records, which no client lists.
- **The Data Providers panel is the only feed-job UI**, and it is
  run/manage/status only: per-source `feedJobs` views with
  run/pause/resume/cancel/retry actions through `POST
  /data-providers/:id/feed-jobs/:jobId/:action` (dataProviders.ts:14;
  panel handlers `runFeedAction` ~L273), plus the S1 feed block. Its cadence
  line (`DataProvidersPanel.tsx:140`) is **display-only text**, rendered from
  the #3530 registry's env-resolved `cadenceMinutes` — *not* from the stored
  pipeline definition that actually schedules the job. After any future
  `configureJob` patch, panel text and real schedule could silently diverge.
- Net: **no UI anywhere edits any pipeline job's schedule**, and the only
  schedule an operator can change for a feed job today is the
  `FEED_JOB_<ID>_CADENCE_MINUTES` env var (plus a redeploy/restart for it to
  re-ensure).

---

## Q5 — GAPS: the precise remaining pieces

### (A) Scheduling slice — reduced to schedule *configuration* + durability

Scheduling itself is DONE (Q1b). What remains, file-level, all reusing
existing machinery:

1. **Expose `configureJob` for the schedule fields only.**
   - `src/agents/scheduled-agent.ts`: add one RPC, e.g.
     `configurePipelineJob(jobId, patch)`, following the file's own door
     idiom (build control → ensure → dispatch) — the control method already
     exists (`jobPipelineEngine.ts:370`).
   - `src/agents/orchestrator/meshDoors.ts`: add the
     `configurePipelineJob` member to `ScheduledAgentDoorStub` + a
     `configureFeedJobScheduleViaDoor(env, login, source, {interval/cron,
     enabled})` resolver over `resolveFeedJob` (the Q3 pattern).
   - `src/agents/routes/dataProviders.ts`: add
     `POST /data-providers/:id/feed-jobs/:jobId/schedule` beside the existing
     `:action` route, session-gated like the other mutations, mapping
     refusals through the existing `feedRunRefusalResponse` idiom.
2. **Fix the ensure-clobber (durability bug, latent today).**
   `ensureFeedPipelineJobs` re-defines any job whose stored `rawConfig`
   differs from the env-built raw config — and ensure runs on *every* door
   call. The moment any surface can patch a schedule, the next door call
   silently reverts it. Fix in `src/services/feedPipelineJobs.ts`: make the
   ensure comparison schedule-aware — preserve the stored definition's
   `root.schedule` when re-defining for non-schedule drift (or skip
   re-definition when the only diff is the schedule block), pinned by a test
   in `tests/feed_pipeline_jobs_3535.test.ts`. **This must land before or
   with (1), or (1) is a no-op in practice.**
3. **Make the panel read the real schedule.** In
   `feedJobsViewFor`/`buildFeedJobSurfaceView` (dataProviders.ts /
   feedPipelineJobs.ts), surface the stored definition's schedule
   (enabled + interval/cron) alongside the registry cadence; render it in
   `src/client/DataProvidersPanel.tsx` (extend the `feedJobs` view types in
   `src/client/dataProvidersApi.ts`) and add the edit control there — the
   panel already hosts every other feed-job action; do **not** route this
   through `CadenceModal.tsx` (wrong job system — Q4).
4. **Re-declaration after edit is already wired**: Think declarations are
   rebuilt from stored definitions on every `getScheduledTasks()` reconcile
   (`declarePipelineTasks`), so a stored schedule change takes effect
   without new plumbing — the slice only has to prove it with a test.
5. *Optional, decide explicitly:* the chain double-fire (Q1b) — if the
   intended semantics is "quotes lineages pull once per cadence", the chain
   ensure could strip the standalone feed schedule for chain-headed jobs in
   `chainPipelineJobs.ts`; today both schedules are enabled by design.
   Flagging, not prescribing.

### (B) Copilot run/status slice — reduced to schedule tools + outcome visibility

Run/status/list/manage are DONE (Q3). What remains:

1. **One more command file entry, same pattern**: add
   `GetFeedJobScheduleCommand` / `SetFeedJobScheduleCommand` (or one
   `manage_feed_job_schedule`) to `src/mcps/openaimp/feedJobCommands.ts`,
   backed by the door functions from (A)2, registered in
   `src/mcps/openaimp/commands.ts` + scoped in
   `src/mcps/openaimp/mcpPermissionPorts.ts`. This is the only Copilot code
   the scheduling slice needs — it depends on (A)1-(A)2, not on any new
   engine work.
2. **Feed runs into the Autopilot job-outcomes feed** (the visibility half
   of the original Copilot/status brief, and the #3527 S5 idiom):
   - `src/data/jobOutcomePorts.ts`: extend `JobOutcomeKind` with `"feed"`.
   - Write the row where the run settles on the host: in
     `src/agents/scheduledTasksPipeline.ts`'s dispatch path
     (`dispatchScheduledPipelineJob` + the door settle in
     `scheduled-agent.ts runPipelineJob`), call `recordJobOutcome` with
     id = pipeline run id, trigger from the dispatch, status projected
     (completed/failed; paused/cancelled need an honest mapping — the
     store's vocabulary is completed|failed|partial), counts from the feed
     step's settled output. Manual/Copilot/panel runs all pass through
     `runPipelineJob`, so one write site covers every trigger — do **not**
     write from `feedJobs.ts` (the dataset artifact already records there;
     a second writer would double-record pipeline runs and miss none of
     them, but the host is the only place that knows the trigger and the
     settled pipeline state).
   - `src/client/components/AutopilotControlCenter.tsx`: the card header
     copy (L1032) enumerates the kinds — add feed. No other client change;
     the feed renders `listJobOutcomes` rows generically.
   - Residency note: `mas_job_outcomes` is per-DO-instance (the corpus/
     reports rows are written with the *Orchestrator's* sql handle, and the
     Autopilot route reads its own instance's store). The ScheduledAgent
     host has its own DO sql — writing there puts feed rows in a store the
     Autopilot route does not read. The write therefore needs the same
     residency decision #1333 made for its producers (write through a door
     to the store the route reads, or have the route aggregate) — this is
     the one non-mechanical decision in the slice; everything else is
     transposition.
3. Nothing else: no NLQ handler, no new registry, no new store.

### Collision risk — files the pipeline plane built that these slices touch

The pipeline plane (#3533 epic: J1 #3534, J2 #3535, J3 #3536, J4 #3537,
J5 #3538, J6 #3539, J7 #3540, host #3543, convergence #3578) owns, and is
still actively extending (chains landed last), every central file above:

- `src/services/feedPipelineJobs.ts`, `src/services/chainPipelineJobs.ts`,
  `src/services/jobPipelineEngine.ts` — plane core; the ensure fix (A)2 and
  any schedule semantics change land in their files. **Highest collision
  risk; claim-check the issues before building, per standing rule.**
- `src/agents/scheduledTasksPipeline.ts`, `src/agents/scheduled-agent.ts`,
  `src/agents/orchestrator/meshDoors.ts` — host + doors; every stage family
  (enrich/analyze/generate/deliver/chain) shares these exact files, so a
  feed-schedule RPC added here sits beside five sibling families' doors.
- `src/mcps/openaimp/feedJobCommands.ts`, `src/mcps/openaimp/commands.ts`,
  `src/agents/routes/dataProviders.ts`, `src/client/DataProvidersPanel.tsx`,
  `src/client/dataProvidersApi.ts` — the surface files; the same files carry
  the enrich/analyze/generate/deliver/chain blocks in identical idiom.
- Lower risk (CDO-side / shared platform): `src/data/jobOutcomePorts.ts`,
  `src/services/jobOutcomes.ts`, `src/client/components/AutopilotControlCenter.tsx`,
  `src/services/feedJobs.ts` (read-only for these slices).

Because the ruling on file (comment 6703795326 on #3530) assigned exactly
this surface area to the pipeline plane, and the plane has since *built*
most of it, the remaining work in (A)/(B) is best framed on the issue as
**completion of the plane's own idiom at its edges** (schedule config
exposure + Autopilot-feed visibility), not as a parallel CDO build.
