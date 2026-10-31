/**
 * Issue #2496 — shared test harness for suites that need the
 * turn's DISCOVERED catalog tool set: a real SDK MCPClientManager
 * (agents 0.32.0) wired through the production loopback identity
 * carrier (createOpenaimpMcpFetch) and the production ensure step
 * (ensureOpenaimpMcpConnection). Callers supply only the dispatch
 * target — the real /mcp route handler, or handleMCPRequest
 * directly — so no suite builds the catalog tool set by hand.
 *
 * The one fake is a binding seam: the Lifecycle services' DO
 * storage binding (MockSqlStorage + an in-memory KV), which the
 * Agent installs via Lifecycle.use() in production. The manager
 * reads only `lifecycle.storage`.
 */
import { MCPClientManager } from "agents/mcp/client";
import { MockSqlStorage } from "./mock-sql";
import {
  createOpenaimpMcpFetch,
  ensureOpenaimpMcpConnection,
  type EnsureOpenaimpMcpResult,
} from "../src/agents/orchestrator/meshMcpClient";
import type { Env } from "../src/types";

export interface DiscoveredPlatformTools {
  manager: MCPClientManager;
  ensure: () => Promise<EnsureOpenaimpMcpResult>;
  /** The manager's discovered AI tool set (namespaced keys). */
  aiTools: () => Record<string, unknown>;
}

export function makeDiscoveredPlatformTools(opts: {
  dispatch: (request: Request) => Promise<Response>;
  resolveActingLogin?: () => string | undefined;
  resolveTraceparent?: () => string | undefined;
  sql?: MockSqlStorage;
}): DiscoveredPlatformTools {
  const sql = opts.sql ?? new MockSqlStorage();
  const kv = new Map<string, unknown>();
  const manager = new MCPClientManager("OrchestratorAgent", "0.0.1", {
    env: {} as Env,
  });
  Object.defineProperty(manager, "lifecycle", {
    value: {
      storage: {
        sql,
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => kv.delete(key),
        list: async () => new Map(kv),
      },
    },
  });
  const fetch = createOpenaimpMcpFetch({
    dispatch: opts.dispatch,
    resolveActingLogin: opts.resolveActingLogin ?? (() => undefined),
    resolveTraceparent: opts.resolveTraceparent ?? (() => undefined),
  });
  return {
    manager,
    ensure: () => ensureOpenaimpMcpConnection({ mcp: manager, fetch, audit: () => {} }),
    aiTools: () => manager.getAITools() as Record<string, unknown>,
  };
}

/**
 * A dispatch target backed by the real openaimp MCP handler
 * (handleMCPRequest) with a minimal static context — sufficient
 * for tools/list discovery. Suites that execute tools use the
 * real /mcp route handler as their dispatch instead.
 */
export function handlerDispatch(): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    // Import via the handler module, not the package index: the
    // index <-> handler cycle resolves handleMCPRequest to
    // undefined when the graph is entered through the index first
    // (observed in suites whose first mesh import is this kit).
    const { handleMCPRequest } = await import("../src/mcps/openaimp/handler");
    const body = (await request.json().catch(() => ({}))) as never;
    const result = await handleMCPRequest(body, {
      env: {} as Env,
      orm: {} as never,
      sessionId: "testkit",
      principal: { kind: "system", login: null },
      audit: () => {},
    });
    return Response.json(result);
  };
}
