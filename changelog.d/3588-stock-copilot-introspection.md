### Stock Copilot

- **Tool-driven reflection & self-explanation engine (#3588):** Implement runtime tool introspection and 5-stage pipeline mapping (FEED, ENRICH, ANALYZE, GENERATE, DELIVER) for Stock Copilot. Exposed via mesh door `introspectStockCopilotViaDoor`, MCP tool `stock_copilot_introspect`, and REST route `GET /stock-copilot/introspect` with live SQLite configuration reflection and capability gating.
