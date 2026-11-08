### Added

- **Stock Copilot Recursive Self-Improvement (RSI) Loop & Copilot Evolution Program (#3758):**
  - **Autonomous Capability Gap Diagnosis:** Implemented `synthesizeCapabilityProposals` in `src/services/stockCopilotIntrospection.ts` diagnosing dynamic universe bottlenecks (`GAP_STATIC_UNIVERSE_BOTTLENECK`), unhedged CVaR drawdown exposure (`GAP_UNHEDGED_CVAR_EXPOSURE`), algorithmic strategy synthesis (`GAP_STRATEGY_SYNTHESIS_SANDBOX`), and restricted session coverage (`GAP_RESTRICTED_SESSION_COVERAGE`).
  - **Dual RSI Mode (Governed vs. Self-RSI):** Created `src/services/stockCopilotRsiMode.ts` with externalized setting `stock_copilot:rsi_mode` defaulting strictly to `"governed"` (institutional safe default). Governed mode drafts structured GitHub issue specifications for agentic team review (#ceo-aimp, #clo-arsi); Self-RSI mode uses `BrowserAgent`, `SandboxAgent`, and `ThinkWorkflow` for autonomous sandboxed code synthesis and backtesting. Configurable via chat prompt steering and `tool_openaimp_stock_copilot_control`.
  - **Hero Quick-Chips:** Added quick chips to Stock Copilot Hero greeting in `src/client/chat/copilotRegistry.ts` for *"💡 How can you improve yourself?"*, *"🔬 What capabilities do you need?"*, *"⚙️ Switch to Self-RSI mode"*, and *"🛡️ Switch to Governed RSI mode"*.
  - **Architecture Documentation:** Authored `docs/architecture/agentic/stockcopilot-RSI.md` and `docs/architecture/agentic/copilots-comparison-evolution.md` linking Master Epic #3752 and Sub-Issues #3753-#3758.

### Fixed

- **Optional Ticker Tape & Copilot Chat Header Cleanup (#3758):**
  - **Optional Ticker Tape (Default OFF):** Added `src/client/quotes/tickerVisibility.ts` persisting visibility preference under `cfagent:ticker_enabled` with default `false`. Added an Off/On pill toggle in `src/client/BrokerDynamicMenu.tsx` and conditionally rendered `<MarketTickerTape />` in `src/client/Chat.tsx`.
  - **Hover-Only Copilot Info Badges:** Removed fixed copilot banner blocks (`.options-copilot-banner`) and static badges (`Alpaca · Paper Loop`, `Structured Outputs`) across Stock, Options, and General copilots. Added right-aligned `TabHoverItem` to the capability subnav in `src/client/chat/AgentChatTabContent.tsx` showing copilot information strictly on hover.
  - **Removed Subtitle:** Removed fixed subtitle `"Stateful Distributed Ledger Session · neural strategy intelligence"` from `AgentChatTabContent.tsx`. #clo-arsi #ceo-aimp

