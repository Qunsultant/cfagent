### One engine

- **Goal stock screen runs on the one engine** — every goal entry (manual route, scheduled tick, A2A `run_goal_screen`) now submits through the workflow, and the goal job dispatches its stock leg as a stock-engine job through the S3 seam instead of nesting the full registry run inside one stage (Qunsultant/cfagent#4279).
- **Manual goal screens always answer 202** — the `goal_workflow` flag gate and the synchronous direct path are retired on the manual route; the 402 monetization refusal goes with them (monetization still routes through PaymentWorkflow inside the workflow path) (Qunsultant/cfagent#4279).
- **Goal capability record updated** — the `goal-stock-leg` entry is now `canonical`: the stock leg runs on the engine via `runGoalStockLegViaWorkflow` (Qunsultant/cfagent#4279).
