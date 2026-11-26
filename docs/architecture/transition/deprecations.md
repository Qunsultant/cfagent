# Deprecation ledger

Single ledger for rename-based deprecations (gitops.md §22). Deprecated
files are frozen: no new features, no new consumers, refactoring only
to migrate consumers off them. Deletion needs zero consumers plus an
owner decision plus a gate amendment, and is never part of a program
slice.

## One-engine out-of-scope tracker (#4789)

Every one-engine slice that leaves something out of scope records the
leftover in this table AND in #4789's body table, with its own
follow-up issue — a ledger line alone is not a home. This table is the
durable record; #4789's body table mirrors it. Update both together
when a row's state changes or a new leftover is found.

Scope: this tracker covers one-engine slices only. Other entries in
this ledger carry the standard deletion condition (zero consumers plus
an owner decision plus a gate amendment) and get no tracker rows.

| # | Leftover | Left out of | Follow-up | State |
|---|---|---|---|---|
| L1 | The options sharded chain still runs through the bespoke `shardSubmit` async-job port (`autonomousOptionsAnalysis`) | #4280 | #4780 | RESOLVED 2026-11-17 (PR #5142) |
| L2 | `runPanelWithAgents` at `src/services/scheduledTasks.ts:4183` (the scheduled firer) — routing it needed the engine panel helper to accept pre-built agents | #4068 | #4275 | RESOLVED 2026-11-12 |
| L3 | The engine options chain does not write the serve-record summary row (`recordOptionsServeReport` needs a `DatabaseORM` the step residency has no handle to) | #4780 | #5170 | RESOLVED 2026-11-19 |
| L4 | The chain job is not in `workflowCatalog` (its six stages differ from the options-screener family's eight), so it has no Workflow Runs visibility | #4780 | #5834 | DECIDED NOT TO 2026-11-19 (`options-chain` shares `optionsscr` with `options-screener` per #4774 and runs via `JobPipelineWorkflow` / `D1JobRunRecordStore`) |
| L5 | `src/config/shardPacing.ts` (+ `config/shard-pacing.json`) is unreferenced by `src/` — its only consumer is `tests/sharded_jobs_p1355.test.ts:33,773-776` | #4780 | #5833 | RESOLVED 2026-11-19 |
| L6 | `planFeedStart` (`src/services/shardJobs.ts`) is unreachable in live code — its only caller is the frozen deprecated module | #4280 | — | KEPT (by design; #4776 removes the frozen module, its only caller) |

Recorded, not rows (decisions, no follow-up needed): #4423 retry
lineage is not carried in the canonical body — the workflow step
journal is the retry record; the blob seam refuses by name
(`OPTIONS_CHAIN_REPORTS_BUCKET_UNBOUND`) when `REPORTS_BUCKET` is
unbound, rather than silently dropping bytes to legacy DO storage.

## 2026-11-25 — #6040 retires the Copilot research door (one dispatch)

- File: `src/agents/orchestrator/meshResearchDoor.ts` → `src/agents/orchestrator/meshResearchDoor.deprecated.ts`
- Date: 2026-11-25
- Reason: Issue #6040 (sub of #5973). The door was the #5123 Copilot path for `research:<runId>`, but no production module imported it and its deterministic `execute` returned a literal `{mode: "deterministic"}` — a dispatched run that ran nothing, so the audit trail reported a run that never happened. The Copilot surface is the `run_research_job` MCP command, which now dispatches through `dispatchResearchEngineRun` with a real six-stage target; keeping a second door beside it would leave two dispatch paths for one event, one of them hollow.
- Replacement: `dispatchResearchEngineRun` (`src/workflows/researchScreenEngine.ts`) with a `ResearchDispatchTarget`, driven by the `run_research_job` command (`src/mcps/openaimp/researchJobCommands.ts`); per-stage control is `executeResearchStageControl` over `(runId, stageId)`.
- Consumers at deprecation: none in live code — the only importers were three tests (`tests/research_agentic_5123.test.ts`, `tests/research_door_mcp_durable_5286.test.ts`, `tests/research_real_deps_5287.test.ts`), repointed to the deprecated path in the same slice and still running.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice. The HITL #277 deliver gate (`evaluateResearchDeliverHitlGate`) stays frozen here until a production deliver-stage gate supersedes it.

## 2026-11-22 — #6165 retires the second grant surface (one admin-creation path)

- Routes: `POST /api/iaaa/role-grants/grant` and `POST /api/iaaa/role-grants/revoke` (`src/server/routes/auth.ts`)
- Date: 2026-11-22
- Reason: Issue #6165 (sub of #945). Creating an admin existed in two grant surfaces: the Members-tab grant (`POST /api/iaaa/membership/grant`) and the Role grants section (`POST /api/iaaa/role-grants/grant`). Both mint through the same `grantMembership` seam, so the second surface was pure duplication. The Members tab is the one grant surface; the Role grants section keeps only its read-only admin-role list and points at the Members tab.
- Replacement: `POST /api/iaaa/membership/grant` (grant) and the Members-tab revoke/edit (revoke). Client `grantRoleGrant` / `revokeRoleGrant` (`src/client/roleGrantsApi.ts`) are `@deprecated` and frozen.
- Consumers at deprecation: `RoleGrantsPanel` no longer calls either function; `tests/iaaa_role_grants_2688.test.ts` still exercises the routes as deprecated aliases (behavior unchanged).

## 2026-11-22 — #6074 retires runGoalScreenOnEngine by deprecation

- Name: `runGoalScreenOnEngine` (`ScreenerAgent`, `src/agents/screener-agent.ts`)
- Date: 2026-11-22
- Reason: Issue #6074 ([One engine] #4437 slice 6d-c, sub-issue of #5886) re-points the goal step's default runner off the legacy dispatch: the `screener.goal` step now runs the 6d-a goal composition itself (`runGoalScreenComposition` in `src/services/screenerPipelineJobs.ts`), and the goal options leg runs the options-pipeline nodes in-process (`runGoalOptionsLegOnEngineNodes`) instead of the `optionsWorkflow` dep call. The method is retired, not deleted, per gitops §22 — like `runGoalScreen`, which stays as the registry-leg implementation.
- Replacement: `runGoalScreenComposition` (`src/services/screenerPipelineJobs.ts`) — the eight `goal.*` steps threaded in-process on the captured registry; old stored definitions (single `screener.goal` step) run the composition through it.
- Consumers at deprecation: none in live code — `screenGoalStage`'s default branch was the only caller and now defaults to the composition; the method stays public and pinned by the 6072/4192/6074 suites.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-22 — #6180 deprecates the store-operator legacy-list reads

- Name: the store-operator legacy-list fallback reads — the `COMMERCIAL_STORE_OPERATORS` env list plus the AGENT_DB store operators list, read via `listEffectiveOperatorLogins` / `parseEnvOperators` (`src/data/createStoreOperatorsPorts.ts`)
- Date: 2026-11-22
- Reason: Issue #6180 brings store-operator under IAAA as a tenant-scoped `store-operator` role binding. The env list + store list were a second, login-keyed, unrevocable, unaudited admin gate (capability map §7.2, "Two admin gates"); they are now a deprecated fallback only, kept so no operator loses access during the migration. An unresolvable login keeps access through the fallback until it signs in and the migration mints its membership.
- Replacement: tenant-scoped store-operator memberships — one gate helper `src/security/storeOperatorGate.ts`, migration `src/security/storeOperatorMigration.ts`, `/operators/add` + `/operators/remove` minting/revoking memberships through the grant route's machinery.
- Consumers at deprecation: the six gate sites (`src/agents/routes/dataLifecycle.ts`, `dlq.ts`, `platformChannels.ts`, `platformTenants.ts`, `agenticPayments.ts`), the `/operators` list (env/store rows), and `src/client/StoreOperatorsPanel.tsx` (env/store rows + Expires column).
- Deletion condition: follow-up #6185 (OPEN) — zero consumers of the fallback reads plus live verification that every effective operator holds a store-operator membership, plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-20 — #5915 supersedes the research cutover flag

- Name: `research_engine_cutover` (feature flag key)
- Superseded by: `research_engine_direct_rollback` — same capability, inverted meaning and an explicit name
- Date: 2026-11-20
- Reason: Issue #5915. While the cutover flag could be turned off, the nightly research job took the direct path, which maps every stage to `completed` without running an engine stage and therefore has no retry/pause/cancel. The engine is now the default and the only supported path; the direct branch is reachable solely through the explicitly named emergency flag, so ordinary configuration cannot produce `direct_rollback`. `research_engine_cutover` is no longer read.

## 2026-11-18 — #4253 retires the red probe by rename

- File: `tests/scheduled_goals_removal_red_4253.test.ts` → `tests/scheduled_goals_removal_red_4253.deprecated.ts`
- Date: 2026-11-18
- Reason: Issue #4253's temporary red probe proved the durable-removal bug on pre-#4253 code (a removed built-in goal was re-seeded when the goals list emptied); its red was observed before the fix landed. Per gitops §22 the file is retired by rename, never deleted. Its pins live on, rebuilt for current main's nine goals, in `tests/scheduled_goals_config_4253.test.ts` (4253-P02, 4253-P03).
- Replacement: `tests/scheduled_goals_config_4253.test.ts`.
- Consumers at deprecation: none — the file was a standalone probe, imported by nothing.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames styles.css to styles.deprecated.css (#5178)

- File: `src/client/styles.css` → `src/client/styles.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): the shared sheet is renamed in place, its sole importer (`src/client/main.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 1,296 selectors, 456 with live users in 68 files (heaviest: `BrokerDynamicMenu.tsx`, `landing.ts`, `ScannerPanel.tsx`, `StrategyDiscoveryPanel.tsx`, `ETradeTradingHub.tsx`, `Chat.tsx`, plus ~20 test files asserting on classes).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 68 files use its live selectors (see Reason).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames options/strategyDiscovery.css to strategyDiscovery.deprecated.css (#5178)

- File: `src/client/options/strategyDiscovery.css` → `src/client/options/strategyDiscovery.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its 5 importers updated to the new path, and a deprecation header added. Rules unchanged. 477 selectors, 357 with live users in 23 files (`StrategyDiscoveryPanel`, `OptionsResearchPanel`, `RiskAnalysisModal`, `LlmStrategyEvalModal`, `OptionsDataDownloadDropdown`, `StrategyLibraryModal`, `FlowFiltersSidebar`, `ScannerPanel`, `PortfolioPanel`, `ScheduledOptionsManager`, `RawContractsScreener`, `StockSearchBar`, `MarketTickerTape`, `BrokerDynamicMenu`, `landing.ts`, `Field.tsx`, `AgentChatTabContent`, `OptionsStrategyCard`, `McpApiExplorer`, `StrategyReviewPanel`, `PortfolioRiskPanel`, `WorkflowRunsPanel`).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 23 files use its live selectors (see Reason).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames workflowsHub.css to workflowsHub.deprecated.css (#5178)

- File: `src/client/workflowsHub.css` → `src/client/workflowsHub.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/WorkflowsHub.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 113 selectors, 8 with live users in 6 files (`BrokerDynamicMenu`, `MarkdownContent`, `StockSearchBar`, `landing.ts`, `StrategyDiscoveryPanel`, `LiveResultPreview`); 105 selectors with no static use (WorkflowsHub migrated in S-U3).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 6 files use its live selectors (see Reason).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames accountPanels.css to accountPanels.deprecated.css (#5178)

- File: `src/client/accountPanels.css` → `src/client/accountPanels.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/AccountPanels.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 14 selectors, all 14 with live users in 1 file.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `AccountPanels.tsx` uses all 14 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames agenticWalletPanel.css to agenticWalletPanel.deprecated.css (#5178)

- File: `src/client/agenticWalletPanel.css` → `src/client/agenticWalletPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/AgenticWalletPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 27 selectors, 26 with live users in 2 files (`AgenticWalletPanel.tsx` + its test); 1 unused (`simulated`).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `AgenticWalletPanel.tsx` (+ its test) use 26 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-22 — #6164 retires the four IAAA deprecated sheets (zero consumers)

- Files: `src/client/iaaaAdminPanel.deprecated.css`, `src/client/loggedInUsersPanel.deprecated.css`, `src/client/roleGrantsPanel.deprecated.css`, `src/client/serviceTokensPanel.deprecated.css`
- Date: 2026-11-22
- Reason: Issue #6164 (sub of #945) migrated all 7 consumers to the ui primitives only (Stack/Flex/Card/Notice + `ui-meta`/`ui-mono`/`ui-danger`, the ApiKeysPanel pattern) and removed all 4 imports. No file imports any of the four sheets anymore; zero consumers. The sheets stay on disk — deletion still needs an owner decision plus a gate amendment (gitops §22); deletion is never part of a program slice.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers now: none.
- Deletion condition: zero consumers (met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames iaaaAdminPanel.css to iaaaAdminPanel.deprecated.css (#5178)

- File: `src/client/iaaaAdminPanel.css` → `src/client/iaaaAdminPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/IaaaAdminPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 8 selectors, 3 with live users in 3 files — `ServiceUserSection.tsx`, `AdminQueueWipePanel.tsx`, `PolicyProposalsPanel.tsx` — NOT the importer (`IaaaAdminPanel.tsx` uses 0 of its 8 selectors); 5 unused.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `ServiceUserSection.tsx`, `AdminQueueWipePanel.tsx`, `PolicyProposalsPanel.tsx` use 3 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames loggedInUsersPanel.css to loggedInUsersPanel.deprecated.css (#5178)

- File: `src/client/loggedInUsersPanel.css` → `src/client/loggedInUsersPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/LoggedInUsersPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 19 selectors, all 19 with live users in 2 files (`LoggedInUsersPanel.tsx`, `BootstrapProposalsPanel.tsx`).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `LoggedInUsersPanel.tsx` + `BootstrapProposalsPanel.tsx` use all 19 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames roleGrantsPanel.css to roleGrantsPanel.deprecated.css (#5178)

- File: `src/client/roleGrantsPanel.css` → `src/client/roleGrantsPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/RoleGrantsPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 17 selectors, all 17 with live users in 1 file.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `RoleGrantsPanel.tsx` uses all 17 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames serviceTokensPanel.css to serviceTokensPanel.deprecated.css (#5178)

- File: `src/client/serviceTokensPanel.css` → `src/client/serviceTokensPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/ServiceTokensPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 27 selectors, all 27 with live users in 1 file.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `ServiceTokensPanel.tsx` uses all 27 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames reports.css to reports.deprecated.css (#5178)

- File: `src/client/reports.css` → `src/client/reports.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its 2 importers (`src/client/ReportsPanel.tsx`, `src/client/SchedulesPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 52 selectors, 32 with live users in 18 files (shared sheet: research tabs, `BrokerDynamicMenu`, `StrategyDiscoveryPanel`, `ScheduleFormModal`, `NotificationFields`, `DiscoveryFormSections`, `Field.tsx`, `landing.ts`, `McpApiExplorer`, `PendingReviewQueue`, `SetupCatalogPanel`, `StrategyReviewPanel`, `PortfolioRiskPanel`, `AgentChatTabContent`, `ResearchIdeasBrowser`, `ResearchRunDetail`, `ResearchTrackRecord`, `StockSearchBar`, `OptionsDataDownloadDropdown`). `schedules-toolbar` stays live here.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 18 files use its live selectors (see Reason).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames scannerPanel.css to scannerPanel.deprecated.css (#5178)

- File: `src/client/scannerPanel.css` → `src/client/scannerPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/ScannerPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 67 selectors, 7 with live users in 7 files (`ScannerPanel`, `AccountPanels`, `BrokerDynamicMenu`, `StockCopilotPanel`, `StockSearchBar`, `Checkbox.tsx`, `landing.ts`); 60 selectors with no static use (ScannerPanel migrated in S-U2).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 7 files use its live selectors (see Reason).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames portfolioRiskPanel.css to portfolioRiskPanel.deprecated.css (#5178)

- File: `src/client/portfolioRiskPanel.css` → `src/client/portfolioRiskPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/PortfolioRiskPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 35 selectors, 27 with live users in 1 file; 8 unused (`prp-badge-*`, `prp-binding`, `prp-table`).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `PortfolioRiskPanel.tsx` uses 27 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames stockCopilotPanel.css to stockCopilotPanel.deprecated.css (#5178)

- File: `src/client/stockCopilotPanel.css` → `src/client/stockCopilotPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its sole importer (`src/client/StockCopilotPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 12 selectors, all 12 with live users in 3 files (`StockCopilotPanel.tsx`, `StockCopilotVoiceControl.tsx` + its test).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: `StockCopilotPanel.tsx` + `StockCopilotVoiceControl.tsx` use all 12 selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames optionsResearch.css to optionsResearch.deprecated.css (#5178)

- File: `src/client/optionsResearch.css` → `src/client/optionsResearch.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its 2 importers (`src/client/ScreenersHub.tsx`, `src/client/StockHub.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 95 selectors, 8 with live users in 12 files; 87 unused. This copy differs from `src/client/options/optionsResearch.css` (158 changed lines, different tail block) — the pair is NOT unified in this slice (separate migration; importer sets differ).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 12 files use its 8 live selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames options/optionsResearch.css to options/optionsResearch.deprecated.css (#5178)

- File: `src/client/options/optionsResearch.css` → `src/client/options/optionsResearch.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) deprecates the bespoke CSS files per gitops §22 (rename form): renamed in place, its 2 importers (`src/client/options/LlmOptionsIdeasPanel.tsx`, `src/client/options/OptionsResearchPanel.tsx`) updated to the new path, and a deprecation header added. Rules unchanged. 101 selectors, 20 with live users in 10 files; 81 unused. This copy differs from `src/client/optionsResearch.css` (158 changed lines, different tail block) — the pair is NOT unified in this slice (separate migration; importer sets differ).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: 10 files use its 20 live selectors.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames workflowRuns.css to workflowRuns.deprecated.css (#5178)

- File: `src/client/workflowRuns.css` → `src/client/workflowRuns.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) renames the already-retired sheet per gitops §22 (rename form): it was retired in place by S-U4 (#4820) with a deprecation header and no rules; this slice renames the file so the name itself says it can be deleted, keeping the header text (first line changed to the rename note). No importers, no rules, no freeze entries.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames agentsPanel.css to agentsPanel.deprecated.css (#5178)

- File: `src/client/agentsPanel.css` → `src/client/agentsPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) renames the already-retired sheet per gitops §22 (rename form): it was retired in place by S-U5 (#4927) with a deprecation header and no rules; this slice renames the file so the name itself says it can be deleted, keeping the header text (first line changed to the rename note). No importers, no rules, no freeze entries.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames docsAndReports.css to docsAndReports.deprecated.css (#5178)

- File: `src/client/docsAndReports.css` → `src/client/docsAndReports.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) renames the already-retired sheet per gitops §22 (rename form): it was retired in place by S-U5 (#4927) with a deprecation header and no rules; this slice renames the file so the name itself says it can be deleted, keeping the header text (first line changed to the rename note). No importers, no rules, no freeze entries.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames dataProvidersPanel.css to dataProvidersPanel.deprecated.css (#5178)

- File: `src/client/dataProvidersPanel.css` → `src/client/dataProvidersPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) renames the already-retired sheet per gitops §22 (rename form): it was retired in place by tail slice 1 (#5016) with a deprecation header and no rules; this slice renames the file so the name itself says it can be deleted, keeping the header text (first line changed to the rename note). No importers, no rules, no freeze entries.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — S-U7 renames apiKeysPanel.css to apiKeysPanel.deprecated.css (#5178)

- File: `src/client/apiKeysPanel.css` → `src/client/apiKeysPanel.deprecated.css`
- Date: 2026-11-17
- Reason: Issue #5178 (sub of #3695, S-U7) renames the already-retired sheet per gitops §22 (rename form): it was retired in place by tail slice 3 (#5140) with a deprecation header and no rules; this slice renames the file so the name itself says it can be deleted, keeping the header text (first line changed to the rename note). No importers, no rules, no freeze entries.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — options sharded chain start routes through the one engine (#4780)

- Function: the bespoke options chain start (`planOptionsFeedShards` +
  the `shardSubmit` async-job port + `applyShardPacing`) → retired;
  the chain now dispatches as one engine job `options-chain:<chainId>`
  through `startOptionsChainWorkflow`
  (`src/workflows/optionsWorkflowHost.ts`), defined by
  `buildOptionsChainJobDefinition` (`src/services/optionsChainPipelineJobs.ts`)
- Date: 2026-11-17
- Reason: Issue #4780 (sub-issue of #3550, [One engine]) removes the
  last bespoke chain-start path. The chain is built exactly as before
  (same broker/mode provenance, same schedule attribution, same
  per-symbol screen inputs) and dispatched through the engine seam;
  the feed node's sharded shape with sequential units IS the pacing
  now — each unit is its own journaled workflow step, its own Worker
  invocation, its own subrequest budget — so the 1s stagger / `runAt`
  is retired, not dropped (the step boundary replaces it
  structurally). The #4280 entry's reservation ("the options sharded
  chain still uses the `shardSubmit` port, which stays") is now
  discharged: no scheduled chain executes outside the engine after
  this slice. The feed unit reuses the sync per-symbol scan path
  (`runStrategyScreenViaEngine`); the chain advance still rides the
  mas_async_jobs completion hook for in-flight chains.
- Replacement: `startOptionsChainWorkflow` +
  `buildOptionsChainJobDefinition` (`src/services/optionsChainPipelineJobs.ts`),
  called by `ScheduledTasksService.autonomousOptionsAnalysis` with
  `jobId = options-chain:<chainId>`. The chain job's six stages are
  feed → assemble → generate → store → serve → deliver; the root
  node's shape follows the symbol count (sharded when more than one
  symbol, monolith for a single symbol — the stock idiom).
- Consumers at deprecation: no production callers remain — the one
  live caller (`autonomousOptionsAnalysis`) was migrated in the same
  slice. The pin `tests/options_chain_engine_4780.test.ts` (wired
  into `test:pins`) asserts no second chain-start path remains.
- Kept, never deleted: `planFeedStart` (`src/services/shardJobs.ts`)
  — its only caller remains the frozen deprecated module
  (`src/workflows/startScheduledShardedChain.deprecated.ts`), which
  must keep working as the record (#4776 owns its eventual removal).
  "planFeedStart has no callers" is read as no LIVE callers.
  `staggerRunAt` stays (the in-flight executor's generate/store
  shards still use it). `src/config/shardPacing.ts` and
  `config/shard-pacing.json` are deprecated in place by #5833 (2026-11-19,
  kept on disk per §22 no-deletion rule; zero `src/` importers).
  The two `.deprecated.ts` files stay in place.
- Known gaps (recorded, not blockers): the engine path does not write
  the serve-record summary row (`recordOptionsServeReport` needs a
  `DatabaseORM` the step residency has no handle to) — per-format
  canonical rows carry the run's provenance; a follow-up sub-issue
  under #4780 is prepared
  (`~/workspace/verify-priority-queue/4780/followup-serve-record-body.md`,
  to be filed by the main agent). The chain job is not in
  `workflowCatalog` (its six stages differ from the
  options-screener family's eight). #4423 retry lineage (shard ids,
  retried-shard counts) is not carried in the canonical body — the
  workflow step journal is the retry record. The blob seam refuses by
  name (`OPTIONS_CHAIN_REPORTS_BUCKET_UNBOUND`) when `REPORTS_BUCKET`
  is unbound, rather than silently dropping bytes to legacy DO storage.
- Deletion condition: zero consumers plus an owner decision plus a gate
  amendment; deletion is never part of a program slice.
## 2026-11-17 — tail slice 3 retires apiKeysPanel.css in place (#5140)

- File: `src/client/apiKeysPanel.css` → retired in place (no rules remain)
- Date: 2026-11-17
- Reason: Issue #5140 (sub of #3695, tail slice 3) migrates `src/client/ApiKeysPanel.tsx` to primitives and tokens; the sheet's sole importer no longer imports it and no other component uses any of its 18 selectors (checked `className=` AND `wrapperClassName=` uses). The sheet stays on disk (no file deletion, gitops §22) with a deprecation header naming its successor. The other nine files in the slice import no sheet: their classes were dead (13 distinct, zero CSS rules repo-wide) or shared rules that stay (`section-label-row` in `src/client/styles.css`, still used by `BrokerDynamicMenu.tsx`; `schedules-toolbar` in `src/client/reports.css`).
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities, incl. `ui-meta`, `ui-mono`, `ui-danger`, `ui-grow`) and `src/client/tokens.css` (design tokens), plus the Card, CardHeader, Flex, Notice, PageSection, and Stack primitives.
- Consumers at deprecation: none — the sole importer was migrated in the same slice.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-17 — tail slice 1 retires dataProvidersPanel.css in place (#5016)

- File: `src/client/dataProvidersPanel.css` → retired in place (no rules remain)
- Date: 2026-11-17
- Reason: Issue #5016 (sub of #3695, tail slice 1) migrates `src/client/DataProvidersPanel.tsx` to primitives and tokens; the sheet's sole importer no longer imports it and no other consumer exists. The sheet stays on disk (no file deletion, gitops §22) with a deprecation header naming its successor. `src/client/PlatformAdminPanel.tsx` is migrated in the same slice but has no sheet of its own — its classes lived in the shared `src/client/styles.css`, whose rules stay for the other consumers.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities, incl. `ui-link`, `ui-mono`, `ui-meta-sm`, `ui-meta`, `ui-label`, `ui-danger`, `ui-grow`, `ui-scroll-frame`) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none — the sole importer was migrated in the same slice.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-16 — S-U5 retires agentsPanel.css + docsAndReports.css in place (#4927)

- Files: `src/client/agentsPanel.css`, `src/client/docsAndReports.css` → retired in place (no rules remain)
- Date: 2026-11-16
- Reason: Issue #4927 (sub of #3695, S-U5) migrates `src/client/AgentsPanel.tsx` and `src/client/DocsAndReportsPanel.tsx` to primitives and tokens; each sheet's sole importer no longer imports it and no other consumer exists. The sheets stay on disk (no file deletion, gitops §22) with a deprecation header naming their successor.
- Replacement: `src/client/components/ui/primitives.css` (ui-* utilities, incl. the new `ui-page-frame`, plus `ui-link`, `ui-mono`, `ui-meta-sm`, `ui-meta`, `ui-cell-nowrap`, `ui-scroll-frame`) and `src/client/tokens.css` (design tokens).
- Consumers at deprecation: none — each sole importer was migrated in the same slice.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-16 — #4913 retires WorkCard in place (rule-of-three rationalization)

- Component: `WorkCard` (`src/client/components/ui/WorkCard.tsx`) → deprecated in place
- Date: 2026-11-16
- Reason: Issue #4913 (sub of #3695) folds the single use (OrderTicketPanel's order form card) into the inline Card + Stack gap 5 + CardHeader composition WorkCard itself renders — the component is only that composition, so a second use would be a duplicate, not a reuse. The component stays on disk and exported (no file deletion, gitops §22) with a @deprecated JSDoc naming its successor.
- Replacement: `<Card><Stack gap="5"><CardHeader … />…</Stack></Card>` (see the OrderTicketPanel fold in the same slice).
- Consumers at deprecation: none — the sole use was folded in the same slice; the census test (tests/template_rule_of_three_4913.test.ts) pins zero prod uses.
- Deletion condition: zero consumers (already met) plus an owner decision plus a gate amendment; deletion is never part of a program slice.

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

## 2026-11-18 — Broker-neutral naming sweep deprecates ETradeDynamicMenu.tsx in place (#5236)

- File: `src/client/ETradeDynamicMenu.tsx` (marked `@deprecated` in place)
- Date: 2026-11-18
- Reason: Issue #5236 (Slice 1 of broker-neutral naming sweep) marks the legacy `ETradeDynamicMenu.tsx` shim `@deprecated` in place per gitops §22 (keeping the file in place to satisfy no-deletion), removes the `ETradeDynamicMenu` / `ETradeDynamicMenuProps` symbol aliases, and updates all callers to import `BrokerDynamicMenu` / `SettingsMenu` from `src/client/BrokerDynamicMenu.tsx`.
- Replacement: `src/client/BrokerDynamicMenu.tsx` (`BrokerDynamicMenu`, `SettingsMenu`).
- Consumers at deprecation: zero production consumers (`SettingsMenu.tsx` and all tests import `BrokerDynamicMenu.tsx` directly).
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.

## 2026-11-23 — #6029 (b) retires the dead `research.scheduleCron` setting

- Setting: `research.scheduleCron` (the "Daily schedule (cron)" row of the research settings schema)
- Date: 2026-11-23
- Reason: Issue #6029 (b), sub-issue #6299. The setting was stored, validated and served, and **no code read it** — the filter editor advertised a schedule the nightly run never honoured (the run fires from the tick rider plus `shouldFireResearchTick`). Removing a dead setting removes nothing that runs, which is why this half of #6029 lands before the stored schedule (#6298).
- Tolerance: a stored `research.scheduleCron` value is ignored — the loader iterates the declared settings, so the value is never read and never fails a load. A `POST /api/research/settings` that names the key is refused by name with this reason instead of being persisted again (`RESEARCH_CONFIG_RETIRED_KEYS`).
- Follow-on: the cadence becomes editable when the stored schedule record lands (#6298); the rider branch is retired in the same sub-issue after that.

## 2026-11-24 — #6438 retires the hand-maintained client MCP catalogue

- File: `src/client/mcpEndpointsData.ts` → `src/client/mcpEndpointsData.deprecated.ts` (rename only, gitops §22: never deleted)
- Date: 2026-11-24
- Reason: Issue #6438 (sub-issue of #6266). The Tools tab, the chat Endpoints tab, and the IAAA admin MCP tab read the served catalogue from GET /api/mcp/catalog (`src/mcps/openaimp/catalog.ts`, built from `McpToolFactory.getToolDefinitions()` plus the resource/prompt registries), so a newly registered tool appears on every surface after deploy with no client-file edit. The hand-maintained file held 38 tools against 147 on the server, and its descriptions contradicted each other (10 vs 8 enterprise tables). The served catalogue is the single source; tool categories are now the tools' permission scopes, as served.
- Replacement: `GET /api/mcp/catalog` + `src/client/mcpCatalog.ts` (`fetchMcpCatalog`, `toClientCatalog`); REST entries moved verbatim to `src/client/restEndpointsData.ts` (REST cannot be derived from the OpenAPI spec in this slice — the spec covers only a subset and carries no runner samples; deriving it is #6439 follow-up).
- Consumers at deprecation: zero production consumers — `ToolSearchTab.tsx`, `McpApiExplorer.tsx`, `IaaaAdminPanel.tsx`, and `iaaaEndpointCatalog.ts` (now `buildMcpCorrelationRows`) all read the served catalogue in the same slice. One test reads the file as text (`tests/payment_seed_transactions_removed.test.ts`); it now reads the `.deprecated.ts` path.
- Deletion condition: zero consumers plus an owner decision plus a gate amendment; deletion is never part of a program slice.
