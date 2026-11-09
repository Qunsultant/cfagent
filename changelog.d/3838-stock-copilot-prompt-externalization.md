### Stock Copilot Prompt Externalization & Alpaca HITL Invariant (#3838)

- **Stock Copilot Prompt Externalization & Alpaca HITL Invariant (#3838):**
  - Externalized all Stock Copilot prompts, capabilities, and trading steering into `src/agents/prompts/stockCopilotPrompt.ts`.
  - Replaced contradictory E*TRADE order preview and execute commands on activated Stock Copilot turns with Alpaca trading tools (`tool_openaimp_alpaca_preview_order`, `tool_openaimp_alpaca_place_order`, `tool_openaimp_alpaca_get_quote`, `tool_openaimp_alpaca_orders`, `tool_openaimp_alpaca_cancel_bracket_ladder`).
  - Instructed the model on ticker symbol normalization (e.g. `appl` -> `AAPL`), synchronous trade execution (prohibiting async job polling loops on trading tools), and routing approvals to `alpaca_place_order`.
  - Conformed `ToolResultView.tsx` broker resolution to default to Alpaca for copilot order proposals and paper mode, eliminating erroneous E*TRADE draft labeling.
