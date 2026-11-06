# Stock Copilot: Omnichannel Program & Uniform Architecture Roadmap

## Agent
#ceo-aimp

## 1. Vision & Architectural Principle
Stock Copilot must be a **world-class, channel-agnostic AI copilot** adhering to the uniform copilot standard (Issue #3488, Issue #3514):
- **Uniformity Doctrine**: Every copilot (`general`, `options`, `stock`, and future specialized copilots) shares the **exact same UI shell**: full-height conversational stream, interactive streaming cards, and a sticky composer pinned to the bottom. No isolated admin dashboards, no dual-panel splits, no layout regressions.
- **Reuse Over Reinvention**: Reuse and enhance the existing Cloudflare Agents and Think platform architecture:
  - `ThinkScheduledTask` & Scheduler for autonomous loop execution.
  - 5-stage pipeline (`feed -> enrich -> analyze -> generate -> deliver`) via producer/consumer and pub/sub.
  - Existing audit trails (`mas_audit`), metrics, and R2 blob storage (`REPORTS_BUCKET`).
  - Existing `AlpacaTradingPlatform` and `ETradeTradingPlatform` via broker-neutral routing.
- **Dynamic Introspection & Reflection**: The Copilot introspects its live configuration, registered tools, and active sessions at runtime rather than relying on hardcoded static prompts.
- **Externalized Everything (AOP)**: Every default (cadence, universe, session strategies, stop-loss, take-profit) is externalized to environment variables and dynamic tenant `mas_settings`.

---

## 2. Program Sub-Issues & Phased Roadmap

| Sub-Issue | Title | Scope & Objectives | Status |
|---|---|---|---|
| **Sub-Issue 1 (Goal 1)** | **Uniform Copilot UX & Alpaca Paper Default** | Eliminate side-by-side split panels; set `mode: "chat"` with bottom composer; enforce Alpaca Paper as the unbreakable default; prevent mode guard refusal from deployment-wide pins. | **In Progress (Active Focus)** |
| **Sub-Issue 2 (#3513)** | **Chat Door to Loop Values & Telemetry** | Implement `tool_openaimp_stock_copilot_status` and mesh doors reading positions, session states, and cycle activity from Durable Object SQLite into the conversation stream. | Open |
| **Sub-Issue 3 (#3452 & extensions)** | **Chat-Driven Loop Configuration & Cadence** | Allow users to adjust cadence (e.g., 60m vs 30m), universe (add/remove symbols), and session-specific pattern strategies (pre-market vs intraday) via chat commands storing to `mas_settings`. | Open |
| **Sub-Issue 4** | **5-Stage Pipeline Integration (`ThinkWorkflow`)** | Wire Stock Copilot cycles to the formal `feed -> enrich -> analyze -> generate -> deliver` stages with pub-sub event emission and job status inspection. | Open |
| **Sub-Issue 5** | **Multi-Format Report Generation** | Allow users to request cycle, performance, and reconciliation reports in PDF, CSV, and Markdown, uploaded to R2 (`REPORTS_BUCKET`) and surfaced as download cards in chat. | Open |
| **Sub-Issue 6** | **Tool-Driven Reflection & Self-Explanation** | Equip the Copilot with runtime tool catalog introspection so it answers *"What are you doing?"*, *"What can you do?"*, and *"What stages do you follow?"* dynamically from its available tools and state. | Open |

---

## 3. Immediate Implementation: Goal 1 (UX Uniformity & Alpaca Paper Guarantee)

1. **Frontend (`src/client/chat/copilotRegistry.ts` & `AgentChatTabContent.tsx`)**:
   - Update `stock` copilot config in `DEFAULT_COPILOTS` to `mode: "chat"`.
   - Tear down `splitLayout` and `dashboardPane` in `AgentChatTabContent.tsx`.
   - Render the standard `fullChatArea` for all copilots including Stock Copilot, with the **chatbox pinned to the bottom**.
   - Provide a clean Stock Copilot Welcome Hero with quick-chips for telemetry, open positions, risk parameters, and execution controls.
2. **Backend & Trading Mode (`src/agents/copilotTradingMode.ts` & `src/trading/alpaca/platform.ts`)**:
   - Enforce that when resolving Alpaca trading base for Stock Copilot in `TEST` / paper mode, `overrideEnv = "TEST"` guarantees `baseUrl: "https://paper-api.alpaca.markets"` and `isLive: false`, preventing any deployment-level `ALPACA_TRADING_TYPE="live"` from overriding paper mode and causing `refused_mode_mismatch`.
   - Ensure the default selection is always Alpaca in Paper mode.
