### Changed
- **Durable DO SqlStorage for OODA Research routes (#5273)**: Wired `sql: ctx.getOrm?.()` into `dispatchResearchEngineRun` (`POST /research/run`, `POST /research/scheduled-tick`) and `executeResearchStageControl` (`POST /research/runs/:runId/stages/:stageId`) in `src/agents/routes/screenerResearch.ts` so `research:<runId>` engine jobs persist across HTTP requests.
