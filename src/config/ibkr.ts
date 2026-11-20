/**
 * Externalized Interactive Brokers (IBKR) Hosted MCP configuration (issues #4676, #3410).
 *
 * IBKR's official hosted MCP server uses OAuth 2.1 + PKCE + Dynamic Client
 * Registration (DCR) and has no paper-account scoping. v1 is strictly
 * read-only (`mcp.read` scope only; trade/write tools are refused at the
 * Copilot layer).
 */
export const IBKR_CONFIG = {
  serverId: "ibkr", label: "Interactive Brokers", icon: "🏛️",
  mcpServerUrl: "https://api.ibkr.com/v1/api/mcp-public",
  callbackPath: "/auth/ibkr/callback",
  readOnlyScopes: "mcp.read",
  blockedRegions: ["IN", "JP"] as readonly string[],
  requestTimeoutMs: 15_000,
  /** Substrings that always disqualify an IBKR MCP tool in v1 read-only mode. */
  v1BlockedToolTerms: [
    "place",
    "submit",
    "create_order",
    "modify",
    "replace",
    "cancel",
    "delete",
    "execute",
    "exercise",
    "transfer",
    "withdraw",
    "trade_instruction",
  ] as readonly string[],
  /** Read-only prefixes/terms allowed when live tools/list is enumerated in v1. */
  v1ReadOnlyPrefixes: [
    "get_",
    "list_",
    "read_",
    "search_",
    "fetch_",
    "view_",
    "describe_",
  ] as readonly string[],
} as const;

export function resolveIbkrMcpUrl(env?: { IBKR_MCP_SERVER_URL?: string }): string {
  const raw = env?.IBKR_MCP_SERVER_URL?.trim();
  if (raw && /^https:\/\/[^/]+/i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return IBKR_CONFIG.mcpServerUrl;
}
