### Fixed

- Run ledger: the Job and Async job ids are clickable links to the job's detail, so nobody types `/api/jobs/<id>` by hand (issue #3605). Job opens the run history (`run=<id>`); Async job opens the shared job-detail view. Legacy rows keep plain text for a null async-job id.
