### Added

- **OODA feed stage is real (#6063):** `runFeedStage` performs the run's regime, universe and quote work and returns a persisted `ResearchFeedStageOutput`; the `research.feed` engine step runs it on J-stack and hands the output to `analyze.ooda` through the engine step output (`ctx.input`). `runResearchPipeline` consumes a supplied/handed-off feed and no longer calls `getRegime` / `getUniverseSymbols` / `getQuote`; a host without the stage runtime records `not_configured` and keeps the pre-stage fetch behaviour.
- The research run path threads the feed output from the step through the dispatch, the publish entry and the agent into the pipeline; the manual and scheduled triggers both carry it.
- Tests: the feed stage's counts and null quotes, analyze making zero upstream calls, the run-scoped hand-off, the universe-failure report, and the engine step → analyze hand-off. #CAIO-quns
