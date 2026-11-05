### Added

- feat(3233): Alpaca options data plane — expiry dates and full call/put chains from Alpaca's contracts + snapshots APIs, mapped without inventing any field (a contract with no two-sided quote is omitted, greeks appear only when sent)
- feat(3233): `BrokerOperation` capability declarations in the broker catalog, so "Alpaca does not offer this" is a checked fact (position lots and market screening are declared unsupported)
- feat(3233): `ALPACA_TRADING_TYPE=paper|live` makes the trading type an explicit choice; unset keeps the legacy base-URL inference
- feat(3233): `ALPACA_OPTIONS_FEED` selects the options feed (indicative by default)

### Changed

- feat(3233): Alpaca implements `getOptionChains`, `getOptionExpireDates` and `getQuoteDetailed`, closing three of the five capability gaps against E*TRADE
