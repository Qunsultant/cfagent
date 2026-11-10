/**
 * Issue #2731 (tracker #2708 item A2): the `web_search` MCP
 * command — the catalog surface of the web-search tool family the
 * registry recorded `absent` at S14 (#2417).
 *
 * The command is a thin dispatch over the named-provider seam in
 * src/services/webSearch.ts. Identity carriage follows the mesh
 * rules: the tool takes NO login input — identity rides the
 * handler/turn context like every catalog command, and anonymous
 * calls already fail closed at the handler (-32001). The result
 * shape mirrors the sibling read commands ({query, count,
 * results}) with the producing provider named in-band.
 *
 * Failure honesty is the contract (#2731, #3935): the seam walks a
 * named-provider chain, free/keyless first. An empty chain throws
 * WebSearchError `web_search_provider_not_configured`, an exhausted
 * chain throws `web_search_all_providers_failed` with every
 * attempt's reason, and this command lets either propagate — after
 * recording a `web_search.config_error` audit event — rather than
 * returning fabricated or silently-empty results.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { WebSearchError, executeWebSearch } from "../../services/webSearch";

export class WebSearchCommand
  implements IMcpToolCommand<{ query: string; count?: number }>
{
  readonly name = "web_search";
  readonly description =
    "Search the open web through the configured provider chain — free/keyless first: SearXNG (when SEARXNG_BASE_URL is set), DuckDuckGo (keyless), then Brave (when keyed) — and return result titles, URLs, and snippets with the provider that served named in the result. A provider failure falls through to the next; an empty chain fails with a named web_search_provider_not_configured error and an exhausted chain with web_search_all_providers_failed — it never fabricates results. For platform documentation use query_platform_knowledge; for the internal corpus use knowledge_search.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Web search query" },
      count: {
        type: "number",
        description: "Maximum results to return, clamped to 1–10 (default 5)",
      },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Web search query"),
    count: z.number().optional().describe("Maximum results, clamped to 1–10 (default 5)"),
  });

  async execute(input: { query: string; count?: number }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    try {
      const outcome = await executeWebSearch(context.env, query, input.count);
      context.audit("mcp.tool_called", "orchestrator", {
        tool: this.name,
        query,
        provider: outcome.provider,
        count: outcome.count,
      });
      return {
        query: outcome.query,
        provider: outcome.provider,
        count: outcome.count,
        results: outcome.results,
      };
    } catch (err) {
      if (err instanceof WebSearchError && err.code !== "web_search_provider_error") {
        context.audit("web_search.config_error", "orchestrator", {
          tool: this.name,
          code: err.code,
          provider: err.provider ?? "",
        });
      }
      throw err;
    }
  }
}
