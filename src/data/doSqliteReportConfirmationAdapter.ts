/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the report-confirmation port: the mas_report_confirmations
 * statements from src/agents/orchestrator/reportDispatch.ts
 * (create sweep + insert, get, decide) and
 * src/agents/routes/reports.ts (pending list, per-report
 * list), moved into the data layer statement-for-statement,
 * plus the table's DDL + probed report_id migration from
 * OrchestratorAgent.ensureTables (its ONE home now).
 * Payload semantics (delivery metadata only, #308) stay in
 * the legacy modules.
 */
import type {
  InsertConfirmationInput,
  OrchestratorTableSqlExecutor,
  ReportConfirmationForReportRow,
  ReportConfirmationPendingRow,
  ReportConfirmationPort,
  ReportConfirmationRow,
} from "./orchestratorTablePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

/** Add a column to the table when it is missing (additive migration). */
function ensureColumn(
  sql: OrchestratorTableSqlExecutor,
  column: string,
  type: string
): void {
  const cols = Array.from(
    sql.exec("PRAGMA table_info(mas_report_confirmations)")
  ) as Array<{ name?: unknown }>;
  const names = cols.map((c) => String(c?.name ?? ""));
  if (!names.includes(column)) {
    sql.exec(`ALTER TABLE mas_report_confirmations ADD COLUMN ${column} ${type}`);
  }
}

export class DoSqliteReportConfirmationStore implements ReportConfirmationPort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("mas_report_confirmations"));
    // Additive migrations for tables created before issue #308
    // (report_id) and before issue #2664 (created_by). One helper
    // keeps the file's storage-exec census count unchanged.
    try {
      ensureColumn(this.sql, "report_id", "TEXT");
      ensureColumn(this.sql, "created_by", "TEXT");
    } catch {
      // Non-critical: best-effort migration; fresh installs get the columns.
    }
  }

  sweepExpiredPending(cutoffIso: string): void {
    this.sql.exec(
      "DELETE FROM mas_report_confirmations WHERE status = 'pending' AND created_at < ?",
      cutoffIso
    );
  }

  insertConfirmation(input: InsertConfirmationInput): void {
    this.sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      input.id,
      input.kind,
      input.payloadJson,
      input.status,
      input.createdAt,
      input.reportId,
      input.createdBy ?? null
    );
  }

  getById(id: string): ReportConfirmationRow | null {
    const rows = Array.from(
      this.sql.exec("SELECT * FROM mas_report_confirmations WHERE id = ?", id)
    ) as ReportConfirmationRow[];
    return rows[0] ?? null;
  }

  decide(id: string, status: string, decidedAt: string, decidedBy: string | null): void {
    this.sql.exec(
      "UPDATE mas_report_confirmations SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
      status,
      decidedAt,
      decidedBy,
      id
    );
  }

  listPending(): ReportConfirmationPendingRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, kind, payload_json, created_at FROM mas_report_confirmations WHERE status = 'pending' ORDER BY created_at DESC"
      )
    ) as ReportConfirmationPendingRow[];
  }

  listByReportId(reportId: string): ReportConfirmationForReportRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, kind, status, created_at, decided_at, decided_by, payload_json FROM mas_report_confirmations WHERE report_id = ? ORDER BY created_at DESC",
        reportId
      )
    ) as ReportConfirmationForReportRow[];
  }
}
