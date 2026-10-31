/**
 * Issue #2496 (Agent Mesh Improvement, programme #2494) — the chat
 * turn's consumption of the platform's own MCP server ("openaimp",
 * src/mcps/openaimp) through the Agents SDK MCP client, on the
 * SDK-PROVIDED path (owner direction 2026-10-30/31: consume the
 * server the way Think/the Agents SDK provides; an earlier build of
 * this slice wrapped the SDK core in a custom exoskeleton —
 * includeMcpTools=false, a manual getAITools() merge re-keyed to
 * canonical names — and was rejected and parked for exactly that).
 *
 * The provided path, as built here (agents 0.32.0 /
 * @cloudflare/think 0.23.0, verified against the installed types
 * and the Think runtime):
 *
 * - Registration: the instance registers the openaimp server on
 *   its own Agents SDK MCP client manager (`this.mcp`), the SDK's
 *   registerServer/connectToServer/discoverIfConnected lifecycle.
 * - Tool inclusion: Think's own auto-merge. `includeMcpTools`
 *   keeps its SDK default (true): Think spreads
 *   `this.mcp.getAITools()` into every turn's merged tool set, and
 *   `waitForMcpConnections` (set on OrchestratorAgent) lets the
 *   connection settle first. Discovered tools carry the SDK's
 *   namespaced keys — `tool_openaimp_<catalog name>` — and those
 *   names ARE the turn's steering contract now (src/agents/
 *   chatPrompt.ts names them verbatim). A command added to the
 *   server catalog reaches the turn with no turn-code change
 *   (tests/mesh_mcp_self_registration_2496.test.ts).
 * - The turn's native tools (getTools()) are untouched by this
 *   module; Think merges the two sets.
 *
 * Two adaptations remain. Each is retained because the provided
 * path provably lacks the capability, with the probe named:
 *
 * 1. The loopback transport `fetch` (createOpenaimpMcpFetch). The
 *    SDK's StreamableHTTP transport accepts a `fetch` option; the
 *    default global fetch cannot serve this server from inside
 *    the agent instance:
 *    - the server's in-instance entrance is the instance's own
 *      route handler at the internal base https://agent.internal
 *      (the same base src/server.ts uses to forward external /mcp
 *      traffic into the per-login instance), which does not
 *      resolve on the public network; and the public entrance
 *      (/mcp at the edge) requires the user's session or API-key
 *      credential (src/server.ts answers 401 without one) — a
 *      credential the instance does not hold for its user.
 *    - identity (below) must be stamped PER CALL, and the MCP
 *      SDK client offers no outgoing-call interceptor: its only
 *      request hook is setRequestHandler, which serves
 *      server-initiated requests. The transport fetch is the one
 *      per-call seam the SDK provides.
 *    The fetch dispatches in-instance to the agent's own
 *    routeRequest — the loopback never leaves the instance, so
 *    the call lands on the same route context (session, scoped
 *    mode carriers, job ports) an external call to this instance
 *    gets.
 *
 * 2. Wake re-registration (ensureOpenaimpMcpConnection). The SDK
 *    persists a registration's transport options in DO storage
 *    and restores connections from them on wake; the durable
 *    subset (PersistedMcpTransportOptions in agents 0.32.0) has
 *    no `fetch` field — a function cannot survive storage — so a
 *    restored connection's transport is built without the
 *    loopback fetch and can never reach the in-instance server.
 *    After the restore settles, a non-live openaimp connection is
 *    therefore removed and re-registered with the fetch-bearing
 *    transport (with fail-fast retry options, so the NEXT wake's
 *    dead restore attempt is equally cheap). A live connection
 *    with a discovered catalog is reused as-is: a non-empty
 *    catalog is a sound liveness proof here, because only the
 *    loopback fetch can reach https://agent.internal/mcp at all.
 *
 * Identity carriage (programme rule: identity never regresses).
 * The open question for the provided path — per-registration
 * headers, per-instance manager state, or per-call stamping — is
 * answered PER CALL, on this evidence:
 * - Registration headers are static: they are fixed when the
 *   connection is (re)established, which happens at wake, before
 *   any turn exists, and they persist across hibernation. The
 *   acting login is per-TURN state: OrchestratorAgent's turn
 *   stash (pendingTurn) is filled by the turn drivers/beforeTurn
 *   and consumed at turn end (portOnChatResponse clears it), and
 *   #2341 deliberately resolved identity from the turn, never
 *   from the instance, so an identity-gated call with no turn
 *   identity fails closed even though the instance itself is
 *   named. A static header stamped from the instance would
 *   silently upgrade an unidentified turn to the instance
 *   identity — exactly the synthetic-identity regression the
 *   programme forbids.
 * - So the carrier fetch resolves the in-flight turn's acting
 *   login from the turn stash at call time and stamps it as the
 *   `x-user-login` / `x-principal-kind: session` headers — the
 *   same headers src/server.ts sets from the verified credential
 *   when it forwards external /mcp traffic — plus the turn's
 *   traceparent. The /mcp route threads them into the handler
 *   context, and the handler stamps them server-side into queued
 *   mcp.tool payloads (src/mcps/openaimp/handler.ts), so the
 *   async-job executor re-supplies identity + trace exactly as
 *   it did for the retired turn adapter.
 * - A `tools/call` with NO resolvable login is refused at the
 *   carrier and never dispatched (MESH_MCP_IDENTITY_REQUIRED):
 *   no mesh tool executes anonymously or under a synthetic
 *   identity. Discovery traffic (initialize / tools/list /
 *   ping) carries no identity — the catalog is not user data,
 *   and the server does not principal-gate it.
 *
 * The CHAT_NLQ_MODE gate under the provided path lives in
 * chatNlqTurnGate below: Think's beforeTurn can only spread-over
 * the merged tool set (TurnConfig.tools is additive-only), so the
 * flag now restricts the turn through TurnConfig.activeTools —
 * the lever this codebase already uses to suppress tools on
 * auto-research turns.
 */

import type { MCPClientManager } from "agents/mcp/client";
import {
  chatNlqConfigErrorEvent,
  resolveChatNlqTurnMode,
  type ChatNlqScopedModes,
} from "../../config/chatNlqModes";

/** The platform's own MCP server, as registered on the turn's SDK MCP client. */
export const OPENAIMP_MCP_SERVER_ID = "openaimp";
/** The codebase's established internal base for in-instance DO fetches (src/server.ts). */
export const OPENAIMP_MCP_URL = "https://agent.internal/mcp";
/**
 * The SDK names a discovered tool `tool_<serverId, dashes removed>_<toolName>`
 * (agents 0.32.0, MCPClientManager.getAITools). For the openaimp server:
 */
export const OPENAIMP_MCP_TOOL_PREFIX = `tool_${OPENAIMP_MCP_SERVER_ID}_`;
/** The discovered key of the NLQ catalog tool (the CHAT_NLQ_MODE gate's target). */
export const OPENAIMP_NLQ_TOOL_KEY = `${OPENAIMP_MCP_TOOL_PREFIX}execute_nlq`;
/** Stable token for a carrier refusal: a tools/call with no resolvable acting login. */
export const MESH_MCP_IDENTITY_REQUIRED = "mesh_mcp_identity_required";

/** The fetch shape the SDK's StreamableHTTP transport accepts as its `fetch` option. */
export type OpenaimpMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenaimpMcpFetchDeps {
  /** Dispatch one protocol request to the instance's own /mcp route. */
  dispatch: (request: Request) => Promise<Response>;
  /** The in-flight turn's acting login (the orchestrator's turn stash). */
  resolveActingLogin: () => string | undefined;
  /** The in-flight turn's mesh traceparent (the orchestrator's turn stash). */
  resolveTraceparent: () => string | undefined;
}

/**
 * The in-instance loopback identity carrier: an SDK transport
 * `fetch` that forwards protocol requests to the instance's own
 * route handler, stamping the turn's identity onto `tools/call`
 * requests — and refusing those it cannot identify.
 */
export function createOpenaimpMcpFetch(deps: OpenaimpMcpFetchDeps): OpenaimpMcpFetch {
  return async (input, init) => {
    const incoming = new Request(input, init);
    const method = incoming.method.toUpperCase();
    let bodyText = "";
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      bodyText = await incoming.text();
    }
    let rpcMethod: string | undefined;
    let rpcId: unknown = null;
    if (bodyText) {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const record = parsed as { method?: unknown; id?: unknown };
          rpcMethod = typeof record.method === "string" ? record.method : undefined;
          rpcId = record.id ?? null;
        }
      } catch {
        // Non-JSON body: not a protocol request we stamp — dispatch untouched.
      }
    }

    const headers = new Headers(incoming.headers);
    if (rpcMethod === "tools/call") {
      const login = deps.resolveActingLogin()?.trim();
      if (!login) {
        // Fail closed at the carrier: an unidentified call is
        // refused here and never reaches the server, so no mesh
        // tool can execute without the acting-login discipline.
        return Response.json({
          jsonrpc: "2.0",
          id: rpcId,
          error: {
            code: -32001,
            message:
              `${MESH_MCP_IDENTITY_REQUIRED}: tools/call refused — no acting login is resolvable for this turn; ` +
              "mesh tools require an identified acting user.",
          },
        });
      }
      headers.set("x-user-login", login);
      headers.set("x-principal-kind", "session");
      const traceparent = deps.resolveTraceparent();
      if (typeof traceparent === "string" && traceparent) {
        headers.set("traceparent", traceparent);
      }
    }

    const forwarded = new Request(incoming.url, {
      method,
      headers,
      ...(bodyText ? { body: bodyText } : {}),
    });
    return deps.dispatch(forwarded);
  };
}

/** The slice of the SDK manager the ensure step drives (the real manager satisfies it). */
export type MeshMcpManagerPort = Pick<
  MCPClientManager,
  | "waitForConnections"
  | "getAITools"
  | "registerServer"
  | "connectToServer"
  | "discoverIfConnected"
  | "removeServer"
>;

export interface EnsureOpenaimpMcpResult {
  ready: boolean;
  toolCount: number;
  /** True when an already-live connection was reused (no re-registration). */
  reused: boolean;
  error?: string;
}

/**
 * Establish (or reuse) the openaimp MCP connection on the SDK
 * manager. Wake discipline: the manager restores persisted
 * registrations from DO storage on start, but the persisted
 * transport options cannot carry the loopback `fetch`, so a
 * restored connection can never reach the in-instance server —
 * after the restore settles, a non-live openaimp connection is
 * removed and re-registered with the loopback transport (with
 * fail-fast retry options, so the NEXT wake's dead restore
 * attempt is equally cheap). A live connection with a discovered
 * catalog is reused as-is.
 *
 * Never throws: the outcome is audited (mesh_mcp.discovery_ready
 * / mesh_mcp.discovery_failed) and returned — fail loud, never
 * block startup or a turn on discovery.
 */
export async function ensureOpenaimpMcpConnection(deps: {
  mcp: MeshMcpManagerPort;
  fetch: OpenaimpMcpFetch;
  audit: (type: string, payload: Record<string, unknown>) => void;
}): Promise<EnsureOpenaimpMcpResult> {
  const { mcp } = deps;
  try {
    await mcp.waitForConnections({ timeout: 10_000 });
  } catch {
    // waitForConnections never rejects by contract; the guard keeps
    // a contract surprise from taking the ensure step down with it.
  }
  const existingCount = Object.keys(
    mcp.getAITools({ serverId: OPENAIMP_MCP_SERVER_ID }),
  ).length;
  if (existingCount > 0) {
    return { ready: true, toolCount: existingCount, reused: true };
  }

  try {
    try {
      await mcp.removeServer(OPENAIMP_MCP_SERVER_ID);
    } catch {
      // Nothing registered yet on a first wake — removal is best-effort.
    }
    await mcp.registerServer(OPENAIMP_MCP_SERVER_ID, {
      url: OPENAIMP_MCP_URL,
      name: OPENAIMP_MCP_SERVER_ID,
      transport: { type: "streamable-http", fetch: deps.fetch },
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
    });
    await mcp.connectToServer(OPENAIMP_MCP_SERVER_ID);
    await mcp.discoverIfConnected(OPENAIMP_MCP_SERVER_ID);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.audit("mesh_mcp.discovery_failed", {
      serverId: OPENAIMP_MCP_SERVER_ID,
      error: message,
    });
    console.error(`[mesh-mcp] openaimp MCP discovery failed: ${message}`);
    return { ready: false, toolCount: 0, reused: false, error: message };
  }

  const toolCount = Object.keys(
    mcp.getAITools({ serverId: OPENAIMP_MCP_SERVER_ID }),
  ).length;
  if (toolCount === 0) {
    const message = "openaimp MCP connection produced an empty catalog";
    deps.audit("mesh_mcp.discovery_failed", {
      serverId: OPENAIMP_MCP_SERVER_ID,
      error: message,
    });
    console.error(`[mesh-mcp] openaimp MCP discovery failed: ${message}`);
    return { ready: false, toolCount: 0, reused: false, error: message };
  }
  deps.audit("mesh_mcp.discovery_ready", {
    serverId: OPENAIMP_MCP_SERVER_ID,
    toolCount,
  });
  return { ready: true, toolCount, reused: false };
}

/**
 * The CHAT_NLQ_MODE gate (#2488) at the Think layer. The switch
 * itself is unchanged (src/config/chatNlqModes.ts — same resolver,
 * same fail-closed-to-off + audit on an invalid value); what
 * changed with the provided-path consumption is the mechanism:
 * the discovered set arrives through Think's auto-merge, and
 * TurnConfig.tools is additive-only (it cannot remove the merged
 * `tool_openaimp_execute_nlq`), so while the mode resolves "off"
 * the gate returns TurnConfig.activeTools = every merged tool
 * name EXCEPT the discovered NLQ key — the model cannot call a
 * tool outside activeTools. Mode "on", or a merged set that does
 * not (yet) contain the discovered NLQ tool, needs no restriction
 * and returns {}.
 */
export function chatNlqTurnGate(deps: {
  /** The merged turn tool set's keys (TurnContext.tools), post Think auto-merge. */
  toolNames: readonly string[];
  context: {
    env?: unknown;
    scopedChatNlqModes?: ChatNlqScopedModes;
  };
  audit: (type: string, payload: Record<string, unknown>) => void;
}): { activeTools?: string[] } {
  const resolved = resolveChatNlqTurnMode(deps.context);
  if (resolved.invalid) {
    deps.audit(chatNlqConfigErrorEvent(), {
      switch: "CHAT_NLQ_MODE",
      level: resolved.level,
      raw: resolved.raw ?? null,
      resolvedMode: resolved.mode,
    });
  }
  if (resolved.mode === "on") return {};
  if (!deps.toolNames.includes(OPENAIMP_NLQ_TOOL_KEY)) return {};
  return {
    activeTools: deps.toolNames.filter((name) => name !== OPENAIMP_NLQ_TOOL_KEY),
  };
}
