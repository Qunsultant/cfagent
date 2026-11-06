/**
 * Issue #3422 — the DO-SQLite implementations of the Stock
 * Copilot surface ports (cycle activity log + per-instance pause
 * control), in the statement-for-statement style of the position
 * adapter (doSqliteStockCopilotStoreAdapter.ts). Entries/exits
 * ride as JSON text columns: the record is display-grade and is
 * always read back whole, never queried by symbol.
 */
import {
  COPILOT_ACTIVITY_RETENTION,
  COPILOT_ACTIVITY_TABLE,
  COPILOT_CONTROL_TABLE,
  type CopilotActivityExit,
  type CopilotControlRecord,
  type CopilotCycleActivityRecord,
  type StockCopilotActivityPort,
  type StockCopilotControlPort,
  type StockCopilotStoreSqlExecutor,
} from "./stockCopilotStorePorts";

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

function parseEntries(raw: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(str(raw));
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function parseExits(raw: unknown): CopilotActivityExit[] {
  try {
    const parsed: unknown = JSON.parse(str(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e) => {
      if (e && typeof e === "object" && typeof (e as { symbol?: unknown }).symbol === "string") {
        const exit = e as { symbol: string; reason?: unknown };
        return [{ symbol: exit.symbol, reason: typeof exit.reason === "string" ? exit.reason : "" }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function mapActivity(row: Record<string, unknown>): CopilotCycleActivityRecord {
  const outcome = str(row.outcome);
  return {
    id: str(row.id),
    userLogin: str(row.user_login),
    cycleAt: str(row.cycle_at),
    outcome: outcome === "traded" || outcome === "refused" ? outcome : "no_trade",
    entries: parseEntries(row.entries_json),
    exits: parseExits(row.exits_json),
    detail:
      row.detail === null || row.detail === undefined ? null : str(row.detail),
  };
}

export class DoSqliteStockCopilotActivityStore
  implements StockCopilotActivityPort
{
  constructor(private readonly sql: StockCopilotStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COPILOT_ACTIVITY_TABLE} (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        cycle_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        exits_json TEXT NOT NULL,
        detail TEXT
      )`,
    );
  }

  appendActivity(record: CopilotCycleActivityRecord): void {
    this.sql.exec(
      `INSERT INTO ${COPILOT_ACTIVITY_TABLE} (id, user_login, cycle_at, outcome, entries_json, exits_json, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userLogin,
      record.cycleAt,
      record.outcome,
      JSON.stringify(record.entries),
      JSON.stringify(record.exits),
      record.detail,
    );
    // Bounded retention: keep the login's newest records only
    // (cycle_at order, rowid breaking same-timestamp ties by
    // insertion order — the same order listActivity reads).
    this.sql.exec(
      `DELETE FROM ${COPILOT_ACTIVITY_TABLE} WHERE user_login = ? AND id NOT IN (SELECT id FROM ${COPILOT_ACTIVITY_TABLE} WHERE user_login = ? ORDER BY cycle_at DESC, rowid DESC LIMIT ?)`,
      record.userLogin,
      record.userLogin,
      COPILOT_ACTIVITY_RETENTION,
    );
  }

  listActivity(
    userLogin: string,
    limit: number,
  ): CopilotCycleActivityRecord[] {
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_ACTIVITY_TABLE} WHERE user_login = ? ORDER BY cycle_at DESC, rowid DESC LIMIT ?`,
        userLogin,
        limit,
      ),
    ] as Array<Record<string, unknown>>;
    return rows.map(mapActivity);
  }
}

export class DoSqliteStockCopilotControlStore
  implements StockCopilotControlPort
{
  constructor(private readonly sql: StockCopilotStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COPILOT_CONTROL_TABLE} (
        user_login TEXT PRIMARY KEY,
        paused INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
    );
  }

  getControl(userLogin: string): CopilotControlRecord | null {
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_CONTROL_TABLE} WHERE user_login = ?`,
        userLogin,
      ),
    ] as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      userLogin: str(row.user_login),
      paused: Number(row.paused ?? 0) !== 0,
      updatedAt: str(row.updated_at),
      updatedBy: str(row.updated_by),
    };
  }

  setControl(record: CopilotControlRecord): void {
    this.sql.exec(
      `INSERT INTO ${COPILOT_CONTROL_TABLE} (user_login, paused, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(user_login) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      record.userLogin,
      record.paused ? 1 : 0,
      record.updatedAt,
      record.updatedBy,
    );
  }
}
