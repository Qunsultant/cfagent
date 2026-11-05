### Added
- Alpaca account history: the Alpaca panel now renders the broker's own order history (`GET /v2/orders`, all statuses) and account activity (`GET /v2/account/activities`, in Alpaca's own activity vocabulary — FILL, DIV, FEE, …). Both read through new neutral routes, `GET /api/broker/orders/history?status=open|closed|all` and `GET /api/broker/activities?type=…`, so no surface calls `/api/etrade/*` for an Alpaca tenant.
- `BrokerOperation` gains `orderHistory`, `accountActivity`, `alerts` and `watchlists`; the broker panel contract gains the matching surfaces. Availability is derived from the catalogue, as for every other surface.

### Changed
- Alpaca's order statuses are mapped totally onto the platform's vocabulary, with the broker's own word carried in `rawStatus`. A status the platform does not model reads `UNKNOWN (suspended)` rather than being shown as open or rejected.
- A failed history or activity read is a coded failure (`BROKER_ORDER_HISTORY_FAILED` / `BROKER_ACTIVITY_FAILED`), never an empty table that would read as "you have no orders".

### Notes
- Alerts and watchlists are declared as Alpaca gaps and render the catalogued, named refusal (`FAILURE_BROKER_UNAVAILABLE`) instead of an empty section. Alpaca has no alerts model, and its watchlists are not the platform's E*TRADE-shaped watchlist store.
- E*TRADE is unchanged: same panel, same endpoints, same rows.
