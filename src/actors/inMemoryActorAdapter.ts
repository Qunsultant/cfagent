/**
 * Issue #1738 — the in-memory adapter for the actor port.
 *
 * The second adapter proving portability, and the test harness that
 * replaces tests/stubs/cloudflareThink.ts: the turn runner is the
 * SAME AgentChatTurnRunner production uses, with the model turn
 * stubbed to a fixed assistant reply (the provider boundary is
 * stubbed, the lifecycle is not — same contract the old stub kept).
 * State, schedule, and session are Map/array-backed. Schedule rows
 * are recorded, never fired: the conformance suite asserts the
 * schedule surface, not the SDK's alarm delivery.
 */
import { AgentChatTurnRunner } from "./actorTurnRunner";
import { ActorSessionStore, createMapSessionBackend } from "./actorSessionStore";
import type {
  ActorSchedulePort,
  ActorSessionPort,
  ActorStatePort,
  ActorTurnHooks,
  ActorTurnPort,
  ActorWorkspaceFileEntry,
  ActorWorkspacePort,
} from "./actorPorts";
import {
  THINK_WORKSPACE_ROOT,
  resolveThinkWorkspacePath,
  thinkWorkspaceFileName,
  thinkWorkspaceUrls,
} from "./thinkPortMapping";

export const STUB_ASSISTANT_REPLY = "Stub assistant reply.";

export function createInMemoryActorState(): ActorStatePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T = unknown>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    sql: () => {
      throw new Error("in-memory actor state has no SQL; use the Cf adapter or a SQL stub.");
    },
  };
}

interface ScheduleRow {
  id: string;
  callback: string;
  payload?: unknown;
  when?: unknown;
  intervalSeconds?: number;
}

export function createInMemoryActorSchedule(): ActorSchedulePort & { rows: ScheduleRow[] } {
  const rows: ScheduleRow[] = [];
  let seq = 0;
  return {
    rows,
    schedule: async (when, callback, payload, options) => {
      const row: ScheduleRow = {
        id: `stub-schedule-${++seq}`,
        callback,
        payload,
        when,
      };
      void options;
      rows.push(row);
      return { id: row.id, when, callback, payload, options };
    },
    scheduleEvery: async (intervalSeconds, callback, payload) => {
      const row: ScheduleRow = { id: `stub-schedule-${++seq}`, callback, payload, intervalSeconds };
      rows.push(row);
      return { id: row.id, intervalSeconds, callback, payload };
    },
    listSchedules: async () => [...rows],
    cancelSchedule: async (id) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
    getScheduleById: async (id) => rows.find((r) => r.id === id),
  };
}

export function createInMemoryActorSession(): ActorSessionPort {
  return new ActorSessionStore(createMapSessionBackend());
}

/** Map-backed per-agent workspace port for tests (#3491 / #3896). */
export function createInMemoryActorWorkspace(): ActorWorkspacePort {
  const files = new Map<string, { path: string; content: string; size: number; updatedAt: string; scopeId: string }>();
  return {
    readFile: async (rawPath: string, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(rawPath);
      if (!resolved.ok) return null;
      const entry = files.get(`${scopeId}::${resolved.path}`);
      if (!entry) return null;
      return { content: entry.content, updatedAt: entry.updatedAt };
    },
    writeFile: async (rawPath: string, content: string, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(rawPath);
      if (!resolved.ok) throw new Error(resolved.error);
      const updatedAt = new Date().toISOString();
      const size = new TextEncoder().encode(content).byteLength;
      files.set(`${scopeId}::${resolved.path}`, {
        path: resolved.path,
        content,
        size,
        updatedAt,
        scopeId,
      });
      return {
        path: resolved.path,
        size,
        updatedAt,
        ...thinkWorkspaceUrls(resolved.path),
      };
    },
    deleteFile: async (rawPath: string, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(rawPath);
      if (!resolved.ok) return false;
      return files.delete(`${scopeId}::${resolved.path}`);
    },
    listFiles: async (dir = THINK_WORKSPACE_ROOT, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(dir);
      const prefix = resolved.ok ? resolved.path : THINK_WORKSPACE_ROOT;
      const out: ActorWorkspaceFileEntry[] = [];
      for (const entry of files.values()) {
        if (entry.scopeId !== scopeId) continue;
        if (prefix !== THINK_WORKSPACE_ROOT && !entry.path.startsWith(prefix)) continue;
        out.push({
          name: thinkWorkspaceFileName(entry.path),
          path: entry.path,
          type: "file",
          size: entry.size,
          updatedAt: entry.updatedAt,
          ...thinkWorkspaceUrls(entry.path),
        });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

/** Test turn runner: production lifecycle, stubbed provider reply. */
export function createInMemoryActorTurn(
  hooks: ActorTurnHooks,
  session: ActorSessionPort
): ActorTurnPort {
  return new AgentChatTurnRunner({
    hooks,
    session,
    modelTurn: async () => ({ text: STUB_ASSISTANT_REPLY }),
  });
}
