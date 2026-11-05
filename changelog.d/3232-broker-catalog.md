### Added

- feat(3232): one broker catalog (`src/trading/brokerCatalog.ts`) is the single source of broker facts — ids, credential kinds, asset classes, and the environment → trading-type mapping (`paper` / `live`); `sandbox` now resolves to (etrade, TEST, paper) instead of posing as a broker

### Changed

- refactor(3232): the shared platform contract is broker-neutral — `BrokerQuote`/`BrokerStatus`/`BrokerAccount`/`BrokerPosition`/`BrokerOrderDraft`/`BrokerOrderExecutionResult` (and 14 sibling types) are canonical, with the former `ETrade*` names kept as deprecated aliases naming their successors
- fix(3232): the routed order surface takes its broker list from the catalog instead of a second hand-written copy
- fix(3232): Alpaca reports Alpaca's protocol (`alpaca_rest_v2`) and paper/live type, no longer E*TRADE's `etrade_oauth_rest` / `live_oauth`
