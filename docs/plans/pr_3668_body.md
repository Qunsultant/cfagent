## Agent #clo-arsi

Fixes #3668
Sub-issue tracking under #2764

## Summary

- **Live/Paper Mode Switching**: Fixed `isLive` computation in `src/client/ETradeDynamicMenu.tsx` and `src/client/ETradeTradingHub.tsx` to strictly evaluate `effectiveEnv === "PROD"` rather than allowing previous broker status responses to override and stick mode on live.
- **Alpaca Platform Key Auto-Connect**: Updated `AlpacaSignInCard` invocation in `ETradeDynamicMenu.tsx` with `collapsedWhenConfigured={true}`. Clicking Connect Alpaca in the broker dynamic menu automatically uses the configured deployment keys without prompting the user for manual API keys.
- **BYOK in Platform Admin**: Added a dedicated Bring-Your-Own-Key (BYOK) Provider Credentials section in `src/client/DataProvidersPanel.tsx` under Platform Admin (`/?tab=platform-admin&view=data-providers`) enabling platform administrators to inspect and configure custom Alpaca Paper (`TEST`) and Live (`PROD`) key pairs.
- **Broker-Neutral Order Drafting**:
  - Added `"alpaca"` to `TRADING_AGENT_CONFIG_BASELINE.enabledProviders` in `src/config/tradingAgentConfig.ts`.
  - In `src/mcps/openaimp/meshDoorCommands.ts`, dynamic resolution defaults omitted `provider` to the tenant's active broker via `resolveTenantBroker`.
  - In `src/trading/alpaca/platform.ts`, order preview metadata explicitly stamps `broker: "alpaca"` and threads bracket legs (`orderClass: "bracket"`, `takeProfit`, `stopLoss`).
  - In `src/client/chat/ToolResultView.tsx`, dynamically formats broker labels (`Alpaca Trade Intent`, `Alpaca Order ID`, `Alpaca Execution`, `Alpaca Quote`) using `brokerPresentation(brokerId).label`.
  - In `src/agents/chatPrompt.ts`, updated Rule 6 and command tool descriptions to steer LLM to broker-neutral `tool_openaimp_propose_stock_trade`.
- **Completion Report**: Lands `docs/plans/completion_report_3658.md` permanently on `main`.

## Testing

- Created unit tests in `tests/broker_login_mode_byok_3668.test.ts` (5 tests covering mode switching respecting effectiveEnv, Alpaca baseline inclusion, broker-neutral routing to Alpaca, and ToolResultView broker label neutrality).
- Verified existing suites: `tests/dynamic_menu_broker_neutral_3419.test.tsx`, `tests/broker_menu_mode_3419.test.tsx`, `tests/broker_environment_client_2482.test.ts`, `tests/portfolio_broker_neutrality_3417.test.tsx`, `tests/trading_agent.test.ts`. All 34 tests passed green.

Process documentation impact: none

