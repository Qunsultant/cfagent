### Fixed

- Research feed/enrich/generate/deliver stages no longer run as `not_configured`: `buildResearchJobDefinition` preserves the spec-built step params (`userLogin`, `trigger`) for all four stages, following the analyze precedent.
- The research stage read now surfaces the step output's `status` (`not_configured` vs real) and the unit attempt count, so a future no-op can never again read as a healthy 0 ms completion.
