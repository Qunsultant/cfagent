/**
 * Issue #3491 / #3896 — DO SQLite adapter for per-agent workspace files (`mas_agent_workspace_files`).
 *
 * Lives in `src/data/` per ADR 0022 D-D.2 so `src/actors/cfAgentsAdapter.ts`
 * contains zero above-layer SQL `.exec(` calls beyond its single `ActorStatePort` shim.
 */

export interface WorkspaceSqlLike {
  exec(sql: string, ...params: unknown[]): Iterable<unknown>;
}

export interface WorkspaceSqlRow {
  path: string;
  content?: string;
  size: number;
  updated_at?: string;
}

export function ensureWorkspaceSqlSchema(sql?: WorkspaceSqlLike): void {
  if (!sql?.exec) return;
  try {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_agent_workspace_files (
        user_login TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_login, path)
      )
    `);
  } catch {
    // Best-effort table creation when sql is a minimal mock
  }
}

export function readWorkspaceSqlFile(
  sql: WorkspaceSqlLike | undefined,
  scopeId: string,
  canonicalPath: string
): { content: string; updatedAt?: string } | null {
  if (!sql?.exec) return null;
  ensureWorkspaceSqlSchema(sql);
  try {
    const rows = Array.from(
      sql.exec(
        `SELECT content, updated_at FROM mas_agent_workspace_files WHERE user_login = ? AND path = ? LIMIT 1`,
        scopeId,
        canonicalPath
      )
    ) as Array<{ content?: string; updated_at?: string }>;
    if (rows[0] && typeof rows[0].content === "string") {
      return { content: rows[0].content, updatedAt: rows[0].updated_at };
    }
  } catch {
    // Ignore when mock sql does not implement this table
  }
  return null;
}

export function writeWorkspaceSqlFile(
  sql: WorkspaceSqlLike | undefined,
  scopeId: string,
  canonicalPath: string,
  content: string,
  size: number,
  updatedAt: string
): void {
  if (!sql?.exec) return;
  ensureWorkspaceSqlSchema(sql);
  try {
    sql.exec(
      `INSERT INTO mas_agent_workspace_files (user_login, path, content, size, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_login, path) DO UPDATE SET
         content = excluded.content,
         size = excluded.size,
         updated_at = excluded.updated_at`,
      scopeId,
      canonicalPath,
      content,
      size,
      updatedAt
    );
  } catch {
    // Best-effort SQLite write
  }
}

export function deleteWorkspaceSqlFile(
  sql: WorkspaceSqlLike | undefined,
  scopeId: string,
  canonicalPath: string
): boolean {
  if (!sql?.exec) return false;
  ensureWorkspaceSqlSchema(sql);
  try {
    sql.exec(
      `DELETE FROM mas_agent_workspace_files WHERE user_login = ? AND path = ?`,
      scopeId,
      canonicalPath
    );
    return true;
  } catch {
    return false;
  }
}

export function listWorkspaceSqlFiles(
  sql: WorkspaceSqlLike | undefined,
  scopeId: string
): WorkspaceSqlRow[] {
  if (!sql?.exec) return [];
  ensureWorkspaceSqlSchema(sql);
  try {
    const rows = Array.from(
      sql.exec(
        `SELECT path, size, updated_at FROM mas_agent_workspace_files WHERE user_login = ? ORDER BY path ASC`,
        scopeId
      )
    ) as Array<{ path?: string; size?: number; updated_at?: string }>;
    return rows
      .filter((r): r is { path: string; size?: number; updated_at?: string } => typeof r.path === "string" && r.path.length > 0)
      .map((r) => ({
        path: r.path,
        size: Number(r.size ?? 0),
        updated_at: r.updated_at,
      }));
  } catch {
    return [];
  }
}
