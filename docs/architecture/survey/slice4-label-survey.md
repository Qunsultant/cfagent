> **Filed into the repo 2026-11-16** (issue #4792) — copy of `~/workspace/slice4-label-survey.md` as written on its stated base (main `8414089` / `42b4977`, 2026-10-28). Survey body below unchanged.

# Slice 4 (#2177) chunk 2 survey — raw <label> inventory (2026-10-28, main 8414089)

222 raw `<label>` occurrences across 25 files (outside components/ui).
Top 4 files hold 107 of them — chunk 2 starts here:

- src/client/options/EtapiConfigModal.tsx — 29 → DONE 2026-10-28 (branch fix/2177-labels): all 29 were uniform htmlFor + sibling TextInput/Select with matching id + optional hint span. First converted to manual FieldShell wrappers, then REDONE to the better pattern: label/hint props directly on TextInput/Select (they render FieldShell internally with a real id on the control — the manual wrapper left htmlFor dangling). tsc clean, ceiling + related tests green.
- src/client/options/OptionsResearchPanel.tsx — 27 → DONE 2026-10-28 (branch fix/2177-labels @ bf6b39d): 25 converted — single-control fields to label props (leg-editor labels get per-instance ids free via TextInput/Select useId; range + strike labels are dynamic template labels); target-date (two controls) to a manual FieldShell wrapper. 2 REMAIN BY DESIGN: strategy-picker checkbox labels — Checkbox is a bare control whose doc says callers keep their own label wrappers, and FieldShell is documented for TextInput/Select only. Open question for Ceos: add a label prop to Checkbox, or sanction wrapper labels (ceiling target = zero non-checkbox labels).
- src/client/ScannerPanel.tsx — 25 → DONE 2026-10-28 (branch fix/2177-labels @ ec1878b): 22 converted (20 htmlFor+control to label props, strategies picker Button to a FieldShell wrapper, spacer `<label>&nbsp;</label>` DELETED — vestigial under the form's align-items:flex-end, verified no visual change). 3 REMAIN BY DESIGN: checkbox labels (gateEnabled, gateRequireFresh, compare) — same sanctioned Checkbox-wrapper exception. Script bug caught in review on first pass: a single-line label with a nested span overshot its block scan and mangled the strategies/risk region (picker Button dropped, FieldShell miswrapped); file restored from branch and rerun with single-line-first logic. No code from the bad pass was pushed.
- src/client/scheduledOptionsManager/DiscoveryFormSections.tsx — 26 → DONE 2026-10-28 (branch fix/2177-labels @ ec1878b): all 26 converted (idx + noview groups to label props keeping dynamic/static ids; text+hint labels to label+hint props with template-literal hints decoding &apos;/&quot; and {LIMIT} expressions; 3 section headings — Saved Discovery Views, Symbol Set + Strategy Profile, No-View Constraint Sets — changed label→div keeping .sched-form-label, which is display:flex and tag-agnostic, so rendering is identical). Hint bug caught in review: single-line hints kept a trailing </span> in the prop; fixed (4 sites).
- Labels total: 223 → 121 after the top 4 files (102 converted; 5 checkbox exceptions remain across them).

## Chunk 3 survey (2026-10-28, main 42b4977) — remaining 121 labels, 23 files

- options/StrategyDiscoveryPanel.tsx — 14
- PortfolioRiskPanel.tsx — 14 (chunk 1 converted its footnote sites, not these labels)
- ETradeTradingHub.tsx — 14
- scheduledOptionsManager/ScheduleFormModal.tsx — 11
- ScreenersHub.tsx — 10
- options/flows/FlowFiltersSidebar.tsx — 9
- MarketDataResearchHub.tsx — 7
- components/AutopilotControlCenter.tsx — 6
- scheduledOptionsManager/CadenceFields.tsx — 5
- GoalScreenPanel.tsx — 5
- scheduledOptionsManager/NotificationFields.tsx — 4
- options/RawContractsScreener.tsx — 3
- ScannerPanel.tsx — 3 (checkbox exceptions)
- ResearchReportActions.tsx — 3
- scheduledOptionsManager/ThesisRiskFields.tsx — 2
- options/OptionsResearchPanel.tsx — 2 (checkbox exceptions)
- options/LlmOptionsIdeasPanel.tsx — 2
- PaymentWorkflowAssurance.tsx — 2
- options/ResearchRunsPanel.tsx — 1
- options/LlmStrategyEvalModal.tsx — 1
- ReportsPanel.tsx — 1
- IvHistoryPanel.tsx — 1
- CheckoutPanel.tsx — 1 (the c66332c base addition)
- Top 6 hold 72. Chunk 3 shape survey still owed per file before converting.

## Chunk 3 progress (2026-10-28, branch fix/2177-labels-3 @ 2be4a1f)

- options/StrategyDiscoveryPanel.tsx — 14 → 11 converted (htmlFor/sibling + wrapping labels to label props; roll expiration/strike chip groups to FieldShell wrappers). 3 REMAIN BY DESIGN: pill-row labels (Implied Move value display, Budget, Min R:R) — `.strat-input-pill` is `inline-flex` row composite (icon + label + control/value); the columnar FieldShell pattern would redesign the pill. Second exception class alongside checkbox wrappers; open question for Ceos: redesign pills to standard fields vs. sanction pill labels.
- Labels total: 121 → 110 after this file.

- PortfolioRiskPanel.tsx — 14 → DONE 2026-10-28 (branch fix/2177-labels-3 @ 1270e6d): all 14 converted (11 single-line inline labels + 2 multi-line Select wraps to label props; dynamic `{label}` map site keeps its key on the control with label={label}).
- ETradeTradingHub.tsx — 14 → DONE 2026-10-28 (branch fix/2177-labels-3 @ 1270e6d): all 14 converted (5 leg-editor wraps to label props with per-leg useId ids; symbol row, order-action toggle grid, quantity stepper to FieldShell wrappers with invented ids; order-type + net-limit to label props; 4 omnichannel htmlFor+id sites to label props keeping ids). Fix caught by tsc: FieldShell requires an id prop — the three wrappers shipped without one on first pass, fixed before push.
- Labels total: 110 → 82 after these two files. Chunk 3 so far: 39 converted (StrategyDiscoveryPanel 11 + PortfolioRiskPanel 14 + ETradeTradingHub 14).

- scheduledOptionsManager/ScheduleFormModal.tsx — 11 → DONE 2026-10-28 (branch fix/2177-labels-3 @ 538cf0f): 6 text+hint labels to label+hint props (one loses a one-off 8px label top margin, parent gap covers it) + 5 htmlFor+id sites to label props.
- ScreenersHub.tsx — 10 → DONE 2026-10-28 (branch fix/2177-labels-3 @ 538cf0f): all 10 options-field wraps (incl. 3 single-line) to label props.
- options/flows/FlowFiltersSidebar.tsx — 9 → 5 DONE 2026-10-28 (branch fix/2177-labels-3 @ 538cf0f): ticker/insider wraps + direction-bias group to FieldShell wrappers (control ids reused as FieldShell ids); slider rows restacked (label, value badge, slider) with the dead .flow-slider-label-row rule deleted. 4 checkbox rows remain by design (sanctioned exception).
- Labels total: 82 → 56. Chunk 3 DONE 2026-10-28: PR #2209 merged (merge 2455245, rebase shape, post-merge CI 17/17 green), #2177 comment 6487211013. Chunk 4 tail (verified on main ec51f94): 44 non-exception labels in 15 files + 12 exceptions in the 56 (9 checkbox-wrapper, 3 pill-row). Correction: earlier "51 in 16" was wrong; recount is 44 in 15.
- Chunk 4 DONE 2026-10-28 (branch fix/2177-labels-4 @ f88ec97): 34 converted (MarketData 7, Autopilot 6, Cadence 5, GoalScreen 3, Notification heading 1, RawContracts 3, ResearchReportActions 3, ThesisRisk 2, LlmOptionsIdeas 2, LlmStrategyEval 1, IvHistory 1); ceiling ratchet 56 → 22 + fragment pushed; verify running. Remaining 22 = 18 checkbox-wrapper + 3 pill-row + 1 ResearchRuns config-list row (mixed Checkbox/TextInput control).
- src/client/scheduledOptionsManager/DiscoveryFormSections.tsx — 26
- src/client/ScannerPanel.tsx — 25
- src/client/options/StrategyDiscoveryPanel.tsx — 14
- src/client/PortfolioRiskPanel.tsx — 14
- src/client/ETradeTradingHub.tsx — 14
- src/client/scheduledOptionsManager/ScheduleFormModal.tsx — 11
- src/client/ScreenersHub.tsx — 10
- src/client/options/flows/FlowFiltersSidebar.tsx — 9
- src/client/MarketDataResearchHub.tsx — 7
- src/client/components/AutopilotControlCenter.tsx — 6
- remaining 13 files — 5 or fewer each

Conversion target: FieldShell (id on FieldShell only, inner control carries no id).
Note: FieldShell requires an `id` prop — labels without an associated control id
need a judgment call per site (wrap control vs drop the label).
