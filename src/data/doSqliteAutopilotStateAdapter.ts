/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the autopilot-state port: the mas_autopilot statements
 * from src/agents/orchestrator/autopilot.ts, moved into the
 * data layer statement-for-statement, plus the table's DDL
 * from OrchestratorAgent.ensureTables (its ONE home now).
 * The state blob's shape and merge logic stay in the legacy
 * module; this store holds the raw value only.
 */
import type {
  AutopilotStatePort,
  OrchestratorTableSqlExecutor,
} from "./orchestratorTablePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteAutopilotStateStore implements AutopilotStatePort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_autopilot"));
  }

  getValue(key: string): string | null {
    const rows = Array.from(
      this.sql.exec("SELECT value FROM mas_autopilot WHERE key = ?", key)
    ) as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }

  putValue(key: string, value: string, updatedAt: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO mas_autopilot (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      updatedAt
    );
  }
}
