### Goal branch out of the screener analyze node (#5873)

- The goal leg rides its own job definition: a goal command builds the new
  `goalScreen` spec (same six kinds; the analyze node is the goal dispatch
  step `screener.goal`), and a market command builds the unchanged `screener`
  spec (analyze node `screener.analysis`).
- The goal step delegates to a new agent stage method, `screenGoalStage`
  (the goal-branch body moved verbatim, including the engine-method goal
  runner); `screenAnalysisStage` is market-only — a goal run never invokes
  it, and the market quote path never runs for a goal command.
- The in-memory workflow adapter (the test host) registers the same move:
  a canned `screener.goal` step carries the goal dispatch, and its canned
  `screener.analysis` is market-only — a goal command through the adapter
  reaches the fake goal runner, never a market fallback.
- The flip (slice 6b3) re-points only the market spec's analyze node; the
  goal definition is untouched. The engine-steps conversion of the goal
  runner and the market refusal stay with slice 6d (#5886).
