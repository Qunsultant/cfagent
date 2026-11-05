### Fixed
- The hub's Sync control follows the selected broker. It used to call `GET /api/etrade/diagnostics` for every selection — a route that answers about E*TRADE's OAuth session — and reported a latency it invented when the answer carried none. E*TRADE keeps its diagnostics (and its two window events); every other broker now reads its own `GET /api/broker/status` and reports the configured state with a locally measured round trip.
- The autopilot's autonomous-action feed reads `GET /api/broker/orders` instead of `GET /api/etrade/orders`. Both return the same stored draft ledger; the neutral name is the honest one for a broker-neutral table, and it is what a non-E*TRADE tenant should call.

### Changed
- `brokerEndpoints.syncTarget(broker)` is the one place the Sync target is decided, next to the existing `diagnosticsEndpoint` / `statusEndpoint` helpers.
