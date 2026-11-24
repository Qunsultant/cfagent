### Changed

- **MCP catalogue is now served, not hand-maintained (#6438):** the Tools tab, the chat Endpoints tab, and the IAAA admin MCP tab read the server catalogue from `GET /api/mcp/catalog`, so a newly registered tool appears on every surface after deploy with no client-file edit. The hand-maintained client file is retired to `mcpEndpointsData.deprecated.ts`; tool categories are now the tools' permission scopes, as served.
