### Fixed

- **Data Providers panel read bound (#6705):** `GET /data-providers` no longer hangs when the pipeline host door never answers — every door list read races the externalized `DATA_PROVIDERS_PANEL_READ_MS` bound (default 10s, named code `DATA_PROVIDERS_PANEL_READ_TIMEOUT`) and degrades to the existing honest fallbacks (feed catalog, empty family lists), and the list route fetches each door list once per request instead of once per provider.
