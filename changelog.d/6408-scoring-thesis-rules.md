### OODA scoring, thesis and evaluation rules read from the versioned block (#6037 c)

- Score weights (0.4 / 0.35 / 0.25), the non-live provenance penalty (-1), the event-risk penalty (0.15), the thesis strength ladder (0.4 / 0.55 / 0.6, +0.1 per confirmation, cap 1), the track-record thresholds (<0.4 / >0.6), the candidate pre-screen multiplier (x3) and the breakeven band (0.98 / 1.02) are read by key from `ResearchRules`, not literals in `src/services/researchPipeline.ts`.
- The block is resolved once per entry point (`runResearchPipeline`, `runFeedStage`, `runResearchEvaluation`), so a stored override changes the ranking with no deploy and the run's snapshot states the values it ran under.
- One duplicate removed: the ordering block's literal `10` becomes the existing `MIN_EVALUATED_FOR_ORDERING`.
- Behaviour-neutral at the defaults, pinned value by value; a stored weight override is proven to move the reported idea score.
