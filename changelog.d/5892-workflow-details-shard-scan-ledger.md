### Fixed

- **Prevent inner per-symbol shard-scan leakage and duplicate false `success` records (#5892):**
  - Exported `isInnerShardScanJobId` from `src/workflows/optionsScreenEngine.ts` to identify `strategy-screen:shard-scan:<chainId>:<symbol>` inner child jobs.
  - Buffered `runRecorder.recordRun` across `withRetry` attempts in `runOptionsChainFeedUnit` (`src/services/optionsChainPipelineJobs.ts`) so skipped retry attempts do not emit multiple false `outcome: "success"` rows to D1 `job_run_records` before failing; exhausted skips record at most one `"skipped"` row and winning retries record one `"success"` row.
  - Filtered inner `strategy-screen:shard-scan:` child rows out of top-level `GET /workflow-runs` (`src/agents/routes/workflowRuns.ts`), `GET /api/runs?kind=all` (`src/agents/routes/reports.ts`), and `listD1JobRunRecordSummaries` (`src/services/runSummaries.ts`), and added D1 `AGENT_DB` fallback to `readInnerShardScanStages` so inner stages still attach to parent options feed shards when checkpointed in D1.
  - Preserved D1 linkage (`scheduleId`, `asyncJobId`, `workflowId`) and provenance (`brokerId`, `mode`, `modeSource`) in `runFromJobRunRecord` (`src/services/workflowRuns.ts`) and `attachWorkflowRuns` (`src/services/runLedgerWorkflowRuns.ts`) without stuffing synthetic `d1:...` keys into `asyncJobId`.
