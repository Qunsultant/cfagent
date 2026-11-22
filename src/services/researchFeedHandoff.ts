/**
 * Issue #6063 — the feed stage's run-scoped hand-off.
 *
 * The feed step is the producer: it runs the regime/universe/quote phase and
 * its output is persisted by the engine as the step result. The analyze step
 * reads that result as `ctx.input`; this module carries it across the
 * `runOodaAnalysis` boundary (which is a publish/agent entry, not a step
 * context), keyed by run id.
 *
 * It is a hand-off, not a store: the engine's persisted step output is the
 * durable record. The map is bounded and consumed by the pipeline once; a
 * missing entry (a different process, a resumed run) simply falls back to the
 * pipeline's own fetch — same behaviour as before the stage existed, never a
 * fabricated feed.
 */

export interface ResearchFeedQuoteEntry {
  symbol: string;
  quote: unknown | null;
}

export interface ResearchFeedStageOutput {
  runId: string;
  asOf: string;
  regime: unknown;
  universe: string;
  universeError: string | null;
  symbols: string[];
  quotes: ResearchFeedQuoteEntry[];
  universeSize: number;
  quotesRetrieved: number;
}

const MAX_ENTRIES = 32;
const handoff = new Map<string, ResearchFeedStageOutput>();

export function putResearchFeed(output: ResearchFeedStageOutput): void {
  if (handoff.has(output.runId)) handoff.delete(output.runId);
  handoff.set(output.runId, output);
  while (handoff.size > MAX_ENTRIES) {
    const oldest = handoff.keys().next().value;
    if (oldest === undefined) break;
    handoff.delete(oldest);
  }
}

export function peekResearchFeed(runId: string): ResearchFeedStageOutput | undefined {
  return handoff.get(runId);
}

export function takeResearchFeed(runId: string): ResearchFeedStageOutput | undefined {
  const found = handoff.get(runId);
  if (found) handoff.delete(runId);
  return found;
}

/** Test seam: drop every hand-off. */
export function clearResearchFeedHandoff(): void {
  handoff.clear();
}
