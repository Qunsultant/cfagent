### Fixed

- **Stock Copilot Synchronous MCP Execution & Clickable Job Links (#3624, #3605)**:
  - Added `SYNCHRONOUS_MCP_TOOLS` and `isSynchronousMcpTool` in `src/config/asyncJobModes.ts` covering `get_async_job`, `list_async_jobs`, `stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, and `stock_copilot_evaluate`.
  - Exempted synchronous MCP tools from async job wrapping in `src/mcps/openaimp/handler.ts` and `src/agents/mcpAdapter.ts`, ensuring Stock Copilot telemetry and control operations return immediate, sub-millisecond synchronous responses without getting queued into background jobs.
  - Updated Rule 8 in `src/agents/chatPrompt.ts` clarifying that synchronous tools return immediate results and queued jobs format links as clickable markdown.
  - Enhanced `renderInlineFormatted.tsx` to render markdown links `[text](url)`, direct `/api/jobs/:id` paths, and URLs as clickable anchors.
  - Added Async Background Job receipt card to `ToolResultView.tsx` with direct link to job details and status polling action.
  - Updated `ScheduleRunLedgerPanel.tsx` (Issue #3605) to render Job and Async job IDs as clickable links to `/api/jobs/:id`. #ceo-aimp
