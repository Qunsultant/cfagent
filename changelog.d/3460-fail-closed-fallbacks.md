### Broker neutrality

- **Fail-closed broker fallbacks (#3460)**: a broker whose platform has no options chain source now refuses with a named `provider_unsupported` error instead of silently screening E*TRADE data — in `resolveEngineClient()`, in the goal leg (which now runs on a refusing screener, so stocks-only goals still proceed), and in `TradingPlatformRegistry.getPlatform()`, which no longer falls back to E*TRADE for an unregistered broker id.
