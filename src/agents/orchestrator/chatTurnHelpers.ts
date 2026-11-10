/**
 * Issue #992: Chat-turn helpers (message text, turn tools, turn derivation, grounding) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ChatTurnHelpersContext.
 */

import type { ToolSet } from "ai";
import type { AgentContext } from "agents";
import type { DatabaseORM } from "../../orm";
import type {
  AgentName,
  AsyncJobRecord,
  AsyncJobSubmission,
  Env,
} from "../../types";
import { createOrmPorts } from "../../data/createOrmPorts";
import { VectorMemory } from "../../memory/vector-memory";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { McpSystemFacade } from "../../patterns/facade";
import { createAgentMcpTools } from "../mcpAdapter";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/chatTurnHelpers",
});

/**
 * Ports the chat-turn helper functions receive from the class. The
 * Think lifecycle itself (beforeTurn/onChatResponse/onChatError and
 * the pending-turn state) stays in OrchestratorAgent; these helpers
 * are the pure-ish computations those hooks compose.
 */
export interface ChatTurnHelpersContext {
  env: Env;
  ensureTables: () => AgentContext["storage"]["sql"];
  getOrm: () => DatabaseORM;
  /**
   * #1686: optional DO blob handle for full capture, supplied by the
   * orchestrator. Unset → today's outcome-only contract for tool screens.
   */
  storage?: import("../../trading").NasdaqUniverseRouteBundleInput["storage"];
  sessionKey: () => string;
  /**
   * #2341 (Agent Mesh S5): resolver for the current turn's acting
   * login (the orchestrator's turn stash). Optional: contexts built
   * outside a turn supply none, and identity-gated turn tools (the
   * mesh doors) then fail closed. Read lazily at tool-execution
   * time — the stash is filled by the turn drivers/beforeTurn,
   * which may run after the tool set is built.
   */
  turnUserLogin?: () => string | undefined;
  /**
   * #3922: optional per-login settings reader (the hosting
   * instance's mas_settings read), forwarded into the turn's
   * tool context — the mesh screen door's ND gate resolves its
   * stored layer through it. Unset → the gate stays env-only.
   */
  readSettingRaw?: (key: string) => string | null;
  /**
   * #2428 (Agent Mesh S17): resolver for the current turn's mesh
   * traceparent (the orchestrator's turn stash, minted lazily on
   * first read so every tool built for the turn shares ONE trace).
   * Optional under the same discipline as turnUserLogin: contexts
   * built outside a turn supply none, and trace recording for the
   * call is then skipped — never fabricated.
   */
  turnTraceparent?: () => string | undefined;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
  submitAsyncJob: (job: AsyncJobSubmission) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  getAsyncJob: (jobId: string) => AsyncJobRecord | undefined;
  listAsyncJobs: (limit?: number) => AsyncJobRecord[];
  getMessages: () => Promise<any[]>;
  activeTurnMetadata: unknown;
}

export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { content?: unknown; text?: unknown; parts?: Array<{ type?: string; text?: string }> };

  if (typeof m.content === "string" && m.content.trim()) {
    return m.content.trim();
  }

  if (Array.isArray(m.parts) && m.parts.length > 0) {
    const extracted = m.parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
    if (extracted) return extracted;
  }

  if (typeof m.text === "string" && m.text.trim()) {
    return m.text.trim();
  }

  return "";
}

/**
 * The per-turn McpToolContext construction the AIChatAgent-era
 * runAgenticChatTurn performed inline (Facade + async-job ports +
 * audit), now shared by getTools for every Think-driven turn.
 */
export function createTurnTools(ctx: ChatTurnHelpersContext, requestId: string): ToolSet {
  const orm = ctx.getOrm();
  const sessionId = ctx.sessionKey();
  const facade = new McpSystemFacade(ctx.env, orm, sessionId);
  return createAgentMcpTools({
    env: ctx.env,
    orm,
    sessionId,
    storage: ctx.storage,
    requestId,
    facade,
    // #3922: the settings reader carrier (see the context field).
    ...(ctx.readSettingRaw ? { readSettingRaw: ctx.readSettingRaw } : {}),
    // #1744: agent-turn principal — the turn runs inside the
    // owner's own agent instance, so the instance boundary IS the
    // identity boundary. Threading the turn's userLogin into the
    // principal (for finer audit attribution) is a follow-up.
    principal: { kind: "agent-turn", login: null },
    // #2341 (Agent Mesh S5): the acting-identity carrier the mesh
    // door commands resolve through (see McpToolContext.actingLogin).
    // The principal above is unchanged; this carrier exists so a
    // door can name the acting user, not just the instance.
    actingLogin: ctx.turnUserLogin,
    // #2428 (Agent Mesh S17): the trace carrier the door/job
    // paths resolve through (see McpToolContext.traceparent).
    traceparent: ctx.turnTraceparent,
    permissionDecisionSink: createObservabilitySink(ctx.env),
    submitJob: (job) => ctx.submitAsyncJob(job),
    getJob: (jobId) => ctx.getAsyncJob(jobId),
    listJobs: () => ctx.listAsyncJobs().map(({ result: _result, ...job }) => job),
    audit: (type: string, agent: any, payload: Record<string, unknown>) =>
      ctx.audit(type, agent, payload),
  });
}

const STOCK_COPILOT_INTENT_RE =
  /\b(draft a limit (?:buy|sell)|limit (?:buy|sell) order|market (?:buy|sell) order|preview (?:buy|sell)|buy \d+\s+[a-z]{1,5}\b|sell \d+\s+[a-z]{1,5}\b|buy [a-z]{1,5} at (?:market|limit)|sell [a-z]{1,5} at (?:market|limit)|take-profit.*stop-loss|bracket exits?|alp_ord_|approve (?:[a-z]+\s+)?trade draft|stock copilot|enable autopilot|disable autopilot|autopilot status|autopilot limits|kill[- ]switch)\b/i;
const OPTIONS_INTENT_EXCLUSION_RE =
  /\b(options?|calls?|puts?|iron condor|straddle|strangle|credit spread|debit spread|dte|greeks)\b/i;

export function isStockCopilotIntent(text: string): boolean {
  if (!text || OPTIONS_INTENT_EXCLUSION_RE.test(text)) return false;
  return STOCK_COPILOT_INTENT_RE.test(text);
}

/**
 * Issue #686: derive the turn inputs for a turn Think drives
 * itself (the WebSocket chat protocol, saveMessages admissions) —
 * the recovery the AIChatAgent-era onChatMessage performed from
 * its in-memory message array: the user text from the submitted
 * session message,
 * sourceTab / userLogin from the client-stamped message metadata
 * (falling back to Think's persisted turn metadata), and recent
 * history from the turn's model messages.
 */
export async function deriveTurn(ctx: ChatTurnHelpersContext, turnCtx: { messages?: any[] }): Promise<{
  userText: string;
  userLogin: string;
  sourceTab?: string;
  isAutoOptionsResearchRequest: boolean;
  recentTurns: Array<{ role?: string; content: string }>;
}> {
  const sessionId = ctx.sessionKey();
  const uiMessages = await ctx.getMessages();
  const lastUser = [...uiMessages].reverse().find((m: any) => m?.role === "user");
  const userText = extractMessageText(lastUser);
  const metadata = ((lastUser as any)?.metadata ?? ctx.activeTurnMetadata ?? {}) as {
    sourceTab?: string;
    userLogin?: string;
  };
  const rawSourceTab = metadata.sourceTab;
  const effectiveSourceTab =
    (!rawSourceTab || rawSourceTab === "Chat & Agents" || rawSourceTab === "Copilot Guide") &&
    isStockCopilotIntent(userText)
      ? "Stock Copilot"
      : rawSourceTab;
  const recentTurns = (turnCtx.messages ?? []).slice(-6).map((m: any) => ({
    role: m?.role as string | undefined,
    content:
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? m.content
              .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("")
          : "",
  }));
  return {
    userText,
    userLogin: metadata.userLogin || sessionId,
    sourceTab: effectiveSourceTab,
    isAutoOptionsResearchRequest: effectiveSourceTab === "Broker · Auto Options Research",
    recentTurns,
  };
}

/** Grounding for the turn prompt: session facts + best-effort vector recall. */
export async function assembleGrounding(ctx: ChatTurnHelpersContext, userText: string): Promise<{ memoryContext: string; vectorContext: string }> {
  const sql = ctx.ensureTables();
  // Issue #2359 (#1976 step 4d): the read serves through the
  // step-3a memory port's listRecent (the identical
  // newest-first, limit-8 projection) instead of raw SQL.
  const activeMemories = createOrmPorts(sql as never).memory.listRecent(8);
  const memoryContext = activeMemories.length > 0
    ? `\nActive Persistent Memory (SQLite Session Facts):\n` + activeMemories.map((m) => `- ${m.key}: "${m.value}"`).join("\n")
    : "";
  let vectorContext = "";
  let recalledSummaries: string[] = [];
  const vectorizeBinding = (ctx.env as any).VECTOR_MEMORY;
  if (userText && userText.trim().length > 0 && ctx.env.AI && vectorizeBinding) {
    try {
      const vm = new VectorMemory(ctx.env.AI, vectorizeBinding, undefined);
      const chunks = await vm.recallForPlan(userText);
      recalledSummaries = chunks.map((c) => c.summary);
      if (chunks.length > 0) {
        vectorContext = `\nRelevant past outcomes (vector memory, most similar first):\n${VectorMemory.brief(chunks)}`;
      }
    } catch (err) {
      structuredLog.warn("chatTurnHelpers.vector_recall_failed", {
        message: "[VectorMemory] recall failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Issue #1740 (Hybrid RAG): append graph-adjacent market
  // context to the turn prompt ONLY when expansion yields rows.
  // Unbound graph, empty graph, or any graph error means
  // byte-identical prior behavior (formatGraphContext("") is "").
  // This plugs retrieval into the actor turn path; it does not
  // replace the turn path or the dense leg above.
  if (userText && userText.trim().length > 0 && (ctx.env as any).AGENT_DB) {
    try {
      const { createMarketGraphAdapter, ensureMarketGraphTables } =
        await import("../../retrieval/createRetrievalPorts");
      const { expandGraphContext, formatGraphContext } = await import(
        "../../retrieval/hybridRetrieval"
      );
      const { resolveIaaaTenant } = await import(
        "../../security/iaaaGithubEndToEnd"
      );
      const adapter = createMarketGraphAdapter(ctx.env as any);
      if (adapter) {
        await ensureMarketGraphTables(adapter);
        const expanded = await expandGraphContext(
          adapter,
          resolveIaaaTenant(ctx.env as any),
          userText,
          recalledSummaries,
          { graphTopK: 12 },
        );
        vectorContext += formatGraphContext(expanded.rows);
      }
    } catch (err) {
      structuredLog.warn("chatTurnHelpers.turn_graph_expansion_failed", {
        message: "[retrieval] turn graph expansion failed, dense-only:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { memoryContext, vectorContext };
}
