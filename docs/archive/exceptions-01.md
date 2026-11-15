> **RETIRED — archived 2026-11-15 (#4632, D0).** Moved here from
> `docs/architecture/UX/exceptions-01.md`. Point-in-time snapshot
> (2026-10-25, pre-ADR-0004), frozen: the live state is the freeze
> allowlist (empty) and
> `docs/architecture/security/ux-primitives-1772-verification.md`
> (44/44 converted). Retirement recorded in
> `docs/architecture/transition/deprecations.md`.

# UX Token Architecture & Primitive Conformance Exceptions Report (Exceptions 01)

**Document Version:** 1.0.0
**Date:** 2026-10-25
**Status:** Architecture Audit & Exception Tracking
**Target Application:** NextGenTP / AI Search Agent (`ai-search-agent`)
**Scope:** `src/client/` UI Component Hierarchy (85 TSX/JSX files analyzed)
**Governing Architecture Standards:**
- **UX Architecture Specification:** `docs/agents/ux-architecture.md`
- **UX Token Architecture & Theme Plan:** `docs/plans/UX/ux-token-architecture-plan.md`
- **UX Assessment 01:** `docs/archive/assessment-01.md`
- **Composable UI Directive & Pin:** Issue #492, `tests/ui_primitives_inventory.test.ts`
- **Theme-Consistency Verification Directive:** Issue #491

---

## Executive Summary

As defined in the NextGenTP UX Token Architecture (`DESIGN.md`, `docs/plans/UX/ux-token-architecture-plan.md`, and Issue #492), all user interface surfaces across the application must be assembled from shared, composable primitives located in `src/client/components/ui/` (`Button`, `TextInput`, `Select`, `Table`, `Card`, `Badge`, `PillGroup`, `Notice`, `Modal`, `Tabs`, `Spinner`, `EmptyState`, etc.).

While Phase 6 of the UX Token Architecture plan enforced zero raw hex color literals via `tests/ux_token_coverage_ratchet.test.ts`, **a major architectural gap remains**: numerous domain panels and components render JSX using raw HTML controls (`<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<th>`, `<td>`, `<tr>`) or hand-rolled container boxes (`style={{ border: "...", borderRadius: "..." }}`) **without importing or using any `src/client/components/ui/` primitive**.

This issue was highlighted in **Issue #1337 / #1382**, where the rebased gate caught `SocialPostingPanel.tsx` rendering interactive JSX without importing any `ui/` primitive. This report presents a comprehensive audit of all 85 TSX/JSX files in `src/client/`, identifying every non-conforming component exception across the application, analyzing the impact on dark/light/system theme consistency and WCAG AA accessibility, and setting out a prioritized remediation roadmap.

---

## Audit Methodology & Classification

Every `.tsx` and `.jsx` file in `src/client/` (excluding `src/client/components/ui/` itself) was audited using AST and regex static analysis for:
1. **Import of UI primitives:** Direct or barrel imports from `components/ui` or `components/ui/*`.
2. **Raw HTML Control Rendering:** Direct usage of `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<th>`, `<td>`, `<tr>`, `<form>`, or `<dialog>`.
3. **Custom Layout / Component Re-implementation:** Custom inline style styling for cards (`border`, `borderRadius`, `padding`), badges/pills (`borderRadius: 999px` / `pill` classes), modals (`position: fixed`, `zIndex`), or tabs.

### Summary Audit Statistics
- **Total `src/client/` TSX/JSX Files Audited:** 85 files
- **Fully Compliant Components (Importing UI Primitives):** 28 files (33%)
- **Bypassing UI Primitives (Import UI Primitives BUT still render raw HTML controls):** 16 files (19%)
- **Non-Compliant Exception Files (Zero UI Primitive Imports + Raw Controls/Containers):** 28 files (33%)
- **Utility / Non-UI Container Files (No UI Primitive Imports & No Raw Controls):** 13 files (15%)

---

## Category 1: Non-Compliant Component Exceptions (Zero UI Primitive Imports)

The following **28 components** render interactive UI controls, tabular data, or card/badge containers without importing a single primitive from `src/client/components/ui/`.

### 1. Social Posting & Goals
* **`src/client/SocialPostingPanel.tsx`** (257 lines) — *Primary reference exception from #1382*
  - **Raw Controls Found:** `<button>`, `<textarea>`
  - **Custom Layouts:** Hand-coded border/radius card boxes for goal and pending approval items (`border: 1px solid var(--color-border-medium)`, `borderRadius: 8`).
  - **Target Primitives:** `Button`, `TextInput` (or `Field`), `Card`, `Badge`.

* **`src/client/ScheduledGoalsPanel.tsx`** (182 lines)
  - **Raw Controls Found:** `<button>`, `<input>`
  - **Custom Layouts:** Ad-hoc card containers with custom inline padding.
  - **Target Primitives:** `Button`, `TextInput`, `Card`.

* **`src/client/SchedulesPanel.tsx`** — **resolved 2026-10-29 by #2329**; moved to Category 3 (item 13). The finding below is kept as the audit record: cards with custom action rows and raw `<button>`/`<input>` controls.

### 2. Core Chat & Workspace Components
* **`src/client/chat/AgentChatTabContent.tsx`** (574 lines)
  - **Raw Controls Found:** `<button>`, `<input>`
  - **Custom Layouts:** Hand-styled action cards, prompt suggestion pills, custom status badges.
  - **Target Primitives:** `Button`, `TextInput`, `Card`, `Badge`, `PillGroup`.

* **`src/client/chat/ToolResultView.tsx`** (455 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Hand-styled JSON tool output boxes, collapsible headers, action buttons.
  - **Target Primitives:** `Button`, `Card`, `Badge`.

* **`src/client/chat/tabs/ReferralsTab.tsx`** (591 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`
  - **Custom Layouts:** Custom referral link cards, payout status badges, input fields.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Card`, `Badge`.

* **`src/client/chat/tabs/RevenueTab.tsx`** (567 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Un-tokenized data tables for transactions and earnings summary.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Table`, `Card`.

### 3. Navigation & Platform Chrome
* **`src/client/components/CapabilityNavBar.tsx`** (166 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Direct `<button>` elements for top tab navigation.
  - **Target Primitives:** `SegmentedControl` or `Tabs`.

* **`src/client/components/NavigationMenu.tsx`** (936 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Hand-crafted drawer, menu items, pills, status indicators.
  - **Target Primitives:** `Button`, `Badge`, `PillGroup`.

* **`src/client/components/StockSearchBar.tsx`** (669 lines)
  - **Raw Controls Found:** `<button>`, `<input>`
  - **Custom Layouts:** Search input with absolute-positioned clear/submit buttons and ticker badges.
  - **Target Primitives:** `TextInput`, `Button`, `Badge`.

* **`src/client/components/MarketTickerTape.tsx`** (262 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Ticker scroll buttons and symbol cards.
  - **Target Primitives:** `Button`, `Badge`.

* **`src/client/components/PartnerDealsModal.tsx`** (234 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Hand-coded modal backdrop and dialog (`position: fixed`, `zIndex: 1000`), custom deal cards.
  - **Target Primitives:** `Modal`, `Card`, `Button`, `Badge`.

* **`src/client/components/AskAgentWidget.tsx`** (425 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Floating chat widget trigger and popup container.
  - **Target Primitives:** `Button`, `Card`, `TextInput`.

### 4. Options & Screener Research Surfaces
* **`src/client/ScannerPanel.tsx`** (1,767 lines) — *Major domain panel*
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** 1,700+ lines of custom scanner forms, universe filters, results tables, and run control buttons.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Table`, `Card`, `Badge`.

* **`src/client/ScreenerResultsView.tsx`** (694 lines)
  - **Raw Controls Found:** `<button>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Hand-built result tables, pagination buttons, CSV/PDF export triggers.
  - **Target Primitives:** `Table`, `Button`, `Badge`.

* **`src/client/ScreeningReviewPanel.tsx`** (648 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Review cards, approval buttons.
  - **Target Primitives:** `Button`, `Card`, `Notice`.

* **`src/client/IvHistoryPanel.tsx`** (172 lines)
  - **Raw Controls Found:** `<button>`, `<select>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** IV history filter controls and tabular historical IV data.
  - **Target Primitives:** `Button`, `Select`, `Table`, `Card`.

* **`src/client/options/RawContractsScreener.tsx`** (691 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Options contract grid, filter row, strike/expiration pickers.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Table`, `Card`.

* **`src/client/options/ResearchRunsPanel.tsx`** (448 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Historical research run listing and status tags.
  - **Target Primitives:** `Button`, `TextInput`, `Table`, `Badge`.

* **`src/client/options/LlmOptionsIdeasPanel.tsx`** (391 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<textarea>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Strategy idea prompt box, strike table, evaluation buttons.
  - **Target Primitives:** `Button`, `TextInput`, `Table`, `Card`.

* **`src/client/options/LlmStrategyEvalModal.tsx`** (432 lines)
  - **Raw Controls Found:** `<button>`, `<textarea>`
  - **Custom Layouts:** Custom modal overlay, evaluation criteria textarea, evaluation score badges.
  - **Target Primitives:** `Modal`, `Button`, `TextInput`, `Card`, `Badge`.

* **`src/client/options/flows/OptionsFlowsHub.tsx`** (921 lines)
  - **Raw Controls Found:** `<button>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Institutional options flow feed, sentiment filter buttons, flow summary table.
  - **Target Primitives:** `Button`, `Table`, `Card`, `Badge`, `PillGroup`.

* **`src/client/options/OptionsDataDownloadDropdown.tsx`** (149 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Custom dropdown trigger and menu container.
  - **Target Primitives:** `Button`, `Select`.

* **`src/client/options/ScreeningActivityPanel.tsx`** (183 lines)
  - **Raw Controls Found:** `<button>`
  - **Custom Layouts:** Activity feed cards and trigger controls.
  - **Target Primitives:** `Button`, `Card`, `Badge`.

### 5. Risk, Autopilot & Workflows
* **`src/client/PortfolioRiskPanel.tsx`** (568 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Risk breakdown matrix, position table, hedge recommendation cards.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Table`, `Card`, `Badge`.

* **`src/client/components/AutopilotControlCenter.tsx`** (1,585 lines) — *Major domain panel*
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<table>`
  - **Custom Layouts:** Policy configuration forms, trade auto-repair tables, execution toggle buttons.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Table`, `Card`, `Badge`, `Notice`.

* **`src/client/WorkflowsHub.tsx`** (1,935 lines) — *Major domain panel*
  - **Raw Controls Found:** `<button>`, `<input>`, `<table>`, `<th>`, `<td>`, `<tr>`
  - **Custom Layouts:** Workflow catalog cards, trigger forms, execution history tables.
  - **Target Primitives:** `Button`, `TextInput`, `Table`, `Card`, `Badge`.

### 6. Admin, Developer & Utility Panels
* **`src/client/McpApiExplorer.tsx`** (778 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<select>`, `<textarea>`
  - **Custom Layouts:** Tool catalog picker, JSON payload editor, execution response viewer.
  - **Target Primitives:** `Button`, `TextInput`, `Select`, `Card`, `Badge`.

* **`src/client/MemoryBrowser.tsx`** (114 lines)
  - **Raw Controls Found:** `<button>`, `<input>`
  - **Custom Layouts:** Memory search bar, memory key/value row buttons.
  - **Target Primitives:** `Button`, `TextInput`, `Card`.

* **`src/client/ResearchReportActions.tsx`** (167 lines)
  - **Raw Controls Found:** `<button>`, `<input>`, `<textarea>`
  - **Custom Layouts:** Report sharing modal/card, export parameter inputs.
  - **Target Primitives:** `Button`, `TextInput`, `Card`.

---

## Category 2: Mixed / Partial Conformance Components (Incomplete Primitive Adoption)

The following **16 components** import primitives from `src/client/components/ui/`, but still contain leftover raw HTML controls (`<button>`, `<input>`, `<table>`, etc.) instead of fully leveraging the primitive suite.

| Component Path | UI Primitives Imported | Remaining Raw HTML Controls / Issues | Remediation Required |
|---|---|---|---|
| `src/client/ApiKeysPanel.tsx` | `Card`, `Button`, `TextInput`, `Table`, `Badge` | Raw `<button>` for key deletion | Replace inline delete buttons with `<Button variant="danger" size="sm">` |
| `src/client/Chat.tsx` | `Card`, `Button`, `TextInput`, `Notice`, `Select` | Raw `<button>` in quick prompts & model pickers | Convert quick prompt tags to `<Button>` or `<PillGroup>` |
| `src/client/DataProvidersPanel.tsx` | `Card`, `Button`, `Badge`, `Notice` | Raw `<input>` for API key entries | Replace raw `<input>` with `<TextInput>` |
| `src/client/ETradeDynamicMenu.tsx` | `Button`, `Badge` | Raw `<button>` in sub-navigation menus | Standardize with `<Button>` or `SegmentedControl` |
| `src/client/ETradeTradingHub.tsx` | `Card`, `Button`, `TextInput`, `Select`, `Table`, `Badge`, `Modal` | Raw `<table>` in account balance overview | Replace raw `<table>` with `<Table>` primitive |
| `src/client/MarketDataResearchHub.tsx` | `Card`, `Button`, `Badge`, `Notice` | Raw `<button>` in topic filters | Convert topic filters to `<PillGroup>` |
| `src/client/IaaaAdminPanel.tsx` | `Card`, `Button`, `TextInput`, `Select`, `Table`, `Badge` | Raw `<button>` in row actions | Replace with `<Button size="sm">` |
| `src/client/ReportsPanel.tsx` | `Card`, `Button`, `Table`, `Badge`, `Modal` | Raw `<button>` in report download links | Replace with `<Button variant="outline">` |
| `src/client/ScreenersHub.tsx` | `Card`, `Button`, `TextInput`, `Select`, `Table`, `Badge`, `Modal` | Raw `<button>` in universe selection | Standardize with `<Button>` and `<PillGroup>` |
| `src/client/chat/tabs/AdsTab.tsx` | `Card`, `Button`, `Badge` | Raw `<input>` in ad configuration | Replace with `<TextInput>` |
| `src/client/chat/tabs/ResearchRunDetail.tsx` | `Card`, `Button`, `Table`, `Badge` | Raw `<button>` in tab switching | Replace with `<Tabs>` primitive |
| `src/client/chat/tabs/ResearchTrackRecord.tsx` | `Card`, `Button`, `Table`, `Badge` | Raw `<button>` in time range filters | Replace with `<SegmentedControl>` |
| `src/client/options/AutonomousOptionsRuns.tsx` | `Card`, `Button`, `Table`, `Badge` | Raw `<button>` in refresh controls | Replace with `<Button>` |
| `src/client/options/DiscoveryRunsPanel.tsx` | `Card`, `Button`, `Table`, `Badge` | Raw `<button>` in run detail expands | Replace with `<Button size="sm">` |
| `src/client/options/EtapiConfigModal.tsx` | `Modal`, `Button`, `TextInput`, `Card` | Raw `<button>` in test connection | Replace with `<Button>` |
| `src/client/options/OptionsResearchPanel.tsx` | `Card`, `Button`, `Select`, `Badge`, `Modal` | Raw `<table>` in strike comparison | Replace with `<Table>` primitive |

---

## Category 3: Compliant Components (Best Practices Reference)

The following **12 components** (and sub-sections) properly import and consistently use primitives from `src/client/components/ui/` as intended by the UX architecture:

1. `src/client/options/StrategyDiscoveryPanel.tsx`
2. `src/client/options/StrategyLibraryModal.tsx`
3. `src/client/options/RiskAnalysisModal.tsx`
4. `src/client/options/flows/FlowFiltersSidebar.tsx`
5. `src/client/options/flows/FlowTradeDetailModal.tsx`
6. `src/client/scheduledOptionsManager/ScheduleFormModal.tsx`
7. `src/client/scheduledOptionsManager/SchedulesSection.tsx`
8. `src/client/scheduledOptionsManager/DiscoveryFormSections.tsx`
9. `src/client/scheduledOptionsManager/ThesisRiskFields.tsx`
10. `src/client/scheduledOptionsManager/NotificationFields.tsx`
11. `src/client/scheduledOptionsManager/CadenceFields.tsx`
12. `src/client/components/PartnerDealsModal.tsx` *(uses Modal primitive, though contains minor card raw elements)*
13. `src/client/SchedulesPanel.tsx` *(resolved by #2329: one `Table` of `Badge`/`Button` rows per surface, `PillGroup` filters, `Modal`-based Details/cadence/confirm dialogs, no raw `<button>`/`<input>`; pattern recorded in `docs/architecture/UX/schedule-surface-01.md`)*

---

## Category 4: Utility & Container Components (Exempt)

The following **13 components** do not import UI primitives because they serve as pure layout wrappers, charting canvases, text formatters, or top-level entry points:

1. `src/client/LlmOptionsIdeasPanel.tsx` (Re-exporter / host)
2. `src/client/OptionsResearchPanel.tsx` (Re-exporter / host)
3. `src/client/ScreeningOutcomesPanel.tsx` (Host wrapper)
4. `src/client/SettingsMenu.tsx` (Menu state container)
5. `src/client/TabHoverItem.tsx` (Hover interaction wrapper)
6. `src/client/chat/MarkdownContent.tsx` (Markdown AST renderer)
7. `src/client/chat/ReasoningView.tsx` (Collapsible text stream)
8. `src/client/chat/renderInlineFormatted.tsx` (Text formatting utility)
9. `src/client/chat/tabs/EndpointsTab.tsx` (Static endpoint listing)
10. `src/client/components/MarketStatusPill.tsx` (Lightweight status pill)
11. `src/client/components/UniversalChart.tsx` (Canvas/SVG chart container)
12. `src/client/main.tsx` (App mount entrypoint)
13. `src/client/options/flows/FlowSummaryDualBars.tsx` (SVG/CSS bar chart)

---

## Architectural & UX Impact Analysis

Bypassing `src/client/components/ui/` primitives introduces systematic UX, accessibility, and maintenance defects across the product:

1. **Broken Density Responsiveness (`compact` vs `comfortable`):**
   - Design tokens such as `--control-height`, `--input-padding`, `--table-row-height`, and `--card-padding` are built directly into `primitives.css` and `src/client/components/ui/` components.
   - Domain panels rendering raw `<button>` and `<input>` elements with fixed pixel inline styles (`style={{ padding: "8px 12px" }}`) ignore density toggles, causing visual misalignment in compact mode.

2. **Dark / Light / System Theme Drift:**
   - Raw `<button>` and `<select>` controls rely on browser native defaults or ad-hoc `var(--color-...)` bindings without proper focus rings (`var(--color-focus-ring)`), hover states, or disabled opacity layers.
   - Custom card boxes (`border: 1px solid var(--color-border-medium)`) miss surface elevation tokens (`var(--color-surface-raised)`, `var(--color-surface-sunken)`), leading to flat contrast in high-contrast or light themes.

3. **WCAG 2.2 AA Accessibility Non-Compliance:**
   - **Target Size (WCAG 2.5.8):** Small raw `<button>` elements in `ScannerPanel.tsx` and `MemoryBrowser.tsx` lack the minimum 24×24px / 44×44px click target padding guaranteed by `<Button>`.
   - **Keyboard Navigation (WAI-ARIA 1.2):** Custom modals in `PartnerDealsModal.tsx` and `LlmStrategyEvalModal.tsx` lack focus trapping and Escape key listeners, which are automatically provided by `<Modal>`.
   - **Form Labelling & Errors:** Raw `<input>` and `<select>` controls lack `aria-invalid`, `aria-describedby`, and associated `<Field>` label binding.

---

## Prioritized Remediation Roadmap

To achieve complete composable UX primitive conformance (fulfilling Issues #492, #1337, and #1382), refactoring should proceed in four distinct phases:

```
Phase 1: High-Visibility & Reference Exceptions (Immediate)
  ├── Refactor SocialPostingPanel.tsx (#1382 reference) to full UI primitives
  ├── Refactor NavigationMenu.tsx & CapabilityNavBar.tsx
  └── Refactor StockSearchBar.tsx & PartnerDealsModal.tsx

Phase 2: Core Workspace & Chat Components (Short-Term)
  ├── Refactor AgentChatTabContent.tsx & ToolResultView.tsx
  ├── Refactor ReferralsTab.tsx & RevenueTab.tsx
  └── Complete partial primitive conversion in Chat.tsx & ETradeTradingHub.tsx

Phase 3: High-Volume Domain Panels (Mid-Term)
  ├── Refactor ScannerPanel.tsx (1,767 lines) & ScreenerResultsView.tsx
  ├── Refactor WorkflowsHub.tsx (1,935 lines) & AutopilotControlCenter.tsx (1,585 lines)
  └── Refactor PortfolioRiskPanel.tsx & McpApiExplorer.tsx

Phase 4: Automated CI Enforcement Pin (Final)
  └── Extend tests/ui_primitives_inventory.test.ts or add a new Vitest pin
      that flags any TSX component rendering raw <button>, <input>, <select>,
      <textarea>, or <table> controls outside src/client/components/ui/.
```

---

## Conclusion & Verification Plan

This report documents all 44 exception files (28 zero-primitive exceptions + 16 partial exceptions) currently bypassing UX primitives. Remediating these components will complete NextGenTP's transition to a fully composable, WCAG 2.2 AA compliant, and density-aware design system.

### Verification Commands
Future refactoring PRs must verify compliance with:
- `npm run check`
- `npx vitest run tests/ui_primitives_inventory.test.ts`
- `npx vitest run tests/ux_token_coverage_ratchet.test.ts`
- `npx vitest run tests/theme_preferences.test.ts`
