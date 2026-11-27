### Feed stage D1-only cutover (#6609)

The ScheduledAgent pipeline host now builds its job-pipeline stores, run recorder, and stage-event store over D1 only, with `job_stores_unavailable` when `AGENT_DB` is unbound. Feed capture wiring uses the D1 capture port and R2 blob seam, step shard reads use the same D1 definitions, and pipeline schedule declarations gate on `AGENT_DB`. No DO data is copied or migrated; definitions re-seed into D1 through the existing ensure path.
