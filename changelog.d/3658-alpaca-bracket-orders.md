### Added

- **Alpaca native bracket order support on alpaca_place_order (#3658):**
  - Added native bracket parameters (`order_class: "bracket"`, `take_profit`, `stop_loss`, `take_profit_limit_price`, `stop_loss_stop_price`, `stop_loss_limit_price`, and `extended_hours`) to `alpaca_place_order` in `src/mcps/openaimp/marketDataCommands.ts`.
  - Added bracket validation and fail-closed refusal logic for invalid prices, missing legs, or incompatible parent order types.
  - Extended `MarketDataResearchService` and `AlpacaTradingService.placeOrder` to serialize bracket legs and return `orderClass` and `legs`.
  - Added unit test suite in `tests/alpaca_bracket_orders_3658.test.ts`.
