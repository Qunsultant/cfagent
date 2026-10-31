/**
 * GoF Adapter Pattern & GRASP Pure Fabrication: McpAgentToolAdapter
 *
 * Implements:
 * - GoF Adapter Pattern: Converts IMcpToolCommand protocol objects into Vercel AI SDK `tool()` instances.
 * - GRASP Pure Fabrication: Introduced to bridge two heterogeneous interfaces (AI SDK & Model Context Protocol)
 *   without polluting domain entities with AI SDK dependencies.
 * - GRASP Indirection: Mediates interaction between the AI Orchestrator and the MCP command subsystem.
 * - Protected Variations: Protects AI agents from underlying database or MCP JSON-RPC protocol changes.
 *
 * Issue #2496 (Mesh Improvement, programme #2494): the chat turn no
 * longer adapts the MCP catalog in-process here. The turn's catalog
 * tools are DISCOVERED at runtime from the platform's own MCP
 * server through the Agents SDK MCP client and merged into the
 * turn by Think itself (see src/agents/orchestrator/meshMcpClient.ts)
 * — the dogfooding guarantee this header used to claim for the
 * adapter is now carried by the protocol itself: the turn consumes
 * the exact MCP surface external clients (Claude Desktop, Cursor,
 * Antigravity) consume. What remains in this module:
 * - createAgentMcpTools: the turn's NATIVE tools (task drafting,
 *   the session-memory helpers, valuation comparison) that
 *   Think's getTools() contributes alongside the discovered set;
 * - McpAgentToolAdapter: retained as the direct command adapter —
 *   the mesh-door suites drive commands through it, and it keeps
 *   the #1744 gate + queue-stamp discipline for any in-process
 *   caller that adapts a command directly.
 */

import { tool } from "ai";
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { McpToolFactory } from "../mcps/openaimp/commands";
import { recordTraceHopBestEffort } from "../data/createMeshTracePorts";
import { childContextOfTraceparent } from "../observability/meshTrace";
import {
  authorizeMcpToolCall,
  createProductionMcpPermissionPort,
  executeWithPermissionGate,
} from "../mcps/openaimp/mcpPermissionPorts";

export class McpAgentToolAdapter {
  /**
   * Adapts an IMcpToolCommand into a Vercel AI SDK Tool
   */
  static adapt(command: IMcpToolCommand, context: McpToolContext) {
    return tool({
      description: command.description,
      inputSchema: command.zodSchema,
      execute: async (input: any) => {
        // #1744: agent-turn calls gate here — this path calls
        // command.execute directly and never passes through
        // McpToolFactory.executeTool, so an ungated adapter would
        // leave the model-driven path (the highest-risk caller
        // class) outside the permission model. Queued calls
        // authorize before queueing; the executor gates again at
        // execution time. Principal defaults to agent-turn: the
        // turn runs inside the owner's own agent instance, so the
        // instance boundary IS the identity boundary.
        const port = context.permissionPort ?? createProductionMcpPermissionPort();
        const principal = context.principal ?? { kind: "agent-turn" as const, login: null };
        const gateOpts = {
          sessionId: context.sessionId,
          audit: context.audit,
          decisionSink: context.permissionDecisionSink,
        };
        if (context.submitJob && command.name !== "get_async_job" && command.name !== "list_async_jobs") {
          await authorizeMcpToolCall(port, principal, command.name, gateOpts);
          // #2341 (Agent Mesh S5): stamp the turn's acting identity
          // into the job payload, resolved HERE — server-side, from
          // the turn context, never from the tool's arguments — so
          // the job executor can thread it into the execution
          // context's actingLogin carrier. Absent identity stamps
          // nothing: identity-gated tools then fail closed at
          // execution, exactly as an unidentified direct call does.
          const actingLogin = context.actingLogin?.();
          // #2428 (Agent Mesh S17): stamp the turn's traceparent
          // into the job payload under the same server-side-only
          // discipline as the acting identity — resolved HERE,
          // from the turn context, never from tool arguments — so
          // the job executor re-supplies it to the execution
          // context and the run stays on the turn's trace. Absent
          // trace stamps nothing.
          const traceparent = context.traceparent?.();
          const submitted = await context.submitJob({
            capability: "mcp.tool",
            payload: {
              toolName: command.name,
              arguments: input,
              ...(typeof actingLogin === "string" && actingLogin.trim()
                ? { actingLogin }
                : {}),
              ...(typeof traceparent === "string" && traceparent
                ? { traceparent }
                : {}),
            },
          });
          const traceChild = childContextOfTraceparent(traceparent);
          if (traceChild) {
            void recordTraceHopBestEffort(context.env, {
              traceId: traceChild.traceId,
              spanId: traceChild.spanId,
              parentSpanId: traceChild.parentSpanId,
              kind: "job-queue",
              operation: command.name,
              timestampMs: Date.now(),
              caller: typeof actingLogin === "string" ? actingLogin : undefined,
              jobId: submitted.jobId,
            });
          }
          return submitted;
        }
        return executeWithPermissionGate({
          port,
          principal,
          toolName: command.name,
          ...gateOpts,
          run: (executionId) => command.execute(input, { ...context, executionId }),
        });
      },
    });
  }
}

/**
 * Creates the turn's NATIVE AI tools for the Multi-Agent
 * Orchestrator — the tools Think's getTools() contributes. The MCP
 * catalog is NOT adapted here anymore (#2496): catalog tools reach
 * the turn by runtime discovery through the Agents SDK MCP client
 * (Think auto-merges them under `tool_openaimp_<name>` keys), and
 * the CHAT_NLQ_MODE gate (#2488) now restricts that discovered set
 * at the Think layer — chatNlqTurnGate in
 * src/agents/orchestrator/meshMcpClient.ts, applied by
 * portBeforeTurn through TurnConfig.activeTools. The catalog
 * camelCase aliases that used to point at adapted commands
 * (searchKnowledge, queryPlatformKnowledge,
 * getPlatformCapabilities, draftPayment, confirmDraft) are retired
 * with the adapter path: the prompt steers to the discovered names
 * verbatim (src/agents/chatPrompt.ts).
 */
export function createAgentMcpTools(context: McpToolContext) {
  const tools: Record<string, any> = {};

  // 1. Task management tool for agent task proposals
  tools["createTaskDraft"] = tool({
    description: "Draft a task or reminder for the user or organization. Returns a structured task proposal for user confirmation.",
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe("Task title or summary"),
      dueDate: z.string().optional().describe("Optional target deadline or ISO date"),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium").describe("Urgency level"),
      assignee: z.string().optional().describe("Assignee name or role"),
    }),
    execute: async (input) => {
      if (context.submitJob) return context.submitJob({ capability: "task.draft", payload: input });
      const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        taskId,
        status: "draft",
        requiresConfirmation: true,
        ...input,
        message: "Task draft created. Awaiting human confirmation via 'confirm_payment_draft' or 'confirmDraft'.",
      };
      context.audit("task.drafted", "tasks", payload);
      return payload;
    },
  });

  // 2. Memory helper aliases mapping to manage_session_memory
  tools["rememberFact"] = tool({
    description: "Persist a key fact, user preference, or project context into durable SQLite memory for this session.",
    inputSchema: z.object({
      key: z.string().min(1).describe("Descriptive memory key"),
      value: z.string().min(1).describe("The information to store"),
    }),
    execute: async ({ key, value }) => {
      // #1744: same gate as adapt() — this helper calls the command
      // directly, so it must not bypass the permission model.
      const port = context.permissionPort ?? createProductionMcpPermissionPort();
      const principal = context.principal ?? { kind: "agent-turn" as const, login: null };
      if (context.submitJob) {
        await authorizeMcpToolCall(port, principal, "manage_session_memory", {
          sessionId: context.sessionId,
          audit: context.audit,
          decisionSink: context.permissionDecisionSink,
        });
        return context.submitJob({
          capability: "mcp.tool",
          payload: { toolName: "manage_session_memory", arguments: { action: "remember", key, value } },
        });
      }
      const command = McpToolFactory.getTool("manage_session_memory");
      if (!command) throw new Error("Memory command missing");
      return executeWithPermissionGate({
        port,
        principal,
        toolName: "manage_session_memory",
        sessionId: context.sessionId,
        audit: context.audit,
        decisionSink: context.permissionDecisionSink,
        run: (executionId) =>
          command.execute({ action: "remember", key, value }, { ...context, executionId }),
      });
    },
  });

  tools["recallFacts"] = tool({
    description: "Recall all stored memory facts and user preferences recorded during this session.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional keyword to filter stored memories"),
    }),
    execute: async () => {
      // #1744: same gate as adapt() — see rememberFact above.
      const port = context.permissionPort ?? createProductionMcpPermissionPort();
      const principal = context.principal ?? { kind: "agent-turn" as const, login: null };
      if (context.submitJob) {
        await authorizeMcpToolCall(port, principal, "manage_session_memory", {
          sessionId: context.sessionId,
          audit: context.audit,
          decisionSink: context.permissionDecisionSink,
        });
        return context.submitJob({
          capability: "mcp.tool",
          payload: { toolName: "manage_session_memory", arguments: { action: "list" } },
        });
      }
      const command = McpToolFactory.getTool("manage_session_memory");
      if (!command) throw new Error("Memory command missing");
      return executeWithPermissionGate({
        port,
        principal,
        toolName: "manage_session_memory",
        sessionId: context.sessionId,
        audit: context.audit,
        decisionSink: context.permissionDecisionSink,
        run: (executionId) => command.execute({ action: "list" }, { ...context, executionId }),
      });
    },
  });

  // 3. Multi-Stock Valuation Comparison Tool
  tools["compare_stock_valuations"] = tool({
    description: "Compare valuation metrics, P/E ratios, market caps, margins, and performance across peer stock tickers (e.g. NVDA, AMD, INTC).",
    inputSchema: z.object({
      symbols: z.array(z.string()).min(1).max(6).describe("List of stock tickers to compare (e.g. ['NVDA', 'AMD', 'INTC'])"),
    }),
    execute: async ({ symbols }) => {
      const { MarketDataResearchService } = await import("../services/marketDataResearch");
      const service = new MarketDataResearchService(context.env);
      const comparison = await service.compareStocks(symbols);
      context.audit("market_data.compare_valuations", "research", { symbols, count: comparison.length });
      return { count: comparison.length, comparison };
    },
  });
  tools["compareValuations"] = tools["compare_stock_valuations"];
  tools["compareStocks"] = tools["compare_stock_valuations"];

  return tools;
}
