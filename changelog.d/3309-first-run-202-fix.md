### Fixed

- First-run account setup and profile save now honor the 202 async-job contract instead of failing on every refresh (#3309): the first-run calls route through `apiFetch`'s 202 polling, so a queued setup/profile request returns once its job completes. A failed job or a still-processing job surfaces a coded outcome-catalog message (`FAILURE_ASYNC_JOB_FAILED`, `FAILURE_ASYNC_JOB_STILL_PROCESSING`) instead of the generic dialog.
- Async jobs now audit `async_job.started` at claim, so the job lifecycle is observable as queued → started → completed/failed instead of going dark between queue and completion (#3309).
