### Fixed

- **Alpaca is configured in the deployed Worker (#3330, programme #3292):** `.github/workflows/deploy.yml` writes `ALPACA_PAPER_API_KEY` / `ALPACA_LIVE_API_KEY` (with secret and URL pairs); the adapter read `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` / `ALPACA_BASE_URL`. Nothing mapped the two, so `getStatus().configured` was false in production — Alpaca looked absent from the build before a single surface was reached. `withAlpacaCredentials` decides the side once (deployment pin → persisted selection → legacy base-URL inference) and maps only that side's pair; a generic value already present always wins and the input env is never mutated. The adapter applies the mapping once in its constructor, so status, quotes, chains, orders and the market-data provider all read the same credential set.

### Added

- **The connect surface asks each broker for its own credential kind (#3330):** `brokerCredentialGuidance(broker)` declares, from the catalogue, whether the broker signs in with OAuth (E*TRADE) or an API key pair (Alpaca) and which deployment variables to name. The Alpaca panel's new Connection card renders `/broker/status` with that guidance — `Configured` / `Not configured`, the trading type, and the exact `ALPACA_PAPER_*` / `ALPACA_LIVE_*` names when unconfigured. The browser never asks for the secret.

#ceo-aimp
