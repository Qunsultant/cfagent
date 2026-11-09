/**
 * Issue #1738 — the Cloudflare Agents SDK adapter for the actor port.
 *
 * Binds each facet to the live Agents SDK runtime: the actor's own
 * DO storage (ctx.storage), the SDK scheduler (schedule-by-method-
 * name), and the SDK workflow doors (runWorkflow/sendWorkflowEvent
 * live on Agent — verified against agents 0.24.0 types, not assumed
 * from Think). No new addressing scheme is introduced: DO instances
 * are still addressed by idFromName/idFromString + get through the
 * existing bindings, and routeAgentRequest stays the framework seam
 * (Adapter S5 owns dispatch centralization; this adapter does not
 * duplicate it).
 */
import { AgentChatTurnRunner, generateTextModelTurn, type ModelTurnFn } from "./actorTurnRunner";
import { ActorSessionStore, type SessionStorageBackend } from "./actorSessionStore";
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
import {
  deleteWorkspaceSqlFile,
  listWorkspaceSqlFiles,
  readWorkspaceSqlFile,
  writeWorkspaceSqlFile,
} from "../data/doSqliteWorkspaceStoreAdapter";

/** DO ctx.storage satisfies this; the cast keeps the port free of SDK types. */
export function createCfActorSession(storage: SessionStorageBackend): ActorSessionPort {
  return new ActorSessionStore(storage);
}

export function createCfActorState(storage: {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  sql: { exec(sql: string, ...params: unknown[]): Iterable<unknown> };
}): ActorStatePort {
  return {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      (await storage.get(key)) as T | undefined,
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    sql: (sql, ...params) => storage.sql.exec(sql, ...params),
  };
}

/** Any object exposing the SDK scheduler surface (a real Agent qualifies). */
export interface SchedulerLike {
  schedule(when: unknown, callback: string, payload?: unknown, options?: unknown): Promise<unknown>;
  scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<unknown>;
  listSchedules(): Promise<unknown[]>;
  cancelSchedule(id: string): Promise<boolean>;
  getScheduleById?(id: string): Promise<unknown | undefined>;
}

export function createCfActorSchedule(agent: SchedulerLike): ActorSchedulePort {
  return {
    schedule: (when, callback, payload, options) => agent.schedule(when, callback, payload, options),
    scheduleEvery: (intervalSeconds, callback, payload) => agent.scheduleEvery(intervalSeconds, callback, payload),
    listSchedules: () => agent.listSchedules(),
    cancelSchedule: (id) => agent.cancelSchedule(id),
    getScheduleById: agent.getScheduleById
      ? (id) => agent.getScheduleById!(id)
      : undefined,
  };
}

/** Production turn runner: the agent's own hooks + generateText model turn. */
export function createCfActorTurn(
  hooks: ActorTurnHooks,
  session: ActorSessionPort,
  modelTurn: ModelTurnFn = generateTextModelTurn
): ActorTurnPort {
  return new AgentChatTurnRunner({ hooks, session, modelTurn });
}

export interface WorkspaceHostEntryLike {
  name: string;
  type: string;
  size: number;
  path: string;
}

export interface WorkspaceHostLike {
  readFile?: (path: string) => Promise<string | null>;
  writeFile?: (path: string, content: string) => Promise<void>;
  deleteFile?: (path: string) => Promise<boolean>;
  listFiles?: (dir: string) => Promise<WorkspaceHostEntryLike[]>;
}

async function listHostWorkspaceRecursive(
  host: WorkspaceHostLike | undefined,
  dir: string,
  depth = 0,
  visited = new Set<string>()
): Promise<ActorWorkspaceFileEntry[]> {
  if (!host?.listFiles || depth > 4) return [];
  const resolved = resolveThinkWorkspacePath(dir);
  if (!resolved.ok) return [];
  const targetDir = resolved.path;
  if (visited.has(targetDir)) return [];
  visited.add(targetDir);

  let entries: WorkspaceHostEntryLike[] = [];
  try {
    entries = (await host.listFiles(targetDir)) ?? [];
  } catch {
    entries = [];
  }
  if (entries.length === 0 && targetDir === THINK_WORKSPACE_ROOT) {
    try {
      entries = (await host.listFiles("/")) ?? [];
    } catch {
      entries = [];
    }
  }

  const out: ActorWorkspaceFileEntry[] = [];
  for (const entry of entries) {
    const rawEntryPath = entry.path || `${targetDir === "/" ? "" : targetDir}/${entry.name}`;
    const entryResolved = resolveThinkWorkspacePath(rawEntryPath);
    const canonicalEntryPath = entryResolved.ok ? entryResolved.path : rawEntryPath;
    const isDir = entry.type === "directory" || entry.type === "dir";
    if (isDir) {
      const children = await listHostWorkspaceRecursive(host, canonicalEntryPath, depth + 1, visited);
      out.push(...children);
    } else {
      out.push({
        name: entry.name || thinkWorkspaceFileName(canonicalEntryPath),
        path: canonicalEntryPath,
        type: "file",
        size: typeof entry.size === "number" ? entry.size : 0,
        ...thinkWorkspaceUrls(canonicalEntryPath),
      });
    }
  }
  return out;
}

/**
 * Durable Object + Think workspace adapter (#3491 / #3896).
 * Reads/writes both Think's built-in workspace host (`_hostReadFile`,
 * `_hostWriteFile`, `_hostDeleteFile`, `_hostListFiles`) and the DO's
 * SQLite table (`mas_agent_workspace_files`) + KV fallback.
 */
export function createCfActorWorkspace(
  storage?: {
    get?(key: string): Promise<unknown>;
    put?(key: string, value: unknown): Promise<void>;
    delete?(key: string): Promise<unknown>;
    sql?: { exec(sql: string, ...params: unknown[]): Iterable<unknown> };
  },
  hostWorkspace?: WorkspaceHostLike
): ActorWorkspacePort {
  const memoryFallback = new Map<string, { path: string; content: string; size: number; updatedAt: string; scopeId: string }>();

  return {
    readFile: async (rawPath: string, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(rawPath);
      if (!resolved.ok) return null;

      if (hostWorkspace?.readFile) {
        for (const candidate of resolved.candidates) {
          try {
            const read = await hostWorkspace.readFile(candidate);
            if (typeof read === "string") {
              return { content: read };
            }
          } catch {
            // Try next candidate
          }
        }
      }

      const sqlFound = readWorkspaceSqlFile(storage?.sql, scopeId, resolved.path);
      if (sqlFound) {
        return sqlFound;
      }

      const memEntry = memoryFallback.get(`${scopeId}::${resolved.path}`);
      if (memEntry) {
        return { content: memEntry.content, updatedAt: memEntry.updatedAt };
      }
      return null;
    },

    writeFile: async (rawPath: string, content: string, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(rawPath);
      if (!resolved.ok) throw new Error(resolved.error);
      const size = new TextEncoder().encode(content).byteLength;
      const updatedAt = new Date().toISOString();

      if (hostWorkspace?.writeFile) {
        try {
          await hostWorkspace.writeFile(resolved.path, content);
        } catch {
          // Best-effort Think workspace write
        }
      }

      writeWorkspaceSqlFile(storage?.sql, scopeId, resolved.path, content, size, updatedAt);

      memoryFallback.set(`${scopeId}::${resolved.path}`, {
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
      let deleted = false;

      if (hostWorkspace?.deleteFile) {
        for (const candidate of resolved.candidates) {
          try {
            const ok = await hostWorkspace.deleteFile(candidate);
            if (ok) deleted = true;
          } catch {
            // Best-effort host delete
          }
        }
      }

      if (deleteWorkspaceSqlFile(storage?.sql, scopeId, resolved.path)) {
        deleted = true;
      }

      if (memoryFallback.delete(`${scopeId}::${resolved.path}`)) {
        deleted = true;
      }

      return deleted;
    },

    listFiles: async (dir = THINK_WORKSPACE_ROOT, scopeId = "default") => {
      const resolved = resolveThinkWorkspacePath(dir);
      const targetDir = resolved.ok ? resolved.path : THINK_WORKSPACE_ROOT;
      const byPath = new Map<string, ActorWorkspaceFileEntry>();

      const hostFiles = await listHostWorkspaceRecursive(hostWorkspace, targetDir);
      for (const f of hostFiles) {
        byPath.set(f.path, f);
      }

      const rows = listWorkspaceSqlFiles(storage?.sql, scopeId);
      for (const row of rows) {
        if (targetDir !== THINK_WORKSPACE_ROOT && !row.path.startsWith(targetDir)) continue;
        byPath.set(row.path, {
          name: thinkWorkspaceFileName(row.path),
          path: row.path,
          type: "file",
          size: Number(row.size ?? 0),
          updatedAt: row.updated_at,
          ...thinkWorkspaceUrls(row.path),
        });
      }

      for (const entry of memoryFallback.values()) {
        if (entry.scopeId !== scopeId) continue;
        if (targetDir !== THINK_WORKSPACE_ROOT && !entry.path.startsWith(targetDir)) continue;
        if (!byPath.has(entry.path)) {
          byPath.set(entry.path, {
            name: thinkWorkspaceFileName(entry.path),
            path: entry.path,
            type: "file",
            size: entry.size,
            updatedAt: entry.updatedAt,
            ...thinkWorkspaceUrls(entry.path),
          });
        }
      }

      return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
