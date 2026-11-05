### Fixed
- Allowed Alpaca and routed brokers into Trading Hub instead of blocking with `FAILURE_BROKER_UNAVAILABLE` (#3411). Replaced the legacy `tenantProviders.brokerId !== "etrade"` guard in `Chat.tsx` and `OptionsScreenerPage.tsx` with `!isBrokerId(tenantProviders.brokerId)`, allowing multi-broker surfaces (`AlpacaBrokerPanel`, neutral orders, portfolio risk) to render for Alpaca tenants while preserving the coded unavailable notice for truly unrecognized brokers.
- Synchronized `ETradeTradingHub` with dynamic broker changes by subscribing directly to `useTenantProviders()` (#3411).
