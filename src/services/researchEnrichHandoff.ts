/**
 * Deprecated (#6093): the process-local maps are no longer used by the J-stack
 * path. Stage outputs travel through the engine step output (durable) and the
 * types below are the hand-off contracts; the maps remain only for legacy
 * direct callers.
 * Issue #6064 — the enrich stage's run-scoped hand-off.
 *
 * The enrich step is the producer: it fetches technicals and catalysts for the
 * feed's quoted symbols and its output is persisted by the engine as the step
 * result. The analyze step reads that result as `ctx.input`; this module carries
 * it across the `runOodaAnalysis` boundary, keyed by run id.
 *
 * It is a hand-off, not a store: the engine's persisted step output is the
 * durable record. A missing entry (another process, a resumed run) falls back
 * to the pipeline's own fetch — the pre-stage behaviour, never a fabricated
 * enrichment.
 */

/** The subset of the provider's per-symbol context the pipeline consumes. */
export interface ResearchEnrichEntry {
  technicals: unknown | null;
  catalysts: unknown[] | null;
}

import type { ResearchFeedStageOutput } from "./researchFeedHandoff";

export interface ResearchEnrichStageOutput {
  runId: string;
  asOf: string;
  /** Issue #6093 — the feed step output this enrichment was built from. */
  feed: ResearchFeedStageOutput;
  bySymbol: Record<string, ResearchEnrichEntry>;
}

const MAX_ENTRIES = 32;
const handoff = new Map<string, ResearchEnrichStageOutput>();

export function putResearchEnrich(output: ResearchEnrichStageOutput): void {
  if (handoff.has(output.runId)) handoff.delete(output.runId);
  handoff.set(output.runId, output);
  while (handoff.size > MAX_ENTRIES) {
    const oldest = handoff.keys().next().value;
    if (oldest === undefined) break;
    handoff.delete(oldest);
  }
}

export function takeResearchEnrich(runId: string): ResearchEnrichStageOutput | undefined {
  const found = handoff.get(runId);
  if (found) handoff.delete(runId);
  return found;
}

/** Test seam: drop every hand-off. */
export function clearResearchEnrichHandoff(): void {
  handoff.clear();
}
