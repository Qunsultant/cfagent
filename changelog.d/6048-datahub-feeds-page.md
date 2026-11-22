### Added

- **DataHub → Feeds (#6048, slice 1):** a new `?tab=data-hub&view=feeds` sub-view lists the stored-index feed family (four quote jobs, fundamentals, technicals, sentiment and the stored-universe job) with source, dataset, universe, state, last run, persisted rows/freshness and schedule, plus run/pause/resume/cancel/retry and schedule enable/disable through the existing per-job routes. The page reads `GET /api/data-providers` and links each row to its definition; it never fetches from a provider.
- **Feed-jobs list no longer renders "no jobs" when the pipeline host is unbound (#6046):** `feedJobsViewFor` falls back to `FEED_PIPELINE_CATALOG` joined with the dataset store, listing every registered job with `feed` = the real stored status and pipeline-only fields honestly null. `FeedPipelineCatalogEntry.family` (`index100`) and `FeedJobSurfaceView.family` carry the family, so the page filters by data, not by job-id pattern.

Pins: the DataHub hub arrays (views/labels/sub-items/surface values/deep links), the door-unbound route pin (now expects the catalog list), plus new tests for the family projection and the catalog fallback. #CAIO-quns
