### One options-strategy vocabulary for OODA and the screen registry (#6507)

- **One shared catalog.** `src/shared/optionsStrategyVocabulary.ts` owns the shared slice of strategy vocabulary: canonical screen id, label, thesis compatibility, category, screen aliases, and the OODA structure names that build the same strategy.
- **Both sides read it.** OODA's `structuresForOutlook` selects through catalog ids; `researchDiscovery` resolves catalog ids to OODA structures from the same map; the screen `StrategyRegistry` resolves OODA names (`bull_call_spread`, `pmcc`, …) to their canonical ids as aliases.
- **Drift-pinned:** every catalog entry matches the registry's label/theses/category; every OODA structure resolves to exactly one id; every OODA selection for every outlook/ownership/PMCC combination is catalogued; unknown names stay unresolved.
- No change to supported strategies, defaults, gates, ranking, or report shapes; the research and strategy suites stay green.
