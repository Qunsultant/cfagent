### Fixed

- Channel desks no longer route a non-E*TRADE tenant's order to E*TRADE (#3429). `handleTradingIntegrationsRoutes` now resolves the tenant's selected broker before constructing any channel service; for a broker other than E*TRADE it answers `BROKER_CHANNEL_UNAVAILABLE` (501) naming the selection and pointing at the Trading Hub / `/api/broker/order/execute`. Nothing is previewed, quoted from another broker, or routed.
- The Omnichannel and Voice tabs state the same refusal on the surface, before a tenant types a command (#3429). An E*TRADE tenant sees no notice.

### Why a refusal and not a second venue

The desks (`src/trading/email/agent.ts`, `src/trading/slack/agent.ts`, `src/trading/voice/agent.ts`) build one `ETradeService` for preview, quotes, screening and execution. Swapping only the executor would let an E*TRADE-priced preview execute at Alpaca — a worse defect than an honest refusal. Wiring the desks to a second broker is a separate feature, not a neutralisation.
