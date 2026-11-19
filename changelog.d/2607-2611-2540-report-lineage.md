### Changed
- **R2-pointer & full report lineage + Autopilot Run Details parity (#2607, #2611, #2540):**
  - Extended `CANONICAL_ARTIFACT_BACKFILL_FIELDS` with lineage fields (`captureIds`, `lineage`, `inputHash`, `engineVersion`, `catalogueVersion`, `rendererVersions`) and enabled R2-pointer backfill parity in `storeReportAtGenerationWithR2` (`src/services/scheduledReports.ts`).
  - Extended `RunDetail.lineage` (`src/services/runDetails.ts`, `src/client/components/RunDetailsModal.tsx`) with `storageMode`, `bodyR2Key`, `origin`, bidirectional `artifactLinks` (`artifact ↔ run ↔ capture`), and `incompleteFields` naming missing/unresolved lineage instead of guessing.
  - Wired `RunDetailsModal` into `AutopilotControlCenter` (`src/client/components/AutopilotControlCenter.tsx`) for Run Details parity on job outcomes.
