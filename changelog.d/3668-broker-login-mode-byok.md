### Fixed

- **Broker live/paper switching, Alpaca platform key auto-connect with BYOK, and broker-neutral proposals (#3668):**
  - Fixed `isLive` computation in `ETradeDynamicMenu.tsx` and `ETradeTradingHub.tsx` to strictly evaluate `effectiveEnv === "PROD"` rather than allowing previous broker status responses to override and stick mode on live.
  - In `ETradeDynamicMenu.tsx`, configured `AlpacaSignInCard` with `collapsedWhenConfigured={true}` to automatically use configured deployment keys on Alpaca connect without popping up key/secret inputs.
  - Added a dedicated BYOK Provider Credentials card in `DataProvidersPanel.tsx` under Platform Admin (`/?tab=platform-admin&view=data-providers`) for administrators to manage custom Alpaca Paper (`TEST`) and Live (`PROD`) key pairs.
  - Added `"alpaca"` to `TRADING_AGENT_CONFIG_BASELINE.enabledProviders`. In `meshDoorCommands.ts`, dynamic resolution defaults omitted `provider` to the tenant's active broker via `resolveTenantBroker`.
  - Stamped `broker: "alpaca"` and threaded bracket parameters in Alpaca order preview drafts, and updated `ToolResultView.tsx` to display dynamic broker presentation labels (`brokerPresentation(brokerId).label`).
