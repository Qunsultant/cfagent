### #6278: chunk the Alpaca batch quotes fetch, bound each request, and surface the last leg error on a feed deadline

- `AlpacaMarketDataProvider.getQuotes` sends one ≤50-symbol `/v2/stocks/snapshots` request per chunk and merges the snapshots, so a whole-universe (~100 symbols) pull is no longer a single request that can burn the 60s fetch bound.
- Every Alpaca HTTP request carries the pipeline policy's per-fetch timeout (15s default, `PIPELINE_FETCH_TIMEOUT_MS` env knob, `pipeline.fetchTimeoutMs` setting) via `AbortSignal.timeout` in `throttledFetch`, so a hung connection fails fast instead of waiting for the 60s race.
- A feed run that dies at the 240s whole-run deadline mid-retry now carries the last leg error (codedError + attempt count) in its terminal error, so the next timeout is diagnosable from the production error. The 240s deadline itself is unchanged.
- Pinned by `tests/feed_timeout_chunking_6278.test.ts` (3 tests).
