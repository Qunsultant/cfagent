### #6208: chunk the Alpaca option snapshots fetch to ≤100 symbols and log the upstream 400 body server-side

- `fetchAlpacaOptionSnapshots` sends one `symbols=` parameter per ≤100-symbol chunk (Alpaca documents the multi-contract snapshots limit as 100) and merges the results, so an expiry with 100–400 contracts is no longer rejected with HTTP 400.
- A failed chunk logs the upstream error body server-side (truncated to 500 chars) while the caller still gets the short `Alpaca option snapshots unavailable [HTTP 400].` message.
- Pinned by `tests/alpaca_option_snapshots_chunking_6208.test.ts` (3 tests); neutrality census `optionsData.ts alpaca` 25→27.
