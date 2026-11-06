### Added

- **Stock Copilot dual-mode operation: deterministic trajectory + non-deterministic agentic loop (#3519, parent #3514):**
  - Added user-selected execution mode stored in `mas_settings` as `stock_copilot:execution_mode` (with `STOCK_COPILOT_EXECUTION_MODE` env default), defaulting to `deterministic`.
  - Added `StockCopilotMemoryPort` (`stock_copilot_learnings` in DO SQLite and in-memory double) for tenancy-scoped memory of distilled learnings.
  - Implemented `evaluateCriticRules` (`src/services/stockCopilotCritic.ts`) verifying trade intents against risk bounds (5% stop loss, 10% target, CVaR sizing caps, extended-hours limit orders) before order submission.
  - Implemented `runStockCopilotAgenticCycle` (`src/services/stockCopilotAgenticLoop.ts`) orchestrating the Perceive-Plan-Critic-Execute-Learn cycle. Raw model output never reaches orders; trades cross into the deterministic order seam only as validated data intents.
  - Extended `CopilotCycleActivityRecord` with `mode` and `criticVerdict`.
  - Added `getLearningsViaDoor` and route support to query learnings and answer "What did you learn from recent cycles?".
  - Added interactive quick-chips "💡 What have you learned?" and "🧠 Switch to Agentic Dual-Mode" to `copilotRegistry.ts`. #ceo-aimp

