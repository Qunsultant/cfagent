/**
 * Issue #3990 Slice C — Public.com trading client: the second
 * allow-list over the same hosted-MCP transport.
 *
 * The data client (publicMcp.ts) is read-only by construction; this
 * client is the trading half. It reuses PublicMcpClient's transport
 * (session handling, SSE parsing, credential injection) with the
 * trading allow-list, so one transport serves both halves and a
 * write tool can never reach the data path.
 *
 * Tool names and parameter names are NOT hardcoded as wire facts:
 * exactly as the data reads do (publicData.ts), each call fetches
 * the tool's LIVE inputSchema via tools/list (probed once, cached)
 * and maps semantic parameters onto the property names the schema
 * actually declares (pickArgs). A tool the server does not offer is
 * refused by name instead of called — hosted-vs-local parity (Q5)
 * is therefore decided at first use, in the open, not assumed.
 *
 * Rate limit (official docs): 10 req/s per account; a 429 backs
 * off once (1s) and retries, then throws. Placement is async on
 * Public's side: place_order returns an order ID (acceptance
 * receipt, NOT a fill); callers poll get_order. The MCP surface
 * exposes NO idempotency key, so this client never retries a
 * place_* call after a transport failure — a retry could double
 * the order. A failed place is reported, never silently retried.
 */

import { PublicMcpClient, PublicMcpError, type PublicMcpTool } from "./publicMcp";
import { pickArgs, missingRequired, parseToolJson } from "../../services/publicData";

/**
 * The only tools this client will call. Verified against Public's
 * official MCP server docs + SDK (research 2026-11-10): the 11
 * write tools minus flatten_and_go_short (experimental, NOT atomic
 * — no neutral shape) and buy_event_contract (event contracts are
 * outside the equity/options scope), plus their preflights and the
 * reads trading needs. get_quotes / get_option_chain ride the DATA
 * adapter, never this client.
 */
export const PUBLIC_TRADING_TOOL_ALLOWLIST = [
  "place_order",
  "place_multileg_order",
  "place_call_credit_spread",
  "place_call_debit_spread",
  "place_put_credit_spread",
  "place_put_debit_spread",
  "place_short_order",
  "cancel_order",
  "cancel_and_replace_order",
  "preflight_order",
  "preflight_multileg_order",
  "preflight_short_order",
  "preflight_call_credit_spread",
  "preflight_call_debit_spread",
  "preflight_put_credit_spread",
  "preflight_put_debit_spread",
  "get_accounts",
  "get_orders",
  "get_order",
  "search_orders",
  "get_portfolio",
  "get_option_greek",
  "get_option_greeks",
] as const;

export class PublicTradingMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicTradingMcpError";
  }
}

const BACKOFF_MS = 1000;

export class PublicTradingMcpClient {
  private readonly client: PublicMcpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private toolsPromise: Promise<PublicMcpTool[]> | null = null;

  constructor(options: {
    accessTokenProvider: () => Promise<string | null>;
    fetchImpl?: typeof fetch;
    /** Injectable sleep for the 429 backoff (tests pass a no-op). */
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.client = new PublicMcpClient({
      accessTokenProvider: options.accessTokenProvider,
      fetchImpl: options.fetchImpl,
      toolAllowlist: PUBLIC_TRADING_TOOL_ALLOWLIST,
    });
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The live tools/list, probed once and cached for the instance. */
  async listTools(): Promise<PublicMcpTool[]> {
    this.toolsPromise ??= this.callWithBackoff(() => this.client.listTools());
    return this.toolsPromise;
  }

  private async callWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PublicMcpError && err.status === 429) {
        await this.sleep(BACKOFF_MS);
        return await fn();
      }
      throw err;
    }
  }

  /**
   * Invoke one trading tool by its semantic name and return its text
   * result. Refuses (in order): a tool outside the allow-list, a tool
   * the live server does not offer, a required parameter the live
   * schema declares but no caller mapped. Arguments are mapped onto
   * the live schema's property names — a name is used only when the
   * schema offers it.
   */
  async callTradingTool(
    name: string,
    semanticArgs: Record<string, { names: string[]; value: unknown }>
  ): Promise<string> {
    if (!(PUBLIC_TRADING_TOOL_ALLOWLIST as readonly string[]).includes(name)) {
      throw new PublicTradingMcpError(
        `tool "${name}" is not on the Public trading allow-list; the trading client never calls it.`
      );
    }
    const tools = await this.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new PublicTradingMcpError(
        `tool "${name}" is not offered by this Public MCP server (tools/list at first use); refusing instead of guessing the call.`
      );
    }
    const { args, matched } = pickArgs(tool.inputSchema, semanticArgs);
    const missing = missingRequired(tool.inputSchema, args);
    if (missing.length > 0) {
      const unmatched = Object.entries(matched)
        .filter(([, prop]) => prop === undefined)
        .map(([concept]) => concept);
      throw new PublicTradingMcpError(
        `tool "${name}" requires ${missing.join(", ")} but the live schema offers no property for ${unmatched.join(", ") || "them"}; refusing instead of guessing.`
      );
    }
    // No retry after a place_* transport failure: the MCP surface
    // exposes no idempotency key, so a retry could double the order.
    // The 429 backoff above covers rate-limiting only (a refusal,
    // not a placement attempt).
    return this.callWithBackoff(() => this.client.callToolText(name, args));
  }

  /** Parse a tool's text result as JSON; undefined when it is not JSON. */
  parseResult(text: string): unknown {
    return parseToolJson(text);
  }
}
