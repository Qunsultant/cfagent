/**
 * Issue #359-06: memory + reset routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Persistent Memory facts endpoint (GET /memory, POST /memory, DELETE /memory)
 * and the session reset endpoint (POST|DELETE|GET /clear or /reset). The two
 * blocks were contiguous in routeRequest (between the autopilot handler and
 * the referrals+ads handler), so this module exports ONE handler invoked from
 * routeRequest at the EXACT position the original blocks occupied in the
 * sequential path.endsWith matching sequence. It returns a Response when one
 * of its paths matches, or null when none does — matching order relative to
 * all other handlers is preserved by the call site.
 *
 * The reset endpoints are destructive and their guards/confirmations are
 * preserved byte-for-byte in behavior: the ?purge=false opt-out, the
 * abortAllRequests reason string, and the audit event names
 * (memory.deleted / memory.cleared / history.purged / history.cleared).
 * Session-state teardown stays delegated to the orchestrator via the
 * context — this module never touches OrchestratorAgent internals.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit MemoryResetRouteContext parameter; there are no new globals
 * and no back-references into the class.
 */

import type { AgentName } from "../../types";
import { DatabaseORM, type SqlStorage } from "../../orm";
import type { MemoryRecord } from "../../types";
import { runRestTool } from "./restToolBridge";
import {
  MEMORY_READ_MODE_SWITCH,
  applyMemoryReadCap,
  levelsForMemory,
  memoryConfigErrorEvent,
  resolveMemoryReadMode,
  type MemoryScopedModes,
} from "../../config/knowledgeMemoryModes";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/memoryReset",
});

/** The subset of OrchestratorAgent surface the memory/reset handlers need. */
export interface MemoryResetRouteContext {
  ensureTables(): SqlStorage;
  /**
   * #1723: Worker env for the MEMORY_READ_MODE env level on GET
   * /memory (optional — unset falls through to the builtin "capped").
   * Populated by the orchestrator call site.
   */
  env?: { MEMORY_READ_MODE?: unknown };
  /**
   * #1723: optional session/user carriers for MEMORY_READ_MODE on GET
   * /memory (run = the `?mode=` query param). Populated by the
   * execution-context owner; unset carriers fall through to env.
   */
  scopedMemoryModes?: MemoryScopedModes;
  /**
   * #1644: ORM accessor for command execution. Optional — routes without
   * it build a DatabaseORM over ensureTables() (same tables, no seeding).
   */
  getOrm?: () => DatabaseORM;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Aborts all in-flight requests with the given reason (owner: OrchestratorAgent). */
  abortAllRequests(reason: string): void;
  /** Resets per-turn state (owner: OrchestratorAgent). */
  resetTurnState(): void;
  /**
   * Clears the in-memory chat transcript and persists the empty state
   * (owner: OrchestratorAgent — was `this.messages = []; await this.persistMessages([])`).
   */
  clearConversationMessages(): Promise<void>;
}

/**
 * Handles the memory + reset routes. Returns a Response on match, null when
 * no memory/reset path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleMemoryResetRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MemoryResetRouteContext
): Promise<Response | null> {
  // Persistent Memory facts endpoint
  // #1644: memory reads/writes execute through the manage_session_memory
  // command. The route keeps its contract as presentation: the read cap
  // and row mapping on GET, and its memory.deleted / memory.cleared audits
  // plus {success:true} shapes on DELETE.
  // #1723: GET resolves MEMORY_READ_MODE at the route (run = `?mode=`
  // query param > session/user carriers > env > builtin "capped",
  // the REST legacy). Invalid wins fail closed to "capped", logged +
  // audited as memory.config_error. The command's own resolution
  // applies on the MCP surface; the route deliberately does NOT
  // forward its carriers into the command call, so an invalid value
  // is audited exactly once, here.
  if (path.endsWith("/memory")) {
    const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
    const toolParts = {
      orm,
      sessionId,
      audit: (type: string, agent: unknown, payload: Record<string, unknown>) =>
        ctx.audit(type, agent as AgentName, payload),
    };
    if (request.method === "GET") {
      try {
        const out = (await runRestTool("manage_session_memory", { action: "list" }, toolParts)) as {
          memories: Array<{ key: string; value: string; updatedAt: string }>;
        };
        const resolved = resolveMemoryReadMode(
          levelsForMemory(
            ctx.scopedMemoryModes,
            url.searchParams.get("mode") ?? undefined,
            ctx.env?.MEMORY_READ_MODE
          ),
          "capped"
        );
        if (resolved.invalid) {
          structuredLog.error("memoryReset.memory_read_mode_config_invalid", {
            message: `[memory] invalid ${MEMORY_READ_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "capped"`,
            setting: MEMORY_READ_MODE_SWITCH,
            value: resolved.raw ?? "",
            resolved: "capped",
          });
          ctx.audit(memoryConfigErrorEvent(), "orchestrator", {
            setting: MEMORY_READ_MODE_SWITCH,
            value: resolved.raw ?? "",
            resolved: "capped",
          });
        }
        const memories: MemoryRecord[] = applyMemoryReadCap(out.memories, resolved.mode).map((m) => ({
          key: String(m.key),
          value: String(m.value),
          updatedAt: String(m.updatedAt),
        }));
        return Response.json({ count: memories.length, memories });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch memories" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const key = url.searchParams.get("key");
        if (key) {
          await runRestTool("manage_session_memory", { action: "delete", key }, toolParts);
          ctx.audit("memory.deleted", "memory", { key });
        } else {
          await runRestTool("manage_session_memory", { action: "clear" }, toolParts);
          ctx.audit("memory.cleared", "memory", {});
        }
        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete memory" }, { status: 500 });
      }
    }

    // #1723: POST /memory closes the M09 gap — REST could list and
    // delete facts it could not create. This is transport + envelope
    // ONLY: it reuses the same manage_session_memory command (same
    // mas_memory store, same upsert-by-key, same non-empty key+value
    // validation) and adds NO new store or engine. The MCP write path
    // is NOT removed. Validation failures map to 400 (transport
    // error-status mapping, as the route owns); the command already
    // audits memory.remembered, so — unlike DELETE, whose audits the
    // command does not emit — the route adds no second audit.
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
      }
      const key = typeof (body as { key?: unknown })?.key === "string"
        ? ((body as { key: string }).key.trim())
        : "";
      const value = typeof (body as { value?: unknown })?.value === "string"
        ? ((body as { value: string }).value.trim())
        : "";
      if (!key || !value) {
        return Response.json({ error: "key and value are required to remember fact" }, { status: 400 });
      }
      try {
        const out = (await runRestTool("manage_session_memory", { action: "remember", key, value }, toolParts)) as {
          success: boolean;
          stored: boolean;
          key: string;
          value: string;
          memory: { updatedAt: string };
        };
        return Response.json({
          success: true,
          stored: out.stored,
          key: out.key,
          value: out.value,
          updatedAt: out.memory?.updatedAt,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to remember fact" }, { status: 500 });
      }
    }
  }

  // Clear active conversation transcript and reset session state
  if ((path.endsWith("/clear") || path.endsWith("/reset")) && (request.method === "POST" || request.method === "DELETE" || request.method === "GET")) {
    try {
      ctx.ensureTables();
      ctx.abortAllRequests("Session reset requested by user");
      ctx.resetTurnState();
      await ctx.clearConversationMessages();
      const purge = url.searchParams.get("purge") !== "false";
      if (purge) {
        // #2345: the purge is the message port's session delete
        // now — the raw DELETE that used to run here is retired.
        const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
        orm.messages.deleteBySessionId(sessionId);
        ctx.audit("history.purged", "orchestrator", {});
      } else {
        ctx.audit("history.cleared", "orchestrator", {});
      }
      return Response.json({
        success: true,
        message: purge ? "All chat transcripts and session state purged from SQLite" : "Active chat cleared; historical analytics vault preserved in SQLite",
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to clear history" }, { status: 500 });
    }
  }

  return null;
}
