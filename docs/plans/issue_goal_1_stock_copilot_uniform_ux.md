## Agent
#ceo-aimp

## Problem
Stock Copilot currently has an inconsistent and fragmented user experience compared to all other copilots (General Copilot, Options Copilot):
1. **Divergent Layout**: Instead of following the uniform single-screen conversational layout with a sticky composer at the bottom, Stock Copilot was rendered as a split-screen dashboard (`StockCopilotPanel` alongside a squished chat pane), violating the copilot uniformity doctrine (#3488, #3514).
2. **False Mode Refusals on Alpaca Paper**: When deployment-wide environment variables pin `ALPACA_TRADING_TYPE="live"` for the worker account, `resolveAlpacaTradingBase` overrode `overrideEnv="TEST"`, setting `isLive: true` and causing the mode guard to refuse cycles as `refused_mode_mismatch`. The default for Stock Copilot must be Alpaca in paper mode and must never refuse on default settings.
3. **Stale Historical Activity Surface**: The left panel rendered stale historical activity records from hours earlier before the loop fixes, confusing users about the copilot's current state.

## Outcome
1. **100% Uniform Copilot UX**: Stock Copilot adopts `mode: "chat"` and shares the exact same full-height conversational stream with the **chatbox pinned to the bottom** across 100% width, matching Options Copilot and General Copilot. No dual panels, no split layouts, zero overlap.
2. **Alpaca Paper Default Guarantee**: Stock Copilot defaults strictly to **Alpaca in Paper mode** (`https://paper-api.alpaca.markets`, `isLive: false`), and `overrideEnv = "TEST"` explicitly takes precedence over any account-wide `ALPACA_TRADING_TYPE="live"` pin.
3. **Conversational Stream Integration**: Status, loop telemetry, open positions, and controls are presented as clean streaming cards and quick-chips inside the unified conversation stream.

## User journey
- **Journey**: Financial trader / operator interacting with Stock Copilot.
- **User**: Any authenticated user navigating to `?tab=chat&view=stock`.
- **How value surfaces in UX**: The user sees the exact same clean, responsive copilot interface as Options Copilot and General Copilot: a top banner, a full-height scrollable conversation stream with interactive Stock Copilot welcome hero / quick chips, and a sticky composer at the bottom. The loop runs autonomously in Alpaca Paper mode without refusal.

## Scope
- **Included**:
  - Update `stock` copilot definition in `src/client/chat/copilotRegistry.ts` to `mode: "chat"`.
  - Remove `splitLayout` and `dashboardPane` in `src/client/chat/AgentChatTabContent.tsx`; render `fullChatArea` for all registered copilots.
  - Update `resolveAlpacaTradingBase` in `src/trading/alpaca/platform.ts` so `overrideEnv === "TEST"` or `"PAPER"` guarantees paper mode even when `env.ALPACA_TRADING_TYPE` is `"live"`.
  - Ensure `resolveCopilotTradingSelection` in `src/agents/copilotTradingMode.ts` defaults to Alpaca in paper mode.
  - Tests ensuring uniform rendering, bottom composer presence, and fail-safe Alpaca paper resolution.
- **Excluded**:
  - LLM tool definitions for changing loop cadence / universe via chat (covered in follow-up sub-issues #3513, #3452).

## Acceptance criteria
- [ ] `hasCustomSurface(findCopilot("stock"))` returns `false` (declared as `mode: "chat"`).
- [ ] On `?tab=chat&view=stock`, layout renders `fullChatArea` with a sticky chatbox pinned at the bottom across 100% width.
- [ ] `resolveAlpacaTradingBase(env, "TEST")` returns `{ baseUrl: "https://paper-api.alpaca.markets", isLive: false }` even when `env.ALPACA_TRADING_TYPE === "live"`.
- [ ] Stock Copilot autonomous loop runs without `refused_mode_mismatch` under default configuration.
- [ ] Zero file deletions (Policy Gate §22).

## Test plan
- Vitest tests covering:
  - Copilot registry mode verification (`tests/chat_copilots_subtabs_3449.test.tsx`).
  - Alpaca trading base override resolution (`tests/alpaca_trading_platform_base.test.ts`).
  - Stock copilot trading mode default resolution (`tests/stock_copilot_modes_3451.test.ts`).
- Full frontend build verification (`npm run build`).
- TypeScript strict type check (`npx tsc --noEmit`).

## Dependencies
- Epic #3514 (`[Stock Copilot] One copilot, every channel — the full capability list invocable through chat, schedule, webhook, Slack, email, voice, MCP`)
- Issue #3488 (`[Uniform copilot standard] Any copilot, any channel`)

## Change management (expected)
- Expected impact: Stock Copilot frontend aligns with all other copilots; mode guard never refuses default paper execution.
- Migration and data impact: None; additive / configuration refinement only.
- Rollout plan: Merge to main via PR and Merge Queue.
- Rollback plan: Revert commit.
- Communication: Update Issue #3514 and program roadmap.

## Conformance (no drift — docs/compliance)
- UX surfaces touched: `AgentChatTabContent.tsx`, `copilotRegistry.ts` using Fluent design tokens.
- Architecture surfaces touched: `src/trading/alpaca/platform.ts`, `src/agents/copilotTradingMode.ts`.
- Reused surfaces: Standard copilot chat shell, existing Alpaca paper endpoint, existing message stream.
- Rework justification: Replaces ad-hoc split screen with standard uniform copilot shell.
- Regression risk + pins: Preserves all existing copilot tests and ensures no regressions on other copilot tabs.

## Agentic design (docs/agents)
- Capability allocation: Deterministic layout rendering and broker base URL resolution; agentic conversation via chat turns.
- Coordinator / delegation path: OrchestratorAgent routes turns.
- Task state + records: Mas_settings and durable object stores preserve configuration.
- Adaptive policies + budgets: Bounded token limits for streaming chat.
- Deterministic rules kept in code: Exact URL and mode resolution rules.
