# Completion Report — Issue #3541

## Agent
#ceo-aimp

## 1. Executive Summary
- **Issue**: [#3541](https://github.com/Qunsultant/cfagent/issues/3541)
- **Pull Request**: [#3547](https://github.com/Qunsultant/cfagent/pull/3547)
- **Branch**: `feat/3541-stock-copilot-unconstrained`
- **Goal**: Eliminate autonomous trading loop blockers ("The mode guard refused this cycle" and "The pre-market session opened — it is not one of your enabled sessions, so the loop is waiting"), default all 4 trading sessions (`pre_market`, `regular`, `after_hours`, `exto`) for 24/7 continuous operation, externalize mode guard constraints, and provide a side-by-side split workspace on `?tab=chat&view=stock` with full chatbox capabilities.

---

## 2. Root Cause Analysis (RCA)

### A. Why did the mode guard refuse the cycle ("The mode guard refused this cycle")?
- In `src/services/stockCopilot.ts` lines 689–695:
  ```ts
  const resolvedBase = resolveAlpacaTradingBase(deps.env, selection.environment);
  if (resolvedBase.isLive !== (selection.mode === "live")) {
    result.status = "refused_mode_mismatch";
    result.refusal = STOCK_COPILOT_MODE_MISMATCH;
    appendCycleActivity(deps, result, nowIso, "refused", STOCK_COPILOT_MODE_MISMATCH, session);
    return result;
  }
  ```
- In Cloudflare Worker production, the environment defines `ALPACA_TRADING_TYPE="live"` (or live credentials / base URL).
- However, when a tenant has not stored an explicit environment setting in `mas_settings` (`etrade:environment`), `resolveTradeEnvironmentFromSettings` defaulted unconditionally to `"TEST"` (mapping to paper).
- This generated a synthetic selection `{ environment: "TEST", mode: "paper" }` which directly contradicted the deployment's live base (`isLive: true`).
- The mode guard aborted every cycle as `refused_mode_mismatch`.

### B. Why did cycles halt outside regular hours ("The pre-market session opened — it is not one of your enabled sessions")?
- In `src/services/stockCopilotSessions.ts` line 58:
  ```ts
  export const DEFAULT_COPILOT_SESSIONS: readonly CopilotSessionId[] = ["regular"];
  ```
- Default sessions only included `"regular"` (09:30–16:00 ET).
- Outside regular hours (04:00–09:30 Pre-market, 16:00–20:00 After-hours, 20:00–04:00 Overnight EXTO), `session === null || !enabledSessions.includes(session)` triggered `outside_enabled_sessions` and paused the loop.

### C. Why did the overlap occur only for Stock Copilot and not for others?
- `general` and `options` copilots are conversational only (`mode: "chat"`): they render no dashboard, so the viewport has only one single scrollable area (`.messages-stream`) taking `flex: 1`, leaving the bottom composer fixed and visible without overlap.
- `stock` copilot introduced a custom surface (`StockCopilotPanel`). In PR #3454, it was stacked vertically above the conversation stream inside a 50% max-height container. Because the welcome hero and messages stream also required vertical space, two scrollbars fought on the same vertical axis, crushing elements into half height and overlapping.
- In PR #3521, an attempt to prevent this crushing isolated `StockCopilotPanel` by suppressing the conversational chatbox completely. This eliminated the overlap but removed all chat capabilities from Stock Copilot.

---

## 3. Implementation Details

### A. 24/7 Trading Sessions by Default
- `DEFAULT_COPILOT_SESSIONS` updated to all four canonical sessions:
  `["pre_market", "regular", "after_hours", "exto"]`.
- `parseCopilotSessionList` supports `"all"` and `"*"` aliases to enable all sessions.
- `STOCK_COPILOT_IGNORE_SESSIONS="true"` and `STOCK_COPILOT_FORCE_ALL_SESSIONS="true"` allow full session bypass via env.

### B. Externalized Non-Blocking Mode Alignment
- In `src/agents/copilotTradingMode.ts`:
  When no tenant setting is stored in `readSettingRaw(BROKER_ENVIRONMENT_SETTING_KEY)`, `resolveCopilotTradingSelection` respects externalized deployment configurations (`STOCK_COPILOT_MODE` and `ALPACA_TRADING_TYPE`). If live, it resolves as `PROD` / `live`; if paper, `TEST` / `paper`.
- In `src/services/stockCopilot.ts`:
  When `resolvedBase.isLive !== (selection.mode === "live")`, if `STOCK_COPILOT_STRICT_MODE_GUARD="false"` or `STOCK_COPILOT_AUTO_ALIGN_MODE="true"`, the loop auto-aligns `selection.mode = resolvedBase.isLive ? "live" : "paper"` rather than refusing.
- Added broker neutrality support via `STOCK_COPILOT_BROKER_NEUTRAL="true"` and `STOCK_COPILOT_BROKER_ID`.

### C. Side-by-Side Responsive Workspace UX
- In `src/client/chat/AgentChatTabContent.tsx`:
  - Desktop: Replaced vertical 50% stacking with a horizontal split workspace (`splitLayout`).
    - **Left Pane (`dashboardPane`)**: Full `StockCopilotPanel` dashboard with independent scrolling (`overflow-y: auto`), 50% width, 100% viewport height.
    - **Right Pane (`chatPane`)**: Full conversational chatbox with independent scrolling (`overflow-y: auto`), 50% width, 100% viewport height.
  - Mobile (<900px): Clean responsive stack with bounded flex containers.
  - Stock Copilot Welcome Hero when `messages.length === 0`:
    - Quick chips: 📊 Open Positions & Exits, 🔄 Latest Cycle Telemetry, 🛡️ CVaR Risk Management, ⏰ 24/7 Trading Sessions, ⏸️ Pause Loop, ▶️ Resume Loop.
  - Chat Input loop adjustments: typing "pause loop" / "resume loop" calls `setStockCopilotPaused` directly while streaming conversational confirmations.

---

## 4. Verification Evidence

### Fast Gates & Battery Checks
1. `npm run build`: **Green** in 8.13s (3,713 modules transformed, 0 errors).
2. `npx tsc --noEmit`: **Green** across all modified files.
3. Vitest Battery:
   - `tests/stock_copilot_sessions_3398.test.ts`: **45 / 45 passed**
   - `tests/stock_copilot_3391.test.ts`: **22 / 22 passed**
   - `tests/stock_copilot_surface_3422.test.ts`: **16 / 16 passed**
   - `tests/stock_copilot_modes_3451.test.ts`: **25 / 25 passed**
   - `tests/stock_copilot_routes_3422.test.ts`: **11 / 11 passed**
   - `tests/stock_copilot_panel_3422.test.tsx`: **11 / 11 passed**
   - `tests/stock_copilot_settings_webhook_3471.test.ts`: **22 / 22 passed**
   - `tests/chat_copilots_subtabs_3449.test.tsx`: **11 / 11 passed**
   - **Total: 163 tests passed across all suites.**
4. Policy Gate:
   `python scripts/ci/policy_gate.py --base origin/main --head HEAD --diff-only` → **Passed 100%**.

