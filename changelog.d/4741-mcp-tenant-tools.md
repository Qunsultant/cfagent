### Added
- BizCopilot chat can now administer tenants through the MCP tool `manage_tenants` (list, create, detail, settings read/update; membership writes stay a deterministic refusal), via the Tenants page's own routes with the same store-operator gate, session-scoped identity, and audit as the page path. The deterministic branch stays as the option for exact commands.
