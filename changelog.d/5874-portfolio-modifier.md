### Portfolio modifier as an analyze input (#5874)

- The portfolio book now rides the parent hand-off: the gather stage fetches it once per run (the one live broker leg, best-effort) and carries the JSON snapshot as `portfolioBook` on the gather output; the analyze stage applies `applyPortfolioContextToOpportunities` purely from that snapshot and never touches the broker.
- No broker in scope records a `no-broker` snapshot; a failed fetch records `positions-unavailable`; a goal run skips the fetch (the goal leg never consumes positions). A hand-off without the field degrades to `positions-unavailable` in analyze, never a failure.
- The legacy `runScreenInner` path keeps its own live fetch until slice 7 retires it.
