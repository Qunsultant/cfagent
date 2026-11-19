### Added

- Id resolver (#5175 slice 5): `GET /api/ids/resolve` and the `resolve_id` MCP tool (`mcp:read`, synchronous) resolve any run, alias, or derived id to its canonical run via the `mas_runs` registry. Read-only; neither endpoint mints.
