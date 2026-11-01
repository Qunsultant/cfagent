### Added

- Stuck-running honesty for async jobs (#2567, #2494): a job still
  `running` past the configured threshold (default 30 minutes,
  `STUCK_RUN_ALERT_THRESHOLD_MINUTES`) raises exactly one operator
  Slack alert — job id, kind, age, owner — claimed through a
  guarded `stuck_alerted_at` stamp on the job row, well before the
  2h reap backstop; plus the stuck-runs operator runbook
  (`docs/operations/runbook/stuck-runs.md`).
