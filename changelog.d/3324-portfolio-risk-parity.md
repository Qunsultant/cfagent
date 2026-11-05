### Added

- **Portfolio risk runs on the selected broker (#3324, programme #3292):** the risk model was typed against `ETradeService`, so PR #3301 could only declare `portfolioRisk: false` for Alpaca. `PortfolioRiskSource` (`readBook`, `optionChain`, `spotPrice`) now separates the model from the broker: E*TRADE keeps its exact reads through `etradePortfolioRiskSource`, and every platform that can report positions, chains, and a quote feeds the same aggregation through `platformPortfolioRiskSource`. New neutral routes `GET /broker/portfolio-risk` and `POST /broker/portfolio-risk/{evaluate,correlation,size}` serve the selection and stamp `broker` + `environment` on the envelope; a broker the catalogue says cannot risk-report still answers `501 provider_unsupported` naming it, before any platform is constructed.

### Fixed

- **Alpaca option positions are resolvable (#3324):** Alpaca reports an option position as an OCC symbol with no strike, expiry, or call/put field, so every Alpaca option position was excluded from every Greek total. `parseOccSymbol` reads the symbol from the end (robust to adjusted roots such as `AAPL1`), and `mapAlpacaPosition` now carries `optionType` / `strikePrice` / `expirationDate` with the neutral `OPTN` security type. A symbol that does not parse stays unresolved and is named in the report's `excluded` list rather than receiving a manufactured contract.

#ceo-aimp
