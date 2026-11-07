### Fixed

- **Stock Copilot door on the /mcp surface (#3635):** the /mcp route shell now propagates the owning OrchestratorAgent instance's SQL storage (`storage: ctx.getStorage?.()`) into the MCP handler context, so `stock_copilot_status` / `stock_copilot_control` (and the `run_stock_screen` sync path, which had the identical refusal) reach the instance store instead of failing with `door_unavailable` ("executing context carries no instance SQL storage"). The storageless refusal is preserved where storage is genuinely unavailable; no silent in-memory fallback. #clo-arsi
