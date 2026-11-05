### Added

- **Alpaca multi-leg option orders (#3329, programme #3292):** both brokers were declared to support the `options` asset class while the Alpaca adapter refused every option order — `previewOrder` threw and `placeOrderRemote` failed any leg. It now previews and places them through Alpaca's `mleg` order class. Legs map to OCC symbols via `formatOccSymbol` (the inverse of the #3324 parser, refusing anything ambiguous), each with its ratio, side and position intent. Preview prices the strategy from its net limit and says so — Alpaca has no mleg preview endpoint, so the draft is computed locally rather than implying broker confirmation. Placement reports success only with a broker order id; anything else is a failure. Refusals are named: no legs, an equity leg inside a strategy, more than four legs, a market order (a limit price is required, as on E*TRADE), a missing strike/expiry/type, or unconfigured credentials. Equity placement is untouched.

#ceo-aimp
