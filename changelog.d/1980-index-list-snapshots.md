### Added

- **Stored index-list snapshots + scheduled refresh (#1980):** index lists for all six indices stored as snapshot-dated artifacts (`mas_index_lists`) on the feed-seam idiom, refreshed by ScheduledAgent goals (Wikipedia weekly, ETF holdings daily), and consumable by the screener as `opts.symbols` with stale lists refused or flagged, never silently served.
