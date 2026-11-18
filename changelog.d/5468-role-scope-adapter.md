### GAP-4: IAAA role-to-scope adapter for MCP tools (#5468)

- Plug the IAAA role→scope adapter into the ADR 0012 seam (`mcpPermissionPorts.ts`): scopes derive from IAAA roles through a permission correspondence read off the compiled policy snapshot, with the `scanner-payment` pin and the `unknown` deny expressed through the adapter. The correspondence is a proposal put to CISO review (#5350). Where no role resolver is supplied, the recorded permissive defaults remain, explicitly; no live behavior changes at any current call site.
