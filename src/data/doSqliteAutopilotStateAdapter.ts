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
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";

export class DoSqliteAutopilotStateStore implements AutopilotStatePort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_autopilot"));
  }

  getValue(key: string): string | null {
    const rows = executeDoDml<Array<{ value: string }>>(
      DO_DML_CATALOGUE,
      this.sql as never,
      "dml.do.mas_autopilot.get_value",
      { key },
    );
    return rows[0]?.value ?? null;
  }

  putValue(key: string, value: string, updatedAt: string): void {
    executeDoDml(
      DO_DML_CATALOGUE,
      this.sql as never,
      "dml.do.mas_autopilot.put_value",
      { key, value, updated_at: updatedAt },
    );
  }
}
