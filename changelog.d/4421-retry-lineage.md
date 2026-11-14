### Added

- **Retry lineage in Workflow Runs (#4421):** a stage row now carries its durable **job id**, and a row that is a retry shows **`Retry of <original job id>`** as a link to the original row. `retryOf` was already persisted in the job payload by both retry paths (single retry and host-death re-arm) but no surface read it — now the read model projects it and the panel renders it. An original attempt renders no marker, and a stage recorded only as a transition shows its recorded job id with no invented lineage. #autoclaw-001
