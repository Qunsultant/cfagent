## Agent

#ceo-aimp

## Completion Report

### Issue
Fixes #3449 — [UX] Multi-Copilot Sub-Tabs: General, Options & Stock Copilot Separation in Chat

### PR
Merged via PR #3450 into `main` at commit `48c17217`.

### Summary of Delivered Work
1. **Multi-Copilot Sub-Tabs**:
   - Replaced the fixed, overlapping render layout on `https://agent.openaimp.com/?tab=chat` where `<StockCopilotPanel />` was previously rendered unconditionally at the top across all sub-views.
   - Organized all copilots into dedicated, distinct sub-tabs in `CapabilityNavBar`:
     - **General Copilot** (`id: "general"`): Enterprise conversational multi-agent orchestrator.
     - **Options Copilot** (`id: "options"`): Specialized options screening, multi-leg spreads, Greeks, and interactive payoff visualizers with dedicated structured outputs banner and quick action chips.
     - **Stock Copilot** (`id: "stock"`): Autonomous paper-trading loop telemetry, open positions with exit plans, recently closed positions, cycle activity feed, and execution pause/resume controls.
2. **View Isolation & Zero Overlap**:
   - In `general` and `options` views: `StockCopilotPanel` is hidden, restoring full-height conversational stream space and chat composer responsiveness without visual crowding.
   - In `stock` view: `StockCopilotPanel` renders exclusively within its own dedicated, scrollable custom surface.
3. **Modular & Extensible Copilot Architecture**:
   - Added `src/client/chat/copilotRegistry.ts` defining modular `CopilotConfig` descriptors with layout modes (`"chat"` vs `"custom"`), dynamic banners, badge types, tooltips, and composer prompts.
   - Provided `registerCopilot(...)`, `getRegisteredCopilots()`, `findCopilot()`, and `isRegisteredCopilotId()` for easy runtime extension by new or third-party copilots (e.g., Crypto, Forex, Research) with zero boilerplate.
   - Maintained full URL synchronization via `useUrlSyncedTabs` with canonical `?view=` and backwards-compatible aliases `?copilot=` / `?subtab=`.
4. **Verification & Conformance**:
   - Added hermetic unit and integration suite `tests/chat_copilots_subtabs_3449.test.tsx` (8/8 passed).
   - Verified existing options sub-view wiring in `tests/chat_options_view_wiring.test.ts` (5/5 passed).
   - Verified stock copilot panel tests in `tests/stock_copilot_panel_3422.test.tsx` (4/4 passed).
   - Verified token coverage and UX conformance in `tests/ux_token_coverage_ratchet.test.ts`, `tests/ux_conformance_gates_3047.test.ts`, and `tests/ux_bespoke_ceiling_2177.test.ts`.
   - Verified Post-Merge CI on `main` green.
   - Zero deletions policy strictly preserved.

