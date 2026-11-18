### Changed

- **Data model (#5034):** Moved `mas_learnings`, `mas_cancel_previews`, `mas_ladder_states`, and the `mas_promotions` active-check read behind data-layer ports and DO SQLite adapters (`src/data/learningsStorePorts.ts`, `doSqliteLearningsAdapter.ts`, `cancelPreviewPorts.ts`, `doSqliteCancelPreviewAdapter.ts`, `ladderStatePorts.ts`, `doSqliteLadderStateAdapter.ts`, `promotionsReadAdapter.ts`), retired their 18 sites from `tests/global_dd_census_2356.test.ts`, and updated `docs/architecture/data/data-model.md` §5 (D-6).
