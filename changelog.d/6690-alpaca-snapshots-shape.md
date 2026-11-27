### Fixed

- Alpaca batch quotes (#6690): `getQuotes` now parses the documented top-level symbol map from `/v2/stocks/snapshots` instead of the wrapped `data.snapshots` shape, which merged zero snapshots on every healthy 2xx and failed the feed leg with "returned no results". A malformed body is now its own named failure, the terminal empty-result error carries response-shape evidence (HTTP status, feed, snapshots present/unusable, requested), and feed selection is externalized via `ALPACA_STOCKS_FEED` (unset keeps Alpaca's entitled default).
