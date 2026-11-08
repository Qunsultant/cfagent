# Async-job staleness sweep (#3784)

Parent incident: #3781 (the six workflow runs stuck `Running` on
2026-11-08 ~10:29 EST: MCP preview-order `09d862f5`, MCP
market-data quote `506bd6e7`, MCP quote `761f3471`,
and three POST `/environment/switch` jobs `342ba7f2` / `cdf703f4` /
`316bfe5a`, all still `Running` at 11:22 EST — full capability
names on #3784, comment 6724682943).

## The gap it closes

The stuck-running alert (#2567: `maybeAlertStuckRunning`, 30-min
default threshold) and the stale-running reap (2h backstop) fire only
inside `getAsyncJob` — a per-job read. The Workflow runs list reads a
direct SQL projection (`readWorkflowRunJobs` → `workflowRunRows`) and
never calls `getAsyncJob`; shard reconcile skips non-terminal rows;
`recoverQueuedAsyncJobs` re-arms `queued` rows only. A row whose
executor claims it and then stalls (isolate death/hibernation
mid-await, or a downstream await that never resolves) has no path to
a terminal state. All six incident jobs were claimed within the same
minute — consistent with a single executor stall, not six
independent hangs. The production cause for the six rows is not
observable from this lane; the sweep closes the structural window.

This supersedes the decision in
`docs/operations/runbook/stuck-sweeper-decision.md` (#2000, "NO
background sweeper"): that decision's G1 reopen trigger — unread
stuck rows observed at volume — fired on 2026-11-08 (six rows,
~53 min unread, no alert, no reap). The read path stays as-is; the
sweep is the second detection path, not a replacement.

## The sweep

- **Function:** `sweepStaleAsyncJobs(ctx, nowMs?)` in
  `src/agents/orchestrator/asyncJobs.ts`. Lists the session's
  `running` rows via the new additive read-port method
  `AsyncJobReadPort.listRunning(sessionId, limit)` (SQL kept as data
  in `LIST_RUNNING_SQL`, `src/data/asyncJobPorts.ts`, implemented in
  `src/data/doSqliteAsyncJobAdapter.ts` and
  `src/data/inMemoryAsyncJobAdapter.ts`), capped at 100 rows/tick,
  oldest first. The query plan is pinned by
  `tests/stale_async_job_sweep_3784.test.ts` (seeks on
  `idx_mas_async_jobs_session_created`, never scans the table).
- **Per row, in this order** (same order as `getAsyncJob`, so an
  already-reaped row is never alerted): age > 2h → `reapStaleRunning`
  as `failed` with the read path's exact unknown-outcome message
  ("Execution stopped before a result was recorded; the outcome may
  be unknown. Verify external side effects before submitting
  again.") + audit `async_job.failed` with the established
  `{ jobId, capability, error }` shape (no new event name); else age
  > stuck threshold (`resolveStuckRunAlertThresholdMs`, default
  30 min; `0` disables alerting, reaping still applies) →
  `maybeAlertStuckRunning` (exactly-once claim, audits
  `async_job.stuck_detected`, notifies via the existing
  `notifyStuckRun` Slack seam).
- **Idempotency:** the guarded transitions make a second sweep a
  no-op for already-flagged/reaped rows (pinned by test). Per-row
  try/catch + structured log, so one bad row never fails the sweep
  or its caller; the sweep never throws its callback.
- **Arming:** `OrchestratorAgent.sweepStaleAsyncJobs()` (thin
  delegating callback next to `executeAsyncJob`,
  `src/agents/orchestrator.ts`) dispatches to the asyncJobs
  function with `this.asyncJobsContext()`; `onStart` runs one sweep
  and `ensureStaleAsyncJobSweepSchedule()` arms the recurring
  interval (15 min = `STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS`),
  copying the #618 ledger-sweep pattern (list schedules, skip if a
  `sweepStaleAsyncJobs` schedule exists, else `scheduleEvery`).
  Best-effort in `onStart` with the same try/catch +
  `structuredLog.warn` pattern. Wiring pinned by
  `tests/stale-sweep-wiring.test.ts` and the class inventory pin.
- **Deliberate non-integrations:** the sweep does NOT publish to the
  J1 CloudEvents status stream (`mas_async_jobs` rows are not J1
  pipeline runs and the stream's consumers expect pipeline runs);
  no second job table; no status-enum change.

## The UI flag

`WorkflowRunJobRow` carries `stuck_alerted_at` through
`readWorkflowRunJobs` (`src/agents/routes/workflowRuns.ts`); the
run model derives `WorkflowRun.stuck` in `runFromJobs`
(`src/services/workflowRuns.ts`) — true only when the run is still
`running` AND at least one job carries the claim. "Stuck" is a
display derivation, NOT a new stored status and NOT a lifecycle
state: the recorded status stays "running", the lifecycle stays
in-progress. `WorkflowRunsPanel` renders a stuck run as "Stuck"
with the warning tone (`runStatusLabel` / `runStatusTone`).

## The triple-submit fix

`src/client/BrokerDynamicMenu.tsx`: `onSwitchEnv` calls the
`handleSwitchEnvironment` prop when present, else the direct
`switchBrokerEnvironment` import — never both. The Policy Mode
pill no longer calls `onToggleAccountMode` (Chat's toggle posts
directly; `onSwitchEnv` already switches to the same target). The
"Switch to TEST & Connect" banner no longer calls `onSwitchEnv`
(`handleSwitchAndConnect` switches through
`handleSwitchEnvironment` and then starts OAuth). Switch semantics
unchanged (same target, same echo adoption); the only client POST
remains `switchBrokerEnvironment` (`brokerEnvironment.ts:111`).
Pinned by `tests/broker_dynamic_menu_single_submit_3784.test.tsx`
(one switch action → exactly one POST).

## Operator note

The sweep resolves stuck rows on its first tick after deployment:
flagged rows alert once, rows past 2h reap as failed with the
unknown-outcome reason. **Production delivery is blocked until
#3789** (Deploy red since bb24be82, failing step "Ensure Vectorize
index for VectorMemory (PR #6)"): the six incident rows stay
`Running` in production until the sweep's first tick after a green
deploy. The production live check — a stuck run producing a visible
Slack alert + the `async_job.stuck_detected` / `async_job.stuck_alert`
audit events — is outstanding until #3789 lands and is not claimed
by #3784.
