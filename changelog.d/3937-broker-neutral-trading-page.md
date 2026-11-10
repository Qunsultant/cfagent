### Broker-neutral trading page (#3937)

- One broker default everywhere: `resolveTenantBroker` now falls back to the platform default (alpaca) instead of the legacy etrade fallback, so neutral routes, legacy surfaces, options routes, copilot, and panels resolve the same selected broker; mode still defaults to paper (TEST, #3857).
- E*TRADE adapter serves the reads the catalog declares: `getOrderHistory`, `getAccountActivity`, `getWatchlists`, plus `getAlerts` through the new `GET /broker/alerts`; a declared-but-unimplemented capability answers `BROKER_CAPABILITY_NOT_IMPLEMENTED`, never `provider_unsupported`.
- Cancel-ticker and cancel-all serve the selected broker through the same engine (Alpaca keeps its service port; other brokers run over the platform adapter), with per-broker ledger identity; the alpaca-only gates are gone.
- The broker panel speaks for the selected broker (gates, copy, trading type, credential guidance, sign-in card) and renders the broker's own alerts; the hub passes the selected broker and its diagnostics fallback is the platform default.
