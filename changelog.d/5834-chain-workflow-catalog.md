### Changed
- docs(workflows): record the `#5834` decided-not-to in `docs/architecture/transition/deprecations.md` (row `L4`) with grounds (`options-chain` shares `optionsscr` with `options-screener` per `#4774` and executes via `JobPipelineWorkflow` / `D1JobRunRecordStore` rather than `stageRuntimeIds` topic pub/sub) and pin it in `tests/options_chain_catalog_decision_5834.test.ts` (#5834)
