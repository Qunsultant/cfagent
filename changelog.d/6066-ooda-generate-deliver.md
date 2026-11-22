### Changed

- **OODA generate and deliver are real stages (#6066), and analyze stops publishing (#6065):** the publish entry now takes a stage selector — `analyze` runs the pipeline and returns the report; `generate` runs `generateAndStoreResearchReport`; `deliver` runs `deliverResearchReport`. The `research.generate` and `research.deliver` engine steps take the report (and the generation result) from the previous step and do only their leg; analyze hands off the report instead of generating and delivering inline.
- The manual and scheduled dispatch wire the two stage runtimes and pass `stage: "analyze"` when the upstream feed/enrich stages ran, so a run generates exactly once and delivers exactly once. A host without the stage runtimes records `not_configured` and keeps the full behavior.
- Tests: analyze defers publication; generate hands report + publication to deliver; the generate/deliver deps are called with the right inputs; unwired hosts record `not_configured`. #CAIO-quns
