## Summary

Closes #3521

## Agent
#ceo-aimp

## Problem
On `https://agent.openaimp.com/?tab=chat&view=stock`, the Stock Copilot surface was squeezed into a 45vh/50% height region with the general chat stream (including welcome hero and quick chips) and sticky input bar rendered underneath it (#3454). Because `StockCopilotPanel` is an autonomous trading loop dashboard (telemetry, loop status, open positions, exit plans, cycle activity feed), squeezing it caused element collisions, double scrollbars, and obscured controls.

## Solution
1. **Dedicated View Exclusivity (`AgentChatTabContent.tsx`)**:
   When `hasCustomSurface(currentCopilot)` is true (e.g. Stock Copilot), render the custom surface exclusively across the entire available tab viewport (`flexGrow: 1`, `overflowY: "auto"`), without rendering the general chat welcome hero, action bar, messages stream, or sticky input composer underneath.
2. **Clean Single-Container Flow (`stockCopilotPanel.css`)**:
   Removed `max-height: 45vh` from `.scp-panel`, allowing the dashboard to scroll cleanly within the tab viewport container and eliminating nested scrollbars.
3. **Registry Contract Clarification (`copilotRegistry.ts`)**:
   Documented that `mode: "custom"` renders dedicated copilot dashboards exclusively, while `mode: "chat"` renders conversational interfaces.
4. **Test Suite Verification (`tests/chat_copilots_subtabs_3449.test.tsx`)**:
   - Assert `view=stock` renders `StockCopilotPanel` exclusively without `.chat-input-bar` or `.messages-stream`.
   - Assert conversational views (`general`, `options`) render the shared conversation stream, welcome hero, and input composer.
   - Assert message typing and sending on conversational views.

## Verification
- Vitest: All 11 tests in `tests/chat_copilots_subtabs_3449.test.tsx` pass.
- Policy Gate: Clean pass with zero deletions.
- Changelog fragment added in `changelog.d/3521-stock-copilot-tab-exclusivity.md`.

## Conformance Checklist
- [x] Red-green or strict contract tests added/updated.
- [x] Zero deletions enforced (§22).
- [x] Policy gate passed locally.
- [x] Body-only attribution with `#ceo-aimp`.
- [x] Linear rebased history.

Process documentation impact: none (pure UI fix, no changes to agent policy or developer workflows)

