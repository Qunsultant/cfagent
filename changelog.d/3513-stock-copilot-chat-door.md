### Added
- **Stock Copilot chat door, telemetry tools & dynamic quick-chips** (#3513):
  - Created `stock_copilot_status` and `stock_copilot_control` MCP commands in `meshStockCopilotDoor.ts` and `openaimp` MCP server, enabling direct conversational telemetry queries (open positions with bracket exits, cycle activity, trading mode) and execution controls (pause/resume, session selection).
  - Extended `CopilotConfig` in `copilotRegistry.ts` with `hero` and `quickChips` properties, and updated `AgentChatTabContent.tsx` to dynamically render hero greetings and quick-chips across all registered copilots without hardcoded component branches.
  - Added architectural and runtime introspection specifications in `docs/architecture/agentic/stockcopilot-evoluation.md`.

