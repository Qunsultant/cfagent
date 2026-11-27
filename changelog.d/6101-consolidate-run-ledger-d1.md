### Added

- **Run ledger consolidated into D1 (#6101):** job run records, canonical reports, stage events and audit events are now written to D1 only (`job_run_records`, `agent_reports`, `job_stage_events`, `mas_events`). The DO tables are frozen at cutover — pre-cutover runs stay as history, never copied — and drop in follow-up #6627. A run exists in the ledger only if written after cutover. The ScheduledAgent KV `jobRunRecords` key is retired: goal runs post to the shared ledger, and a failed or absent post is a visible tick error instead of a silent KV row.

### Removed

- **The #6099 run-ledger projector is deleted (#6101):** no projection, sweep, carrier table or reconcile route — the D1 writer is the writer. The reports seed route (`POST /api/reports/seed-canonical`) answers 410 Gone: it copied existing DO rows into D1, which the replacement ruling forbids.
