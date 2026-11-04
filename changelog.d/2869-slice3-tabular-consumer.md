### Added

- #2869 slice 3: chain tabular generate legs (XLSX/CSV) now run through the tabular-aware stage consumer (`src/workflows/stageTabularConsumer.ts` — persisted assemble dataset only, format-specific durable claims with release-on-failure, injected generate/store, poison dead-lettered). Chain PDF leg stays with its single owner, runReportPipeline; monolithic tabular legs stay in the one generation module (stockReportArtifacts).
