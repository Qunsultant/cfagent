## Agent
#ceo-aimp

## Problem
Navigating to `https://agent.openaimp.com/?tab=chat&view=stock` produces a severe visual overlap and dual-scrolling conflict.
In PR #3454, a "uniform copilot shell" was introduced that stacked the custom copilot surface (`StockCopilotPanel`) directly above the general chat stream (which contains the tall welcome hero and quick chips) and sticky bottom composer, clamping the custom surface with `maxHeight: "50%"` and `.scp-panel` with `max-height: 45vh; overflow-y: auto;`.

Because `StockCopilotPanel` is an autonomous trading dashboard containing telemetry, live execution controls, position tables with exit plans, and cycle feeds, squeezing it into 45-50% of the viewport causes elements to collide with the chat hero and sticky composer beneath it, producing nested scrollbars and an unusable interface. Furthermore, `StockCopilotPanel` is an autonomous loop surface, not an interactive chatbot, so forcing the general chat stream and composer underneath it is functionally inappropriate.

## Outcome
Clean, permanent tab exclusivity is restored:
1. When a copilot declares a custom surface (`hasCustomSurface` or `mode: "custom"`, e.g. Stock Copilot), it renders exclusively across the entire available tab viewport (`flexGrow: 1`, `overflowY: "auto"`), without the general chat hero, action bar, messages stream, or chat input bar underneath it.
2. For conversational copilots (`mode: "chat"`, e.g. General Copilot and Options Copilot), the shared conversation stream, welcome hero, quick chips, and sticky input bar render normally.
3. The arbitrary 45vh / 50% max-height clamps in `stockCopilotPanel.css` and `AgentChatTabContent.tsx` are removed, allowing the dashboard to scroll cleanly in a single viewport container without double scrollbars.

## User journey
Journey: User opens `https://agent.openaimp.com/?tab=chat&view=stock` or selects "Stock Copilot" tab from the Chat capability navbar.
User: Quantitative trader, investor, or platform operator monitoring autonomous stock loop executions.
How value surfaces in UX: The Stock Copilot dashboard occupies the entire viewport cleanly with unobstructed access to loop status, pause/resume controls, open position tables, exit plans, and cycle logs without overlapping the general chat stream or competing with double scrollbars.

## Scope
Included:
- Update `src/client/chat/AgentChatTabContent.tsx`: render `StockCopilotPanel` (or `currentCopilot.renderCustom`) exclusively when `hasCustomSurface(currentCopilot)` is true, rather than stacking the chat conversation underneath.
- Update `useSurfaceStyles` in `src/client/chat/AgentChatTabContent.tsx`: expand `customSurface` to `flexGrow: 1`, `flexShrink: 1`, `minHeight: 0`, `overflowY: "auto"` (removing `maxHeight: "50%"`).
- Update `src/client/stockCopilotPanel.css`: change `.scp-panel` from `max-height: 45vh; overflow-y: auto;` to `flex: 1; min-height: 0;` so scrolling is handled cleanly by the surface container.
- Update `src/client/chat/copilotRegistry.ts`: document that `mode: "custom"` renders dedicated copilot dashboards exclusively, while `mode: "chat"` renders the conversational interface.
- Update `tests/chat_copilots_subtabs_3449.test.tsx` to assert that `view=stock` renders `StockCopilotPanel` exclusively without `.chat-input-bar` or `.messages-stream`, while `view=general` and `view=options` render the conversation.
- Add changelog entry in `changelog.d/`.

Excluded:
- Modifying Stock Copilot backend routes or session services.
- Modifying Options Copilot or General Copilot conversational behaviors.

## Acceptance criteria
- [ ] On `?tab=chat&view=stock`, `StockCopilotPanel` is rendered exclusively across the full tab height.
- [ ] On `?tab=chat&view=stock`, the chat messages stream and chat input bar are NOT rendered (zero overlap).
- [ ] On `?tab=chat&view=general` and `?tab=chat&view=options`, the chat messages stream and chat input bar ARE rendered.
- [ ] `.scp-panel` does not have `max-height: 45vh`, eliminating nested scrollbars.
- [ ] All tests in `tests/chat_copilots_subtabs_3449.test.tsx` pass.
- [ ] TypeScript check (`npx tsc --noEmit`) and Vite build pass without errors.
- [ ] Policy gate passes with zero deletions.

## Test plan
- Run `npx vitest run tests/chat_copilots_subtabs_3449.test.tsx --exclude "**/.worktrees/**"`.
- Verify full test battery and build.

## Dependencies
None.

## Change management (expected)
Expected impact: Permanently eliminates UI overlap and double scrollbars on the Stock Copilot view.
Migration and data impact: None.
Rollout plan: PR via merge queue.
Rollback plan: Git revert if needed.
Communication: Changelog entry and §15 completion report.

## Conformance (no drift — docs/compliance)
UX surfaces touched: `src/client/chat/AgentChatTabContent.tsx`, `src/client/stockCopilotPanel.css`.
Architecture surfaces touched: `src/client/chat/copilotRegistry.ts`.
Reused surfaces: `StockCopilotPanel`, `CapabilityNavBar`.
Rework justification: Fixes UI regression introduced in #3454 that broke viewport exclusivity.
Regression risk + pins: `tests/chat_copilots_subtabs_3449.test.tsx` pins exclusivity and ensures no regressions for `general` and `options` views.

