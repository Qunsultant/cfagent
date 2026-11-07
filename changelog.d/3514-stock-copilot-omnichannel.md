### Added

- **Stock Copilot Omnichannel Capabilities & Platform MCP Tools (#3514)**:
  - Added dynamic universe resolution (`resolveCopilotUniverse`) supporting presets (`NASDAQ100`, `SP100`, `MEGA_TECH`, `SEMIS`) and custom comma-separated tickers externalized in `mas_settings`.
  - Added dynamic strategy selection (`resolveCopilotStrategies`) supporting `"all"` or custom strategy subsets externalized in `mas_settings`.
  - Implemented on-demand strategy evaluation (`evaluateStockCopilotStrategy`) over live market bars without order execution or position alterations.
  - Added platform MCP tools `stock_copilot_learnings` and `stock_copilot_evaluate` to `McpToolFactory` and `meshDoorCommands.ts`.
  - Extended `stock_copilot_control` MCP tool, mesh door, and REST route to configure universe, strategies, cadence, sessions, and execution mode.
  - Added REST routes `GET /stock-copilot/learnings` and `POST /stock-copilot/evaluate`.
  - Updated scheduled tasks to execute across tenancy-configured universe, strategies, dual-mode engine, and persistent memory. #ceo-aimp
