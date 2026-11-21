### Added

- **Feeds page output and consumers (#6048, slice 2):** each feed row gains an **Output** action that reads a bounded preview of the latest persisted artifact through `GET /api/data-providers/:id/feed-artifact` (quotes, fundamentals, technicals, sentiment or chains; `limit` capped at 100) and offers a JSON download. The page also renders the catalog's declared **consumers** per job (`enrich`, `analyze`, `research`, `screener`, `feed jobs`, `options screens`), and the server carries `consumers` on `FeedPipelineCatalogEntry` / `FeedJobSurfaceView`.
- The preview is served only from the persisted copy — no provider is read — and a missing copy is the coded `FEED_ARTIFACT_MISSING` 404.

Replay is not in this slice: `replayRun` looks the original up by workflow id, so host-resident feed runs cannot replay; that engine gap is filed as #6058 and blocks the Replay control. The validated consumer graph remains #6049. #CAIO-quns
