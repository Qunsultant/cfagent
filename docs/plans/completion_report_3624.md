# Completion Report: Issue #3624 (#3605)

**Issue**: #3624: [Fix] Stock Copilot telemetry & control tools must execute synchronously and render clickable job links  
**Linked Enhancement**: #3605: Ledger job IDs must be clickable links to the job detail  
**PR**: #3625  
**Agent**: #ceo-aimp  
**Date**: 2026-11-07  

---

## 1. Executive Summary

When interacting with the Stock Copilot via chat or MCP, telemetry and control operations (`stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate`) were unexpectedly intercepted by the async job queue mechanism (`HTTP_DELIVERY_MODE` queued delivery mode), returning `status: queued` receipts (`/api/jobs/<uuid>`) rather than immediate data. These operations query and update local Durable Object SQLite tables in <1ms; queuing them caused the user's conversational turns to stall, poll background jobs, and eventually fail with *"Execution stopped before a result was recorded; the outcome may be unknown"*.

In addition, raw job identifiers (`/api/jobs/<id>` and UUIDs in both chat and the consolidated Run ledger) were rendered as plain text strings rather than interactive clickable links, forcing users to manually copy and paste URLs.

This PR fixes both issues:
1. All Stock Copilot MCP tools are classified as `SYNCHRONOUS_MCP_TOOLS` and exempted from async-job wrapping, returning immediate synchronous data in both chat and MCP transports.
2. Job URLs and markdown links are rendered as clickable anchors in chat (`renderInlineFormatted.tsx`), `ToolResultView.tsx` renders a structured Async Background Job Card with direct link and status polling action, and `ScheduleRunLedgerPanel.tsx` renders Job and Async job IDs as clickable links to `/api/jobs/<id>`.

---

## 2. Root Cause Analysis (RCA)

1. **Why Stock Copilot tools returned queued async job receipts**:
   - In `src/mcps/openaimp/handler.ts` (lines 187–220) and `src/agents/mcpAdapter.ts` (line 46), whenever `context.submitJob` is present (which is standard for chat turns and `/mcp` route context), all MCP tools were routed into the async job queue unless explicitly exempted.
   - The exemption condition was strictly hardcoded to `name !== "get_async_job" && name !== "list_async_jobs"`.
   - As a result, all newly introduced Stock Copilot MCP tools (`stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate`) were queued into `mas_async_jobs`, returning `{ jobId, status: "queued", statusUrl: "/api/jobs/{id}" }`.
2. **Why background jobs failed with "Execution stopped before a result was recorded"**:
   - Durable Object async jobs rely on scheduled alarms (`ctx.schedule(...)`). If the alarm execution context was interrupted, delayed, or if `list_async_jobs` was queried over older jobs, `reapStaleRunning` in `asyncJobs.ts` reaped running jobs older than the stale threshold with the exact error message: *"Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again."*
   - Queuing sub-millisecond local reads/writes through the async job queue was an architectural anti-pattern for conversational Copilot interaction.
3. **Plain text job identifiers in UI**:
   - `renderInlineFormatted.tsx` only split on bold (`**text**`) and inline code (`` `code` ``), leaving markdown links `[label](url)` and `/api/jobs/<id>` unparsed.
   - `ScheduleRunLedgerPanel.tsx` rendered `<code>{r.jobId}</code>` without an anchor tag.

---

## 3. Changes Implemented

1. **`src/config/asyncJobModes.ts`**:
   - Defined `SYNCHRONOUS_MCP_TOOLS` and exported `isSynchronousMcpTool(name: string): boolean`.
   - Tools included: `get_async_job`, `list_async_jobs`, `stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate`.
2. **`src/mcps/openaimp/handler.ts` & `src/agents/mcpAdapter.ts`**:
   - Replaced hardcoded `name !== "get_async_job" && name !== "list_async_jobs"` with `!isSynchronousMcpTool(name)`.
   - All synchronous MCP tools now execute inline and return HTTP 200 responses with actual payload data immediately.
3. **`src/agents/chatPrompt.ts`**:
   - Updated Rule 8 to clarify that synchronous tools return immediate results and long-running queued jobs format links as clickable markdown `[Job <id>](/api/jobs/<id>)`.
4. **`src/client/chat/renderInlineFormatted.tsx`**:
   - Enhanced regex tokenization to parse markdown links `[label](url)`, raw `/api/jobs/:id` paths, and `http/https` URLs into clickable `<a>` elements with `target="_blank"`.
5. **`src/client/chat/ToolResultView.tsx`**:
   - Added an Async Background Job card when `data?.jobId` or `data?.statusUrl` is present, showing job ID, status badge, clickable review link, and interactive "Check Status" button.
6. **`src/client/ScheduleRunLedgerPanel.tsx` (#3605)**:
   - Wrapped `r.jobId` and `r.asyncJobId` in `<a href="/api/jobs/<id>" target="_blank">` tags so ledger rows link directly to job details without manual URL typing.
7. **`tests/stock_copilot_sync_tools_3624.test.ts`**:
   - Added 9 unit and integration tests verifying synchronous MCP tool execution, inline link rendering, and ledger anchor generation.

---

## 4. Verification

- `tests/stock_copilot_sync_tools_3624.test.ts`: 9/9 passing.
- `tests/schedule-3121-s2-parity.test.tsx`: 33/33 passing.
- `tests/stock_copilot_chat_door_3513.test.ts`: 8/8 passing.
- `tests/stock_copilot_omnichannel_3514.test.ts`: 12/12 passing.
- `tests/mcp.test.ts`: 15/15 passing.
- Policy Gate: PASS (zero deletions, changelog fragment, valid issue linkage).

