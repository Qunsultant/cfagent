# Screener-chain stuck repair (#3787)

Sub-issue of incident #3781 (chat copilot invented an order price
while quote jobs were still running). This slice audits and repairs
the stock screener workflow — all five J1–J7 stages as applied to
screening — for the two failure modes the owner named: jobs that get
STUCK (Running, no end, no alert) and jobs that do NOT WORK AT ALL
(never run, silently fail, produce nothing).

## Per-stage audit: supposed vs actual vs where the gap closed

| Stage | Supposed to do (§10.2) | Actually does today (verified on main `a1234aa`) | Where the gap closed |
|---|---|---|---|
| Feed (J2) | Ingest NASDAQ-100 / S&P 100 / Yahoo fundamentals / Alpaca quotes; persist the platform's local copy | Feed jobs exist and run through the pipeline control plane (`yahoo/alpaca/etrade/public-nasdaq100-quotes` + fundamentals, `src/services/feedJobs.ts`); triggerable via the `run_feed_job` MCP tool. The control-plane definitions carry enabled `every 60 minutes` schedules, but `DEFAULT_SCHEDULES` (`src/schedule.ts`) had NO feed goal — no goal-tick execution with a visible run record existed | **Closed here**: `feed-refresh` goal in `DEFAULT_SCHEDULES` (`feed.refresh_all`, hourly, UTC) + the `feed.refresh_all` tick branch in `ScheduledAgent.onCron`, dispatching every feed job through the control plane's own scheduled-firing seam (`dispatchScheduledPipelineJob`). See "Feed goal mechanics" below |
| Enrich (J3) | Compute technicals (RSI, SMA, MACD, Bollinger, ATR) over the persisted feed | The enrich job reads the PERSISTED feed dataset and computes its elements; a missing input refuses by name (`ENRICH_INPUT_MISSING`, fail-closed — the failed run is recorded on the enriched store, never a silent empty success) | **Already closed in the engine; proven here**: `tests/screener_chain_stuck_3787.test.ts` runs the enrich job with an empty feed store and pins the `ENRICH_INPUT_MISSING` failure in the run outcome and the run record. No engine change was needed |
| Analyze (J4) | Apply screening criteria & filter rules | The analyze job derives from the enriched copy; a missing input refuses by name (`ANALYZE_INPUT_MISSING`, same fail-closed pattern as enrich) | **Already closed in the engine** (same pattern as Enrich; the chain test below proves the halt propagates end-to-end) |
| Generate (J5) | Assemble candidate stock matches + thesis cards | The generate job renders from the analyzed copy; the chain composes it after Analyze | **Already closed in the engine** (same composition; see the chain test) |
| Deliver (J6) | Route candidate lists to Chat UI, Slack, email | The deliver job delivers the generated reports to the configured channels; the screen result reaches chat via the door's read-back + chat | **Already closed in the engine** (the settled-chain test runs the full lineage end-to-end, including deliver) |
| J7 composition | Compose feed→enrich→analyze→generate→deliver as one schedulable, checkpointed chain | The chain exists (`runPipelineChain` via the mesh door; chain definitions in `src/services/pipelineChains.ts`) and the live screen path STILL does not invoke it — the live path runs `ScreenerScreenWorkflow` through the mesh door. The Phase 2 migration (moving the copilot loop + screening onto J1–J7, §10.4.4) is NOT this slice: the audit proves the smaller repair below closes every named failure mode without it | **Closed here (stuck + visibility)**: chain runs are bridged into `mas_async_jobs` (see "The run bridge"); a chain run with missing feed data fails visibly with the named coded error in the run outcome, the chain surface view, and the bridge row (see "Missing feed data") |

## The run bridge

The ONLY stuck mechanism in `src/` is the #3784 sweep over
`mas_async_jobs` rows (`sweepStaleAsyncJobs`: 30-min stuck alert,
2h reap). WorkflowPort runs and pipeline-chain runs had no stuck
detection at all. The bridge (`src/agents/orchestrator/runBridge.ts`)
closes that gap with NO second sweep and NO new substrate:

- The mesh screen door (`runStockScreenViaDoor`) inserts + claims a
  `running` row for the screen run (capability `screener.run`, row id
  = the screener job id) immediately after the workflow starts, and
  settles it from the door's own verdict when a terminal state is
  observed (collation or terminal workflow status): completed on
  success, failed with the result's error otherwise.
- `runPipelineChainViaDoor` does the same for chain runs
  (capability `pipeline.chain`, row id `chain:<chainJobId>:<iso>:<rand>`)
  when the caller supplies a bridge handle; `RunPipelineChainCommand`
  builds it from the tool context's own store + session id.
- A run whose await never settles leaves its row `running`: the
  #3784 sweep alerts at 30 min and reaps at 2h. The door's
  await-deadline return deliberately does NOT settle the row.
- Best-effort by construction: a bridge that cannot write never
  fails the run. No execution is ever scheduled for a bridge row
  (insert + claim directly through the queue port, never
  `submitAsyncJob` — the door already owns the run). The payload
  carries no `chain` key, so the already-running gate
  (`hasActiveChain`) can never match a bridge row. Retention rides
  the existing submit-time prune (500 terminal rows per session).

## Missing feed data

Verified, not assumed: a chain run whose feed stage fetches nothing
fails at the feed frontier with the named code
(`FEED_NO_QUOTES_RETURNED`), and the enrich stage refuses by name
(`ENRICH_INPUT_MISSING`) when no usable persisted dataset exists.
Both are pinned end-to-end in
`tests/screener_chain_stuck_3787.test.ts`: the door returns
`state: "failed"` with the code in `error`, `get_pipeline_chain_status`
reports `frontier: "feed"` with `lastError` naming the code, and the
bridge row is `failed` with the same error. Never
completed-with-no-output.

## Feed goal mechanics

- The `feed-refresh` goal fires on the existing `*/30` tick; no new
  scheduler, no new wrangler cron triggers. The branch dispatches
  every feed job in catalog order through
  `dispatchScheduledPipelineJob` (the same dispatch a Think scheduled
  firing makes). A dispatch that throws `job_already_running` is
  recorded as `running`, not a failure — the dataset is being
  produced by the in-flight run.
- `lastRun` is NEVER stamped by this branch: `isDue`'s 23h guard
  would suppress the next hourly firing (the
  `resource.cap_alert` precedent). Hourly dedup lives in the goal's
  latest run record (`getLatestJobRun`): a successful dispatch
  within the last 55 minutes is a deduped no-op. A failed dispatch
  records failure and stays due, so the next tick retries; a
  partial dispatch records success with its failures named as tick
  errors (the index-refresh precedent).
- `DEFAULT_SCHEDULES` only seeds fresh deployments. **Operator step
  for the running deployment**: add the goal via the schedule
  dashboard API (the #1819 pattern) — `POST /api/schedule/goals`
  with the seeded definition (`id: "feed-refresh"`, `operation:
  "feed.refresh_all"`, `cron: "0 * * * *"`, `timeZone: "UTC"`,
  `budgetCents: 1`, `enabled: true`) — or the equivalent Settings →
  Scheduled goals add. Until the operator adds it, the running
  deployment's feed jobs run only on their control-plane interval
  schedules and the goal's run records stay absent, which is itself
  the visible signal (no `feed-refresh` run record = goal not
  installed).

## remediatePlatformGaps: false success removed

`remediatePlatformGaps` (`src/services/stockCopilotIntrospection.ts`)
reported success for work it never did: the no-env branch claimed
the chain was "validated across all 5 stages… queued and
processing" without executing anything, and steps 2–4 claimed
cleared locks / verified payment tools / affirmed cadence without
checking anything. Now: the no-env branch reports `skipped` with
`pipelineStatus: "not_run"`; steps 3–4 report `skipped` (not-run,
not verified); step 2 reports `skipped` when no SQL handle is
available, and when one is available it runs main's 5-minute
stagnant-job auto-heal and reports honestly what it did (reaped
count, or that no job was past the threshold) — success only when
the ledger was actually read; a chain run that fails reports
`failed` with its error; and `remediated` is true only when at
least one action actually succeeded. No underlying verification was
built here — that is separate work, not silent success.

## Known limitations (recorded, not hidden)

- A chain run that returns `paused` leaves its bridge row
  `running`: `mas_async_jobs` has no paused status, so the sweep
  will alert it as stuck at 30 min and reap it at 2h. Pausing is
  an explicit operator action, and the alert names the run, so
  this is visible rather than silent — but a long-paused chain
  run's bridge row will read `failed` after the reap even though
  the chain itself is only paused.
- The live screen path still runs `ScreenerScreenWorkflow`, not
  the J1–J7 chain (§10.4.4 Phase 2 migration is out of scope for
  this slice). Stuck coverage for the live path comes from the
  bridge, not from migrating the path.
- The feed jobs' control-plane interval schedules (`every 60
  minutes` on the definitions) and the new goal can both dispatch
  the same feed job; the second dispatch while one runs refuses
  with `job_already_running`, which the goal branch records as
  `running`, not a failure.

## Status surface

No new job-tracking substrate. The status surfaces stay the J1–J7
tools (`get_feed_job_status`, `list_feed_jobs`,
`get_pipeline_chain_status`) plus the jobs list/get over
`mas_async_jobs` (bridge rows read as ordinary `screener.run` /
`pipeline.chain` jobs, with the stuck flag + alert on the row).

#CISO-bhdm
