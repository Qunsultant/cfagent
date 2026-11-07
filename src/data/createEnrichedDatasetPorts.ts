/**
 * Issue #3536 (Pipeline J3) — composition root for the
 * enriched-dataset port. This is the ONLY module that maps a
 * Worker binding to the port's production implementation:
 * domain code imports this helper and the port types, never a
 * store client (the createFeedDatasetPorts pattern).
 *
 * Absence of the binding is a normal, non-error state:
 * createEnrichedDatasetAdapter returns null and callers report
 * the enrich surface as not configured instead of inventing a
 * store. AGENT_DB is bound in production (wrangler.jsonc) —
 * the same binding the feed datasets live on, since the
 * analyze stage's readers run in different instances than the
 * enrich writer.
 */
import {
  createD1EnrichedDatasetDb,
  D1EnrichedDatasetStore,
} from "./d1EnrichedDatasetAdapter";
import type { EnrichedDatasetStore } from "./enrichedDatasetPorts";

/** Build the enriched-dataset adapter from Worker env, or null if unbound. */
export function createEnrichedDatasetAdapter(env: {
  AGENT_DB?: unknown;
}): D1EnrichedDatasetStore | null {
  if (!env.AGENT_DB) return null;
  return new D1EnrichedDatasetStore(
    createD1EnrichedDatasetDb(env.AGENT_DB as D1Database),
  );
}

export type { EnrichedDatasetStore };
