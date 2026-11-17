### Added
- Routed manual and scheduled research triggers through `dispatchResearchEngineRun` (`research:<runId>`) and added `(runId, stageId)` stage control (`POST /research/runs/:runId/stages/:stageId`) in `src/workflows/researchScreenEngine.ts` and `src/agents/routes/screenerResearch.ts` for `#5120` (`#5109`).
