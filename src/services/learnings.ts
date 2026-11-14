/**
 * Issue #706: persistent learning store — the "Remember" step.
 *
 * Learnings are written by the reflection job (#705) and by explicit human
 * corrections. The screener/research pipeline reads applicable learnings at
 * run start and adjusts behavior. Learnings are superseded, never edited —
 * the history of what the agent believed and when stays auditable.
 */

import { remainderIndexSql, remainderTableSql } from "../data/schemaComponent/remainderCatalogue";

export interface Learning {
  id: string;
  domain: string;
  observation: string;
  evidenceRefs: string[];
  confidence: number;
  createdAt: string;
  supersededBy: string | null;
  source: "reflection" | "human" | "calibration";
}

export function ensureLearningsTable(sql: any): void {
  sql.exec(remainderTableSql("mas_learnings"));
  sql.exec(remainderIndexSql("idx_learnings_domain"));
  sql.exec(remainderIndexSql("idx_learnings_active"));
}

/** Write a new learning. Returns its id. */
export function recordLearning(
  sql: any,
  learning: { domain: string; observation: string; evidenceRefs?: string[]; confidence?: number; source?: Learning["source"] }
): string {
  ensureLearningsTable(sql);
  const id = `learn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sql.exec(
    `INSERT INTO mas_learnings (id, domain, observation, evidence_refs, confidence, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    learning.domain,
    learning.observation,
    JSON.stringify(learning.evidenceRefs || []),
    learning.confidence ?? 0.5,
    learning.source || "reflection"
  );
  return id;
}

/** Supersede a learning with a newer one. The old row stays for audit. */
export function supersedeLearning(sql: any, oldId: string, newId: string): void {
  ensureLearningsTable(sql);
  sql.exec(`UPDATE mas_learnings SET superseded_by = ? WHERE id = ?`, newId, oldId);
}

/** Active learnings for a domain (or all domains), newest first. */
export function getActiveLearnings(sql: any, domain?: string): Learning[] {
  ensureLearningsTable(sql);
  const where = domain
    ? `WHERE superseded_by IS NULL AND domain = '${domain.replace(/'/g, "''")}'`
    : `WHERE superseded_by IS NULL`;
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_learnings ${where} ORDER BY created_at DESC LIMIT 50`)
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    observation: r.observation,
    evidenceRefs: JSON.parse(r.evidence_refs || "[]"),
    confidence: r.confidence,
    createdAt: r.created_at,
    supersededBy: r.superseded_by,
    source: r.source,
  }));
}

/** Full history including superseded learnings, for audit. */
export function getLearningHistory(sql: any, domain?: string): Learning[] {
  ensureLearningsTable(sql);
  const where = domain ? `WHERE domain = '${domain.replace(/'/g, "''")}'` : "";
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_learnings ${where} ORDER BY created_at DESC LIMIT 100`)
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    observation: r.observation,
    evidenceRefs: JSON.parse(r.evidence_refs || "[]"),
    confidence: r.confidence,
    createdAt: r.created_at,
    supersededBy: r.superseded_by,
    source: r.source,
  }));
}
