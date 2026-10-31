/**
 * Issue #2496 — self-registration proof in miniature (programme
 * rule 2 acceptance): a command added to McpToolFactory appears in
 * the chat turn's discovered tool set with NO change to turn code.
 *
 * The only "change" this test makes is a factory registration —
 * the same act as adding a command to the static registration
 * block in src/mcps/openaimp/commands.ts. Everything else is the
 * production composition: SDK MCPClientManager discovery over the
 * production loopback carrier into the real /mcp route, and the
 * turn's merged set composed the way Think composes it
 * (getTools() native set + the manager's discovered set).
 *
 * Module-load order mirrors production: the factory module is
 * loaded and the registration happens BEFORE the server module
 * (src/mcps/openaimp/index.ts, whose MCP_TOOLS catalog snapshot is
 * taken at load) is imported — exactly how a deploy-time
 * registration lands in the catalog. Hence the dynamic imports:
 * static imports would evaluate the whole graph before the
 * registration could happen. This file intentionally shares no
 * harness with the main #2496 suite.
 */
import { describe, expect, it } from "vitest";
import { MCPClientManager } from "agents/mcp/client";
import { z } from "zod";
import { MockSqlStorage } from "./mock-sql";
import type { AsyncJobSubmission, Env } from "../src/types";

const PROBE_TOOL = "mesh_probe_ping_2496";
const PROBE_KEY = `tool_openaimp_${PROBE_TOOL}`;

describe("issue #2496 — self-registration: a new factory command reaches the turn unaided", () => {
  it("registering a command in McpToolFactory is sufficient — no turn-code change", async () => {
    // 1. Load the factory FIRST and register a brand-new command.
    const { McpToolFactory } = await import("../src/mcps/openaimp/commands");
    McpToolFactory.registerTool(
      {
        name: PROBE_TOOL,
        description: "Self-registration probe command (issue #2496 test fixture).",
        jsonSchema: {
          type: "object",
          properties: { note: { type: "string" } },
          additionalProperties: false,
        },
        zodSchema: z.object({ note: z.string().optional() }),
        execute: async () => ({ ok: true, probe: PROBE_TOOL }),
      } as never,
      // Registration declares the tool's permission scope, as a
      // real command's registration does (statically via
      // MCP_TOOL_SCOPES, or here via the registerTool scope arg).
      "mcp:read",
    );
    expect(McpToolFactory.getTool(PROBE_TOOL)).toBeDefined();

    // 2. Only now load the server + route + discovery + turn
    //    assembly (the server's catalog snapshot now includes the
    //    probe command, as a deploy-time registration would).
    const { handleMcpChatNlqRoutes } = await import("../src/agents/routes/mcpChatNlq");
    const { createOpenaimpMcpFetch, ensureOpenaimpMcpConnection } = await import(
      "../src/agents/orchestrator/meshMcpClient"
    );
    const { createTurnTools } = await import("../src/agents/orchestrator/chatTurnHelpers");

    // 3. The production composition (binding-seam fakes only: DO
    //    storage for the manager; the route's job queue capture).
    const sql = new MockSqlStorage();
    const kv = new Map<string, unknown>();
    const manager = new MCPClientManager("OrchestratorAgent", "0.0.1", { env: {} as Env });
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

    const submitted: AsyncJobSubmission[] = [];
    const routeCtx = {
      getOrm: () => ({}) as never,
      getStorageSql: () => sql,
      getStorage: () => ({ sql }) as never,
      env: {} as Env,
      audit: () => {},
      submitAsyncJob: async (job: AsyncJobSubmission) => {
        submitted.push(job);
        return { jobId: "job-probe-1", status: "queued" as const, statusUrl: "/api/jobs/job-probe-1" };
      },
      getAsyncJob: () => undefined,
      listAsyncJobs: () => [],
      extractMessageText: () => "",
      getMessages: async () => [],
      recordMessage: () => {},
      runAgenticChatTurn: async () => {
        throw new Error("not used by the /mcp drive");
      },
      buildChatErrorFallback: async () => "",
      nlqSchedulingPort: () => ({}) as never,
    };

    const loopbackFetch = createOpenaimpMcpFetch({
      dispatch: async (request) => {
        const url = new URL(request.url);
        const response = await handleMcpChatNlqRoutes(request, url, url.pathname, "session-probe", routeCtx as never);
        if (!response) throw new Error("route did not handle the request");
        return response;
      },
      resolveActingLogin: () => "alice",
      resolveTraceparent: () => undefined,
    });

    const ensured = await ensureOpenaimpMcpConnection({
      mcp: manager,
      fetch: loopbackFetch,
      audit: () => {},
    });
    expect(ensured.ready).toBe(true);

    // 4. The probe is in the DISCOVERED set under its namespaced
    //    key — and NOT in the native set: discovery is the only
    //    path by which it can reach the turn.
    const discovered = manager.getAITools() as Record<string, unknown>;
    expect(discovered[PROBE_KEY]).toBeDefined();
    const native = createTurnTools(
      {
        env: {} as Env,
        ensureTables: () => sql as never,
        getOrm: () => ({}) as never,
        storage: { sql } as never,
        sessionKey: () => "session-probe",
        turnUserLogin: () => "alice",
        turnTraceparent: () => undefined,
        audit: () => {},
        submitAsyncJob: async () => {
          throw new Error("native turn tools do not queue in this drive");
        },
        getAsyncJob: () => undefined,
        listAsyncJobs: () => [],
        getMessages: async () => [],
        activeTurnMetadata: null,
      },
      "req-probe",
    ) as Record<string, unknown>;
    expect(native[PROBE_TOOL]).toBeUndefined();
    expect(native[PROBE_KEY]).toBeUndefined();

    // Think's merge (native spread first, discovered second) puts
    // the probe in the turn's usable set, unchanged turn code.
    const tools = { ...native, ...discovered } as Record<
      string,
      { execute: (input: never, opts: never) => Promise<unknown> }
    >;
    expect(tools[PROBE_KEY]).toBeDefined();

    // 5. And it executes through the discovered path: queued by
    //    the handler with the acting identity stamped server-side.
    const result = (await tools[PROBE_KEY].execute(
      { note: "hello" } as never,
      { toolCallId: "call-probe-1", messages: [] } as never,
    )) as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const receipt = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    expect(receipt).toMatchObject({ jobId: "job-probe-1", status: "queued" });
    expect(submitted).toHaveLength(1);
    const payload = submitted[0].payload as Record<string, unknown>;
    expect(payload.toolName).toBe(PROBE_TOOL);
    expect(payload.actingLogin).toBe("alice");
  });
});
