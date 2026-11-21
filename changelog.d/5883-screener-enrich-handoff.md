### #5883 — screener enrich hand-off (#4437 slice 6a)

- Added `enrich.screener` (`src/services/enrichPipelineJobs.ts`): a screener enrich application beside `enrich.apply` that runs the enrich job identically and returns the gather-shaped hand-off (`acquired.quotes` + lineage) the `analyze.screener` hand-off mode consumes, pinned by `tests/screener_enrich_handoff_5883.test.ts`.
- Recorded the feed freshness decision: the re-pointed chain fetches once per run, so the remaining loss is only cross-run dedup within minutes; a feed-node freshness check is a separate feed-family change set, filed as its own follow-up.
- The feed node flips to `feed.pull` in 6b, not this slice: flipping it alone breaks the bespoke gather.
