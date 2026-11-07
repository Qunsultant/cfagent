# Completion Report — Issue #3658 (PR #3663)

## Agent
#clo-arsi

## Issue / Pull request / Integration
- **Issue**: #3658 (`Alpaca place order: native bracket support (order_class=bracket with take_profit / stop_loss) on alpaca_place_order`)
- **Parent Tracking Issue**: #2764 (`[Tracking] Stock-only screener lifecycle consolidation, lossless, with user-managed pattern catalog`)
- **Pull Request**: #3663 (`feat(3658): alpaca native bracket orders on alpaca_place_order`)
- **Merged commit on main**: `8c34074610d69ad9185f942f3cf2ae378b423e75`

## Implementation
- **Problem**: When a user or Stock Copilot issued a bracket order command (e.g. `Buy AAPL Bracket (TP +4% / SL -2%)`) via `alpaca_place_order`, the command schema did not expose `order_class` or bracket legs (`take_profit`, `stop_loss`). The orchestrator stripped the bracket parameters and degraded the order to an unbracketed 1-share market order without failing closed.
- **Solution**:
  - Extended `MarketDataOrderRawInput` and `MarketDataOrderNormalized` in `src/config/marketDataModes.ts` to accept bracket fields and convenience aliases (`take_profit_limit_price`, `stop_loss_stop_price`, `stop_loss_limit_price`), and auto-infer `order_class: "bracket"` when legs are present.
  - Implemented fail-closed parameter validation in `AlpacaPlaceOrderCommand` (`src/mcps/openaimp/marketDataCommands.ts`):
    - Refuses missing legs with `invalid_bracket_parameters` error (never places an unbracketed order).
    - Refuses incompatible parent order types (e.g. `stop_limit`) with `invalid_bracket_order_type`.
    - Refuses nonsensical bracket prices with `invalid_bracket_prices` (e.g. BUY where `take_profit <= entry` or `stop_loss >= entry`; SELL where `take_profit >= entry` or `stop_loss <= entry`).
  - Serialized bracket legs (`order_class`, `take_profit`, `stop_loss`) to Alpaca `POST /v2/orders` in `AlpacaTradingService` and `MarketDataResearchService.placeAlpacaOrder` in `src/services/marketDataResearch.ts`, returning `orderClass` and child `legs` in the order receipt.
  - Preserved backward compatibility: plain market/limit orders without bracket parameters execute unchanged.

## Test evidence
- **Unit test suite**: `tests/alpaca_bracket_orders_3658.test.ts` (7 tests covering valid brackets, convenience aliases, missing leg rejection, price sanity rejection for BUY/SELL, stop_limit rejection, and non-bracket backward compatibility).
- **Merge Queue checks**: All checks passed green on `gh-readonly-queue/main/pr-3663-ed42e8a6...` (`Policy Gate`, `Gitleaks secret scan`, `Fast gates (typecheck + build)`, `Tests MQ shards 1-4`, `CodeQL`, `Test & Build (Node 22) [PROD]`).
- **Post-merge verification**: Post-merge CI `42383047023` on `main` passed green.

## Change management
- **Change type**: Feature / Bugfix
- **Impacted surfaces**: `alpaca_place_order` MCP command, `MarketDataResearchService`, `AlpacaTradingService`.
- **Changelog fragment**: `changelog.d/3658-alpaca-bracket-orders.md`.
- **Process documentation impact**: none.

## Conformance
- **Zero deletions**: 0 deletions.
- **Deprecations**: None.

