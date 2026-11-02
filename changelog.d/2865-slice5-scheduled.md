### Changed

- **Stock screener Phase 2 Slice 5 (#2865, under #2764):** scheduled monolithic runs are now planned through the one planner (`planScheduledScreen`) — sector, universe, provider, and the E*TRADE-auth-dead Yahoo fallback resolve in the planner, and the run executes as the broker's sync branch via `ScreenerAgent.runScreen`. No behaviour change, no screening semantics change; the sharded scheduled path is untouched (Slice 6).
