# Job execution telemetry (#3811)

- Async jobs now emit execution telemetry: a heartbeat stamps `last_activity_at`
  on running rows every 2 minutes while the executor runs; an executor that
  dies mid-job leaves a stale heartbeat — the stall evidence.
- Executor-side failure capture: a throw in `executeAsyncJob` writes a terminal
  failed state with a coded error from the single outcome catalog
  (`FAILURE_ASYNC_JOB_FAILED` when the throw carries no code); the sweep's
  2-hour reap and the arming failure carry the same code.
- Stage terminal reasons now exist for all jobs, not only screening stages
  (transition reason, then result reason for skipped/held stages, then the
  coded error for failed stages); run-level outcome codes ride the projection
  for tool runs.
- The Workflow runs view shows last activity + heartbeat age for running runs
  and the coded error for failed runs; the stuck-run Slack alert carries the
  last-activity instant.
