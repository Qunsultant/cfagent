/**
 * Issue #5034 — DO SQLite adapter for `mas_learnings`.
 */
import type { Learning, LearningsStorePort, RecordLearningInput } from "./learningsStorePorts";
import { remainderIndexSql, remainderTableSql } from "./schemaComponent/remainderCatalogue";

export function createDoSqliteLearningsStore(sql: any): LearningsStorePort {
  const ensureSchema = () => {
    sql.exec(remainderTableSql("mas_learnings"));
    sql.exec(remainderIndexSql("idx_learnings_domain"));
    sql.exec(remainderIndexSql("idx_learnings_active"));
  };

  const mapRow = (r: any): Learning => ({
    id: r.id,
    domain: r.domain,
    observation: r.observation,
    evidenceRefs: JSON.parse(r.evidence_refs || "[]"),
    confidence: r.confidence,
    createdAt: r.created_at,
    supersededBy: r.superseded_by,
    source: r.source,
  });

  return {
    ensureSchema,
    record(learning: RecordLearningInput): string {
      ensureSchema();
      const id = `learn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sql.exec(
        `INSERT INTO mas_learnings (id, domain, observation, evidence_refs, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        learning.domain,
        learning.observation,
        JSON.stringify(learning.evidenceRefs || []),
        learning.confidence ?? 0.5,
        learning.source || "reflection",
      );
      return id;
    },
    supersede(oldId: string, newId: string): void {
      ensureSchema();
      sql.exec(`UPDATE mas_learnings SET superseded_by = ? WHERE id = ?`, newId, oldId);
    },
    getActive(domain?: string): Learning[] {
      ensureSchema();
      const where = domain
        ? `WHERE superseded_by IS NULL AND domain = '${domain.replace(/'/g, "''")}'`
        : `WHERE superseded_by IS NULL`;
      const rows = Array.from(
        sql.exec(`SELECT * FROM mas_learnings ${where} ORDER BY created_at DESC LIMIT 50`),
      ) as any[];
      return rows.map(mapRow);
    },
    getHistory(domain?: string): Learning[] {
      ensureSchema();
      const where = domain ? `WHERE domain = '${domain.replace(/'/g, "''")}'` : "";
      const rows = Array.from(
        sql.exec(`SELECT * FROM mas_learnings ${where} ORDER BY created_at DESC LIMIT 100`),
      ) as any[];
      return rows.map(mapRow);
    },
  };
}
