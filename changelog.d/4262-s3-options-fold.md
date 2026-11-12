### Changed

- **Options runs are listed in the one run ledger (#4262 S3):** the options research panel no longer keeps a run history of its own — it keeps its settings, run controls, latest report and screening-activity log, and links to `?tab=schedules&view=runs&kind=options`. The data was already flowing: #4069 joined the options scan runs into the workflow-runs read, and S2 (#4308) attaches that read to the ledger with the recorded family, so an options run classifies as `options` there. One run list, one place to find it. #autoclaw-001
