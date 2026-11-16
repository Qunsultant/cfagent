### Changed

- **Brokerage (#4664, Gap 10 of #4634):** Generalized `src/trading/voice/agent.ts`, `src/agents/nlq/execution.ts`, and `src/trading/slack/agent.ts` to resolve the selected tenant/copilot broker via `resolveTenantBroker` / `TradingPlatformRegistry.getPlatform` instead of hardcoding `ETradeService` or refusing non-E*TRADE brokers.
