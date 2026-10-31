/**
 * Issue #359-02: MCP + chat + NLQ routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move —
 * no behavior change.
 *
 * The module handles the three contiguous AI-interaction blocks: the MCP
 * server endpoint (JSON-RPC 2.0 + discovery), POST /api/chat (thin adapter
 * over the single-owner runAgenticChatTurn pipeline, PR #320), and the
 * POST /nlq natural-language query route. It is invoked from routeRequest at
 * the EXACT position the original blocks occupied in the sequential
 * path.endsWith matching sequence. It returns a Response when one of its
 * paths matches, or null when none does — matching order relative to all
 * other handlers is preserved by the call site.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit McpChatNlqRouteContext parameter; there are no new globals
 * and no back-references into the class.
 *
 * NOT moved (documented so no one re-litigates):
 * - The POST /nlq/webhook spellings live in src/server.ts, delegating to
 *   the single-owner handleNlqWebhookRequest (issue #313) — they were never
 *   in routeRequest.
 * - /schema/tables and /schema/query are generic ORM introspection routes
 *   and belong to a future schema/admin slice, not the MCP/chat/NLQ slice.
 *
 * Safety notes carried over verbatim from the original code:
 * - POST /api/chat delegates to runAgenticChatTurn (the same judge-routed
 *   pipeline the WebSocket chat runs); the route shell here does no chat
 *   logic of its own.
 * - The NLQ safety invariants (NLQ table allowlist seam, zod-validated plan,
 *   bound parameters) live inside executeNaturalLanguageQuery in
 *   src/agents/nlq.ts — untouched by this move; this file calls it, the
 *   same single-owner pipeline.
 * - PRE-EXISTING HYGIENE (noted, not fixed): the chat block's leading
 *   comment says "Natural Language Query (NLQ) endpoint" — that line was
 *   already mislabeled in orchestrator.ts before this move.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import type { AgentName, AsyncJobRecord, AsyncJobSubmission, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  MCP_TOOLS,
} from "../../mcps/openaimp";
import { handleOpenaimpMcpHttpRequest } from "../../mcps/openaimp/handler";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { resolveMcpPrincipalFromHeaders } from "../../mcps/openaimp/mcpPermissionPorts";
import { executeNaturalLanguageQuery, type NLQSchedulingPort, type NLQSocialBriefPort } from "../nlq";
import {
  NLQ_MODE_SWITCH,
  levelsForNlq,
  nlqConfigErrorEvent,
  resolveNlqMode,
} from "../../config/nlqModes";
import type { NlqScopedModes } from "../../config/nlqModes";
import type {
  HttpDeliveryScopedModes,
  JobListScopedModes,
} from "../../config/asyncJobModes";
import { resolveAiModelName } from "../model";
import { getUserDid } from "../did";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { createDiscoveryService } from "../../services/discoveryService";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { createFitDiscoveryRunner } from "../../services/fitDiscoveryRunner";

/** The subset of OrchestratorAgent surface the MCP/chat/NLQ handlers need. */
export interface McpChatNlqRouteContext {
  getOrm(): DatabaseORM;
  getStorageSql(): any;
  /**
   * Issue #1661: DO blob handle for full capture (mirrors the
   * getStorageSql idiom). Optional — mock ctxs without it degrade
   * to today's outcome-only contract via `ctx.getStorage?.()`.
   */
  getStorage?(): any;
  env: Env;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  submitAsyncJob(
    job: AsyncJobSubmission
  ): Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  getAsyncJob(jobId: string): AsyncJobRecord | undefined;
  listAsyncJobs(): AsyncJobRecord[];
  extractMessageText(message: unknown): string;
  /** Issue #686: the Think session's async message read. */
  getMessages(): Promise<any[]>;
  recordMessage(
    role: "user" | "assistant" | "system",
    content: string,
    agent: AgentName | "orchestrator"
  ): void;
  runAgenticChatTurn(opts: {
    userText: string;
    recentTurns: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest: boolean;
  }): Promise<{
    result: any;
    route: {
      agent: string;
      confidence: number;
      reason: string;
      needsConfirmation: boolean;
    };
  }>;
  buildChatErrorFallback(err: unknown, userText: string, userLogin: string): Promise<string>;
  nlqSchedulingPort(): NLQSchedulingPort;
  /**
   * #1077 Phase 5b slice 2: optional — test/older contexts omit it and
   * the /nlq route then passes no social port (executor fails
   * honestly). Production orchestrator contexts bind it from
   * SESSION_STORE; the route still withholds it from
   * webhook-originated requests (see below).
   */
  nlqSocialBriefPort?(): NLQSocialBriefPort | null;
  /**
   * #1722: optional NLQ_MODE session/user carriers for the /nlq
   * route (run comes from the body `mode`, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/nlqModes.ts.
   */
  scopedNlqModes?: NlqScopedModes;
  /**
   * #1724: optional HTTP_DELIVERY_MODE / JOB_LIST_ENVELOPE
   * session/user carriers for the /mcp route (delivery run comes
   * from the `x-delivery-mode` header on the /mcp POST, envelope
   * run from the per-call `envelope` input, global env from `env`).
   * Populated by the execution-context owner; unset carriers fall
   * through to env. See src/config/asyncJobModes.ts.
   */
  scopedHttpDeliveryModes?: HttpDeliveryScopedModes;
  scopedJobListModes?: JobListScopedModes;
}

/**
 * Handles the MCP + chat + NLQ routes. Returns a Response on match, null
 * when none of its paths matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleMcpChatNlqRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: McpChatNlqRouteContext
): Promise<Response | null> {
  // Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)
  if (path.endsWith("/mcp")) {
    const orm = ctx.getOrm();

    if (request.method === "GET") {
      return Response.json({
        server: MCP_SERVER_INFO,
        tools: MCP_TOOLS,
        resources: MCP_RESOURCES,
        prompts: MCP_PROMPTS,
        endpoints: {
          jsonrpc: "/api/mcp",
          protocol: "MCP JSON-RPC 2.0",
        },
      });
    }

    if (request.method === "POST") {
      try {
        // Issue #2494: the wire protocol is served by the SDK handler
        // (src/mcps/openaimp/handler); this shell keeps owning the
        // route context — identity, audit, job ports — exactly as
        // before. The GET discovery document above is unchanged.
        // Issue #2496: the acting-login / traceparent carriers for
        // this surface. The x-user-login header is Worker-verified
        // at the edge — src/server.ts overwrites it from the
        // session / API key before forwarding, and the in-instance
        // SDK MCP loopback (src/agents/orchestrator/meshMcpClient.ts)
        // stamps it from the turn stash under the same discipline;
        // both arrive here indistinguishably, by construction. The
        // handler spreads the resolvers into the sync-path tool
        // context and stamps their values server-side into queued
        // mcp.tool payloads. No header → no carrier → door commands
        // still fail closed.
        const headerLogin = request.headers.get("x-user-login")?.trim() || undefined;
        const headerTraceparent = request.headers.get("traceparent") ?? undefined;
        return await handleOpenaimpMcpHttpRequest(request, {
          env: ctx.env,
          orm,
          sessionId,
          // #1744: the calling principal, resolved from the
          // Worker-forwarded identity headers (x-user-login always,
          // x-principal-kind session|api-key). No login resolves to
          // `unknown` (fail closed) — the gate never defaults an
          // external call to system.
          principal: resolveMcpPrincipalFromHeaders(request.headers),
          actingLogin: () => headerLogin,
          traceparent: () => headerTraceparent,
          permissionDecisionSink: createObservabilitySink(ctx.env),
          scopedNlqModes: ctx.scopedNlqModes,
          scopedHttpDeliveryModes: ctx.scopedHttpDeliveryModes,
          scopedJobListModes: ctx.scopedJobListModes,
          deliveryModeRun: request.headers.get("x-delivery-mode"),
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
          submitJob: (job) => ctx.submitAsyncJob(job),
          getJob: (jobId) => ctx.getAsyncJob(jobId),
          listJobs: () => ctx.listAsyncJobs().map(({ result: _result, ...job }) => job),
        });
      } catch (err: any) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message || "Internal error" } },
          { status: 500 }
        );
      }
    }
  }

  // Natural Language Query (NLQ) endpoint
  // Issue #312: the advertised POST /api/chat. The Worker strips the /api
  // prefix when forwarding, so it arrives here as /chat (also registered as
  // an immediate endpoint in onRequest so it is not queued as an async job).
  // This is a thin adapter over the single-owner agentic chat turn
  // (runAgenticChatTurn) — the same judge-routed pipeline the WebSocket chat
  // runs. The HTTP response carries the completed turn as JSON; true
  // streaming remains available over the agent WebSocket chat the UI uses.
  // One turn per request, executed against the per-user conversation state.
  if ((path === "/chat" || path === "/api/chat") && request.method === "POST") {
    const chatBody = (await request.json().catch(() => null)) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    } | null;
    const incoming = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
    const lastUserMessage = [...incoming]
      .reverse()
      .find((m) => typeof m?.role === "string" && (m.role as string).toLowerCase() === "user");
    const chatUserText = ctx.extractMessageText(lastUserMessage);
    if (!chatUserText) {
      return Response.json(
        { error: "messages must be a non-empty array with a final user message containing text." },
        { status: 400 }
      );
    }
    const chatUserLogin = request.headers.get("x-user-login");
    if (!chatUserLogin) return unauthenticatedResponse();
    try {
      // Run the pipeline against the per-user conversation state.
      // Issue #686: conversation state is the Think session. The turn
      // driver owns session appends (the user message enters through
      // runTurn's factory input, delta-by-id, so a re-sent history is
      // not duplicated; Think persists the assistant reply), and
      // beforeTurn is the single writer of the user mas_messages
      // record. This adapter only reads history for the judge's
      // recent-turns context.
      const existingMessages = await ctx.getMessages();
      const tailUser = [...existingMessages]
        .reverse()
        .find((m: any) => m?.role === "user");
      const chatRecentTurns = [
        ...existingMessages.slice(-6).map((m: any) => ({
          role: m?.role,
          content: ctx.extractMessageText(m),
        })),
        ...(ctx.extractMessageText(tailUser) !== chatUserText
          ? [{ role: "user", content: chatUserText }]
          : []),
      ].slice(-6);

      const { result: chatResult, route: chatRoute } = await ctx.runAgenticChatTurn({
        userText: chatUserText,
        recentTurns: chatRecentTurns,
        userLogin: chatUserLogin,
        isAutoOptionsResearchRequest: false,
      });
      const chatText = await chatResult.text;
      ctx.audit("chat.http_turn", "orchestrator", {
        route: chatRoute.agent,
        confidence: chatRoute.confidence,
        reason: chatRoute.reason,
      });

      return Response.json({
        reply: chatText,
        route: {
          agent: chatRoute.agent,
          confidence: chatRoute.confidence,
          reason: chatRoute.reason,
          needsConfirmation: chatRoute.needsConfirmation,
        },
        model: resolveAiModelName(ctx.env),
        streaming: false,
      });
    } catch (err) {
      // Same degraded content the WebSocket chat would stream, as JSON.
      const fallbackText = await ctx.buildChatErrorFallback(err, chatUserText, chatUserLogin);
      ctx.recordMessage("assistant", fallbackText, "orchestrator");
      return Response.json({ reply: fallbackText, fallback: true, streaming: false });
    }
  }

  if (path.endsWith("/nlq") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        query?: string;
        context?: string;
        validateWithLLM?: boolean;
        mode?: unknown;
      };
      const query = (body.query || "").trim();
      if (!query) {
        return Response.json({ error: "Query parameter is required" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const contextHeader = request.headers.get("x-nlq-context") || body.context;
      const userDid = getUserDid(sessionId);
      const orm = ctx.getOrm();
      // #1077 Phase 5b slice 2: the social brief port is bound ONLY
      // for trusted chat requests. Webhook-originated NLQ (the
      // server's NLQ webhook forwards here with x-nlq-source:
      // webhook) never gets it: webhook bodies are untrusted
      // external content, and a brief is a public-post input —
      // autonomous channels would publish it with no human approval.
      // Withholding the port makes the executor fail honestly; the
      // header can only REMOVE the port (a forged "webhook" value
      // on a direct call disables intake for that caller), never
      // grant it.
      //
      // #1722: withholding is computed BEFORE the mode branch and
      // stands in BOTH modes — it is enforcement, not a behavior
      // variant. A run/session/user/env value can never re-grant a
      // withheld port: in rest mode the withheld port is passed as
      // undefined; in mcp mode no port is passed at all. Scheduling
      // and discovery are NOT withheld on the webhook path, in
      // either mode. The x-user-login gate above likewise stands in
      // both modes (it runs before any mode resolution).
      const socialBriefPort =
        request.headers.get("x-nlq-source") === "webhook"
          ? undefined
          : (ctx.nlqSocialBriefPort?.() ?? undefined);
      // #1722: NLQ_MODE, run (body `mode`) > session > user >
      // global env > built-in "rest". An invalid winning value fails
      // closed to "rest" and is logged + audited as nlq.config_error.
      const resolvedNlqMode = resolveNlqMode(
        levelsForNlq(ctx.scopedNlqModes, body.mode, (ctx.env as unknown as Record<string, unknown> | undefined)?.[NLQ_MODE_SWITCH])
      );
      if (resolvedNlqMode.invalid) {
        console.error(
          `[nlq] invalid ${NLQ_MODE_SWITCH} value ${JSON.stringify(resolvedNlqMode.raw)} — failing closed to "rest"`
        );
        ctx.audit(nlqConfigErrorEvent(), "nlq", {
          setting: NLQ_MODE_SWITCH,
          value: resolvedNlqMode.raw ?? "",
          resolved: "rest",
        });
      }
      // #1722: "rest" (default) is the pre-#1722 route contract
      // verbatim — full ports, stores, runners, validateWithLLM
      // passthrough (note: the REST route binds NO stock-screen port,
      // so stock screens still fall back to the listings screener
      // here, in both modes; the async job is the stock-screen
      // surface). "mcp" is the MCP-direct shape — the full function
      // with NO options (no ports, no stores, no runners) — while
      // keeping the REST identity (x-user-login) and audit.
      // Issue #1686: the single exception to "NO options" is the DO
      // blob handle — mcp-mode screens capture fully like rest-mode
      // screens; ports, stores, and runners stay absent.
      // #2303: ports for the REST-mode discovery runner (mcp
      // mode keeps its no-options shape, #1686 exception aside).
      const nlqDpPorts =
        resolvedNlqMode.mode === "mcp" ? null : await buildDataProviderPorts(ctx.env);
      const { plan, result } = resolvedNlqMode.mode === "mcp"
        ? await executeNaturalLanguageQuery(orm, sessionId, query, ctx.env, userLogin, userDid, { storage: ctx.getStorage?.() })
        : await executeNaturalLanguageQuery(
            orm,
            sessionId,
            query,
            ctx.env,
            userLogin,
            userDid,
            { context: contextHeader, validateWithLLM: body.validateWithLLM, scanRunStore: createOptionsDiscoveryPorts({ sql: ctx.getStorageSql(), storage: ctx.getStorage?.() }).scanRuns, profileStore: createOptionsDiscoveryPorts({ sql: ctx.getStorageSql(), storage: ctx.getStorage?.() }).strategyProfiles, schedulingPort: ctx.nlqSchedulingPort(), socialBriefPort, storage: ctx.getStorage?.(), discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin, orm, sql: ctx.getStorageSql(), blobStorage: ctx.getStorage?.(), ...(nlqDpPorts?.config ? { configPort: nlqDpPorts.config } : {}), ...(nlqDpPorts?.captures ? { capturePort: nlqDpPorts.captures } : {}) }), fitDiscoveryRunner: createFitDiscoveryRunner({ env: ctx.env, userLogin, sql: ctx.getStorageSql(), storage: ctx.getStorage?.() }) }
          );
      ctx.audit("nlq.executed", "nlq", {
        query,
        domain: result.domain,
        operation: plan.operation,
        count: result.count,
      });

      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "NLQ query processing failed" }, { status: 500 });
    }
  }
  return null;
}
