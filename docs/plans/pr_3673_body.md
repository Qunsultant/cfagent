## Agent #clo-arsi

Fixes #3673
Sub-issue tracking under #2764

## Summary

- **TOS-style Multi-Bracket Ladder Engine**:
  - Implemented `src/services/bracketLadder.ts` to generate, validate, execute, and cancel multi-tier bracket orders with configurable step increments (dollar and percentage), tiered quantities (uniform or pyramid/custom array), and paired take-profit and stop-loss exits per tier.
  - Implemented `buildLadderFromPatternRange` to automatically anchor ladder rungs and protective stops to technical pattern ranges (support and resistance levels).
  - Added fail-closed validation for price boundaries, positive price steps, and valid bracket exit targets.
- **Broker & Service Integration**:
  - Added `cancelAlpacaOrder(orderId)` to `MarketDataResearchService` (`src/services/marketDataResearch.ts`).
  - Added MCP tools `alpaca_place_bracket_ladder` and `alpaca_cancel_bracket_ladder` in `src/mcps/openaimp/marketDataCommands.ts`.
  - Registered tools in `McpToolFactory` (`src/mcps/openaimp/commands.ts`), `TOOL_FAMILIES` (`src/agents/registry.ts`), and `MCP_TOOL_SCOPES` with `"mcp:trade"` scope (`src/mcps/openaimp/mcpPermissionPorts.ts`).

## Testing

- Created unit test suite in `tests/bracket_ladder_orders_3673.test.ts` (11 tests covering pure rung calculation for ascending buy, descending buy, ascending sell, fail-closed validation, pattern-range bounding, batch execution, and batch cancellation).
- Verified regression suites: `tests/alpaca_bracket_orders_3658.test.ts`, `tests/market_data_research.test.ts`, `tests/mesh_registry_s1_2322.test.ts`, `tests/mcp_permission_ports.test.ts`, `tests/orchestrator-actor-cutover.test.ts`. All 96 tests passed green.

Process documentation impact: none
