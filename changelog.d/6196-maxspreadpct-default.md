### Fixed

- **maxSpreadPct default is now 15 (percent) (#6196):** the research config default was 0.15 (fraction of mid) but the options screener reads it as percent, so a constraint-less goal run's options leg matched zero contracts. The default is now 15 (percent, owner decision A); the research pipeline's spread consumers (gates, pipeline score, discovery liquidity, scenario floor) are aligned to percent, and the validation bound is (0, 200). Explicit constraints are unchanged. #CAIO-quns
