/**
 * Issue #2357 (#1976 step 4b) — the DO-SQLite implementation
 * of the adaptation audit port: the persistence section of
 * the legacy src/services/adaptationAudit.ts, moved into the
 * data layer statement-for-statement. Append-only: this
 * adapter issues no UPDATE or DELETE against the audit table
 * (the #755 surface pin, now over the layer).
 */
import type {
  AdaptationAuditRow,
  AdaptationAuditSqlExecutor,
  AdaptationAuditStore,
  AdaptationRecord,
} from "./adaptationAuditPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteAdaptationAuditStore implements AdaptationAuditStore {
  constructor(private readonly sql: AdaptationAuditSqlExecutor) {}

  ensureTable(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_adaptation_audit"));
    sql.exec(doIndexSql("idx_adaptation_audit_subject"));
  }

  insert(
    rec: AdaptationRecord,
    status: "applied" | "blocked",
    blockReason: string | null,
    now: Date
  ): string {
    this.ensureTable();
    const id = `adapt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sql.exec(
      `INSERT INTO mas_adaptation_audit
     (id, actor, subject, parameter, before_value, after_value, delta, rationale, data_window, status, block_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      rec.actor,
      rec.subject,
      rec.parameter,
      rec.before,
      rec.after,
      rec.delta,
      rec.rationale,
      rec.dataWindow,
      status,
      blockReason,
      rec.createdAt ?? now.toISOString()
    );
    return id;
  }

  list(subject?: string, limit = 100): AdaptationAuditRow[] {
    this.ensureTable();
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (
      subject
        ? Array.from(
            this.sql.exec(
              `SELECT * FROM mas_adaptation_audit WHERE subject = ? ORDER BY created_at DESC LIMIT ${lim}`,
              subject
            )
          )
        : Array.from(
            this.sql.exec(`SELECT * FROM mas_adaptation_audit ORDER BY created_at DESC LIMIT ${lim}`)
          )
    ) as any[];
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      subject: r.subject,
      parameter: r.parameter,
      before: r.before_value,
      after: r.after_value,
      delta: r.delta,
      rationale: r.rationale,
      dataWindow: r.data_window,
      status: r.status,
      blockReason: r.block_reason ?? null,
      createdAt: r.created_at,
    }));
  }
}
