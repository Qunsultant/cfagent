/**
 * Issue #2223 (AiSearchAgent slice) — AiSearchAgent: the Cloudflare
 * AI Search instance as a first-class agent.
 *
 * Reference docs:
 * - https://developers.cloudflare.com/ai-search/
 * - https://developers.cloudflare.com/agents/tools/ai-search/
 * - https://developers.cloudflare.com/ai-search/agent-sdks/agents-sdk/
 * - https://developers.cloudflare.com/ai-search/api/search/mcp/
 *
 * Design (one paragraph): this agent gives the fleet one agent door
 * onto the SAME Cloudflare AI Search instance the SearchHub
 * knowledge surface serves, and it reaches that instance two ways,
 * in the priority order set by the user directive of 2026-10-29 —
 * tool first, MCP second. PRIMARY is the agent-tool door: the
 * ai_search_namespaces binding's search, which powers BOTH the
 * turn tool below (getTools) and the direct search() method, so a
 * model turn and a programmatic caller get the same answer from
 * the same door. SECOND is the instance's public MCP endpoint,
 * consumed through the repo's RemoteMcpClient exactly as any MCP
 * client would. A third door — the standalone REST API over the
 * public endpoint — existed as last resort until issue #3342
 * retired it (the endpoint is unauthenticated by design; every
 * consumer migrated onto the binding and AI_SEARCH_ENDPOINT was
 * deleted). Every answer is labelled with the path that served it,
 * and degradation is honest: an unconfigured agent is reported as
 * degraded, never dressed up as live results. Result and config
 * conventions are aligned with the SearchHub knowledge surface
 * (shared AI_SEARCH_INSTANCE instance config; S2 result fields and
 * bucket-key provenance via the shared mapping).
 *
 * The behavior lives in src/agents/aiSearchPaths.ts (the two-path
 * runner) and src/agents/aiSearchDispatch.ts (the A2A door); this
 * class is the thin PortThink shell over them, mirroring how slice 1
 * split OrchestratorAgent from its dispatch module.
 *
 * Issue #2246 adds the agent's indexing door (indexDocument): the
 * namespace binding's items upload, used by the report pipeline to
 * index generated reports into this same instance at store time.
 * That pipeline leg is feature-flagged — env
 * AI_SEARCH_REPORT_INDEXING_ENABLED ("1"/"true"/"on" = on, absence
 * = OFF, deliberately not in wrangler.jsonc) — and ships OFF; the
 * door itself is an explicit call, never a background behaviour.
 * Report-type results are served only to their owner's login (the
 * runner's login discipline).
 *
 * OUT of scope (the #1169 S4-5 bridge, dashboard-gated): runtime
 * provisioning (no namespace create) and the knowledge-corpus
 * upload bridge — the only uploads through this agent are report
 * documents via the #2246 executor.
 */

import { PortThink } from "../actors/thinkAdapter";
import type { ActorTurnHooks } from "../actors/actorPorts";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveAiModelName } from "./model";
import {
  runAiSearchPaths,
  runAiSearchIndexUpload,
  type AiSearchAgentSearchOptions,
  type AiSearchAgentSearchResult,
  type AiSearchIndexDeps,
  type AiSearchIndexDocument,
  type AiSearchIndexOutcome,
} from "./aiSearchPaths";
import {
  dispatchAiSearchA2A,
  aiSearchA2AOutcome,
  type AiSearchA2AOutcome,
} from "./aiSearchDispatch";
import type { Env } from "../types";

export class AiSearchAgent extends PortThink {
  /**
   * Think behind the actor port (tracker #1951, shape (a)): the
   * class reaches Think only through PortThink. Unlike BrowserAgent
   * and SlackAgent (no turn path, no hooks), this agent SETS its
   * port hooks — the namespace-binding search is a model tool as
   * well as a direct method (the agents/tools/ai-search pattern).
   * The turn hooks mirror ResearchAgent's: identity beforeTurn, a
   * no-op onChatResponse (the turn caller owns the result), and a
   * SYNCHRONOUS onChatError returning the raw message (Think fires
   * it fire-and-forget; spike fact #1935).
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.portHooks = {
      getModel: () => this.getModel(),
      getSystemPrompt: () => this.getSystemPrompt(),
      getTools: () => this.getTools(),
      beforeTurn: async () => undefined,
      onChatResponse: async () => {},
      onChatError: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    } satisfies ActorTurnHooks;
  }

  getModel() {
    // The "searchAgent" task key is the config's existing entry for
    // the search agent's turns (src/config/etapiConfig.ts).
    return resolveAiModelName(this.env, "searchAgent");
  }

  getSystemPrompt(): string {
    return "You are the AI Search agent: you search the Cloudflare AI Search knowledge instance. For a search request, call search exactly once and then summarize its result faithfully. Report the serving path and any degradation the search result carries; never present degraded or fallback content as live search results, and never invent results the search did not return.";
  }

  getTools(): ToolSet {
    return {
      search: tool({
        description:
          "Search the Cloudflare AI Search knowledge instance (namespace binding first, the instance MCP endpoint second). Returns hub-consistent results labelled with the serving path; a degraded result means no live index answer was served.",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().int().positive().optional(),
        }),
        execute: async (input) => {
          const result = await this.search(input.query, { limit: input.limit });
          return JSON.stringify(result);
        },
      }),
    };
  }

  /**
   * Door 1 (direct/RPC): search the AI Search instance through the
   * two-path runner (namespace -> MCP). The same runner backs the
   * turn tool above and the A2A door below, so every door returns
   * the same typed, path-labelled, honestly-degraded result.
   * Never throws.
   */
  async search(
    query: string,
    opts: AiSearchAgentSearchOptions = {},
  ): Promise<AiSearchAgentSearchResult> {
    return runAiSearchPaths(this.env, query, opts);
  }

  /**
   * Indexing door (issue #2246): upload one document into the AI
   * Search instance via the namespace binding's items API,
   * delegating to the path layer's executor. The report pipeline's
   * store hook calls the same executor (behind
   * AI_SEARCH_REPORT_INDEXING_ENABLED, default OFF); this method is
   * the agent-owned door for explicit callers. Never throws; an
   * unconfigured namespace path is a typed not_configured outcome,
   * never a fabricated success.
   */
  async indexDocument(
    doc: AiSearchIndexDocument,
    deps: AiSearchIndexDeps = {},
  ): Promise<AiSearchIndexOutcome> {
    return runAiSearchIndexUpload(this.env, doc, deps);
  }

  /**
   * Door 2: A2A endpoint, cfpay signature — the dispatcher in
   * src/a2a parses the HTTP request at the edge and calls this with
   * the plain body + origin (a Request cannot cross the DO RPC
   * boundary). Returns the collected { text, data } outcome; the
   * transport shapes the wire.
   */
  async handleA2A(body: unknown, origin: string): Promise<AiSearchA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchAiSearchA2A(this.env, body);
    return aiSearchA2AOutcome(data);
  }
}
