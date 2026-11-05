### Added
- Alpaca sign-in: a user can now connect their own Alpaca account with their API key id and secret. The pair is verified against Alpaca for the trading type the platform will actually trade (`paper` or `live`) before anything is stored, then kept per user in the session store that already holds E*TRADE tokens. The Alpaca panel and the trading hub's Connect control show the sign-in card; signing out removes both trading types.
- `/api/broker/connect/alpaca` (GET status, POST sign-in) and `/api/broker/disconnect/alpaca` (POST sign out). The status read reports three separate facts — whether a pair is configured, whether *this* login signed in, and which source served it — so a deployment key is never presented as a user's connection.
- `BrokerStatus.credentialSource` (`user` / `deployment` / `none`) and `keyIdLast4`, so every surface can name where its credentials came from.

### Changed
- The Alpaca adapter resolves credentials per request: the signed-in user's verified pair wins, the deployment's `ALPACA_PAPER_*` / `ALPACA_LIVE_*` pair is the fallback, and neither present is reported as `none` rather than inferred as paper.
- The hub's "Connect Alpaca" control opens the sign-in card instead of verifying the deployment's secrets and reporting the result to whoever clicked.
- Alpaca credential guidance no longer claims the browser never asks for the key pair — it now does, once, and the secret is never shown again.

### Fixed
- Alpaca stated `configured: true` for a deployment while the panel asked a per-user question, and a failed Alpaca sign-in surfaced the upstream body. A rejected pair now renders one cataloged business message with its outcome code.
