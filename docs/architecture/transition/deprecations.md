# Deprecation ledger

Single ledger for rename-based deprecations (gitops.md §22). Deprecated
files are frozen: no new features, no new consumers, refactoring only
to migrate consumers off them. Deletion needs zero consumers plus an
owner decision plus a gate amendment, and is never part of a program
slice.

## 2026-10-29 — outcome catalog supersedes the error catalog (#2381)

- File: `src/errors/errorAspects.ts` → `src/errors/errorAspects.deprecated.ts`
- File: `src/errors/errorCatalog.json` → `src/errors/errorCatalog.deprecated.json`
- Date: 2026-10-29
- Reason: Issue #2381 replaces the failure-only error catalog with the
  unified outcome catalog (success + failure, outcome-encoded names
  `SUCCESS_*` / `FAILURE_*`). The old cryptic codes
  (`AUTH_*`, `SCREEN_*`, `REPORT_*`, `DELIVER_*`, `SYS_001`, `QUOTE_*`,
  `WATCHLIST_001`, `DATA_001`, `MCP_001`) are retired as emitters;
  pre-rename stored values still resolve at read time through the
  outcome catalog's `legacyAliases` map.
- Replacement: `src/outcomes/outcomeCatalog.json` +
  `src/outcomes/outcomeAspects.ts` (single catalog, single resolver).
- Consumers at deprecation: none — every importer was migrated to the
  outcome module in the same slice (emitters, P1 channel renderers,
  and the report parsers now resolve through `outcomeAspects`).
- Deletion condition: zero consumers (already met) plus an owner
  decision plus a gate amendment; deletion is outside the #2381
  program slices. Retain until the owner confirms no pre-rename
  debugging still needs the frozen originals.

## 2026-11-08 — anti-drift framework supersedes the anti-drift controls document (#3802)

- File: `docs/compliance/anti-drift-controls.md` → `docs/compliance/anti-drift-controls.deprecated.md`
- Date: 2026-11-08
- Reason: Two documents stated the same anti-drift thesis, the same active
  controls, and the same eight mandatory future controls (the standards-set
  survey under #3791 found the duplication). One subject, one home: the
  framework document is the surviving home.
- Replacement: `docs/compliance/anti-drift.md` (single anti-drift home;
  the controls document's one unique control — zero-FOUC pre-paint
  hydration — was folded into its §2 in the same slice).
- Consumers at deprecation: the standards set README
  (`docs/architecture/code/README.md`) and
  `docs/compliance/facts-n-findings-01.md` referenced the controls path;
  both were updated in the same slice. The compliance-docs pin
  (`tests/compliance_docs.test.ts`) now asserts the deprecated path.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.
- Archive addendum (2026-11-09, #3802): the rename above initially left a
  stale un-headered original at `docs/compliance/anti-drift-controls.md`
  (the ship script created the `.deprecated.md` copy but never removed the
  old path). On the user's direction it was moved, unchanged, to
  `docs/archive/anti-drift-controls.md` as a true rename, so the old
  compliance path no longer resolves as a live document. This entry's
  retirement record is unchanged: the frozen retirement copy remains
  `docs/compliance/anti-drift-controls.deprecated.md`.

## 2026-11-11 — unified schedule store supersedes the duplicated per-kind schedule paths (#3123)

- File: `src/data/pausedSchedulePorts.ts` → `src/data/pausedSchedulePorts.deprecated.ts`
- File: `src/data/doSqlitePausedScheduleAdapter.ts` → `src/data/doSqlitePausedScheduleAdapter.deprecated.ts`
- File: `src/data/inMemoryPausedScheduleAdapter.ts` → `src/data/inMemoryPausedScheduleAdapter.deprecated.ts`
- File: `src/services/scheduleManagement.ts` → `src/services/scheduleManagement.deprecated.ts`
- File: `src/client/scheduleApi.ts` → `src/client/scheduleApi.deprecated.ts`
- Date: 2026-11-11
- Reason: Issue #3123 (sub-issue of #3121) unifies the six schedule
  stores, the split run ledger, and the ten management code paths
  into one ScheduleStore port, one ledger write entry, and one
  management service. Pause becomes a record state in
  `unified_schedules` instead of a copy in `paused_schedules`;
  the goals KV key migrates into the store; the client modules
  converge onto `jobsApi.ts`. The five modules above are the
  duplicated halves and are frozen, not deleted.
- Replacement: `src/data/unifiedSchedulePorts.ts` +
  `src/data/doSqliteUnifiedScheduleAdapter.ts` +
  `src/data/inMemoryUnifiedScheduleAdapter.ts` +
  `src/data/createUnifiedSchedulePorts.ts` (store);
  `src/services/unifiedLedger.ts` (`recordLedgerRun`, merged read
  `GET /api/ledger/runs`); `src/services/unifiedScheduleManagement.ts`
  (management); `src/client/jobsApi.ts` (client wrappers, incl.
  `listAllRuns`).
- Consumers at deprecation: none in production — every importer was
  migrated in the same slice (routes, panels, maintenance, tests).
  The frozen `paused_schedules` table and its adapter still own the
  legacy table for old instances; the retention registry
  (`src/privacy/privacyDsar.ts`) keeps a KEEP rule for it alongside
  the new `unified_schedules` rule. The legacy `paused_schedules`
  DDL fixtures in `tests/async_jobs_step4a_characterization_2358.test.ts`,
  `tests/data_lifecycle_3250.test.ts`, and
  `tests/orchestrator_migration_2681.test.ts` still assert the old
  table's shape (migration copies its rows); they are fixtures, not
  consumers.
- Deletion condition: zero consumers plus an owner decision plus a
  gate amendment; deletion is never part of a program slice. The
  legacy `paused_schedules` table itself is deleted only with the
  frozen adapter, under the same conditions.

## 2026-11-12 — engine-routed options screens supersede the direct entry points (#4068)

- Function: `runPanelPipeline` → `runPanelPipelineRetired4068` (`src/trading/options/panelPipeline.ts`)
- Function: `screenOptionsWithSource` → `screenOptionsWithSourceRetired4068` (`src/trading/optionChainSource.ts`)
- Function: `UnifiedOptionsService.screenContracts` → `screenContractsRetired4068` (`src/trading/options/unifiedOptionsService.ts`)
- Function: `UnifiedOptionsService.scanOpportunities` → `scanOpportunitiesRetired4068` (`src/trading/options/unifiedOptionsService.ts`)
- Date: 2026-11-12
- Reason: Issue #4068 (sub-issue of #3551) routes every options screen
  through the one engine-routed workflow (`runOptionsScreenViaEngine`,
  `src/workflows/optionsScreenEngine.ts`) — the 9 direct
  `runOptionsScreenWorkflow` call sites and the four bypasses above. No
  options screen executes outside the workflow after this slice. The four
  functions are the bypasses: the direct panel pipeline, the direct plain
  screen, and the service's direct screen/scan statics. They are frozen,
  not deleted, and keep their `@deprecated` marker naming the successor.
- Replacement: `runOptionsPanelViaEngine` (panel),
  `runOptionsPlainScreenViaEngine` (plain screen),
  `runOptionsScanViaEngine` (scan) — all in
  `src/workflows/optionsScreenEngine.ts`, all executing the same
  decomposition through the engine's `options.runStage` step.
- Consumers at deprecation: no production callers remain. Tests that pin
  the workflow decomposition keep calling the retired names:
  `runPanelPipelineRetired4068` (panel/strategy/kernel-parity suites),
  `scanOpportunitiesRetired4068` (the per-symbol shard parity test).
  `tests/options_stage_vocabulary_4067.test.ts` still asserts the OLD
  name `runPanelPipeline` is absent from `src/workflows/stageRuntimeIds.ts`
  — that assertion is about the catalog file, not the renamed function.
- Known remaining direct panel call (NOT retired here, follow-up):
  `runPanelWithAgents` at `src/services/scheduledTasks.ts:4183` (the
  scheduled firer) — it constructs shared `PanelAgents` once from the
  scheduled universe deps and passes them to both `runPanelWithAgents` and
  agent methods; routing it needs the engine panel helper to accept
  pre-built agents or universe deps. Recorded in the #4068 PR body and
  §15 draft.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.
