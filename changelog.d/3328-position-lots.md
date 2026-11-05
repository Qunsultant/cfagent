### Added

- **Alpaca position lots, derived from fills (#3328, programme #3292):** `positionLots: false` recorded "Alpaca exposes no tax-lot endpoint" as a permanent gap. It does expose account fills — quantity, price, transaction time — and FIFO over those answers the same question. `deriveLotsFromFills` derives lots for long and short books symmetrically; a closing fill consumes the oldest open lot; quantity no retained fill explains is reported as `unmatchedQuantity` (a coverage gap, never a lot at price 0 and never a silent drop). `AlpacaTradingPlatform.getPositionLots` serves the contract method from the same derivation, `derivePositionLots` exposes the coverage the array form cannot carry, and a failed fills read is a failure rather than an empty list. `src/services/marketDataResearch.ts` gains `getFills` (`/v2/account/activities/FILL`).

#ceo-aimp
