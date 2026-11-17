### Issue #4676 / #3410 — IBKR Hosted MCP v1 Read-Only Integration (Gap 22)

- Added `src/config/ibkr.ts` externalizing IBKR's hosted MCP endpoint (`https://api.ibkr.com/v1/api/mcp-public`), callback path (`/auth/ibkr/callback`), read-only scope (`mcp.read`), blocked regions (`IN`, `JP`), and v1 read-only allowlist/blocklist rules.
- Added `src/security/ibkrOAuth.ts` implementing OAuth 2.1 + PKCE + DCR lifecycle, `SessionStore` DO token storage, region gating (`IBKR_REGION_UNAVAILABLE`), single-platform disconnect notice, and fail-closed v1 read-only tool filtering (`isIbkrToolAllowedV1`).
- Extended `src/agents/orchestrator/meshMcpClient.ts` with `ensureIbkrMcpConnection` (`registerServer("ibkr", ...)` on the Agents SDK MCP manager) and `ibkrTurnGate` (`TurnConfig.activeTools` v1 read-only enforcement).
- Added `tests/ibkr_mcp_4676.test.ts` covering mesh registration, v1 read-only allowlist enforcement, region gating, secret-free error/audit handling, and SessionStore DO token lifecycle.
