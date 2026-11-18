### Added

- Durable `mas_runs` run registry (one row per run, canonical run id as primary key) with a `mas_run_aliases` alias table mapping every legacy id to its canonical run, plus a record-once / resolve-first registry port pair (`DoSqliteRunRegistryStore`, in-memory twin, composition root) wired into the orchestrator table ensure.
- Registry pins 5175-S2-P01–P08: record-once (first write wins), alias resolution for every legacy form, canonical ids never aliases, first-mapping-wins alias conflicts, derived-id resolution, the DO catalogue seam, never-mints, and in-memory twin parity.
