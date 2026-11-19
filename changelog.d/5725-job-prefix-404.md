### Fixed
- Fixed `OrchestratorAgent` `GET /jobs/:jobId` and `POST /jobs/:jobId/retry` route matchers (`src/agents/orchestrator.ts`) returning `404: Not found` for `job:<uuid>` IDs minted by `newAsyncJobId()`, which broke `apiFetch` polling on `POST /api/research/run` and `POST /api/research/evaluate` (#5725).
