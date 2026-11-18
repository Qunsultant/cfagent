/**
 * Issue #706 / #5034: persistent learning store — the "Remember" step.
 *
 * Delegates to the data-layer port & DO SQLite adapter
 * (`src/data/learningsStorePorts.ts` + `src/data/doSqliteLearningsAdapter.ts`).
 */
import { createDoSqliteLearningsStore } from "../data/doSqliteLearningsAdapter";
import type { Learning } from "../data/learningsStorePorts";

export type { Learning, LearningsStorePort, RecordLearningInput } from "../data/learningsStorePorts";
export { createInMemoryLearningsStore } from "../data/learningsStorePorts";

export function ensureLearningsTable(sql: any): void {
  createDoSqliteLearningsStore(sql).ensureSchema();
}

/** Write a new learning. Returns its id. */
export function recordLearning(
  sql: any,
  learning: { domain: string; observation: string; evidenceRefs?: string[]; confidence?: number; source?: Learning["source"] },
): string {
  return createDoSqliteLearningsStore(sql).record(learning);
}

/** Supersede a learning with a newer one. The old row stays for audit. */
export function supersedeLearning(sql: any, oldId: string, newId: string): void {
  createDoSqliteLearningsStore(sql).supersede(oldId, newId);
}

/** Active learnings for a domain (or all domains), newest first. */
export function getActiveLearnings(sql: any, domain?: string): Learning[] {
  return createDoSqliteLearningsStore(sql).getActive(domain);
}

/** Full history including superseded learnings, for audit. */
export function getLearningHistory(sql: any, domain?: string): Learning[] {
  return createDoSqliteLearningsStore(sql).getHistory(domain);
}
