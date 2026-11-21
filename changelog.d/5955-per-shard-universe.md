### Feed-family per-shard universe in `feed.pull` (#5955)

- `feed.pull` now reads the unit's shard universe from the shard table (the row for the unit's shard key, via the one shared `shardRowFor` reader) so one job definition serves multi-universe commands; precedence is explicit symbols (6b0) > shard universe > node `universe` param > job default.
- The four nasdaq100 quotes jobs (yahoo/alpaca/etrade/public) are now parameterized on the #3930 idiom (`parameterizedUniverse: true` in `nasdaq100QuotesJob`), so a run's `universe` input names the stored list it actually pulls. Backwards-compatible: no existing caller passed a universe input to a quotes job, and an absent input still resolves to nasdaq100.
- A universe-shard unit pulls its WHOLE universe, never a partition of it; the `feedShardSymbols` partition applies only when the shard row carries no universe (the feed family's own s0/s1 sharding).
- A shard universe with no stored index list (ETF / LEV_ETF) refuses by name (`FEED_UNIVERSE_UNKNOWN`) before any fetch; that coverage is 6b2's slice.
- Pinned by `tests/feed_per_shard_universe_5955.test.ts` (9 tests): each ALL unit fetches its own whole universe; monolith single-universe runs unchanged; explicit symbols still win; partition sharding unchanged.
