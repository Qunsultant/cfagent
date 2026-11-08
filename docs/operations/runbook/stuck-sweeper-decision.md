# Stuck-job sweeper decision (Phase 5 slice 6, #2000)

> **SUPERSEDED 2026-11-08 by #3784 (parent incident #3781).** The
> G1 reopen trigger fired: six `mas_async_jobs` rows sat unread in
> `running` for ~53 min with no alert and no reap. The scheduled
> sweep is now built (`sweepStaleAsyncJobs`,
> `src/agents/orchestrator/asyncJobs.ts`, 15-min tick; see
> `docs/architecture/security/async-job-staleness-sweep-3784.md`).
> The read-path alert + reap described below stay as-is; the "NO
> background sweeper" decision no longer holds. The rest of this
> document is retained as the record of the decision it replaced.

**Decision: NO background sweeper.** The standing answer for stuck
`mas_async_jobs` rows is the read-path alert (30-minute default) +
the read-path reap (2-hour backstop) + the operator runbook, all
shipped under #2567. This decision was recorded by Phase 5 slice 6
as the answer to the plan's open question 6; if the owner disagrees,
the background sweeper becomes a follow-up build slice (it is not
built here, and this doc is not its spec — only a narrow design
pointer at the end).

## What exists (verified on main, not assumed)

**Alert — early signal, exactly once.** `maybeAlertStuckRunning`
(`src/agents/orchestrator/asyncJobs.ts:374`) runs on the read path:
a `running` row older than the configured threshold
(`src/config/stuckRunAlert.ts`, default 30 minutes via
`STUCK_RUN_ALERT_THRESHOLD_MINUTES`; `0` disables the alert) is
claimed exactly once through the guarded `markStuckAlerted`
(`src/data/doSqliteAsyncJobAdapter.ts:251`: `UPDATE ... WHERE
status = 'running' AND stuck_alerted_at IS NULL`; a non-1 row count
means the claim lost and no alert fires). Detection is audited as
`async_job.stuck_detected` even when no delivery hook is wired, so a
stuck run is never invisible. Delivery goes through the existing
Slack operator surface (`notifyStuckRun` in
`src/agents/orchestrator.ts:625`, `postSlackText`) and audits
`async_job.stuck_alert` or `async_job.stuck_alert_failed`. Delivery
is fire-and-forget: a slow or failing channel can never break or
delay the read. Deliberate claim-first trade-off (documented in the
code): if delivery fails, the claim is consumed and no second alert
fires; the failure audit row is the record.

**Reap — late signal, terminal verdict.** `getAsyncJob`
(`src/agents/orchestrator/asyncJobs.ts:419`) reaps on the read path:
a `running` row older than 2 hours is marked `failed` with a fixed
reason ("Execution stopped before a result was recorded; the outcome
may be unknown. Verify external side effects before submitting
again.") and a `completed_at`, then the read re-issues so the caller
sees the failed row. `reapStaleRunning`
(`src/data/doSqliteAsyncJobAdapter.ts:237`) is a guarded `UPDATE ...
SET status = 'failed' ... WHERE job_id = ? AND status = 'running'`:
it never deletes a row, and running rows are never deleted by any
path here. The reap check runs before the alert check, so an
already-reaped row is never alerted (pinned by test: a 3-hour-old
run is reaped, not alerted).

**Runbook.** `docs/operations/runbook/stuck-runs.md` (#2567):
detection, diagnosis (slow-not-stuck vs wedged, platform checks,
audit trail), safe intervention (wait, retry once the cause is
cleared, let the reap fire, fail only through the job surfaces —
never by editing `mas_async_jobs` rows directly), and what not to do.

**What triggers detection.** Every read of the job: single-job GET
(`GET /api/jobs/{id}`), the job list (session-scoped, clamped to 100
rows; each `running` row in the window is re-read, so reap + alert
fire through the list too), the Jobs panel (polls while open),
chat/NLQ and MCP job surfaces, and the operator shard-reconcile
route (which lists 100 jobs — operator-triggered, not periodic).

**What does NOT exist.** No background or periodic scan: no cron or
scheduled path in `src/server.ts` or `src/agents/scheduledTasks.ts`
calls the job-read functions, and the full caller list of
`getAsyncJob`/`listAsyncJobs` is read surfaces plus the operator
reconcile route. `recoverQueuedAsyncJobs` runs only at Durable
Object `onStart` (lifecycle restart recovery for `queued` rows), not
as a stuck-`running` sweep. There is no heartbeat.

**Regression set (the slice's verification, #2567).**
`tests/stuck_running_alert_2567.test.ts`: exactly one alert across
repeated reads; young running jobs emit none; completed and queued
runs emit none however old; threshold configuration (1 minute flags
a 5-minute run, `0` disables); delivery failure never breaks the
read and detection stays audited; no hook wired still claims +
audits (never invisible); the 2-hour reap stays the backstop;
config defaults and parsing.

## Why no sweeper (evidence)

1. **Every observed job is covered.** The first read after 30
   minutes alerts (exactly once); the first read after 2 hours
   reaps to a terminal `failed` row carrying a reason. The
   user-visible contract — a failed run is a row with a reason, not
   an absence — holds for every job anyone looks at, which is every
   job with an owner waiting on it (panel polling, single-job link,
   list) or an operator reconciling.
2. **An unread stuck row does not cascade.** There is no
   submit-time guard on `running` rows in `asyncJobs.ts`: a stuck
   row does not block new submissions. Its cost is bounded to a
   stale `running` row and a missing terminal record — it does not
   wedge the session's queue. (The screen run lock is a separate
   per-(user, universe) mechanism with its own lifecycle; it is
   outside this decision's scope.)
3. **A true sweeper is disproportionate to that cost.** The job
   store is per-session-instance (the read surface is deliberately
   session-scoped); a cross-session sweep would need instance
   enumeration plus an operator-scope design that does not exist,
   for a payoff — alerting and reaping rows nobody reads — whose
   only cost is the stale row itself.
4. **Scheduled runs have a second signal.** The delivery contract
   (email + Slack + UI per run) means a stuck scheduled run surfaces
   as a missing delivery, not pure silence.

## Gaps left open (recorded, not fixed — fixes are follow-up slices)

- **G1 — unread stuck `running` rows persist indefinitely.** No
  alert, no reap, until someone reads the row. Accepted cost
  (bounded, see 2 above). Reopen triggers: unread stuck rows
  observed at volume, or a future per-session concurrency cap
  making stuck rows blocking.
- **G2 — claim-first alert loss on delivery failure.** A failed
  Slack delivery consumes the claim; only the
  `async_job.stuck_alert_failed` audit row remains. Any future
  sweeper or escalation design must handle failed-delivery re-alert
  explicitly; the current machinery does not re-alert.
- **G3 — `queued` rows that never start are outside alert + reap.**
  Both mechanisms fire only for `running`. Partially mitigated by
  `onStart` recovery (re-arms `queued` rows on restart); a `queued`
  row on a live isolate that never gets claimed has no detector.
- **Boundary, not a gap — workflow instances with no async-job
  wrapper are outside by design** (the runbook states this); their
  state is not in `mas_async_jobs`, so no job-scoped mechanism
  covers them.

## What would change the decision

Owner disagreement (per the plan, the sweeper then becomes a
follow-up build slice with its own TDD + review); a per-session
concurrency cap landing; instance enumeration / operator-scope
scanning becoming available; or unread stuck rows observed at
volume (G1). None of those holds today.

## If a sweeper is ever built (narrow design pointer, not a build)

A periodic scan (not a read-path hook) over `running` rows older
than the reap threshold, session-agnostic but tenant-scoped, reusing
the existing guarded transitions — `markStuckAlerted` for the alert
claim, `reapStaleRunning` for the terminal verdict — so it can
neither double-alert nor double-reap. Invariants: never delete a
running row; never reap without a terminal verdict (`failed` +
reason); claim-once per alert; failed-delivery escalation handled
explicitly (G2); the session-scoped read discipline question
answered at design time, not discovered at build time.
