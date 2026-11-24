### Chat/MCP can inspect and update the OODA configuration (#5976)

- New `research_config` MCP/chat command: `get` returns the effective `ResearchConfig` (version included); `update` applies the named settings through the same `ResearchConfigService` the settings page and `POST /api/research/settings` use — validated by name, atomic on refusal, visible in the UI immediately.
- The command reaches the config through the orchestrator's door to the research agent (`researchConfigDoor.ts`), so chat/MCP adds no second store, no second validation and no model-chosen binding.
- Fail-closed: no acting identity, or an update naming no settings, refuses before anything is read or written.
