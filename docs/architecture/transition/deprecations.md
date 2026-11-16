# Deprecation ledger

Single ledger for rename-based deprecations (gitops.md §22). Deprecated
files are frozen: no new features, no new consumers, refactoring only
to migrate consumers off them. Deletion needs zero consumers plus an
owner decision plus a gate amendment, and is never part of a program
slice.

## 2026-11-16 — S-U4 retires workflowRuns.css in place (#4820)

- File: `src/client/workflowRuns.css` → retired in place (no rules remain)
- Date: 2026-11-16
- Reason: Issue #4820 (sub of #3695, S-U4) migrates `src/client/WorkflowRunsPanel.tsx` to primitives and tokens; the sheet's sole importer no longer imports it and no other consumer exists. The sheet stays on disk (no file deletion, gitops §22) with a deprecation header naming its successor.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities, incl. the new `ui-label`, `ui-mono`, `ui-pre`, `ui-scroll-x`, `ui-clip`, `ui-grow`) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none — the sole importer was migrated in the same slice.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-15 — UX docs consolidation D0 retires three stale UX docs to docs/archive/ (#4632)

- File: `docs/architecture/UX/design-system-01.md` → `docs/archive/design-system-01.md`
- File: `docs/architecture/UX/assessment-01.md` → `docs/archive/assessment-01.md`
- File: `docs/architecture/UX/exceptions-01.md` → `docs/archive/exceptions-01.md`
- Date: 2026-11-15
- Reason: Issue #4632 (sub of #3695, W6 docs consolidation) makes `docs/architecture/UX/` the one home for UX docs. These three are stale: design-system-01 is superseded in substance by the consolidated-design-system draft (#3096) and carries stale counts (C1, C2, C4) plus a self-contradictory header; assessment-01 and exceptions-01 are 2026-10-25 point-in-time snapshots, partially addressed or superseded since (C5, C6). They move to `docs/archive/` (Ceos decision Q4) so the folder holds only live, draft, and pattern docs, indexed by its new README.
- Replacement: `docs/architecture/UX/consolidated-design-system.md` (DRAFT, #3096) for design-system-01; no successor for the two snapshots — their live state is the gates (`tests/ux_primitive_usage_freeze_1580.test.ts`, token ratchet, contrast gate) and `docs/architecture/security/ux-primitives-1772-verification.md` (44/44 converted).
- Consumers at deprecation: `docs/architecture/UX/consolidated-design-system.md` §4 source map and C1–C10 analysis (citations updated to the archive paths in this slice); `docs/architecture/ADD.md` (three links updated); `docs/compliance/anti-drift.md` (assessment-01 path updated); `docs/architecture/security/ux-primitives-1772-verification.md` (exceptions-01 audit-source path updated); `docs/architecture/standards/standards.md` §9.1, `docs/architecture/standards/stock-programme-evidence.md`, `docs/architecture/blueprint/blueprint-01.md`, `docs/architecture/code/component-taxonomy-01.md`, `docs/architecture/evolution/evolution-01.md`, `docs/architecture/plan/plan-01.md`, `docs/compliance/facts-n-findings-01.md`, `docs/compliance/system-duplicates-scan-1717-appendix-p-docs-architecture.md` (paths updated in this slice); the neutrality census baseline rows (updated to the archive paths); `tests/ux_primitives_exceptions_1772.test.ts` (comment cite updated). Historical records left as-is: `docs/architecture/adr/0003-messaging-port.md`, `CHANGELOG.md`, `changelog.d/2860-standards-evidence.md`, and bare-name comment cites in code and tests (the filename is unchanged).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-12 — the scheduled firer routes through the engine panel (#4275)

- Function: `runPanelWithAgents` → `runPanelWithAgentsRetired4275` (`src/trading/options/panelPipeline.ts`)
- Date: 2026-11-12
- Reason: Issue #4275 (#3551 follow-up) routes the scheduled firer
  (`runDiscoveryRequest`, `src/services/scheduledTasks.ts`) — the ONE
  remaining direct panel call recorded in the #3551 §15 — through the
  engine-routed panel. The engine panel helper accepts pre-built
  agents (`runOptionsPanelViaEngineWithAgents`), the shape the #4068
  entry below prescribed: the firer constructs shared `PanelAgents`
  once from the scheduled universe deps. No scheduled options screen
  executes outside the engine-routed workflow after this slice.
- Replacement: `runOptionsPanelViaEngineWithAgents`
  (`src/workflows/optionsScreenEngine.ts`), over the firer's
  pre-built agents; `runOptionsPanelViaEngine` delegates to it.
- Consumers at deprecation: no production callers remain. Tests that
  pin the panel decomposition keep calling the retired name
  (strategy-screen workflow parity suite).
- Deletion condition: zero consumers plus an owner decision plus a
  gate amendment; deletion is never part of a program slice.

## 2026-11-12 — the one workflow engine supersedes the bespoke screener flow (#4192)

- File: `src/workflows/screenerWorkflowFlow.ts` → `src/workflows/screenerWorkflowFlow.deprecated.ts`
- Date: 2026-11-12
- Reason: Issue #4192 (#3550 S2 cutover) moves production screens onto
  the one workflow engine. The bespoke child-workflow fan-out
  (`runParentFlow` / `runShardFlow`: fan-out, poll loop, child
  workflows, `SHARD_DONE_EVENT`) is a parallel stage model, which
  #3550's body forbids. The engine owns fan-out, retries, and stage
  control now; the flow's pure collation helpers live on in
  `src/workflows/screenerCollation.ts` (one home, no copy).
- Replacement: `src/workflows/screenerWorkflow.ts` (engine dispatch)
  + `src/workflows/screenerCollation.ts` (collation) +
  `src/services/screenerPipelineJobs.ts` (definition, six nodes).
- Consumers at deprecation: none — every importer was migrated to the
  engine path or to `screenerCollation.ts` in the same slice
  (`screenerWorkflow.ts`, `inMemoryWorkflowAdapter.ts`, and the
  flow/mesh/goal/stage test suites).
- Deletion condition: zero consumers (already met) plus an owner
  decision plus a gate amendment; deletion is never part of a program
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
  §15 draft. Resolved by #4275 (2026-11-12): the helper accepts
  pre-built agents (`runOptionsPanelViaEngineWithAgents`), the firer
  routes through it, and the function is retired by rename — see the
  #4275 entry at the top of this ledger.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.

## 2026-11-12 — scheduled sharded chain onto the engine (#4280)

- Function: `startScheduledShardedChain` → frozen in place as
  `src/workflows/startScheduledShardedChain.deprecated.ts` (no rename;
  the module IS the deprecation marker, with an `@deprecated` tag
  naming the successor)
- Date: 2026-11-12
- Reason: Issue #4280 (sub-issue of #3550, [One engine] S5) routes the
  scheduled sharded chain through the one engine seam
  (`submitStockScreenViaEngine`, `src/workflows/runStockScreenViaEngine.ts`)
  — the chain's submit-and-return contract, the engine job id IS the
  chain id, and the delivery envelope + stageChain ride the workflow
  command to the deliver stage. The G7 note's three conditions are now
  met (stageChain-in-workflow, chain-run-model migration, channel
  plumbing). No scheduled screen executes outside the engine after
  this slice. The function is frozen, not deleted, and keeps the
  broker's old chain start (planFeedStart + the shardSubmit async-job
  port) exactly as it was.
- Replacement: `submitStockScreenViaEngine`
  (`src/workflows/runStockScreenViaEngine.ts`), called by
  `ScheduledTasksService.autonomousMarketScreenSharded` with
  `jobId = chainId`. Chain-mode scheduled goal screens ride the goal
  workflow instead (`buildGoalScreenCommand` carries `stageChain` +
  `slackChannel`; the workflow's deliver stage bridges).
- Consumers at deprecation: no production callers remain — the one live
  caller (`autonomousMarketScreenSharded`) was migrated in the same
  slice. Tests that pin the retired shape keep calling it:
  `tests/g7_callers_2914.test.ts` (chain-start describe),
  `tests/scheduled_sharded_chain_4280.test.ts` (no-live-chain-calls
  pin allows the deprecated module + tests).
- Known remaining direct call (NOT retired here, out of scope):
  `planFeedStart` (`src/services/shardJobs.ts`) is now unreachable in
  live code — its only caller is the deprecated module. It is kept,
  never deleted; the options sharded chain still uses the `shardSubmit`
  port (`autonomousOptionsAnalysis`), which stays.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.
