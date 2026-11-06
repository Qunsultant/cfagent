### Added

- **Alpaca platform carries session order terms on the wire (`extended_hours`, overnight) + truthful `supportsSessionOrders` (#3508, parents #3398, #3391, #3514):**
  - Implemented truthful `supportsSessionOrders(session: string): boolean` on `AlpacaTradingPlatform` (`src/trading/alpaca/platform.ts`), reporting true for all four canonical sessions (`pre_market`, `regular`, `after_hours`, and `exto`).
  - Extended `PlaceOrderParams` in `src/trading/interfaces.ts` with optional `session`, `extendedHours`, and `timeInForce`.
  - Updated `AlpacaMarketDataProvider.placeOrder` and `MarketDataResearchService.placeAlpacaOrder` in `src/services/marketDataResearch.ts` to accept and serialize `extended_hours: true` into the `POST /v2/orders` request body.
  - Enforced venue order rules in `AlpacaTradingPlatform.placeOrderRemote`: orders targeting extended-hours or overnight sessions require `LIMIT` order types; non-limit orders are rejected before network dispatch with an explicit diagnostic message.
  - Wired `session` and `extendedHours` through Stock Copilot's `evaluateExit` and `attemptEntry` in `src/services/stockCopilot.ts`, removing `stock_copilot_session_wire_unsupported` refusals on capable platforms. #ceo-aimp

