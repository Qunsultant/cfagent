/**
 * Issue #1247 (add-provider slice of epic #1116): Public.com hosted
 * MCP client — the transport half of the Public data provider.
 *
 * Ground truth is the sibling repo OpenAIMP/cfpay, whose Public
 * integration is verified live against production (its
 * src/public-mcp.ts): Public's data surface is NOT a documented REST
 * API but a hosted MCP server —
 *
 *   POST https://mcp.public.com/mcp   (JSON-RPC 2.0)
 *   Content-Type: application/json
 *   Accept: application/json, text/event-stream
 *   Authorization: Bearer <per-user access token>
 *   MCP-Protocol-Version: 2025-06-18
 *
 * Responses may be plain JSON or SSE (Streamable HTTP); an
 * Mcp-Session-Id issued by the server is threaded onto later calls.
 * Every method, including tools/list, answers 401 until a credential
 * is presented, so nothing here is reachable unauthenticated.
 *
 * READ-ONLY BY CONSTRUCTION: this client will only ever invoke the
 * data tools on PUBLIC_DATA_TOOL_ALLOWLIST (the three market-data
 * tools the provider declares, plus get_accounts, which the option
 * tools' schemas require an account id from — cfpay resolves it the
 * same way). Order-placing tools are not merely unused, they are
 * refused: the data-provider platform never exposes them at all.
 *
 * The credential arrives through an injected access-token provider
 * (src/security/publicOAuth.ts is the production source: the signed-in
 * user's stored token set, refreshed on expiry). Tokens are never
 * logged and never returned to a browser by this module.
 */

export const PUBLIC_MCP_URL = "https://mcp.public.com/mcp";
export const PUBLIC_MCP_PROTOCOL_VERSION = "2025-06-18";

/** The only tools this client will call. Anything else is refused. */
export const PUBLIC_DATA_TOOL_ALLOWLIST = [
  "get_accounts",
  "get_quotes",
  "get_option_expirations",
  "get_option_chain",
] as const;

export type PublicAccessTokenProvider = () => Promise<string | null>;

export class PublicMcpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PublicMcpError";
    this.status = status;
  }
}

export interface PublicMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Parse a JSON-RPC response body: plain JSON, or the first JSON
 * `data:` frame of an SSE stream (cfpay parseRpcBody semantics).
 */
export function parsePublicRpcBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      if (payload.startsWith("{")) {
        try {
          return JSON.parse(payload);
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  throw new PublicMcpError("unparseable MCP response: " + trimmed.slice(0, 200));
}

/**
 * One Public MCP client bound to one credential source. Holds the
 * server-issued session id (Streamable HTTP servers may issue one on
 * initialize and expect it echoed back).
 */
export class PublicMcpClient {
  private readonly accessTokenProvider: PublicAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly toolAllowlist: readonly string[];
  private sessionId: string | undefined;

  constructor(options: {
    accessTokenProvider: PublicAccessTokenProvider;
    fetchImpl?: typeof fetch;
    /**
     * Issue #3990: the tools this instance may call. Defaults to the
     * data allow-list, so a data client stays read-only by
     * construction. The trading client (publicTradingMcp.ts) passes
     * its own list over the same transport — one transport, two
     * allow-lists, never a shared list that could grow a write tool
     * into the data path.
     */
    toolAllowlist?: readonly string[];
  }) {
    this.accessTokenProvider = options.accessTokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.toolAllowlist = options.toolAllowlist ?? PUBLIC_DATA_TOOL_ALLOWLIST;
  }

  /** One JSON-RPC call. Throws PublicMcpError on any failure. */
  async callRpc(method: string, params: unknown): Promise<unknown> {
    const accessToken = await this.accessTokenProvider();
    if (!accessToken) {
      throw new PublicMcpError(
        "no Public.com credential is available for this user (connect Public in Settings, or store a personal access token); the MCP server was not called."
      );
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + accessToken,
      "MCP-Protocol-Version": PUBLIC_MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const res = await this.fetchImpl(PUBLIC_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    const issued = res.headers.get("mcp-session-id");
    if (issued) this.sessionId = issued;

    const text = await res.text();
    if (!res.ok) {
      throw new PublicMcpError(
        "Public.com " +
          method +
          " failed (" +
          res.status +
          ")" +
          (res.status === 401
            ? ": the access token was rejected."
            : ": " + text.slice(0, 180)),
        res.status
      );
    }
    if (!text.trim()) return null;

    const parsed = parsePublicRpcBody(text) as {
      error?: unknown;
      result?: unknown;
    } | null;
    if (parsed?.error) {
      throw new PublicMcpError(
        "Public.com " + method + " error: " + JSON.stringify(parsed.error).slice(0, 200)
      );
    }
    return parsed?.result ?? null;
  }

  async listTools(): Promise<PublicMcpTool[]> {
    const result = (await this.callRpc("tools/list", {})) as {
      tools?: unknown;
    } | null;
    const tools = result?.tools;
    return Array.isArray(tools) ? (tools as PublicMcpTool[]) : [];
  }

  /**
   * Invoke one allow-listed tool and return its text result (the
   * content parts of type "text", joined). A tool outside THIS
   * instance's allow-list is refused before any network call — the
   * data instance's read-only guarantee and the trading instance's
   * write boundary are the same check over different lists.
   */
  async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.toolAllowlist.includes(name)) {
      const kind = this.toolAllowlist === PUBLIC_DATA_TOOL_ALLOWLIST ? "data" : "trading";
      throw new PublicMcpError(
        `tool "${name}" is not on the Public ${kind} allow-list; the ${kind === "data" ? "data provider is read-only by construction and never calls it" : "trading client never calls it"}.`
      );
    }
    const result = (await this.callRpc("tools/call", {
      name,
      arguments: args ?? {},
    })) as { content?: unknown } | null;
    const content = result?.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (c): c is { type: string; text: string } =>
            Boolean(c) &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "text" &&
            typeof (c as { text?: unknown }).text === "string"
        )
        .map((c) => c.text)
        .join("\n");
      if (text) return text;
    }
    return JSON.stringify(result ?? null).slice(0, 20000);
  }
}
