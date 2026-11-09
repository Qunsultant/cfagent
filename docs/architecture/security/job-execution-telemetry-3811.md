# Job execution telemetry (#3811)

Sub-issue of incident #3781. The incident's runs view could not answer
"failing or successful?" for a running job: a job row carried only
`started_at` / `completed_at` / `result_json` / `error`, written at terminal
states, with no heartbeat, no last activity, no progress — and if the
executor died or the execution threw before writing, nothing was recorded and
the row stayed "running". This slice emits per-job execution telemetry into
the existing #1742 telemetry / #1743 observability platform — no parallel
telemetry system, no second job-state record.

## What is recorded

- **Heartbeat / last activity.** `mas_async_jobs` gains two probed columns
  (`ensureGraphColumns` pattern, like `stuck_alerted_at`):
  - `last_activity_at TEXT` — stamped at claim, at every 2-minute heartbeat
    while `executeAsyncJob` runs (`ASYNC_JOB_HEARTBEAT_MS = 120_000`, the #624
    research-task precedent), and at every terminal transition
    (`complete`, `failRunning`, `reapStaleRunning`, `failQueued`,
    `insertTerminal`). The heartbeat is a guarded UPDATE that writes only
    while the row is `running` and touches neither `status` nor
    `updated_at`: it is observation, not a state change. If the executor
    dies, the timer dies with it and the row's last activity ages — the
    stall evidence. The heartbeat callback never throws
    (`heartbeatAsyncJob` is best-effort).
  - `error_code TEXT` — the coded failure, set on failure transitions only.
    Legacy rows carry NULL for both columns and upgrade in place.
- **Coded failures.** `resolveJobFailureCode(error)` maps a throw to the
  single outcome catalog: a `BusinessError` keeps its own code (validated
  through `resolveOutcome`); a message with a leading `[CODE]` naming a
  cataloged code resolves to that code; anything else (uncoded, unknown
  bracket, non-Error) falls back to `FAILURE_ASYNC_JOB_FAILED` — the generic
  code, never an invented one. The executor's catch, the sweep's 2-hour
  reap, and the arming failure all write the code; the `async_job.failed`
  audit gains `errorCode`, and the sweep's audit also gains
  `lastActivityAt`.
- **Stage terminal reasons for all jobs.** Previously only screening stages
  recorded a terminal reason (`mas_screening_activity`). The projection now
  resolves, per stage, in order: the transition's reason; the result's
  reason for a skipped/held stage; the coded error for a failed stage. The
  stage error itself renders coded (`codedMessage(code, detail)` with a
  leading `[CODE] ...` prefix stripped so the code never renders twice);
  rows with no code keep their raw error verbatim. The run's `firstError`
  logic is unchanged and now rides the coded stage errors.
- **Run-level outcome code for tool runs.** Tool runs have no
  `mas_job_outcomes` row, so the code rides the projection (the job row's
  `error_code` surfaced through `WorkflowRun.error` and the stage reason)
  rather than a second record of the same fact.

## What the runs view shows

- A running run's **Started** column gains a "Last activity {time} ({age}
  ago)" line under "No end recorded" — the heartbeat age distinguishes
  "still progressing" (recent heartbeat) from "stalled" (aging heartbeat).
- The **Result** column shows the run's coded error when present.
- `WorkflowRun` gains optional `lastActivityAt` / `heartbeatAgeMs`
  (running runs only; null for terminal runs and for runs with no recorded
  activity — never backfilled, never invented). Job runs take the max over
  their jobs (`last_activity_at` falling back to `started_at` for legacy
  rows); outcome-only runs take the outcome's recording instant; saga runs
  take the latest stage / projection / ended instant.
- The stuck-run Slack alert gains a "Last activity: {lastActivityAt}
  (~{lastActivityMin} min ago)" line (both `stuck_run_alert` and
  `legacy_stuck_run_alert` templates; the pinned expected text in
  `tests/catalog_rendering_2975.test.ts` was updated in the same PR, per
  the pin rule). The 30-minute alert threshold still keys on `started_at`
  (#2567 contract) — last activity is evidence, never a second threshold.

## Out of scope (sibling slices)

- Trigger / schedule provenance columns: #3810.
- Screener-chain routing through the J1–J7 substrate: #3787.
- Schedule-missed-fire detection: #3788.

## Verification

- `tests/async_job_execution_telemetry_3811.test.ts` (19 tests): claim /
  heartbeat / terminal stamping, legacy-row upgrade, best-effort
  heartbeat, code resolution (coded, uncoded, unknown-bracket), executor
  throw → failed + code + audit, heartbeat ticks during a slow leg,
  sweep alert / reap evidence, projection derivations, heartbeat interval.
  Written Red first (19 failed on pristine main), Green on the branch.
