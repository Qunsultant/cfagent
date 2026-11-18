### Changed

- **Data model (#5041):** Added `ALLOWED_QUERY_TABLES` allowlist gating to `QueryTableDataCommand` (`src/mcps/openaimp/commands.ts`), pinned `McpToolFactory.getAllTools()` completeness against `SYNCHRONOUS_MCP_TOOLS` + `QUEUED_MCP_TOOLS` + `MCP_TOOL_SCOPES` and verified paid-tool queueing never charges at queue time (`tests/mcp_registry_completeness_5041.test.ts`), and updated `docs/architecture/data/data-model.md` §5 (H-9, H-15).
