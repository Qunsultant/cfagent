### Added

- Alpaca's own watchlists are read through the neutral seam (#3434): `GET /api/broker/watchlists` serves `GET /v2/watchlists` mapped onto the platform's `BrokerWatchlist`, gated by `brokerSupports(broker, "watchlists")` like every other read.
- `AlpacaBrokerPanel` renders the account's saved lists (name + symbols) instead of a coded refusal, under the same `BrokerSurfaceGate`.

### Changed

- `BROKER_CATALOG.alpaca.supports.watchlists` is now `true`. The declaration was written when Alpaca was assumed to have no watchlist API; it does, and a stale `false` hides a real capability — the mirror image of the defect #3416 fixed.
- Pins updated in the same PR: `account_panel_parity_3359`, `broker_panel_contract_2853`, `alpaca_panel_history_3359` (each asserted the old absence).

### Not claimed

- Creating, renaming or deleting lists through the neutral seam. Alpaca supports those writes; the platform's write seam does not exist yet, so E*TRADE keeps its own routes and Alpaca is read-only for now.
- Alerts stay declared absent for Alpaca: the broker exposes no alerts API, and the panel keeps naming that gap.
