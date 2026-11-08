/**
 * Issue #3491 / #3779 — Per-agent Workspace Filesystem (Capability S7).
 *
 * Implements a persistent, isolated filesystem workspace backed by DO SQLite
 * storage (or Think `this.workspace`). Provides standard filesystem primitives:
 * writeFile, readFile, exists, readdir, deleteFile, stat, listFiles.
 *
 * Security & Isolation invariants:
 * - Paths are normalized to start with '/' and directory traversal ('..') is rejected.
 * - Files are isolated per agent instance / tenant storage.
 * - Filesystem operations do not cross out-of-sandbox boundaries.
 */

export interface AgentWorkspaceFile {
  path: string;
  content: string;
  size: number;
  updatedAt: string;
}

export interface AgentWorkspaceStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
}

export interface AgentWorkspace {
  writeFile(path: string, content: string): Promise<AgentWorkspaceFile>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  readdir(dirPath?: string): Promise<string[]>;
  deleteFile(path: string): Promise<boolean>;
  stat(path: string): Promise<AgentWorkspaceFile | null>;
  listFiles(dirPath?: string): Promise<AgentWorkspaceFile[]>;
}

const STORAGE_PREFIX = "ws:file:";

export function normalizeWorkspacePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("Workspace path must be a non-empty string.");
  }
  let p = rawPath.trim().replace(/\\/g, "/");
  if (!p.startsWith("/")) {
    p = "/" + p;
  }
  // Defuse directory traversal
  const segments = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (resolved.length > 0) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(seg);
  }
  return "/" + resolved.join("/");
}

export class InMemoryWorkspaceStorage implements AgentWorkspaceStorageLike {
  private files = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.files.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.files.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.files.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<Map<string, unknown>> {
    const res = new Map<string, unknown>();
    const prefix = options?.prefix || "";
    for (const [k, v] of this.files.entries()) {
      if (k.startsWith(prefix)) {
        res.set(k, v);
      }
    }
    return res;
  }
}

export class DOAgentWorkspace implements AgentWorkspace {
  constructor(private storage: AgentWorkspaceStorageLike = new InMemoryWorkspaceStorage()) {}

  async writeFile(rawPath: string, content: string): Promise<AgentWorkspaceFile> {
    const path = normalizeWorkspacePath(rawPath);
    const file: AgentWorkspaceFile = {
      path,
      content,
      size: new TextEncoder().encode(content).length,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put(`${STORAGE_PREFIX}${path}`, file);
    return file;
  }

  async readFile(rawPath: string): Promise<string> {
    const path = normalizeWorkspacePath(rawPath);
    const file = await this.storage.get<AgentWorkspaceFile>(`${STORAGE_PREFIX}${path}`);
    if (!file) {
      throw new Error(`File not found in workspace: ${path}`);
    }
    return file.content;
  }

  async exists(rawPath: string): Promise<boolean> {
    const path = normalizeWorkspacePath(rawPath);
    const file = await this.storage.get<AgentWorkspaceFile>(`${STORAGE_PREFIX}${path}`);
    return Boolean(file);
  }

  async stat(rawPath: string): Promise<AgentWorkspaceFile | null> {
    const path = normalizeWorkspacePath(rawPath);
    const file = await this.storage.get<AgentWorkspaceFile>(`${STORAGE_PREFIX}${path}`);
    return file ?? null;
  }

  async deleteFile(rawPath: string): Promise<boolean> {
    const path = normalizeWorkspacePath(rawPath);
    return this.storage.delete(`${STORAGE_PREFIX}${path}`);
  }

  async listFiles(dirPath?: string): Promise<AgentWorkspaceFile[]> {
    const prefix = dirPath ? `${STORAGE_PREFIX}${normalizeWorkspacePath(dirPath)}` : STORAGE_PREFIX;
    const entries = await this.storage.list({ prefix });
    const files: AgentWorkspaceFile[] = [];
    for (const val of entries.values()) {
      if (val && typeof val === "object" && "path" in val && "content" in val) {
        files.push(val as AgentWorkspaceFile);
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readdir(dirPath: string = "/"): Promise<string[]> {
    const normalizedDir = normalizeWorkspacePath(dirPath);
    const allFiles = await this.listFiles(normalizedDir);
    const names = new Set<string>();

    for (const f of allFiles) {
      if (f.path === normalizedDir) continue;
      if (normalizedDir === "/" || f.path.startsWith(normalizedDir + "/")) {
        const sub = normalizedDir === "/" ? f.path.slice(1) : f.path.slice(normalizedDir.length + 1);
        const firstSegment = sub.split("/")[0];
        if (firstSegment) {
          names.add(firstSegment);
        }
      }
    }
    return Array.from(names).sort();
  }
}

export function createAgentWorkspace(storage?: AgentWorkspaceStorageLike): AgentWorkspace {
  return new DOAgentWorkspace(storage || new InMemoryWorkspaceStorage());
}

