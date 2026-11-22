### Added

- **OODA enrich stage is real (#6064):** `runEnrichStage` fetches technicals and catalysts for the feed's quoted symbols and returns a persisted `ResearchEnrichStageOutput`; the `research.enrich` engine step runs it on J-stack, takes the feed step output as `ctx.input`, and hands its own output to `analyze.ooda`. `runResearchPipeline` consumes a supplied/handed-off enrich and no longer calls `getTechnicals` / `getCatalysts`; a host without the stage runtime records `not_configured` and keeps the pre-stage fetch behaviour.
- The manual and scheduled run paths thread the enrich output alongside the feed through dispatch, publish and the agent; analyze receives both.
- Tests: per-quoted-symbol fetch counts, analyze making zero technicals/catalyst calls, the run-scoped hand-off, and the feed → enrich → analyze engine hand-off. #CAIO-quns
