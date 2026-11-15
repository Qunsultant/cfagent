> **RETIRED — archived 2026-11-15 (#4632, D0).** Moved here from
> `docs/architecture/UX/assessment-01.md`. Point-in-time snapshot
> (2026-10-25), frozen: its findings are partially addressed since, with
> no doc recording what remains open. It states no live rule; the live
> gates are the current enforcement. Retirement recorded in
> `docs/architecture/transition/deprecations.md`.

# UX Assessment & Compliance Audit (Assessment 01)

**Document Version:** 1.0.0
**Status:** Approved Architecture Evaluation
**Target Application:** NextGenTP / AI Search Agent (`ai-search-agent`)
**Compliance Standards Assessed:**
- **WCAG 2.2 Level AA / AAA** (Accessibility Guidelines)
- **WAI-ARIA Authoring Practices 1.2** (Widget, Keyboard & Live Region Patterns)
- **Microsoft Human-AI Interaction (HAX) Guidelines** (Capabilities, Uncertainty, Control, Feedback)
- **OWASP Agentic & LLM Security Top 10** (ASI-01 through ASI-10: Permission Boundaries, Action Transparency, Tool Binding)
- **NextGenTP Design System Spec** (`DESIGN.md` & `docs/agents/ux-architecture.md`)

---

## Executive Summary

This assessment presents a comprehensive evaluation of the user experience (UX), information architecture, accessibility compliance, state management, design token adherence, and agentic interaction patterns across the NextGenTP application.

While recent platform refactoring has established strong foundations—such as zero raw color literal enforcement in `src/client/`, composable UI primitives in `src/client/components/ui/`, and pre-hydration theme resolution—a rigorous audit reveals critical architectural gaps, component fragmentation, accessibility defects, and state synchronization issues that prevent the product from meeting world-class agentic UX standards.

### Summary of Key Findings
1. **Information Architecture & Workspace Fragmentation:** The UI is organized around standalone domain tools (Screeners Hub, Workflows Hub, Options Research Panel, ETrade Trading Hub, Autopilot Control Center) rather than goal-oriented task lifecycles with evidence, decisions, and progress tracking.
2. **Agentic Autonomy & Approval Gaps (OWASP / Microsoft HAX):** Trades and consequential agent actions lack explicit delegation contracts, pre-execution cost/exposure previews, and version-bound approval tokens.
3. **Accessibility & WCAG 2.2 AA Compliance Deficiencies:** Gaps remain in keyboard focus trapping (modals), screen reader live announcements during live streaming/polling, minimum touch target size (24px/44px guidelines), and high-contrast color contrast ratios for secondary indicators.
4. **UX Token Architecture & Primitive Usage Gaps:** Although raw hex colors are banned by `tests/ux_token_coverage_ratchet.test.ts`, ad-hoc inline styles (`style={{ padding: "12px", gap: "8px" }}`) bypass tokenized density variables (`--control-height`, `--input-padding`, `--card-padding`), and custom element re-implementations persist in domain panels instead of consuming `src/client/components/ui/`.
5. **State Synchronization & Error Recovery Defects:** WebSocket/polling updates optimistically update UI without explicit server outcome confirmation, and error boundaries lack safe recovery/compensating action triggers.

---

## 1. Domain-by-Domain Comprehensive Assessment

### 1.1 Navigation & Information Architecture
* **Current State:** Navigation relies on `CapabilityNavBar.tsx` and `segmentedNavigation.ts` with top-level tabs (`Trading`, `Research`, `Screener`, `Workflows`, `Autopilot`, `API/MCP`, `Settings`).
* **Issues & Gaps:**
  - **Tool-Centric vs Goal-Centric:** Navigation exposes agent operational tooling rather than user goals, active tasks, and pending approvals.
  - **Overlapping Research Views:** `MarketDataResearchHub.tsx`, `OptionsResearchPanel.tsx`, `LlmOptionsIdeasPanel.tsx`, and `IvHistoryPanel.tsx` exist as separate tabs/panels without a unified task workspace.
  - **Lack of Global Approval Queue:** High-risk actions (e.g. order execution, social posting, schedule mutations) are scattered across individual panels instead of appearing in a centralized `Approvals` inbox.

### 1.2 Goal Capture, Scoping & Delegation Contracts
* **Current State:** Forms in `GoalScreenPanel.tsx` and `SchedulesPanel.tsx` collect basic search/scan parameters.
* **Issues & Gaps:**
  - **Missing Delegation Contract:** Users cannot specify explicit boundaries (budget limits, permitted tool classes, allowed loss/exposure threshold, maximum duration, human-in-the-loop triggers) before starting autonomous runs.
  - **Ambiguity Resolution:** No interactive clarification loop exists when user inputs are ambiguous; the backend either executes with implicit defaults or fails without recovery guidance.

### 1.3 Autonomy, Permissions & Action Approvals (OWASP / HAX)
* **Current State:** `AutopilotControlCenter.tsx` displays policy decisions; `ETradeTradingHub.tsx` handles trade previews.
* **Issues & Gaps:**
  - **Unbound Approvals:** Approvals do not bind to exact proposed payload versions. If market quotes or order parameters change between approval and execution, stale approvals can be executed.
  - **Missing Reversibility Disclosures:** Approval modals do not explicitly label actions as irreversible, reversible, or requiring compensating operations.
  - **Lack of Capabilities Matrix:** Users cannot view or adjust granular permissions (Read, Draft, Analyze, Execute, Commit) per agent or tool.

### 1.4 Execution State, Real-Time Monitoring & Disconnection Recovery
* **Current State:** Polling hooks (`usePolling.ts`, `panel_api_job_polling.test.ts`) update job execution statuses.
* **Issues & Gaps:**
  - **Connection vs Task State Confusion:** Network disconnects or polling timeouts are occasionally represented as task failures.
  - **Stream Noise for Screen Readers:** Real-time updates push raw token/event changes without filtering, creating screen reader announcement overload.
  - **Reconnection Snapshot Reconcile:** Refreshing or reconnecting re-initiates full polling instead of fetching an authoritative state reconciliation snapshot.

### 1.5 Evidence, Uncertainty & Artifact Lifecycle
* **Current State:** Research reports and scanner outputs generate downloadable PDFs/CSVs.
* **Issues & Gaps:**
  - **Confidence & Source Attribution:** Model recommendations lack inspectable source provenance, timestamp freshness badges, and explicit uncertainty classifications (e.g., "Calculated", "Estimated", "Unverified").
  - **Artifact Versioning & Edits:** Generated reports cannot be edited or version-compared directly in the UI before publication/export.

### 1.6 Errors, Interruption & Compensating Actions
* **Current State:** `ErrorBoundary.tsx` catches runtime react errors.
* **Issues & Gaps:**
  - **Incomplete Error Guidance:** Error messages state the technical failure but do not detail what steps completed, what side-effects occurred, or whether retry is safe.
  - **Cancellation Semantics:** Cancelling an active run does not report whether in-flight external tool requests were successfully halted or require compensation.

### 1.7 Personalization, Memory & Privacy Transparency
* **Current State:** `MemoryBrowser.tsx` displays stored memory items.
* **Issues & Gaps:**
  - **Lack of Distinction Between Context Types:** Saved preferences, inferred habits, conversation history, and verified domain facts are presented in a flat list.
  - **Retention & Data Governance:** Users cannot see retention policies, expiry dates, or tenant isolation scope per memory entry.

---

## 2. UX Token Architecture Audit

### 2.1 Token Layers Assessment
* **Layer 1 (Primitives):** `src/client/tokens.css` defines spacing, fonts, radii, and core scale variables.
* **Layer 2 (Semantic Tokens):** Semantic roles (`--color-surface`, `--color-surface-raised`, `--color-surface-sunken`, `--color-card`, `--color-muted`, `--color-primary`, `--color-success`, `--color-danger`, etc.) adapt seamlessly across dark and light modes via `data-theme`.
* **Layer 3 (Utilities & Primitives):** Standard classes (`.bg-surface`, `.text-primary`, `.border-subtle`, `.badge-success`, etc.) and UI primitives in `src/client/components/ui/` wrap these styles.

### 2.2 Token Compliance & Architectural Violations
* **Enforced Controls (Strengths):**
  - `tests/ux_token_coverage_ratchet.test.ts` strictly prevents raw color literals (hex, rgb, hsl, named CSS colors) in `src/client/` outside `tokens.css` and `designTokens.ts`.
  - `scripts/gen-design-tokens.mjs --check` validates that TS token definitions remain in parity with CSS variables.
* **Un-tokenized Hardcoded Values (Areas for Improvement):**
  - **Inline Spacing & Layouts:** Components frequently contain hardcoded pixel inline styles (e.g., `style={{ padding: "16px", gap: "12px", borderRadius: "8px" }}`) instead of tokenized CSS variables (`var(--space-4)`, `var(--radius-md)`).
  - **Density Tokens Underutilization:** While `tokens.css` defines `--control-height`, `--input-padding`, `--table-row-height`, and `--card-padding`, domain components in `src/client/` rarely consume them, preventing consistent comfortable/compact density toggling across the suite.
  - **Ad-Hoc Markup vs UI Primitives:** Several panels (`AccountPanels.tsx`, `ApiKeysPanel.tsx`, `SocialPostingPanel.tsx`) write custom `<button>`, `<select>`, and `<table>` DOM elements with inline styles rather than importing `Button`, `Select`, `Table`, and `Card` from `src/client/components/ui/`.

---

## 3. Standards Compliance Analysis (WCAG 2.2 AA, WAI-ARIA, HAX, OWASP)

| Domain | Standard | Status | Gap / Non-Compliance | Required Remediation |
|---|---|---|---|---|
| **Accessibility** | WCAG 2.2 AA 2.5.8 (Target Size) | Non-Compliant | Interactive icons and table action buttons in `ScannerPanel.tsx` and `MemoryBrowser.tsx` measure <24px without padding. | Ensure all touch/click targets meet minimum 24x24px (preferably 44x44px for primary actions). |
| **Accessibility** | WCAG 2.2 AA 4.1.3 (Status Messages) | Non-Compliant | Polling updates in `AsyncJobsPanel.tsx` update DOM visually without `aria-live="polite"` or `role="status"`. | Wrap progress/status streams in polite live regions. |
| **Accessibility** | WAI-ARIA 1.2 (Keyboard Navigation) | Non-Compliant | Custom modal dialogs in `PartnerDealsModal.tsx` lack focus trapping and focus restore on unmount. | Utilize `Modal` primitive from `components/ui/Modal.tsx` which enforces Esc key & focus trap. |
| **AI Interaction** | Microsoft HAX #1 (Scope Disclosure) | Partial | Goal creation forms do not summarize what systems or tools will be accessed. | Display a "Delegation Contract" preview before execution. |
| **AI Interaction** | Microsoft HAX #9 (Uncertainty) | Non-Compliant | Options and research recommendations provide single confidence numbers without method breakdown. | Expose inspectable evidence, data freshness, and methodology labels. |
| **Agentic Security** | OWASP ASI-02 (Action Transparency) | Non-Compliant | Trades in `ETradeTradingHub.tsx` do not preview exact execution payload, fees, or slippage limits. | Implement explicit Approval Cards with payload hashes and expiration bounds. |
| **Agentic Security** | OWASP ASI-03 (Untrusted Content) | Partial | Agent response renders markdown with risk of unsafe links/html injection. | Sanitize and isolate all untrusted model outputs through safe renderer wrappers. |

---

## 4. Consolidation, Reuse, and Optimization Opportunities

### 4.1 Component Primitive Consolidation
Replace page-local DOM elements across all domain panels with shared primitives from `src/client/components/ui/`:

1. **Buttons & Actions:** Replace `<button className="...">` in `SocialPostingPanel.tsx`, `ApiKeysPanel.tsx`, and `DataProvidersPanel.tsx` with `<Button variant="...">`.
2. **Status Badges:** Unify ad-hoc status badges across `AsyncJobsPanel.tsx` and `WorkflowsHub.tsx` with `<Badge tone="success|danger|warning|info">`.
3. **Form Controls:** Replace raw `<input>` and `<select>` controls in `GoalScreenPanel.tsx` and `SchedulesPanel.tsx` with `<TextInput>` and `<Select>` backed by `FieldShell`.
4. **Data Tables:** Migrate custom tabular layouts in `ScreenerResultsView.tsx` and `IvHistoryPanel.tsx` to `<Table columns={...} data={...}>`.

### 4.2 Workspace & Navigation Consolidation
Consolidate fragmented views into a unified **Task Workspace Information Architecture**:
- **Consolidate Research Panels:** Merge `MarketDataResearchHub`, `OptionsResearchPanel`, `LlmOptionsIdeasPanel`, and `IvHistoryPanel` into a single **Research & Analysis Hub** with unified tabbed sub-navigation.
- **Consolidate Operations & Monitoring:** Merge `AsyncJobsPanel`, `AutopilotControlCenter`, and `SchedulesPanel` into an **Agent Operations & Activity Workspace**.
- **Centralize Approvals:** Introduce a top-level **Approvals Inbox** tab that gathers pending trade executions, social posts, and schedule modifications requiring human sign-off.

---

## 5. Actionable Implementation Roadmap

```
Phase 1: Token & Primitive Standardization (Short-Term)
  ├── Enforce primitive adoption across all domain panels
  ├── Eliminate ad-hoc inline spacing/layout styles in favor of token variables
  └── Standardize density variables (--control-height, --card-padding)

Phase 2: Accessibility & Standards Compliance (Mid-Term)
  ├── Enforce WCAG 2.2 AA target size (24px/44px minimums)
  ├── Integrate aria-live regions for stream and polling state updates
  └── Audit and fix focus management, roving tabindex, and keyboard shortcuts

Phase 3: Agentic UX & OWASP Security Architecture (Long-Term)
  ├── Implement Delegation Contracts prior to autonomous run initiation
  ├── Build version-bound Approval Cards with exposure previews
  ├── Unify Task Workspace, Research Hub, and Approvals Inbox
  └── Provide inspectable evidence cards with data freshness & confidence breakdown
```

---

## Conclusion & Verification Plan

By executing the consolidation, primitive adoption, accessibility fixes, and agentic interaction patterns detailed in this assessment, NextGenTP will achieve a world-class, WCAG 2.2 AA compliant, and OWASP-secure user experience.

All future UX refactoring must pass existing automated verification gates:
- `npm run check`
- `tests/ux_token_coverage_ratchet.test.ts`
- `tests/composable_ui_primitives.test.ts`
- `tests/ui_primitives_inventory.test.ts`
