### Removed

- The hourly `feed-refresh` goal is gone: feed datasets are now produced only by the per-job Think scheduled tasks (one `pipeline-job:` task per feed job, monthly). The goal no longer appears in the built-ins endpoint, the schedules-home goals list, or the operation catalog, and `addGoal` refuses `feed.refresh_all`. (#4306)
