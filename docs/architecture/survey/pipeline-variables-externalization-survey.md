# Survey — externalize ALL job / pipeline / stage / chain / workflow variables

- **Base:** `c334d9ae5f71850bce708263e0372ae9faebb36f` (`feat(isolation): per-tenant provider and broker credential store (#4614)`), latest tag `v0.1.1858`
- **Worktree:** `~/workspace/w3533/wt-externalize` (fresh, from `origin/main`)
- **Evidence:** `inv-01-consts.txt` … `inv-06-numdefaults.txt`, `scope.txt` in this directory
- **Issue:** to be filed after this survey; parent epic #3533 (proposed). LOCAL ONLY — no GitHub writes, no code changes.
- **User direction (2026-11-16):** externalize ALL job, pipeline, stage, chain, workflow variables — all of them — and make them configurable and manageable through UX (the workflow-catalog define view). This widens the earlier timeout-only direction (#4775, 600s stage deadline).
- **Rule measured against:** repo `AGENTS.md` — "No hard coding — every default/constant/setting/etc. must be externalized and configurable through a config file. Make this change on every code touch."

## Method

Grep inventory over the scope files (engine, config, stage runner, workflow ports, catalog, feed jobs, PipelineJobs builders, doors, routes, MCP job commands), then read each hit's home: code constant / inline literal / env knob / settings map / job-definition field / define-view field. A variable counts as a variable only if an operator or a job author could reasonably want a different value (counters, indices, and ids are not counted). Already-filed items (#4772 naming, #4773 catalog literal, #4775 deadline) are noted, not double-counted.

## What the define UX can already change (verified)

The define view (`?tab=workflow-catalog&view=define`, `src/client/WorkflowDefinitionFlow.tsx`) edits, per job:
- spec (picker), job id, cadence (job-level; `CADENCES` list, see C14), per-stage `stageModes` (the four mode axes), per-stage `stageParams` (arbitrary params), per-stage `stageSchedules` (`intervalMinutes` / `cron`).
- It posts to `POST /api/job-definitions/:id/define` (per-stage overrides) + `POST /api/schedules` (job cadence), `src/agents/routes/jobDefinitions.ts:35-37,147-156`.

It does **not** edit: any timeout, any retry value, any fan-out cap, any batch size, any retention cap, or `processing.*` fields. There is **no UX anywhere** for the `pipeline.*` settings map or any `FEED_JOB_*` env knob (grep over `src/client/` empty).

## Inventory

Class: **A** = externalized AND UX-editable · **B** = externalized (config/env/settings) but NOT UX-editable · **C** = hardcoded in code.

| # | Variable | File:line | Current home | Class | Proposed home |
|---|---|---|---|---|---|
| A1 | Execution mode, root + per-stage (sequential/parallel, batch/online, sync/async, monolith/sharded; defaults sequential/batch/async/monolith) | `src/data/jobPipelinePorts.ts:60-84` (type + `DEFAULT_JOB_EXECUTION_MODE`); `src/config/screenerExecutionMode.ts:25,40` (env JSON override); define view `stageModes` | Spec field + env default + define-view per-stage | A | — (done; `monolith` spelling kept per #4772) |
| A2 | Job / stage cadence (schedule) | `src/data/jobPipelinePorts.ts:83-98` (`JobScheduleConfig`); define view cadence + `stageSchedules`; stored schedules (`POST /api/data-providers/:id/feed-jobs/:jobId/schedule`); `FEED_JOB_<JOB_ID>_CADENCE_MINUTES` env | Definition field + define view + stored schedule + env knob — **three homes for one value** (see C15) | A* | Consolidate to one home (see S7 / Q3) |
| A3 | Per-stage params (generic channel) | `src/services/jobDefinitionSpecBuilder.ts:48`; define view `stageParams` | Definition field + define view | A | — (channel exists; note: the engine does not read timeout/retry/fan-out from it today — S1/S2 wire their fields explicitly, not through params) |
| B1 | Feed leg timeouts: refresh 30s / fetch 60s / capture 30s / execution 240s + verify 120s | `src/services/feedJobTimeouts.ts:60-73` (`FEED_JOB_TIMEOUTS` defaults table); knobs `FEED_JOB_REFRESH_MS` / `FEED_JOB_FETCH_MS` / `FEED_JOB_CAPTURE_MS` / `FEED_JOB_EXECUTION_MS` / `FEED_JOB_VERIFY_MS` (#4312, #4304); resolved via `resolveFeedJobTimeouts(env)` | Env knobs + defaults table | B | + job-definition field (per job / per stage) + define-view editing — this is #4775 widened; the env knobs stay as the global fallback |
| B2 | Feed cadence / staleness defaults: cadence 43200 min, stale 44640 min | `src/services/feedJobs.ts:301-303` (`FEED_JOB_DEFAULTS`); per-job env `FEED_JOB_<JOB_ID>_CADENCE_MINUTES` / `_STALE_MINUTES` (`:230-234`, resolvers `:237-263`) | Env knobs + defaults table | B | Same as A2 — one cadence home (S7); stale threshold to the same home |
| B3 | Retry budgets: acquisition 3 attempts / 250ms base / 4000ms max; delivery 3 / 500 / 8000; report 2 / 500 / 4000; jitter 0.25 each | `src/services/pipelinePolicy.ts:64-82` (`DEFAULT_PIPELINE_POLICY`); env `PIPELINE_*_RETRY_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` + shared `PIPELINE_RETRY_*`; settings `pipeline.retry.*` | Env + settings map + defaults table — **the model pattern for this programme** | B | + define-view per-stage override (retry attempts/delay) in S2; fix the two caveats (below) in S3 |
| B4 | Provider fetch timeout 15,000ms | `src/services/pipelinePolicy.ts:80`; env `PIPELINE_FETCH_TIMEOUT_MS`, setting `pipeline.fetchTimeoutMs` | Env + settings + defaults table | B | Stays global; surface in the platform settings UX if one is built (Q2) |
| B5 | Notification policy (enabled, slack/email/webhook, per-event on/off) | `src/services/pipelinePolicy.ts:44-62`; env `PIPELINE_NOTIFICATIONS` / `PIPELINE_NOTIFY_*`; settings `pipeline.notify.*` | Env + settings + defaults table | B | Out of the pipeline-variable scope proper; no change proposed (recorded for completeness) |
| B6 | Screener default mode, global | `src/config/screenerExecutionMode.ts:19,25,40` (`SCREENER_DEFAULT_EXECUTION_MODE`, JSON env knob) | Env knob | B | Stays; per-stage mode is already A1 |
| B7 | Executor backstop 90 min | `src/agents/orchestrator/asyncJobs.ts:1233-1240` (`ASYNC_JOB_MAX_RUNTIME_MINUTES`, env) | Env knob | B | Adjacent (async-jobs plane, not pipeline-plane); no change |
| B8 | `processing.checkpointEverySteps`, default 1 | `src/services/jobPipelineConfig.ts:226-234` (validated), `:297-300` (`?? 1`) | Definition field (exists, validated) | B | Expose `processing.*` in the define view as per-stage advanced fields (S2); the code default 1 stays as the fallback |
| C1 | Stage per-unit deadline 600s | `src/workflows/workflowPorts.ts:134` (`DEFAULT_SHARD_TIMEOUT_MS = 10*60*1000`); alias `DEFAULT_STAGE_TIMEOUT_MS` (`src/workflows/stageRunnerPorts.ts:317`); `stageForNode` sets `timeoutMs: DEFAULT_STAGE_TIMEOUT_MS` unconditionally (`src/services/jobPipelineEngine.ts:2419`) — **no definition field exists to read** | Code constant | C | Job-definition node field `timeoutMs` + define-view per-stage field; global default in a timeouts config (same family as `FEED_JOB_TIMEOUTS`). This is #4775's core |
| C2 | Parent shard-status poll interval 15s | `src/workflows/workflowPorts.ts:137` (`DEFAULT_POLL_INTERVAL_MS = 15*1000`); command field `pollIntervalMs?` (`:383`) | Code constant | C | Global config (workflow polling config); not per-job |
| C3 | Fan-out cap 4 shards | `src/workflows/workflowPorts.ts:131` (`DEFAULT_MAX_PARALLEL_SHARDS = 4`); `stageMaxParallel` falls back to it (`src/workflows/stageRunnerPorts.ts:311-313`); `stageForNode` never sets `maxParallel` (`src/services/jobPipelineEngine.ts:2402-2425`) | Code constant | C | Job-definition node field `maxParallel` + define-view per-stage field; global default in config |
| C4 | Retry-bucket assignment per stage kind + default bucket `"report"` | `src/workflows/stageRunnerPorts.ts:76` (`STAGE_RETRY_BUCKET` table); `:158` (`JOB_STAGE_DEFAULT_RETRY_BUCKET = "report"`); applied by kind in `stageForNode` (`src/services/jobPipelineEngine.ts:2410-2417`) | Code table | C | Job-definition node field `retryBucket` + define-view per-stage select (buckets stay defined in `pipelinePolicy`) |
| C5 | Workflow step max retries 3 | `src/workflows/workflowPorts.ts:140` (`WORKFLOW_STEP_MAX_RETRIES = 3`) | Code constant — **only used by the deprecated screener flow** (`screenerWorkflowFlow.deprecated.ts:319,324,597`); the live engine uses policy buckets | C | Delete with #4776 (dead-module removal); no new knob |
| C6 | Screen await deadlines: goal 2×600s, stock 1×600s | `src/workflows/runGoalScreenViaEngine.ts:63` (`GOAL_SCREEN_AWAIT_DEADLINE_MS = 2 * DEFAULT_SHARD_TIMEOUT_MS`); `src/workflows/runStockScreenViaEngine.ts:539` (`?? DEFAULT_SHARD_TIMEOUT_MS`); both injectable per call (`awaitDeadlineMs?`) but default from the code constant | Code constant (per-call injectable, no config/definition) | C | Derive from C1's home once it exists — no separate knob |
| C7 | Run-record retention per job 100 | `src/data/jobRunRecordPorts.ts:34` (`JOB_RUN_RECORDS_PER_JOB_CAP = 100`) | Code constant | C | Global retention config |
| C8 | Stored pipeline completions cap 100 | `src/agents/scheduledTasksPipeline.ts:899` (`PIPELINE_COMPLETIONS_CAP = 100`), applied `:918` | Code constant | C | Same retention config as C7 |
| C9 | Sentiment leg batching: classify batch 20, news per symbol 5 | `src/services/feedJobs.ts:1802-1805` (`SENTIMENT_CLASSIFY_BATCH_SIZE = 20`, `SENTIMENT_NEWS_PER_SYMBOL = 5`) | Code constants | C | Feed-job definition params (per job — universe size varies) + define-view stage params |
| C10 | Options-chains defaults: minDte 0, maxDte 365, max expirations/symbol 100 | `src/services/feedJobs.ts:2375-2377` (`opts.minDte ?? 0`, `?? 365`, `?? 100`) | Per-call defaults, no config | C | Feed-job definition params on the options-chains job + runner wiring (the define view's `stageParams` channel exists; the runner must read it) |
| C11 | Input validation caps: command symbols 200, screen intent chars 2000 | `src/workflows/workflowPorts.ts:151` (`MAX_COMMAND_SYMBOLS = 200`); `:167` (`MAX_SCREEN_INTENT_CHARS = 2000`) | Code constants | C | Global validation-limits config; not per-job UX |
| C12 | Catalog screener mode literal | `src/config/jobDefinitionCatalog.ts:107-112` | Inline literal | C | Already filed as #4773 (R2, partial reuse #4447) — not counted twice |
| C13 | Define-view cadence choices: job 15m/1h/6h/daily; stage 15/60/360/1440 min | `src/client/WorkflowDefinitionFlow.tsx:57-69` (`STAGE_CADENCES`, `CADENCES` hardcoded lists) | UX literal — **monthly (43200 min), the cadence feed jobs actually run on, is not offered** | C | Derive the choice list from config + add monthly (and a custom interval input) |
| C14 | Stale-run reap 2h | `src/agents/orchestrator/asyncJobs.ts:1159` (`STALE_RUNNING_REAP_MS = 2 * 60 * 60 * 1000`) | Code constant | C | Adjacent (async-jobs plane, reaps pipeline runs) — global config; propose as a separate issue, not a #3533 slice |
| C15 | (Overlap, not a variable) Cadence has THREE homes | Env knob (B2) + stored schedule (data-providers `POST .../schedule`, #3530) + define-view cadence (A2) | Three homes, one value | — | Consolidation issue (S7): one home; define view writes the stored schedule; env knob becomes the fallback/default, not a third live value. Tied to #4457 (dynamic host declaration) and the #4770 open question (define view vs data-providers view) |

## Counts

| Class | Count |
|---|---|
| A — externalized AND UX-editable | 3 (A1 mode, A2 cadence, A3 stage params) — A2 carries the three-homes overlap |
| B — externalized, NOT UX-editable | 8 (B1–B8) |
| C — hardcoded | 15 (C1–C15: 14 core + 1 adjacent C14 reap; C12 already filed as #4773, counted here but not double-filed) |
| **Total inventoried** | **26 rows** (3 A + 8 B + 15 C) |

## Caveats found (verified, need handling in the build)

1. **The settings-map half of `pipelinePolicy` is unwired at the live call sites.** `resolvePipelinePolicy(env, settings)` supports `pipeline.*` settings, but the live callers pass env only (`src/agents/orchestrator/asyncJobs.ts:2397,2589`). An operator tuning `pipeline.retry.*` in settings gets no effect on pipeline runs today. S3 must pass the settings map at the call sites (or remove the settings path honestly).
2. **`jitterRatio` is not overridable.** The resolver hardcodes `jitterRatio: base.jitterRatio` (0.25) for every bucket (`pipelinePolicy.ts`, `retryFor`). Either make it overridable like the other three retry values or record it as a fixed constant by decision.
3. **The define view cannot express the cadence feed jobs run on.** `CADENCES` tops out at daily; feed jobs run monthly (43200 min, #4306). A feed job defined through the define view cannot be given its own production cadence (C13).
4. **`stageForNode` is the choke point for C1/C3/C4.** Timeout, fan-out, and retry-bucket all resolve in one method (`jobPipelineEngine.ts:2402-2425`) from constants/tables, never from the node. The fix is one method + three node fields + define-view fields — that is why S1/S2 are small.
5. **No UX exists for any global (B) variable.** Env knobs and the settings map are operator-only (deploy/env or settings store). "Manageable through UX" for the B family needs a decision: per-job fields in the define view (S1/S2) vs a platform settings surface (Q2). They are different UX surfaces.

## Proposed homes (pattern)

Follow the two existing patterns, don't invent a third: **`feedJobTimeouts.ts`** (defaults table + per-bound env knobs + `resolve*` function, refused-by-name on bad values) and **`pipelinePolicy.ts`** (defaults table + env + settings map, precedence code < env < settings, invalid values ignored-with-log or refused-by-name). New per-job/per-stage values go on the **job definition** (`JobNodeConfig` fields, validated in `jobPipelineConfig.ts`, edited in the define view via `stageParams`-style per-stage sections); new global values go in a **config module** under `src/config/` following the `*Modes.ts` convention; env knobs stay as the operator-global fallback where they already exist.

## Proposed issue shape (recommendation)

Phased slices under parent epic #3533 (one issue per slice, merge-first, one at a time). #4775 already exists and is the S1 vehicle — widen it, don't file a duplicate.

| Slice | Content | Size / Priority |
|---|---|---|
| S1 — #4775 (already filed, widened) | C1 stage timeout (600s) as a definition field + define-view field + config default; reconcile with the 240s run budget; C6 await deadlines derive from it | Small / Medium (as filed) |
| S2 | C3 fan-out cap + C4 retry-bucket assignment + B8 `processing.*` exposure: node fields `maxParallel`, `retryBucket`, `processing.*` + define-view per-stage fields | Small / Low |
| S3 | B3 caveats: wire the settings map at the live `resolvePipelinePolicy` call sites; make `jitterRatio` overridable (or record it fixed); C2 poll interval to config | Small / Low |
| S4 | C7 + C8 retention caps (100/100) to a retention config | Small / Low |
| S5 | C9 + C10 feed-leg defaults (sentiment batching, options DTE/expirations) to feed-job definition params + runner wiring | Small / Low |
| S6 | C11 validation caps + C13 cadence choice list (add monthly + custom interval) to config | Small / Low |
| S7 | C15 + A2: cadence three-homes consolidation — one home; define view writes the stored schedule; env knob as fallback | Medium / Medium (needs #4457 dynamic declaration) |
| Adjacent (separate issue, async-jobs plane) | C14 stale-run reap 2h to config | Small / Low — file separately, not under #3533 |

## Open questions (need a user ruling before building)

- **Q1 — per-job vs global, per family.** Recommendation: timeouts, fan-out, retry-bucket per-job (they vary by job — a feed pull and a screen have different budgets); poll interval, retention, validation caps global config; retry budgets global (env/settings) with a per-job override only if the user wants it. Does the user agree, or should retry budgets also be per-job?
- **Q2 — where do global (B) variables get a UX?** The define view is per-job. The `pipeline.*` settings and env knobs are global. Is there a platform settings surface for them, or do they stay operator-only (env/settings store) while only per-job values get define-view editing?
- **Q3 — cadence: which home wins?** Env knob, stored schedule, or define-view cadence — one must be the source of truth, the others fallback/display. Recommendation: the stored schedule is the home (it is what the scheduler arms); the define view writes it; the env knob is the default for jobs without one.
- **Q4 — scope boundary.** Include the adjacent C14 reap (async-jobs plane) and B5 notifications in this programme, or keep it strictly pipeline-plane (job/pipeline/stage/chain/workflow) and file C14 separately?
- **Q5 — cadence choices.** Add monthly to the define view's list (and a custom interval input), or keep the fixed four choices and let monthly live only in stored schedules/env?
