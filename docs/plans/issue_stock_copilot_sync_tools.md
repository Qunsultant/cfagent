## Agent #ceo-aimp

## Summary

When interacting with Stock Copilot via chat or MCP (`stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate`), commands were intercepted by `HTTP_DELIVERY_MODE` queued delivery mode and wrapped into asynchronous jobs (`/api/jobs/...`), returning `status: queued` receipts instead of immediate synchronous runtime data. Read and control commands take <1ms to query/update local DO SQLite; queuing them caused user commands to stall, poll, and fail with "Execution stopped before a result was recorded; the outcome may be unknown". This fix exempts all Stock Copilot tools from async-job wrapping so they execute immediately and synchronously.

## Current state (verified on main, 2026-11-07)

- `src/mcps/openaimp/handler.ts` line 219 only exempts `get_async_job` and `list_async_jobs` from queued async job wrapping.
- When `submitJob` is present on the context (the standard chat turn and `/mcp` route context), `stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, and `stock_copilot_evaluate` are all wrapped as `mcp.tool` async jobs.
- The user is presented with a queued job ID (`/api/jobs/<uuid>`), delaying responses and leading to timeouts / "Execution stopped before a result was recorded".

## Requirements

1. Add `SYNCHRONOUS_MCP_TOOLS` set containing `get_async_job`, `list_async_jobs`, `stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, and `stock_copilot_evaluate`.
2. Exempt `SYNCHRONOUS_MCP_TOOLS` from async-job wrapping in `src/mcps/openaimp/handler.ts` and `src/agents/mcpAdapter.ts`.
3. Update `src/agents/chatPrompt.ts` Rule 8 clarifying that synchronous status/control tools return immediate results.
4. Support clickable job links in Chat UI (`renderInlineFormatted.tsx`) and `ToolResultView.tsx` for any asynchronous jobs that do return job receipts (addressing #3605).

## Scope

**Included:**
- Exemption of all Stock Copilot telemetry & control tools from async-job wrapping across MCP handlers.
- Clickable job links in chat markdown and tool result views.
- Test coverage verifying synchronous execution of Stock Copilot MCP commands.

**Excluded:**
- Changes to long-running screening pipeline jobs or batch backtest jobs.

## Change management

- [x] This change has been reviewed for impact on existing users and data.
- [x] This change has been reviewed for impact on the platform's architecture.
- [x] This change has been reviewed for impact on the platform's security.
- [x] This change has been reviewed for impact on the platform's performance.
- [x] This change has been reviewed for impact on the platform's reliability.
- [x] This change has been reviewed for impact on the platform's maintainability.
- [x] This change has been reviewed for impact on the platform's testability.
- [x] This change has been reviewed for impact on the platform's documentation.
- [x] This change has been reviewed for impact on the platform's compliance.
