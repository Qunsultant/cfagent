/**
 * Issue #2494 — the OpenAIMP MCP server's HTTP handler, rebuilt on the
 * SDK handler API (owner direction 2026-10-30: "first build a better
 * server, then consume it"; SDK-native, not custom).
 *
 * Composition (all SDK pieces, @modelcontextprotocol/sdk 1.32.2 — the
 * SDK generation this repo already runs in production via McpAgent):
 * - the low-level `Server` from @modelcontextprotocol/sdk/server, with
 *   one request handler per MCP method family, backed by the existing
 *   catalog/execution layer in ./index (MCP_TOOLS, executeMCPTool,
 *   readMCPResource — unchanged);
 * - `WebStandardStreamableHTTPServerTransport` in the established
 *   stateless idiom (`sessionIdGenerator: undefined`) with
 *   `enableJsonResponse: true`, so responses keep the plain-JSON shape
 *   existing clients (the in-app explorer, API-key scripts) consume.
 *
 * Why not `createMcpHandler` from the agents package (probed against
 * the installed types + wire behaviour, agents 0.32.0):
 * - The `agents/mcp` (SDK v1) overload is deprecated in 0.32.0
 *   ("will be removed in the next major version"; superseded by
 *   `createMcpHandler` from `agents/mcp/server` for new stateless
 *   servers), and its import graph does not load under this repo's
 *   default Node test runner (it pulls `cloudflare:` scheme modules).
 * - The `agents/mcp/server` (SDK v2) stateless handler cannot carry
 *   this server's established error contract: its legacy lane answers
 *   only over SSE (it rejects the `enableJsonResponse` option), and
 *   a tool handler throwing a plain error is serialized as -32603 —
 *   there is no type-level way to emit the established -32000 with
 *   the [FAILURE_MCP_PERMISSION_DENIED] business message (#1744 /
 *   #1763). Both facts were verified empirically against the
 *   installed packages (probe battery, slice note on #2494).
 * The composition below is the brief's named fallback — the SDK's
 * Server + StreamableHTTP transport — and carries every hard parity
 * requirement. The two contained adaptations are named where they
 * live: Accept normalization and the invalid-params parity guard,
 * both in handleOpenaimpMcpHttpRequest.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AsyncJobSubmission, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { BusinessError } from "../../outcomes/outcomeAspects";
import { recordTraceHopBestEffort } from "../../data/createMeshTracePorts";
import { childContextOfTraceparent } from "../../observability/meshTrace";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import type { ObservabilitySink } from "../../observability/observabilityPorts";
import {
  MCP_PERMISSION_DENIED_CODE,
  authorizeMcpToolCall,
  createProductionMcpPermissionPort,
  type McpPrincipal,
  type ToolPermissionPort,
} from "./mcpPermissionPorts";
import { McpToolFactory } from "./commands";
import {
  HTTP_DELIVERY_MODE_SWITCH,
  jobsConfigErrorEvent,
  levelsForHttpDelivery,
  resolveHttpDeliveryMode,
} from "../../config/asyncJobModes";
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  OPENAIMP_MCP_SERVER_NAME,
  executeMCPTool,
  readMCPResource,
  type MCPRequest,
  type MCPResponse,
} from "./index";

/** The per-request context the route shell builds for one /mcp call. */
export interface OpenaimpMcpHandlerContext {
  env: Env;
  orm: DatabaseORM;
  sessionId: string;
  /** #1744: calling principal + gate port for tools/call (see executeMCPTool). */
  principal?: McpPrincipal;
  /**
   * #2496: acting-identity resolver for this surface, supplied by
   * the route from the verified identity headers (see
   * McpToolContext.actingLogin). Spread into the tool context on
   * the sync path by executeMCPTool; on the queued path its value
   * is stamped server-side into the mcp.tool job payload, so the
   * async-job executor re-supplies it at execution. Unset / no
   * login means NO acting identity: identity-gated commands (the
   * mesh doors) fail closed.
   */
  actingLogin?: () => string | undefined;
  /**
   * #2496: mesh-trace traceparent resolver, under exactly the
   * actingLogin discipline (see McpToolContext.traceparent):
   * spread on the sync path, stamped into the queued payload, and
   * the source of the queue-time trace hop recorded below.
   */
  traceparent?: () => string | undefined;
  permissionPort?: ToolPermissionPort;
  permissionDecisionSink?: ObservabilitySink;
  /** #1722: NLQ_MODE session/user carriers, forwarded to tool execution. */
  scopedNlqModes?: import("../../config/nlqModes").NlqScopedModes;
  /** #1723: KNOWLEDGE_MODE / MEMORY_READ_MODE carriers, forwarded likewise. */
  scopedKnowledgeModes?: import("../../config/knowledgeMemoryModes").KnowledgeScopedModes;
  scopedMemoryModes?: import("../../config/knowledgeMemoryModes").MemoryScopedModes;
  /** #1724: HTTP_DELIVERY_MODE / JOB_LIST_ENVELOPE carriers, forwarded likewise. */
  scopedHttpDeliveryModes?: import("../../config/asyncJobModes").HttpDeliveryScopedModes;
  scopedJobListModes?: import("../../config/asyncJobModes").JobListScopedModes;
  /** #1729: GOAL_COMPILE_MODE carrier, forwarded likewise. */
  scopedGoalChainModes?: import("../../config/goalChainModes").GoalChainScopedModes;
  /** #1724: HTTP_DELIVERY_MODE run level — the `x-delivery-mode` header on the /mcp POST. */
  deliveryModeRun?: unknown;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  submitJob?: (job: AsyncJobSubmission) => Promise<{
    jobId: string;
    status: "queued";
    statusUrl: string;
  }>;
  getJob?: (jobId: string) => unknown;
  listJobs?: () => unknown[];
}

/**
 * A JSON-RPC protocol error with an exact code and the bare business
 * message. The SDK's McpError prefixes its message with
 * "MCP error <code>:"; the established wire contract carries the bare
 * message, so the prefix is removed after construction (verified
 * against the installed SDK: the transport serializes
 * `error.message` verbatim).
 */
function mcpProtocolError(code: number, message: string): McpError {
  const err = new McpError(code as ErrorCode, message);
  (err as { message: string }).message = message;
  return err;
}

/**
 * Builds one stateless SDK Server for a single /mcp exchange. The
 * method handlers delegate to the same catalog/execution layer the
 * hand-rolled dispatch used; the tools/call handler carries the
 * delivery-mode + permission-gate logic over verbatim.
 */
export function createOpenaimpMcpServer(context: OpenaimpMcpHandlerContext): Server {
  const server = new Server(
    { name: OPENAIMP_MCP_SERVER_NAME, version: MCP_SERVER_INFO.version },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    // #1724: HTTP_DELIVERY_MODE over tools/call wrapping — moved
    // verbatim from the hand-rolled dispatch. Legacy = queued when a
    // submitJob submitter is present, direct execution otherwise; an
    // explicitly set level (run > session > user > env) overrides the
    // submitter rule. The async-job tools are NEVER wrapped, in any
    // mode. An invalid winning value fails closed to legacy, logged +
    // audited as jobs.config_error. Queued without a submitter still
    // executes directly — there is nothing to queue with.
    const deliveryLegacy = context.submitJob ? "queued" : "sync";
    const resolvedDelivery = resolveHttpDeliveryMode(
      levelsForHttpDelivery(
        context.scopedHttpDeliveryModes,
        context.deliveryModeRun,
        (context.env as unknown as Record<string, unknown> | undefined)?.[HTTP_DELIVERY_MODE_SWITCH]
      ),
      deliveryLegacy as "sync" | "queued"
    );
    if (resolvedDelivery.invalid) {
      console.error(
        `[jobs] invalid ${HTTP_DELIVERY_MODE_SWITCH} value ${JSON.stringify(resolvedDelivery.raw)} — failing closed to "${deliveryLegacy}"`
      );
      context.audit(jobsConfigErrorEvent(), "orchestrator", {
        setting: HTTP_DELIVERY_MODE_SWITCH,
        value: resolvedDelivery.raw ?? "",
        resolved: deliveryLegacy,
      });
    }
    // #1744: the gate runs on BOTH delivery paths. The sync path
    // gates inside executeMCPTool; the queued path authorizes
    // BEFORE submitJob, so a refused call never receives a job
    // receipt (the receipt would imply the call was accepted).
    // A permission denial returns a stable business error token,
    // never a technical leak.
    let data: unknown;
    try {
      if (
        resolvedDelivery.mode === "queued" && context.submitJob && McpToolFactory.getTool(name) &&
        name !== "get_async_job" && name !== "list_async_jobs"
      ) {
        const port = context.permissionPort ?? createProductionMcpPermissionPort();
        const principal = context.principal ?? { kind: "system" as const, login: null };
        await authorizeMcpToolCall(port, principal, name, {
          sessionId: context.sessionId,
          audit: context.audit,
          decisionSink:
            context.permissionDecisionSink ?? createObservabilitySink(context.env),
        });
        // #2496: stamp the acting identity + traceparent into the
        // job payload HERE, server-side, from the route-threaded
        // carriers (never from tool arguments) — the stamps the
        // retired turn adapter (McpAgentToolAdapter) made at queue
        // time, moved to the surface that now queues: the chat
        // turn's discovered tools execute through this handler, so
        // this is the one queue point for turn and external calls
        // alike. Absent carriers stamp nothing: the executor then
        // re-supplies no identity and identity-gated tools fail
        // closed at execution, exactly as an unidentified direct
        // call does.
        const actingLogin = context.actingLogin?.()?.trim() || undefined;
        const traceparent = context.traceparent?.() || undefined;
        const submitted = await context.submitJob({
          capability: "mcp.tool",
          payload: {
            toolName: name,
            arguments: toolArgs || {},
            ...(actingLogin ? { actingLogin } : {}),
            ...(traceparent ? { traceparent } : {}),
          },
        });
        // #2428 (Agent Mesh S17): the queue-time trace hop,
        // recorded here for the same reason the stamps live here —
        // this handler is where mcp.tool jobs are queued now.
        const traceChild = childContextOfTraceparent(traceparent);
        if (traceChild) {
          void recordTraceHopBestEffort(context.env, {
            traceId: traceChild.traceId,
            spanId: traceChild.spanId,
            parentSpanId: traceChild.parentSpanId,
            kind: "job-queue",
            operation: name,
            timestampMs: Date.now(),
            caller: actingLogin,
            jobId: submitted.jobId,
          });
        }
        data = submitted;
      } else {
        data = await executeMCPTool(name, toolArgs || {}, context);
      }
    } catch (err) {
      if (err instanceof BusinessError && err.code === MCP_PERMISSION_DENIED_CODE) {
        throw mcpProtocolError(-32000, `[${MCP_PERMISSION_DENIED_CODE}] ${err.message}`);
      }
      // The hand-rolled dispatch answered every other execution
      // failure at -32000 with the bare message (its outer catch);
      // the SDK would otherwise serialize a plain throw as -32603.
      throw mcpProtocolError(
        -32000,
        err instanceof Error ? err.message || "Internal error during MCP execution" : "Internal error during MCP execution"
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
      isError: false,
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: MCP_RESOURCES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      const resource = await readMCPResource(uri, context);
      return { contents: [resource] };
    } catch (err) {
      throw mcpProtocolError(
        -32000,
        err instanceof Error ? err.message || "Internal error during MCP execution" : "Internal error during MCP execution"
      );
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const prompt = MCP_PROMPTS.find((p) => p.name === name);
    if (!prompt) {
      throw mcpProtocolError(-32601, `Prompt not found: ${name}`);
    }
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Execute workflow for prompt template: ${prompt.name}.`,
          },
        },
      ],
    };
  });

  server.setRequestHandler(PingRequestSchema, async () => ({}));

  return server;
}

const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * Serves one /mcp HTTP exchange through the SDK transport. The route
 * shell keeps owning authentication and identity stamping (server.ts
 * + the DO route); this handler owns the protocol.
 */
export async function handleOpenaimpMcpHttpRequest(
  request: Request,
  context: OpenaimpMcpHandlerContext
): Promise<Response> {
  // Parity guard (named adaptation): the SDK validates tools/call
  // and resources/read parameters against its protocol schemas
  // before dispatch and answers a missing required field with
  // -32603 plus a schema dump. The established contract answers
  // -32602 with a business message. Exactly those two cases are
  // answered here, in the established shape; everything else is the
  // SDK's. (A body that does not parse falls through to the
  // transport's own parse error.)
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = undefined;
  }
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const msg = body as { id?: unknown; method?: unknown; params?: { name?: unknown; uri?: unknown } };
    if (typeof msg.method !== "string") {
      // A method-less (or non-string-method) body: the established
      // dispatch answered -32601 naming the method; the SDK answers
      // a protocol-invalid request with -32600. The established
      // answer is kept (it is pinned by the route-extraction suite).
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
      });
    }
    if (msg.method === "tools/call" && !msg.params?.name) {
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32602, message: "Invalid params: 'name' is required" },
      });
    }
    if (msg.method === "resources/read" && !msg.params?.uri) {
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        error: { code: -32602, message: "Invalid params: 'uri' is required" },
      });
    }
  }

  // Accept normalization (named adaptation): the Streamable HTTP
  // transport enforces the spec's Accept contract (406 when the
  // client does not accept both application/json and
  // text/event-stream). The pre-SDK endpoint accepted any Accept —
  // including the browser default the in-app explorer sends — so a
  // non-compliant Accept is upgraded here, at the route edge, the
  // same seam that already rewrites identity headers. Compliant
  // clients are untouched.
  const accept = request.headers.get("Accept") ?? "";
  let effectiveRequest = request;
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    const headers = new Headers(request.headers);
    headers.set("Accept", MCP_ACCEPT);
    effectiveRequest = new Request(request, { headers });
  }

  const server = createOpenaimpMcpServer(context);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(effectiveRequest);
  } finally {
    await server.close().catch(() => {});
  }
}

/**
 * In-process JSON-RPC entry — the shape `handleMCPRequest` has always
 * had, kept for in-process callers and the existing test surface.
 * It is a facade over the SDK HTTP handler above (one implementation,
 * two entrances): the message is serialized into a Request, served,
 * and the JSON response parsed back. A param-less `initialize` is
 * completed with the server's own protocol version — an in-process
 * caller is not a wire client and the historical contract answers it.
 */
export async function handleMCPRequest(
  request: MCPRequest,
  context: OpenaimpMcpHandlerContext
): Promise<MCPResponse> {
  const wireMessage =
    request.method === "initialize" && request.params == null
      ? {
          ...request,
          params: {
            protocolVersion: MCP_SERVER_INFO.protocolVersion,
            capabilities: {},
            clientInfo: { name: "cfagent-in-process", version: "0" },
          },
        }
      : request;
  const httpRequest = new Request("https://agent.internal/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify(wireMessage),
  });
  const response = await handleOpenaimpMcpHttpRequest(httpRequest, context);
  const text = await response.text();
  if (!text.trim()) {
    // A notification acknowledgement (HTTP 202, no body) — the
    // historical in-process shape for a served notification.
    return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
  }
  return JSON.parse(text) as MCPResponse;
}
