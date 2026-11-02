/**
 * Issue #2760 (tracker #2708 item A3): the `web_fetch` MCP
 * command — the catalog surface of the web-fetch tool family the
 * registry recorded `absent` at S14 (#2417).
 *
 * The command is a thin dispatch over the deterministic service
 * in src/services/webFetch.ts. Identity carriage follows the mesh
 * rules: the tool takes NO login input — the acting identity
 * rides the tool context (context.actingLogin) into the audit
 * only, like every catalog command, and anonymous calls already
 * fail closed at the handler (-32001). The command itself needs
 * no per-user state: it fetches public web content.
 *
 * Failure honesty is the contract: the service's named
 * WebFetchError codes (web_fetch_http_error,
 * web_fetch_unsupported_content_type, web_fetch_timeout, …)
 * propagate to the caller after a `web_fetch.fetch_error` audit
 * event — never a fabricated or silently-empty success.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  fetchWebPage,
  WebFetchError,
  type WebFetchResult,
} from "../../services/webFetch";

export interface WebFetchInput {
  url: string;
  timeoutMs?: number;
  maxTextChars?: number;
}

export class WebFetchCommand implements IMcpToolCommand<WebFetchInput> {
  readonly name = "web_fetch";
  readonly description =
    "Fetch one web page by URL with a plain Worker fetch and return its readable text: for HTML, the page title plus body text extracted with the same extractor BrowserAgent's fetch fallback uses; for plain-text or JSON responses, the body as-is. The result names the final URL after redirects, the HTTP status, the content type, and whether the content was truncated at the hard limits (30s max timeout, 2 MiB body cap, 20,000-char text cap — truncation is flagged, never silent). Non-2xx responses, unsupported content types, invalid or non-http(s) URLs, and timeouts fail with named web_fetch_* errors; content is never fabricated. For JS-rendered pages use browser_inspect_page or browser_scrape_tables; for platform documentation use query_platform_knowledge.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The page URL to fetch (http or https)." },
      timeoutMs: {
        type: "number",
        description: "Optional per-fetch timeout in milliseconds, clamped to 1–30000 (default 10000).",
      },
      maxTextChars: {
        type: "number",
        description: "Optional cap on returned text length, clamped to 1–20000 (default 20000); truncation is flagged in the result.",
      },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({
    url: z.string().describe("The page URL to fetch (http or https)"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Per-fetch timeout in ms, clamped to 1–30000 (default 10000)"),
    maxTextChars: z
      .number()
      .optional()
      .describe("Cap on returned text length, clamped to 1–20000 (default 20000)"),
  });

  async execute(input: WebFetchInput, context: McpToolContext): Promise<WebFetchResult> {
    try {
      const result = await fetchWebPage(input.url, {
        timeoutMs: input.timeoutMs,
        maxTextChars: input.maxTextChars,
      });
      context.audit("mcp.tool_called", "orchestrator", {
        tool: this.name,
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        truncated: result.truncated,
        actingLogin: context.actingLogin?.() ?? null,
      });
      return result;
    } catch (err) {
      if (err instanceof WebFetchError) {
        context.audit("web_fetch.fetch_error", "orchestrator", {
          tool: this.name,
          code: err.code,
          status: err.status ?? null,
          url: String(input?.url ?? ""),
          actingLogin: context.actingLogin?.() ?? null,
        });
      }
      throw err;
    }
  }
}
