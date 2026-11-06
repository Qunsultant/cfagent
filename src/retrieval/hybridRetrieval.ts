/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — hybrid retrieval composition
 * (ADR 0007). Pure composition over the retrieval ports: no store
 * client, no query language, no drizzle import anywhere here.
 *
 * Fusion rule (deterministic, documented so tests pin it):
 *  1. Dense hits first, in the vector leg's score order.
 *  2. Graph rows after, grouped by seed order — query symbols in
 *     query order first, then symbols from dense-hit texts in
 *     dense order — and within a seed by relation order
 *     in_sector < peer_of < related_event, then node key.
 *  3. Deduped by (nodeType, nodeKey), first occurrence wins.
 *  4. Capped at graphTopK (default 12).
 *
 * Seeds are known symbols only: candidates are uppercase
 * ticker-like tokens from the query and the dense-hit texts,
 * resolved against stored symbol nodes. Nothing is inferred —
 * an unknown token contributes no seed.
 *
 * Failure contract: a graph failure degrades to embeddings-only
 * (degraded: true, graphError carries the message, logged) and
 * never throws. A null graph behaves like an empty graph.
 *
 * Events: a retrieval emits one best-effort `retrieval.completed`
 * CloudEvents v1.0 envelope through #1739's MessageEnvelope
 * shape (same envelope, id-as-idempotency-key) when the caller
 * supplies an emitter. Emission failure is swallowed and logged;
 * it never fails the retrieval. Event data carries counts only —
 * never query text, never user material.
 */
import type { MessageEnvelope } from "../messaging/messagingPorts";
import type {
  GraphContextRow,
  HybridRetrieveInput,
  HybridRetrievalResult,
  MarketGraphReader,
  MarketRelation,
  VectorSearchPort,
} from "./retrievalPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "retrieval/hybridRetrieval",
});

/** Default graph rows per retrieval. */
export const DEFAULT_GRAPH_TOP_K = 12;

/** Relation order for fusion: sector membership, then peers, then events. */
export const RELATION_ORDER: readonly MarketRelation[] = [
  "in_sector",
  "peer_of",
  "related_event",
];

/** Ticker-like tokens: an uppercase letter followed by up to 4 uppercase alphanumerics or dots (BRK.B). */
const SYMBOL_TOKEN = /\b[A-Z][A-Z0-9.]{0,4}\b/g;

/** Uppercase ticker-like tokens in order of appearance, deduped. */
export function extractSymbolCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.match(SYMBOL_TOKEN) ?? []) {
    if (!seen.has(match)) {
      seen.add(match);
      out.push(match);
    }
  }
  return out;
}

/** Sort graph rows by (seed order, relation order, node key) and dedup by node. */
export function fuseGraphRows(
  rows: GraphContextRow[],
  seedOrder: string[],
  graphTopK: number,
): GraphContextRow[] {
  const seedIndex = new Map(seedOrder.map((key, i) => [key, i]));
  const relationIndex = new Map(RELATION_ORDER.map((rel, i) => [rel, i]));
  const sorted = [...rows].sort((a, b) => {
    const seedDiff =
      (seedIndex.get(a.viaSeedKey) ?? seedOrder.length) -
      (seedIndex.get(b.viaSeedKey) ?? seedOrder.length);
    if (seedDiff !== 0) return seedDiff;
    const relDiff =
      (relationIndex.get(a.viaRelation) ?? RELATION_ORDER.length) -
      (relationIndex.get(b.viaRelation) ?? RELATION_ORDER.length);
    if (relDiff !== 0) return relDiff;
    if (a.node.nodeKey < b.node.nodeKey) return -1;
    if (a.node.nodeKey > b.node.nodeKey) return 1;
    return 0;
  });
  const seen = new Set<string>();
  const out: GraphContextRow[] = [];
  for (const row of sorted) {
    const key = `${row.node.nodeType}:${row.node.nodeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= graphTopK) break;
  }
  return out;
}

export interface ExpandGraphContextOptions {
  graphTopK?: number;
  log?: (message: string) => void;
}

export interface ExpandGraphContextResult {
  rows: GraphContextRow[];
  degraded: boolean;
  graphError?: string;
}

/**
 * Graph expansion alone (shared by the hybrid path, the
 * memory_search route, and the turn grounding): seeds from the
 * query plus dense-hit texts, resolved against stored symbols,
 * then one adjacent() call, fused. Never throws.
 */
export async function expandGraphContext(
  graph: MarketGraphReader,
  tenantId: string,
  query: string,
  denseTexts: string[],
  opts: ExpandGraphContextOptions = {},
): Promise<ExpandGraphContextResult> {
  const graphTopK = opts.graphTopK ?? DEFAULT_GRAPH_TOP_K;
  const log = opts.log ?? ((message: string) => structuredLog.warn("retrieval.log", { message }));
  try {
    const candidates = extractSymbolCandidates(
      [query, ...denseTexts].join(" "),
    );
    if (candidates.length === 0) return { rows: [], degraded: false };
    const seeds = await graph.resolveSymbols(tenantId, candidates);
    if (seeds.length === 0) return { rows: [], degraded: false };
    const rows = await graph.adjacent(tenantId, seeds);
    return { rows: fuseGraphRows(rows, seeds, graphTopK), degraded: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[retrieval] graph expansion failed, degrading to dense-only: ${message}`);
    return { rows: [], degraded: true, graphError: message };
  }
}

/** Format graph rows as a turn-prompt context block; empty rows format to "" (no prompt change). */
export function formatGraphContext(rows: GraphContextRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map(
    (row) =>
      `- ${row.node.nodeKey} (${row.node.nodeType}, via ${row.viaRelation} from ${row.viaSeedKey})`,
  );
  return `\nRelated market context (graph-adjacent symbols, sectors, events):\n${lines.join("\n")}`;
}

export interface HybridRetrieveDeps {
  vector: VectorSearchPort;
  graph: MarketGraphReader | null;
  emit?: (envelope: MessageEnvelope) => Promise<void>;
  log?: (message: string) => void;
}

/** Build a `retrieval.completed` CloudEvents envelope (counts only, no query text). */
export function toRetrievalCompletedEnvelope(input: {
  denseCount: number;
  graphCount: number;
  degraded: boolean;
  id?: string;
  time?: string;
}): MessageEnvelope {
  const id =
    input.id ??
    (typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    specversion: "1.0",
    id,
    source: "retrieval/hybrid",
    type: "retrieval.completed",
    time: input.time ?? new Date().toISOString(),
    data: {
      denseCount: input.denseCount,
      graphCount: input.graphCount,
      degraded: input.degraded,
    },
  };
}

/**
 * Full hybrid retrieval: dense leg, then graph expansion over the
 * query + dense-hit texts. The dense leg throwing propagates (it
 * is the primary leg); the graph leg degrades, never throws.
 */
export async function hybridRetrieve(
  deps: HybridRetrieveDeps,
  input: HybridRetrieveInput,
): Promise<HybridRetrievalResult> {
  const dense = await deps.vector.searchDense(input.query, {
    topK: input.topK,
    filter: input.denseFilter,
  });
  let graph: GraphContextRow[] = [];
  let degraded = false;
  let graphError: string | undefined;
  if (deps.graph) {
    const expanded = await expandGraphContext(
      deps.graph,
      input.tenantId,
      input.query,
      dense.map((d) => d.text),
      { graphTopK: input.graphTopK, log: deps.log },
    );
    graph = expanded.rows;
    degraded = expanded.degraded;
    graphError = expanded.graphError;
  }
  if (deps.emit) {
    try {
      await deps.emit(
        toRetrievalCompletedEnvelope({
          denseCount: dense.length,
          graphCount: graph.length,
          degraded,
        }),
      );
    } catch (err) {
      const log = deps.log ?? ((message: string) => structuredLog.warn("retrieval.log", { message }));
      log(
        `[retrieval] retrieval.completed emission failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return graphError !== undefined
    ? { dense, graph, degraded, graphError }
    : { dense, graph, degraded };
}
