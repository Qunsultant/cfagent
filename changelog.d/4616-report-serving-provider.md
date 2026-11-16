### Added
- `#4616`: Added `servingProviderId` provenance stamping to `ScheduledReportInput`, `ScheduledReportRecord`, `CanonicalReportFanoutOutcome` (persisted on every new `mas_reports` row via `fanout_outcome` JSON), and `readReportServingProvider()` (legacy rows remain `NULL`/unset without synthetic backfill).
