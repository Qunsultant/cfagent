/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the screener-preset port: the mas_screener_presets
 * statements from src/agents/routes/screenerPresets.ts (list,
 * insert, existence probe, delete) and
 * src/services/screenerPresetResolution.ts (the run-time
 * resolution read), moved into the data layer
 * statement-for-statement, plus the table's DDL from
 * OrchestratorAgent.ensureTables (its ONE home now). Every
 * statement stays scoped by (id, user_login) or user_login —
 * the no-existence-oracle discipline is in the queries, not
 * in caller care.
 */
import type {
  OrchestratorTableSqlExecutor,
  ScreenerPresetPort,
  ScreenerPresetRow,
} from "./orchestratorTablePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteScreenerPresetStore implements ScreenerPresetPort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_screener_presets"));
  }

  listByUser(userLogin: string): ScreenerPresetRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, user_login, name, asset_class, criteria_json, created_at, updated_at FROM mas_screener_presets WHERE user_login = ? ORDER BY updated_at DESC, created_at DESC",
        userLogin
      )
    ) as ScreenerPresetRow[];
  }

  insertPreset(row: ScreenerPresetRow): void {
    this.sql.exec(
      "INSERT INTO mas_screener_presets (id, user_login, name, asset_class, criteria_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.user_login,
      row.name,
      row.asset_class,
      row.criteria_json,
      row.created_at,
      row.updated_at
    );
  }

  existsForUser(id: string, userLogin: string): boolean {
    const rows = Array.from(
      this.sql.exec("SELECT id FROM mas_screener_presets WHERE id = ? AND user_login = ?", id, userLogin)
    );
    return rows.length > 0;
  }

  deleteForUser(id: string, userLogin: string): void {
    this.sql.exec("DELETE FROM mas_screener_presets WHERE id = ? AND user_login = ?", id, userLogin);
  }

  getResolutionRow(
    id: string,
    userLogin: string
  ): { asset_class: unknown; criteria_json: unknown } | null {
    const rows = Array.from(
      this.sql.exec(
        "SELECT asset_class, criteria_json FROM mas_screener_presets WHERE id = ? AND user_login = ?",
        id,
        userLogin
      )
    ) as Array<{ asset_class: unknown; criteria_json: unknown }>;
    return rows[0] ?? null;
  }
}
