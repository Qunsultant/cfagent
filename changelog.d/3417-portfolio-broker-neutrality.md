### Fixed

- **Broker-neutral portfolio tab & sign-in persistence (#3417):**
  - Updated `ETradeTradingHub.tsx` portfolio hero summary to derive portfolio equity, available cash, buying power, day gain, and position counts dynamically from the active broker (`etrade` vs `alpaca`).
  - Added `accountsEndpoint()` to `brokerEndpoints.ts` routing to `/api/etrade/accounts` for E*TRADE and `/api/broker/accounts` for neutral brokers.
  - Added support in `ETradeTradingHub.tsx` for parsing neutral broker payload envelopes (`{ broker, environment, result: { account, positions } }`) and legacy E*TRADE payloads seamlessly.
  - Made hero header badge, title, description, and empty states dynamically adapt to the active broker's brand and execution environment (`BROKER_CATALOG[broker].label` and `brokerPresentation`).
  - Improved `AlpacaSignInCard` and `AlpacaBrokerPanel`: when credentials are already configured (e.g. deployment keys or user sign-in), the sign-in form is collapsed so pages no longer ask for sign-in again; when sign-in is required, a notification toast informs the user without disrupting the page layout.
