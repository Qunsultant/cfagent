/**
 * Issue #5034 — Port & in-memory adapter for `mas_learnings` (#706).
 */
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

export interface RecordLearningInput {
  domain: string;
  observation: string;
  evidenceRefs?: string[];
  confidence?: number;
  source?: Learning["source"];
}

export interface LearningsStorePort {
  ensureSchema(): void;
  record(learning: RecordLearningInput): string;
  supersede(oldId: string, newId: string): void;
  getActive(domain?: string): Learning[];
  getHistory(domain?: string): Learning[];
}

export function createInMemoryLearningsStore(): LearningsStorePort {
  const rows: Learning[] = [];
  return {
    ensureSchema() {},
    record(learning) {
      const id = `learn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      rows.unshift({
        id,
        domain: learning.domain,
        observation: learning.observation,
        evidenceRefs: learning.evidenceRefs ? [...learning.evidenceRefs] : [],
        confidence: learning.confidence ?? 0.5,
        createdAt: new Date().toISOString(),
        supersededBy: null,
        source: learning.source ?? "reflection",
      });
      return id;
    },
    supersede(oldId, newId) {
      for (const r of rows) {
        if (r.id === oldId) r.supersededBy = newId;
      }
    },
    getActive(domain) {
      return rows
        .filter((r) => r.supersededBy === null && (!domain || r.domain === domain))
        .slice(0, 50);
    },
    getHistory(domain) {
      return rows
        .filter((r) => !domain || r.domain === domain)
        .slice(0, 100);
    },
  };
}
