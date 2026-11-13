### One engine

- **Scheduled sharded chain runs on the one engine** — the scheduled sharded stock screen now submits through the engine seam's submit-only entry (`submitStockScreenViaEngine`, job id = chain id) instead of the broker's chain start; the delivery envelope and stage chain ride the workflow command to the deliver stage, where the follow-up bridge serves and delivers with the chain's delays (Qunsultant/cfagent#4280).
- **Chain-mode scheduled goal screens run the goal workflow** — the direct registry-leg path and its chain bridge are retired; chain mode rides the payment workflow like any scheduled goal screen, with `stageChain` and `slackChannel` carried on the goal command and the workflow's deliver stage bridging (Qunsultant/cfagent#4280).
- **Broker chain start retired, not deleted** — `startScheduledShardedChain` is frozen in `startScheduledShardedChain.deprecated.ts` with an `@deprecated` tag naming its successor and a ledger entry (Qunsultant/cfagent#4280).
