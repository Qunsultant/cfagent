### Changed

- Autopilot Control Center: the jobs list now reads the unified run rows (GET /api/runs, issue #2606) — the same call Docs makes — instead of the mas_job_outcomes sink (GET /api/autopilot/jobs). The write sink is unchanged. Rows map onto the existing table columns; coded error and origin are unavailable from list rows until #6006 folds the outcome facts into the one run source, and sink-only kinds (corpus-sync, reports-index-backfill, trading-order) no longer appear in this list (they stay visible in the run ledger via the #6003 lossless fold).
