# Runtime inventory — everything that runs, with trigger + defaults

Owner: CFO-qunso. Issue: #4134 (parent: #4133, [Operational Excellence]
runtime inventory). Last verified: 2026-11-11, against main
`0d38800f`. Status: current.

This is the single inventory of everything that keeps running once the
app is deployed: what triggers it, how often it fires, whether it is
enabled, and where its default lives (code file + line, env var,
feature flag, or per-tenant setting). It states what the code says. It
does not state what the live deployment is doing — §10 names the
questions only the live environment can answer.

Companion issues: #4137 (why the autonomous loop is not running
despite the config), #4136 (the sync/async externalized config —
unbuilt work), #4138 (copilot observability), #4135 (the stale
runbook line this inventory corrects — see §7 note and the
`stuck-runs.md` fix in the same change).

## How to read this inventory

Everything runs on one of four trigger kinds, and nothing else:

1. **Worker cron tick** — the platform fires `scheduled()` on a cron
   expression declared in `wrangler.jsonc`.
2. **Queue message** — a queue consumer delivers a batch to
   `queue()` in `src/server.ts`.
3. **SDK alarm** — a Think scheduled task (`ctx.schedule`) or a
   `scheduleEvery` callback on a Durable Object instance.
4. **Direct invocation** — an HTTP request, an MCP call, a chat turn,
   or a door call.

Nothing is triggered by the deploy itself. No schedule, cron, or
container is armed by a deploy; Think scheduled tasks arm when their
host instance first runs (the `onStart` path — e.g. the strategy-scan
schedule is armed from `src/agents/orchestrator.ts:1097`).

**The headline, first, because it changes how the rest reads: most
of the cron-driven layer is armed in code but not firing in the
deployed config.** The Worker cron triggers are commented out
(#4112, §1), so no tick arrives, so the ScheduledAgent goals (§2)
do not fire either — their only trigger path is that tick
(`src/agents/scheduled-agent.ts:383-386`: "ticks still arrive via
the Worker cron trigger as RPC `onCron()` calls, never via the SDK
scheduler"). The Think scheduled tasks and SDK callbacks (§4, §5)
are the parts that still fire, because they arm on the instance
itself rather than on a Worker cron.

Conventions used below:

- **Trigger** — which of the four kinds above, and the exact
  expression, queue, or arming call.
- **Default lives in** — the code file + line, env var, or setting
  that holds the default. Env vars are deployment config; a stored
  per-login setting wins over env, and env wins over the code
  default (precedence: `mas_settings` > env > code default — see
  §8).
- **Enabled state** — as the code declares it, not as the live
  deployment reports it. Where the code and the deployed config
  disagree (e.g. a code default of OFF with the deployed config
  setting it ON), both are stated.
- Anything this inventory could not verify from code is marked
  **not verified from code**, never filled in by guesswork.

## 1. Worker crons — OFF (commented out, #4112)

`wrangler.jsonc:240-251`, owner direction #4112, commit `28086623`
("deploy no container and register no schedule"):

> NO schedules and NO triggers. Every cron entry is commented out,
> so nothing fires — no ScheduledAgent tick, no nightly research
> run, no retention pass. The `scheduled()` handler and
> `resolveCronEntryPoint` stay in code and become unreachable, so
> restoring a schedule is an uncomment here, not a code change.

The commented-out entries, and what each dispatches when restored:

| Cron (commented out) | Entry point | What it dispatches |
| --- | --- | --- |
| `*/30 * * * *` | `tick` | The 30-minute tick: research, reflection, adaptation, corpus-sync, reports-index-backfill dispatches, plus the digest POST (`src/services/consolidatedCronEntries.ts:292`, `runTickEntryPoint`; dispatch list in the file header `:36-37` and `:357-397` — daily options-research run #354, weekly reflection #705, adaptation weights, corpus-sync). The tick also evaluates the ScheduledAgent goals (§2) via `onCron`. |
| `0 3 * * *` | `renewTokens` | Token renewal (`src/services/consolidatedCronEntries.ts:469`, `runRenewTokensEntryPoint`). |
| `0 4 * * *` | `retention` | Retention pass (`src/services/consolidatedCronEntries.ts:525`, `runRetentionEntryPoint`). |

The code that would run them, still present and unreachable:

- `src/server.ts:304-306` — `async scheduled(event, env, ctx)` calls
  `handleScheduledEvent(event, env, ctx)`.
- `src/server/routes/queue.ts:197` — `handleScheduledEvent` calls
  `resolveCronEntryPoint(event?.cron)` at `:241`.
- `src/services/consolidatedCronEntries.ts:75,104` —
  `CronEntryPointName = "tick" | "renewTokens" | "retention"`,
  `resolveCronEntryPoint`, and the three runners (`:292`, `:469`,
  `:525`, wired at `:585-587`).

Two gates on the tick even when the triggers are restored:

- **Service-user gate** (#2331 slice 2): the tick skips entirely
  when the service user is not provisioned for the platform tier —
  "skipping the ScheduledAgent tick and the research /
  reflection / adaptation dispatches rather than running
  unattended work without a verified identity"
  (`consolidatedCronEntries.ts:298`). Provision via
  `POST /api/admin/service-user/provision`.
- **Tick-evaluated goals** (§2) fire only through this tick.

**Restore:** uncomment the three lines in `wrangler.jsonc`
(no code change) and redeploy. Restoring is an owner decision —
#4112 commented them out deliberately, as a cost measure
alongside the container removal.

## 2. ScheduledAgent goals — armed, not firing (no tick)

Source: `DEFAULT_SCHEDULES`, `src/schedule.ts:83-216` (the array
closes at line 216). Goals live in the ScheduledAgent's SQL store;
this list is the built-in seed.

| id | Name | Cron | Time zone | Operation | Budget | Enabled |
| --- | --- | --- | --- | --- | --- | --- |
| `daily-qa-sweep` | Daily QA sweep | `0 6 * * *` | — (UTC `isDue`) | `qa.run_sweep` | 500¢ | true |
| `opportunity-hunt` | Opportunity hunt | `0 */6 * * *` | — (UTC `isDue`) | `search.opportunity_hunt` | 1000¢ | true, but **never fires** — see quirk below |
| `daily-social-post` | Daily social post | `0 9 * * 1-5` | `America/New_York` | `social.publish` | 1¢ | **false** — shipped disabled; the owner enables it via the dashboard API (`src/schedule.ts:98-103`) |
| `resource-daily-rollup` | SessionStore daily resource rollup | `30 1 * * *` | UTC | `resource.rollup_daily` | 1¢ | true |
| `resource-cap-alert` | SessionStore 70% cap alert | `0 * * * *` | UTC | `resource.cap_alert` | 1¢ | true |
| `resource-dashboard-comparison` | SessionStore dashboard comparison | `0 2 * * *` | UTC | `resource.dashboard_comparison` | 1¢ | true |
| `index-refresh-wikipedia` | Index-list refresh (Wikipedia) | `0 4 * * 0` | UTC | `index.refresh_wikipedia` | 1¢ | true |
| `index-refresh-holdings` | Index-list refresh (ETF holdings) | `0 3 * * *` | UTC | `index.refresh_holdings` | 1¢ | **false** — disabled; no holdings-fetcher binding exists (`src/schedule.ts:163-173`) |

Line references: `daily-qa-sweep` `:78-83`, `opportunity-hunt`
`:86-91`, `daily-social-post` `:100-106`,
`resource-daily-rollup` `:119-124`, `resource-cap-alert` `:128-133`,
`resource-dashboard-comparison` `:137-142`,
`index-refresh-wikipedia` `:170-175`, `index-refresh-holdings`
`:179-184`.

**Trigger:** the Worker `tick` only. Goals are evaluated in
`onCron` (`src/agents/scheduled-agent.ts:1448` —
`isDue(goal.cron, goal.lastRun, now, goal.timeZone)`), and ticks
arrive via the Worker cron trigger, never via the SDK scheduler
(`src/agents/scheduled-agent.ts:383-397`). With the triggers
commented out (§1), **no goal in this table fires in the deployed
config**. They are armed, seeded, and evaluated — just never
ticked.

**Seed caveat — fresh deployments only.** "Stored goals are seeded
from this list only when storage is empty, so adding an entry here
does not inject it into already-running deployments — an operator
adds it via the schedule dashboard API" (`src/schedule.ts:79-82`).
Implementation: `getGoals()` writes `DEFAULT_SCHEDULES` only when
no stored goals exist (`src/agents/scheduled-agent.ts:490-495`).

**Quirk — `opportunity-hunt` never fires, deliberately.**
Without a `timeZone`, the `isDue` branch parses the hour with
`Number()` — `"*/6"` becomes `NaN`, so the goal is never due
(`src/schedule.ts:381-383`). The docstring above `isDue`
(`:364-368`) states it plainly: "That includes the
opportunity-hunt quirk: `0 */6 * * *` maps the hour through
`Number()` to `NaN` and is therefore NEVER due. The quirk is
deliberately preserved here, not fixed — fixing it would change
the firing behavior of a shipped goal." Its `enabled: true` is
nominal only. Fixing it — or giving it a time zone — is a
separate decision, not part of this inventory.

## 3. Queue consumers — declared in wrangler, one with no live routing

Declared in `wrangler.jsonc:74-102` (producers `:78-87`,
consumers `:88-102`). The Worker `queue()` entry point
(`src/server.ts:309-311`) routes batches through
`handleQueueBatch` (`src/server/routes/queue.ts:345`).

| Queue | Batch size | Batch timeout | Max retries | Dead-letter queue | Max concurrency | Handler | Live routing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `job-pipeline-events` | 10 | 30s | 3 | `job-pipeline-events-dlq` | 2 | `src/messaging/jobPipelineEventsConsumer.ts:55-62` (`JOB_PIPELINE_EVENTS_CONSUMER_CONFIG` — 10/30/3/2, DLQ `job-pipeline-events-dlq`); factory `createJobPipelineEventsHandler` (`:128`); routes terminal completions to the ScheduledAgent via `recordPipelineCompletion` | **NO — declared, no `queue()` branch.** `grep job-pipeline` in `src/server/routes/queue.ts` returns nothing. The handler module exists but is referenced in production code only as the destination (`recordPipelineCompletion`, `src/agents/scheduledTasksPipeline.ts:831`); its only import is the test `tests/feed_pipeline_host_3543.test.ts:51`. The wrangler comment (`:89-94`) itself says the consumer "arrives with its first handler" — that arrival has not landed in the Worker `queue()` routing at this base. |
| `screener-events` | 5 | 10s | 2 | `screener-events-dlq` | 1 | `src/messaging/screenerEventsConsumer.ts:56-62` (`SCREENER_EVENTS_CONSUMER_CONFIG` — 5/10/2/1, DLQ `screener-events-dlq`) | Yes — `queue.ts:438`, via `createScreenerEventsWorkHandler`. Carries `run-ledger.project` (issue #4116, `src/workflows/runLedgerQueueTransport.ts`) — the queue carrier's claim-check projection messages, applied by the shared projector; the consumer re-projection never re-publishes (no loop). |
| `screener-events-delivery` | 10 | not set | 3 | `screener-events-delivery-dlq` | 2 | `src/messaging/screenerEventsConsumer.ts:69-76` (`SCREENER_EVENTS_DELIVERY_CONSUMER_CONFIG` — 10/3/2, DLQ `screener-events-delivery-dlq`, no timeout — matches wrangler); delivery fan-out via `src/messaging/screenerQueueConsumer.ts:41` (`createScreenerQueueHandler`) | Yes — `queue.ts:388`, via `createScreenerQueueHandler` + `dispatchSubscriberBatch`. |

The consumer-config pins match wrangler exactly in all three
cases. The delivery consumer's missing `max_batch_timeout` is
not a mismatch — the pin carries no timeout either; the effective
timeout when unset is **not verified from code** (do not assume
the platform default).

**Producers** (`wrangler.jsonc:78-87`): `JOB_PIPELINE_EVENTS` →
`job-pipeline-events`, `JOB_PIPELINE_EVENTS_DLQ` →
`job-pipeline-events-dlq`, `SCREENER_EVENTS` → `screener-events`,
`SCREENER_EVENTS_DELIVERY` → `screener-events-delivery`,
`SCREENER_EVENTS_DLQ` → `screener-events-dlq`,
`SCREENER_DELIVERY_DLQ` → `screener-events-delivery-dlq`.

**What this means for §6:** the queue-publication leg of the
stage pipeline is not live end-to-end at this base, because the
one consumer that would carry stage completions
(`job-pipeline-events`) has no routing. The in-process
completion intake (`recordPipelineCompletion`) still records
completions; the queue hop in between does not run.

## 4. Think scheduled tasks and SDK cron rows (OrchestratorAgent)

These arm on the OrchestratorAgent instance itself
(`getScheduledTasks()`, `src/agents/orchestrator.ts:1352-1365`),
which returns only the observe tasks and the copilot tasks —
`{...observeTasks, ...copilotTasks}`. There is no strategy-scan
dispatch task declared here; the real scan is an Agents SDK cron
row, not a Think task.

| Task / row | Trigger | What it does |
| --- | --- | --- |
| Strategy scan — SDK cron row | Agents SDK cron `35 * * * *` (`STRATEGY_SCAN_CRON`, `src/agents/orchestrator.ts:233`; comment `:228-232`: hourly, minute :35, staggered off equity screens). Armed idempotently by `ensureStrategyScanSchedule` (`src/agents/orchestrator/scheduleMaintenance.ts:153-200` — `ctx.schedule(cron, "autonomousOptionsAnalysis", ...)` at `:195-198`), called from the `onStart` path (`src/agents/orchestrator.ts:1097`). | Dispatches the `autonomousOptionsAnalysis` SDK callback — a full-catalog Strategy/Symbol Scanner run. |
| `options-strategy-scan-observe` — Think task, observe-only | `STRATEGY_SCAN_OBSERVE_SCHEDULE = "every 1 hour"` (`src/agents/orchestrator/scheduledTasksObserve.ts:36,45-46`); declared by `declareStrategyScanObserveTasks` (`:115-131`). Phase is anchored at reconcile time, **not** :35. | Records occurrences to a capped ledger. It **NEVER dispatches the scan** (header `:11-20`; same note at `orchestrator.ts:1345-1351`). Do not mistake the observe task for the scan itself. |
| `stock-copilot-paper-cycle` — Think task | Declared by `declareStockCopilotTasks` (`src/agents/orchestrator/scheduledTasksCopilot.ts:432+`) **only when the master flag is on and the instance holds a login context**; task id `STOCK_COPILOT_TASK_ID` (`:82`). Handler runs `runStockCopilotCycleForInstance` via `recordScheduleCallbackRun` (`:304+`). | Runs one copilot cycle (`runStockCopilotCycle`, `src/services/stockCopilot.ts:712`). Cadence source: `resolveCopilotCadence` (`src/services/stockCopilotCadence.ts:79-110`) — precedence stored setting `stock_copilot:cadence` > env `STOCK_COPILOT_CADENCE` > default; `DEFAULT_STOCK_COPILOT_SCHEDULE = "every 30 minutes"` (`:15`), floor `PLATFORM_MINIMUM_CADENCE_MINUTES = 30` (`:16`) — finer values are coarsened to 30 minutes. `STOCK_COPILOT_SCHEDULE` is an alias (`scheduledTasksCopilot.ts:84`). The wrangler `STOCK_COPILOT_CADENCE` var is commented out, so the default applies unless a stored setting exists. |

**How to tell if the copilot is running** (the status surface,
not the trigger): `GET /api/stock-copilot/status`, read by the
Stock Copilot panel. It derives status from the instance's stored
state, not from a live process: `live` means a cycle actually ran;
`never_executed` means armed but zero cycles ever fired; `off`,
`paused`, `outside_enabled_sessions`, `inactive_broker`, and
`mode_unresolved` are the other states. Two fields separate the
failure modes: `lastCycleFiringAttempt` (whether the cycle handler
ever entered) and `lastCycleNotDeclared` (why the task was not
declared at all — `flag_off`, `no_login_context`, or
`context_error`). Gaps: no "cycle in flight right now" indicator,
and no copilot-specific health endpoint — both are #4138's scope.

## 5. Recurring SDK callbacks — sweeps and watchdogs

Armed by `scheduleEvery` on the OrchestratorAgent instance.
These are the parts of the runtime that keep firing while the
Worker crons are off, because they do not depend on a tick.

| Callback | Interval | Source | What it does |
| --- | --- | --- | --- |
| Stale-async-job sweep (#3784) | every 15 min | `STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS = 15 * 60`, `src/agents/orchestrator.ts:222`; armed by `ensureStaleAsyncJobSweepSchedule` (`:1788-1800`) via `scheduleEvery(..., "sweepStaleAsyncJobs", ...)`; method `sweepStaleAsyncJobs()` (`:1760-1762`) delegates to `src/agents/orchestrator/asyncJobs.ts:1206` | Sweeps `mas_async_jobs` rows stuck in `running`. This is the background sweeper the runbook used to say did not exist — see the `stuck-runs.md` correction in this change. |
| Missed-schedule watchdog (#3788) | every 15 min | `SCHEDULE_WATCHDOG_INTERVAL_SECONDS = STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS`, `src/agents/orchestrator.ts:226`; method `watchdogMissedSchedules()` (`:1768-1773`), armed by `ensureScheduleWatchdogSchedule` (`:1775-1787`); core in `src/agents/orchestrator/scheduleWatchdog.ts:102` | Detects scheduled tasks that should have fired and did not. |
| Stale-ledger sweep | every 6 h | `STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60`, `src/agents/orchestrator.ts:217`; `scheduleEvery(..., "sweepStaleLedgerTasks", ...)` at `:1317`; method at `:1243` | Sweeps stale ledger task rows. |

**Thresholds (not intervals):**

| Threshold | Value | Source |
| --- | --- | --- |
| Stuck-run alert | 30 min | `DEFAULT_STUCK_RUN_ALERT_THRESHOLD_MS = 30 * 60 * 1000`, `src/config/stuckRunAlert.ts:25`; env `STUCK_RUN_ALERT_THRESHOLD_MINUTES` (`0` disables the alert). One alert per job (guarded `stuck_alerted_at` stamp); audit `async_job.stuck_detected` → `async_job.stuck_alert` / `async_job.stuck_alert_failed`. |
| Stale-running reap | 2 h | `STALE_RUNNING_REAP_MS = 2 * 60 * 60 * 1000`, `src/agents/orchestrator/asyncJobs.ts:1009`. A job still `running` after 2h is marked `failed` with a "stale running job reaped" error, by the read path itself. |
| Missed-schedule grace | 60 min | `DEFAULT_MISSED_SCHEDULE_GRACE_MS = 60 * 60 * 1000`, `src/config/missedScheduleAlert.ts:27`; env `MISSED_SCHEDULE_GRACE_MINUTES`. |

## 6. Stage jobs — triggered, not crons

The five pipeline stages (`src/services/feedJobs.ts`,
`enrichJobs.ts`, `analyzeJobs.ts`, `generateJobs.ts`,
`deliverJobs.ts`). No stage is a cron. Each stage consumes its
upstream's persisted output, does its work, stores its output
durably, and signals completion; the next stage is dispatched
when that completion is recorded.

| Stage | Trigger |
| --- | --- |
| Feed | Think pipeline tasks — one `pipeline-job:` task per feed job (monthly), dispatched via `dispatchScheduledPipelineJob` (`src/agents/scheduledTasksPipeline.ts:650`, declared `:780+`); also direct via the MCP door `runFeedJobViaDoor` (`src/agents/orchestrator/meshDoors.ts:456`). Pulls one provider dataset through the provider port and persists to the feed-dataset store (header `src/services/feedJobs.ts:1-35`). |
| Enrich | Consumer of its feed job — the host dispatches it when the feed job's completion is recorded (per `src/services/enrichPipelineJobs.ts` header); independently dispatchable via MCP door `runEnrichJobViaDoor` (`meshDoors.ts:635`). |
| Analyze | Consumer of its enrich job, dispatched when the enrich completion is recorded (per `src/services/analyzePipelineJobs.ts` header; `runAnalyzeJob` at `src/services/analyzeJobs.ts:674`); MCP door `runAnalyzeJobViaDoor` (`meshDoors.ts:759`). |
| Generate | Consumer of its analyze job, dispatched when the analyze completion is recorded (per `src/services/generatePipelineJobs.ts` header); MCP door `runGenerateJobViaDoor` (`meshDoors.ts:883`). |
| Deliver | Consumer of its generate job, dispatched when the generate completion is recorded; completions dispatch nothing (per `src/services/deliverPipelineJobs.ts` header; `runDeliverJob` at `src/services/deliverJobs.ts:665`); MCP door `runDeliverJobViaDoor` (`meshDoors.ts:1007`). |

**Caveat, stated honestly:** the completion intake found in
code, `recordPipelineCompletion`
(`src/agents/scheduledTasksPipeline.ts:831-849`), only *records*
the completion (capped list — "the subscription surface
downstream stages read their upstream's persisted hand-off
from"). No automatic completion→dispatch call chain was found in
the files read for this inventory — downstream dispatch is
asserted by the `*PipelineJobs.ts` headers and the Think-task
dispatch (`dispatchScheduledPipelineJob`), not by a visible
completion→dispatch chain. Combined with §3 (the
`job-pipeline-events` consumer has no live routing), the
queue-publication leg of the trigger chain is not live
end-to-end at this base. The stage producer/consumer pub/sub
model itself is #2870's scope; this inventory records the
current state, it does not redesign it.

## 7. Always-on surfaces

| Surface | State |
| --- | --- |
| `email()` handler | Live. `src/server.ts:290-301`: first tries `routeAgentChannelEmail(message, env)` — agent-addressed mail (`<agent>+<instance>@<domain>`) routes via the SDK's `routeAgentEmail` to the addressed PortThink instance's `onEmail`; every other message falls through to `handleCloudflareEmailMessage` (the existing NLQ handler). |
| SandboxAgent container | **Not provisioned.** `wrangler.jsonc:150-160`, #4112: "the deployment provisions NO container. The block below is commented out, not deleted — uncomment it to restore the binding exactly as it was. If it is restored, cap it: `max_instances: 1`, `instance_type: lite` (one instance, smallest size — the only shape that may ship)." `FEATURE_SANDBOX` is `"0"` for the same reason (vars section). The `SandboxAgent` Durable Object binding itself still exists; only the container is unprovisioned. |
| Workflows (Cloudflare Workflows bindings) | Declared, on-demand only. `wrangler.jsonc` `workflows`: `trading-trade-workflow`, `screener-screen-workflow` (explicitly NO schedule per #4112 — "the workflow binding stays so an on-demand run still resolves; to schedule it again, add `schedules`"), `payment-workflow`, `saga-workflow`, `job-pipeline-workflow`. Nothing in this list fires on its own. |
| Durable Object instances | Created on first use per login/instance; their Think tasks and `scheduleEvery` callbacks (§4, §5) arm at that point, not at deploy. |

## 8. Stock Copilot — full supported-values catalog

Research: main `3688fd4b`, 2026-11-11; re-verified against current
main at build time (anchors below). This section lists, for EVERY
copilot variable, the full supported values — not just the default —
plus where the default lives, how to change it through each channel
(exact chat prompt, panel control, API/MCP payload, env var), how
to restore the default, and out-of-range behaviour.

**Census note (read first):** this file is new, so it has no rows
in the #3525 shrink-only census baseline — any provider-brand
string in it fails the pin. The two broker literals are therefore
not repeated here; they live in #4134 (on GitHub, outside the
censused trees) and in the code registries. Where a value below
says "the paper broker" or "the three catalog broker ids", the
literal is in #4134. See §11.

**Precedence, everywhere:** per-login `mas_settings` value >
env var > code default. There is NO `deleteSetting` /
`clearSetting` anywhere in `src/` — a stored value can only be
overwritten, never deleted. "Restore default" therefore means
overwriting with the default value (or writing `""` where the
parser treats blank as absent — cadence is the exception: empty
string is rejected).

**Channel coverage:** chat (all 13 control fields via
`stock_copilot_control`, `src/agents/registry.ts:883`) > REST
`POST /control` (only `paused`, `sessions`, `cadence`,
`executionMode`, `universe`, `strategies`, `channels` — strict
400s) > panel (pause toggle + session checkboxes only;
cadence/universe/strategies/mode display-only; no reset/defaults
control) > env. There is no dedicated settings parser in chat —
the model interprets free-form requests and calls
`stock_copilot_control`.

### Master switch — `STOCK_COPILOT_PAPER_ENABLED`

- Supported values: `"1"` / `"true"` / `"on"` (case-insensitive,
  trimmed) = ON; anything else, including absent, = OFF.
- Default: **OFF** (code). Deployed config: **ON** — declared
  `"1"` in `wrangler.jsonc:310` (vars, #3413 comment: "the
  pattern-driven paper-trading loop from #3391 is ON in
  production. Paper-only by construction — its guard refuses any
  live configuration — and it declares itself only on instances
  holding a screener execution context"). The repo cannot confirm
  the live account's effective value — that is #4137's first
  question.
- Change: env only — no chat/panel/API path. Flag-off instances
  declare nothing and run no cycles (§4).
- Restore: remove the env var (and redeploy).

### Cadence — `stock_copilot:cadence` / `STOCK_COPILOT_CADENCE`

- Supported values: `"every X minutes"`, `"every X hours"`,
  `"Xm"` / `"Xmin"`, `"Xh"` / `"Xhr"`, integer X > 0. No cron,
  no seconds.
- Default: `"every 30 minutes"`
  (`DEFAULT_STOCK_COPILOT_SCHEDULE`,
  `src/services/stockCopilotCadence.ts:15`). Finer values clamp
  to 30 effective (the configured value is preserved; status
  reports both configured and effective). Floor:
  `PLATFORM_MINIMUM_CADENCE_MINUTES = 30`
  (`stockCopilotCadence.ts:16`). Resolver precedence: stored
  setting > env > default (`:79-110`).
- Change: chat — "Set loop interval to 1 hour". Panel: display
  only. Env: `STOCK_COPILOT_CADENCE` (the wrangler var is
  commented out, so the default applies unless a stored setting
  exists).
- Restore: write `"every 30 minutes"`. Empty string is rejected
  (door throws, REST 400).
- Out of range: unparseable input → door throws / REST 400, and
  the resolver falls back to the default.

### Loop execution mode — `stock_copilot:execution_mode` / `STOCK_COPILOT_EXECUTION_MODE`

- Supported values: `deterministic` (alias `fixed`), `agentic`
  (aliases `non_deterministic`, `nd`), case-insensitive.
- Default: `deterministic`. Deterministic runs the fixed pattern
  loop; agentic runs perceive → plan → critic → execute → learn,
  with the critic validating intents against deterministic risk
  constraints.
- Change: chat — "switch loop execution mode". Setting, env, and
  the control field `executionMode` all accept it.
- Out of range: an unknown value silently falls back to
  deterministic. Via MCP the match is case-sensitive exact — an
  exact-match failure is silently ignored (`"Agentic"` via MCP is
  ignored, while the setting parser would accept it).
- Broker interaction: the agentic loop refuses a broker other
  than the default paper broker with `inactive_broker` unless
  `STOCK_COPILOT_BROKER_NEUTRAL=true`
  (`src/services/stockCopilotAgenticLoop.ts:207`); the
  deterministic loop accepts any catalog broker.

### Chat execution mode — `stock_copilot:chat_execution_mode` / `STOCK_COPILOT_CHAT_EXECUTION_MODE`

- Supported values: `hitl`, `autonomous` only.
- Default: `hitl` (unless autopilot is running, then
  `autonomous`).
- Change: chat — "switch chat execution mode between 'hitl' and
  'autonomous'". No REST field, no panel control.
- This is approval mode, NOT sync/async (see "Sync vs async"
  below).

### Broker + mode

- Supported values: the three catalog broker ids (literals in
  #4134 and in the broker registry in code; not repeated here —
  see the census note at the top of this section). All three are
  copilot-supported.
- Default: paper trading on the tenant's selected broker (the
  platform default broker is the paper broker — literal in
  #4134). Broker comes from the tenant's stored selection; there
  is no copilot-private control.
- Mode resolution: the broker's environment setting (TEST/PROD)
  → `STOCK_COPILOT_MODE` → the broker trading-type env var →
  TEST. Live is never a default.
- Refusals: an unresolvable store read → the cycle refuses with
  `mode_unresolved`; a mode mismatch → `refused_mode_mismatch`
  unless `STOCK_COPILOT_STRICT_MODE_GUARD=false` or
  `STOCK_COPILOT_AUTO_ALIGN_MODE=true`
  (`src/services/stockCopilot.ts:788-800`). No named refusal
  exists for a broker with no credentials — quote/placement tools
  fail with the broker error and chat surfaces the connect URL.

### Sessions — `stock_copilot:sessions` / `STOCK_COPILOT_SESSIONS`

- Supported values: `pre_market` 04:00–09:30,
  `regular` 09:30–16:00, `after_hours` 16:00–20:00,
  `exto` 20:00–04:00 ET, Sunday–Thursday nights. Tokens `all` /
  `*` / `around_the_clock` / `24/7` / `continuous` → all four;
  `none` → the empty set (an explicit decision).
- Default: all four.
- Env overrides: `STOCK_COPILOT_IGNORE_SESSIONS` /
  `FORCE_ALL_SESSIONS` / `AROUND_THE_CLOCK` = `"true"` all force
  all four (`src/services/stockCopilotSessions.ts`, `src/types.ts`).
- Change: chat — "Enable pre-market and overnight sessions".
  Panel: per-session checkboxes. REST: any invalid id → 400,
  nothing written. MCP: invalid id → zod error; `"all"` in an MCP
  array is dropped as an invalid id.
- Door (direct): invalid ids are silently dropped; `[]` or
  all-invalid writes `"none"` (all sessions off — NOT the
  default).
- Order shape: `regular` = MARKET; every other session is
  LIMIT-only at the cycle's reference price.

### Universe — `stock_copilot:universe` / `STOCK_COPILOT_UNIVERSE`

- Supported values: presets `NASDAQ100`, `SP100`, `SP500`,
  `DOW`, `MEGA_TECH`, `SEMIS` (matched case/`-`/`_`/
  space-insensitively); or a custom list as a JSON array or a
  comma/semicolon/whitespace-separated list, deduped and
  uppercased.
- Default: SPY, QQQ, AAPL, MSFT, NVDA.
- Labelled fallbacks when stored membership is missing, stale, or
  empty: NASDAQ100 → 12 symbols, SP100 → 12, SP500 → `["SPY"]`,
  DOW → `["DIA"]`.
- Change: chat — "Set the trading universe to S&P 500 and top
  pre-market volume movers". Panel: display only.
- Restore: write `""` — the parser returns and writes the
  default list.
- Out of range: empty or invalid input falls back to the default
  list, never an error. No maximum list length found in code.

### Strategies — `stock_copilot:strategies` / `STOCK_COPILOT_STRATEGIES`

- Supported values: exactly four sandbox ids —
  `sma_crossover`, `rsi_reversal`, `mean_reversion`, `breakout`
  (`src/services/patternSignals.ts:35-46`).
- Default: `sma_crossover, mean_reversion`.
- `"all"` / `"*"` → all four. Unknown ids are silently dropped;
  if none survive, the default two are used.
- Change: chat via `stock_copilot_control{strategies}`; MCP and
  REST accept a string, an array, or `"all"`; panel is display
  only.
- Restore: write `""` or the two defaults.

### RSI mode — `stock_copilot:rsi_mode` / `STOCK_COPILOT_RSI_MODE`

- Supported values: `governed` (aliases `governed-rsi`,
  `hitl`), `self` (aliases `autonomous`, `self-rsi`),
  case-insensitive.
- Default: `governed`.
- Change: chat — "Set RSI mode to self" / "Set RSI mode to
  governed". No REST field, no panel control.
- Out of range: an unknown value silently falls back to
  `governed`.

### Stop-loss / take-profit — NOT configurable

- Hard-coded constants: stop-loss 5%, take-profit 10%
  (`COPILOT_STOP_LOSS_PCT = 5`, `COPILOT_TAKE_PROFIT_PCT = 10`,
  `src/services/stockCopilot.ts:133-134`, used at `:496-497`).
- No setting, env var, or control field exists, and 0 / null /
  disabled is not a supported value. The "+4% TP / −2% SL"
  figures in chat are per-order bracket percentages on
  preview/place calls, not the cycle's exit plan.

### Pause — `stock_copilot:paused`

- Supported values: `true` / `false`. Default: `false`.
- Change: chat — "Pause the Stock Copilot trading loop" /
  "Resume the Stock Copilot trading loop" / "Pause trading until
  9:30 AM". Panel: pause toggle.
- Paused cycles still evaluate exits — a pause never suspends
  exit management.

### Pause-until — `stock_copilot:pause_until`

- Supported values: free-form string (e.g. `'9:30 AM ET'` or an
  ISO timestamp). MCP only — no REST field, no panel control.
- **GOTCHA: written by the door and read only for display — no
  cycle code consumes it.** The door writes it
  (`src/agents/orchestrator/meshStockCopilotDoor.ts:567-575`);
  the only reads are for display (`:775`, `:792`, and
  `src/services/stockCopilotIntrospection.ts:437`). A timed pause
  therefore stays paused until someone resumes it.
- Restore: resume (`paused:false`); the stale `pause_until`
  value is inert.

### Autopilot running / kill-switch (door state)

- Supported values: `autopilotRunning: boolean`,
  `killSwitch: boolean`, `killSwitchReason: string` (≤200 chars).
- Defaults: running `false`, killSwitch `false`, reason `null`.
- Change: chat ("enable/disable 24/7 Autopilot", kill-switch)
  and MCP only. `killSwitch:true` also pauses the loop.

### Autopilot limits

- Supported values: `maxPositionPct` (default 10),
  `cashReservePct` (5), `ordersPerDay` (10),
  `drawdownAlertPct` (20), `universe` ("Default large caps/ETFs"),
  `riskProfile` moderate (`conservative` / `moderate` /
  `aggressive`), `universeSymbols` null.
- MCP only, merged over the current limits (not replaced).
- Out of range: out-of-range values are clamped, never rejected.

### Channels — `copilot_channels:stock` / `COPILOT_CHANNELS`

- Supported values: `chat`, `webhooks`, `email`, `slack`,
  `voice`.
- Defaults: chat true, webhooks false, email false, slack false,
  voice true. Env: `COPILOT_CHANNELS`
  (`src/services/copilotChannels.ts:108`; entries
  `"<registration>:<channel>=on|off"`). Precedence: stored >
  env > default.
- Change: REST `{channels:{...}}` (whole-map validated; unknown
  channel or non-boolean → 400). The panel never calls the
  setter — no channel UI.

### Mode-guard overrides (env only)

- `STOCK_COPILOT_STRICT_MODE_GUARD=false`,
  `STOCK_COPILOT_AUTO_ALIGN_MODE=true`,
  `STOCK_COPILOT_BROKER_NEUTRAL=true`,
  `STOCK_COPILOT_BROKER_ID=<brokerId>`.
- No chat, panel, REST, or MCP path.

### Sync vs async — NO switch exists

Not in chat, config, env, or code (re-verified 2026-11-11 on main
`3688fd4b`; the only "sync" hits are the synchronous universe
preset parser, the role label "Bulk universe feed
synchronization", and the prompt's Synchronous Execution
Invariant — which means trading tools execute synchronously and
must not be polled via async-job tools, not a mode you can
change). The nearest real switch is chat execution mode (`hitl`
vs `autonomous`) — approval, not sync/async. That config is
#4136, unbuilt.

### Canonical quick-chip prompts

`src/client/chat/copilotRegistry.ts`, "stock" registration
(`:197-321` — the file lives under `src/client/chat/`, not
`src/agents/`):

- "Set loop interval to 1 hour" · "Enable pre-market and
  overnight sessions" · "Pause trading until 9:30 AM" · "Pause
  the Stock Copilot trading loop" · "Resume the Stock Copilot
  trading loop" · "Set RSI mode to self" · "Set RSI mode to
  governed" · "Set the trading universe to S&P 500 and top
  pre-market volume movers" · "What is the Stock Copilot doing
  right now and what happened in the latest cycle?" · "Show all
  open positions and their take-profit / stop-loss exit plans" ·
  "Evaluate NVDA against all active trading strategies without
  placing orders".

## 9. Health, observability, and error reporting — what exists today

### Health endpoints — static, nothing probed

`GET /health` and `GET /api/health` return a static JSON payload
(`handleCoreHealthRoutes`, `src/server/routes/core.ts:99-113`):

```json
{
  "status": "healthy",
  "service": "cfagent-multi-agent-studio",
  "version": "1.0.0",
  "timestamp": "<now>",
  "environment": "<from x-environment header or ?env>",
  "runtime": "cloudflare-workers",
  "telemetry": {
    "durableObjects": "healthy",
    "mcp": "available",
    "apiFirst": true,
    "fifteenFactorCompliant": true
  }
}
```

Every field except `timestamp` and `environment` is a literal.
Nothing is probed — a `200` here proves the Worker answers, not
that any agent, queue, schedule, or store is healthy. Do not use
it as a readiness signal. A real health surface is #4138's scope.

### Workers Logs — the floor, not the ceiling

`wrangler.jsonc:231-240` (#4131, owner direction — "the LOWEST
observability setting that still records something"):

- `enabled: true`, `head_sampling_rate: 0.01`,
  `logs.invocation_logs: true`, `logs.head_sampling_rate: 0.01`,
  `logs.persist: false`.
- 0.01 is the platform floor: 1% of invocations sampled.
  `persist: false` keeps logs streaming without storing them.
  To silence it entirely, set `enabled: false` — that is the
  only lower step.
- Analytics Engine dataset `OBSERVABILITY` (`"observability"`,
  #1743, `wrangler.jsonc:51`); unbound, it degrades to local
  logging and never fails the request.

**Stale doc:** `docs/OBSERVABILITY.md:13,20,88` still shows
`head_sampling_rate: 1` (100% sampled). That contradicts
`wrangler.jsonc` (0.01). The doc is stale on that point; the
config value governs. Correcting `docs/OBSERVABILITY.md` is
not part of this inventory change — it needs its own slice
(and its own census check).

### Error reporting — there is no vendor

No Sentry, Datadog, Honeycomb, OpenTelemetry, Axiom, or Logpush
integration exists in `package.json` or `src/`. The Worker's
error boundary, `withErrorBoundary`
(`src/security/workerErrorBoundary.ts:66-70`, wired at
`src/server.ts:289`), defaults to `console.error` — errors
surface in Workers Logs (1% sampled, streaming only, not
stored) and nowhere else. There is no alerting pipeline on top
of it. Aligning this with modern cloud observability (logging,
metrics, traces, error reporting under a defined architecture)
is the follow-up the parent issue orders; this inventory records
the current state so that follow-up starts from facts.

### Audit events

Runs already emit audit events at transitions (e.g.
`async_job.stuck_detected`, `async_job.stuck_alert`,
`async_job.stuck_alert_failed` for the stuck-run path, §5;
`stock_copilot.control_pause_until_via_door` for the copilot
door, §8). There is no single audit catalog in this inventory —
the audit history's shape and coverage belong to the
observability follow-up (#4138 and the parent issue's
modern-cloud alignment slice).

## 10. What only the live environment can confirm

The repo cannot answer these; do not state them from this doc:

- Whether `STOCK_COPILOT_PAPER_ENABLED` is effectively set in
  the live deployment (declared `"1"` in `wrangler.jsonc`
  vars; the live account's effective value is #4137's first
  question).
- Anything about the live deployment's actual running state:
  which cycles fired, DLQ depths, which goals are seeded in a
  given tenant's store, whether the service user is provisioned
  for the platform tier.
- The `/health` payload semantics — static, so there is nothing
  to confirm live beyond reachability.

## 11. Why provider-brand names are absent from this file

The #3525 shrink-only census pin
(`tests/neutrality_census_3525.test.ts`) holds the repo's
provider-brand mentions shrink-only against a baseline seeded
from main `89f6df7` (2026-11-07): a file×term row not in the
baseline fails, and a row whose count exceeds its baseline fails.
This file is new, so it has no baseline rows — any brand string
in it fails the pin. The broker literals are therefore carried
in #4134 (on GitHub, outside the censused `src/` / `docs/` /
`wrangler.jsonc` / `README.md` trees) and in the code registries,
and this doc gives the count, the default, and the source of
truth instead. That is the census programme's own rule for a new
PLATFORM row: neutralize instead of baselining. If a future
slice needs the literals in this file, it must add the baseline
rows with a disposition and a reason, stated in that PR — not
silently.

## 12. Deliberately not doing

- No code changes to any schedule, cadence, or default —
  inventory only. Any default that looks wrong gets its own
  `[Out-of-Scope]` sub-issue, not a silent change here.
  (Candidates already visible while writing: the
  `opportunity-hunt` never-fires quirk, the `job-pipeline-events`
  consumer with no live routing, the `pause_until` write-only
  gotcha, the static `/health` payload, the 1% log sampling
  floor, and the missing error-reporting vendor. None of them is
  fixed here.)
- No live-deployment probing from this issue.

## Sources

Verified against main `0d38800f`, 2026-11-11. Prior research
folded in: the runtime inventory research (main `0981ea11`) and
the supported-values catalog research (main `3688fd4b`), both
recorded in #4134; the #4112 / #4131 corrections verified
against current main before writing. Key files:
`wrangler.jsonc`; `src/schedule.ts`;
`src/agents/scheduled-agent.ts`; `src/server.ts`;
`src/server/routes/queue.ts`;
`src/services/consolidatedCronEntries.ts`;
`src/messaging/jobPipelineEventsConsumer.ts`,
`screenerEventsConsumer.ts`, `screenerQueueConsumer.ts`;
`src/agents/orchestrator.ts`,
`src/agents/orchestrator/scheduleMaintenance.ts`,
`scheduledTasksObserve.ts`, `scheduledTasksCopilot.ts`,
`scheduleWatchdog.ts`, `asyncJobs.ts`;
`src/config/stuckRunAlert.ts`, `src/config/missedScheduleAlert.ts`;
`src/services/feedJobs.ts`, `enrichJobs.ts`, `analyzeJobs.ts`,
`generateJobs.ts`, `deliverJobs.ts` (+ `*PipelineJobs.ts`);
`src/services/stockCopilot.ts`, `stockCopilotCadence.ts`,
`stockCopilotSessions.ts`, `stockCopilotAgenticLoop.ts`,
`stockCopilotIntrospection.ts`, `patternSignals.ts`,
`copilotChannels.ts`; `src/client/chat/copilotRegistry.ts`;
`src/agents/registry.ts`; `src/agents/orchestrator/meshStockCopilotDoor.ts`;
`src/security/workerErrorBoundary.ts`;
`src/server/routes/core.ts`; `docs/OBSERVABILITY.md`;
`tests/neutrality_census_3525.test.ts`.
