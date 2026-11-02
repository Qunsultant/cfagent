### Added

- **Stock screener Phase 2 Slice 4 (#2864, under #2764):** one stock-screen planner (`planStockScreenRun` / `planFromSpec`) extracted verbatim from `ScreenerAgent.runScreenInner` — sector, universe, provider, fallback marker, durable-task idempotency key, and scheduled duplicate-claim key resolved once, so the broker, scheduled, NLQ, mesh, and goal paths can share one plan. No behaviour change, no screening semantics change.
