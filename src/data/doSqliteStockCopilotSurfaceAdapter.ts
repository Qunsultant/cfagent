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
  COPILOT_LEARNINGS_RETENTION,
  COPILOT_LEARNINGS_TABLE,
  type CopilotActivityExit,
  type CopilotControlRecord,
  type CopilotCriticVerdict,
  type CopilotCycleActivityRecord,
  type CopilotExecutionMode,
  type CopilotLearningRecord,
  type StockCopilotActivityPort,
  type StockCopilotControlPort,
  type StockCopilotMemoryPort,
  type StockCopilotStoreSqlExecutor,
} from "./stockCopilotStorePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

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

function parseCriticVerdict(raw: unknown): CopilotCriticVerdict | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(str(raw));
    if (parsed && typeof parsed === "object" && typeof (parsed as any).verdict === "string") {
      const v = parsed as any;
      return {
        verdict: v.verdict,
        reason: typeof v.reason === "string" ? v.reason : "",
        recommendations: Array.isArray(v.recommendations)
          ? v.recommendations.filter((r: unknown): r is string => typeof r === "string")
          : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function mapActivity(row: Record<string, unknown>): CopilotCycleActivityRecord {
  const outcome = str(row.outcome);
  const rawMode = strOrNull(row.mode);
  const mode: CopilotExecutionMode | undefined =
    rawMode === "agentic" || rawMode === "deterministic" ? rawMode : undefined;
  return {
    id: str(row.id),
    userLogin: str(row.user_login),
    cycleAt: str(row.cycle_at),
    outcome:
      outcome === "traded" ||
      outcome === "refused" ||
      outcome === "inactive" ||
      outcome === "outside_sessions" ||
      outcome === "selection_changed"
        ? outcome
        : "no_trade",
    session: strOrNull(row.session),
    entries: parseEntries(row.entries_json),
    exits: parseExits(row.exits_json),
    detail:
      row.detail === null || row.detail === undefined ? null : str(row.detail),
    mode,
    criticVerdict: parseCriticVerdict(row.critic_verdict_json),
  };
}

export class DoSqliteStockCopilotActivityStore
  implements StockCopilotActivityPort
{
  constructor(private readonly sql: StockCopilotStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(
      doTableSql("stock_copilot_activity"),
    );
    // #3398: tables created before session recording gain the
    // column in place (the data layer's PRAGMA/ALTER idiom).
    const cols = Array.from(
      this.sql.exec(`PRAGMA table_info(${COPILOT_ACTIVITY_TABLE})`),
    ) as Array<{ name?: unknown }>;
    if (!cols.some((c) => String(c.name ?? "") === "session")) {
      this.sql.exec(remainderAlterSql("stock_copilot_activity", "session"));
    }
    // #3519: execution mode & critic verdict columns
    if (!cols.some((c) => String(c.name ?? "") === "mode")) {
      this.sql.exec(remainderAlterSql("stock_copilot_activity", "mode"));
    }
    if (!cols.some((c) => String(c.name ?? "") === "critic_verdict_json")) {
      this.sql.exec(remainderAlterSql("stock_copilot_activity", "critic_verdict_json"));
    }
  }

  appendActivity(record: CopilotCycleActivityRecord): void {
    this.sql.exec(
      `INSERT INTO ${COPILOT_ACTIVITY_TABLE} (id, user_login, cycle_at, outcome, entries_json, exits_json, detail, session, mode, critic_verdict_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userLogin,
      record.cycleAt,
      record.outcome,
      JSON.stringify(record.entries),
      JSON.stringify(record.exits),
      record.detail,
      record.session ?? null,
      record.mode ?? null,
      record.criticVerdict ? JSON.stringify(record.criticVerdict) : null,
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
      doTableSql("stock_copilot_control"),
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

// ---------------------------------------------------------------------------
// Issue #3519 — DO-SQLite Learning Memory Store
// ---------------------------------------------------------------------------

function mapLearning(row: Record<string, unknown>): CopilotLearningRecord {
  const cat = str(row.category);
  const category =
    cat === "execution" ||
    cat === "risk" ||
    cat === "pattern" ||
    cat === "session" ||
    cat === "refusal"
      ? cat
      : "execution";
  const rawVerdict = strOrNull(row.source_verdict);
  const sourceVerdict =
    rawVerdict === "accept" || rawVerdict === "revise" || rawVerdict === "reject"
      ? rawVerdict
      : null;

  return {
    id: str(row.id),
    userLogin: str(row.user_login),
    cycleId: strOrNull(row.cycle_id),
    timestamp: str(row.timestamp),
    category,
    insight: str(row.insight),
    sourceVerdict,
    suggestedAction: strOrNull(row.suggested_action),
  };
}

export class DoSqliteStockCopilotMemoryStore implements StockCopilotMemoryPort {
  constructor(private readonly sql: StockCopilotStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(
      doTableSql("stock_copilot_learnings"),
    );
  }

  recordLearning(learning: CopilotLearningRecord): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT INTO ${COPILOT_LEARNINGS_TABLE} (id, user_login, cycle_id, timestamp, category, insight, source_verdict, suggested_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      learning.id,
      learning.userLogin,
      learning.cycleId ?? null,
      learning.timestamp,
      learning.category,
      learning.insight,
      learning.sourceVerdict ?? null,
      learning.suggestedAction ?? null,
    );
    // Bounded retention
    this.sql.exec(
      `DELETE FROM ${COPILOT_LEARNINGS_TABLE} WHERE user_login = ? AND id NOT IN (SELECT id FROM ${COPILOT_LEARNINGS_TABLE} WHERE user_login = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?)`,
      learning.userLogin,
      learning.userLogin,
      COPILOT_LEARNINGS_RETENTION,
    );
  }

  listLearnings(
    userLogin: string,
    limit = COPILOT_LEARNINGS_RETENTION,
  ): CopilotLearningRecord[] {
    this.ensureSchema();
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_LEARNINGS_TABLE} WHERE user_login = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
        userLogin,
        limit,
      ),
    ] as Array<Record<string, unknown>>;
    return rows.map(mapLearning);
  }
}
