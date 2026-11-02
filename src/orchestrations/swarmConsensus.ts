/**
 * #1771 (parent #1717) slice B: swarm cross-screener consensus harness.
 *
 * The missing harness from F-46: given the ranked outputs of N
 * independent screener sources (agents, runs, or strategies — the
 * caller names each source, this module never invents one), produce
 * a DRAFT consensus set with per-symbol agreement and the dissent
 * list. Pure module: no I/O, no network, no orders, no trades.
 *
 * Hard rules:
 * - DRAFT ONLY. A consensus set is data for a human / downstream
 *   screener consumer; nothing here places, previews, or submits
 *   an order, and nothing here feeds the trade-approval workflow
 *   (a consensus symbol is not a trade proposal).
 * - Attribution is mandatory: duplicate source names throw (two
 *   outputs claiming to be the same source would double-count one
 *   voice as two), and an empty source list throws (consensus
 *   over zero voices is undefined, not empty).
 * - A symbol listed twice by ONE source counts once for that
 *   source (a source cannot vote twice for its own pick).
 * - minSources (default 2): a symbol needs at least this many
 *   distinct sources AND agreement >= minAgreement (default 0.5,
 *   majority) to enter the consensus set. A lone source's pick
 *   is dissent, never consensus, even at agreement 1.0 of 1.
 * - Ordering is deterministic: consensus by agreement desc, then
 *   mean rank asc, then symbol asc; dissent by symbol asc.
 */

export interface SwarmScreenerSymbol {
  symbol: string;
  /** 1-based rank within the source, when the source ranked it. */
  rank?: number;
}

export interface SwarmScreenerOutput {
  source: string;
  symbols: SwarmScreenerSymbol[];
}

export interface SwarmConsensusSymbol {
  symbol: string;
  sources: string[];
  /** sources.length / total sources, 0..1. */
  agreement: number;
  /** Mean of the ranks the source gave it (null when no source ranked it). */
  meanRank: number | null;
}

export interface SwarmConsensus {
  status: "DRAFT";
  sourcesCount: number;
  minAgreement: number;
  minSources: number;
  consensus: SwarmConsensusSymbol[];
  /** Symbols that did not reach consensus, with their sources (never silently dropped). */
  dissent: Array<{ symbol: string; sources: string[] }>;
}

export function computeSwarmConsensus(
  outputs: SwarmScreenerOutput[],
  opts: { minAgreement?: number; minSources?: number } = {},
): SwarmConsensus {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("swarm consensus: at least one screener source is required");
  }
  const seenSources = new Set<string>();
  for (const o of outputs) {
    if (typeof o.source !== "string" || !o.source.trim()) {
      throw new Error("swarm consensus: every source must carry a non-empty name");
    }
    if (seenSources.has(o.source)) {
      throw new Error(`swarm consensus: duplicate source name "${o.source}" — attribution must be unique`);
    }
    seenSources.add(o.source);
  }
  const minAgreement = opts.minAgreement ?? 0.5;
  const minSources = opts.minSources ?? 2;
  if (!(minAgreement > 0 && minAgreement <= 1)) {
    throw new Error(`swarm consensus: minAgreement must be in (0, 1], got ${minAgreement}`);
  }
  if (!Number.isInteger(minSources) || minSources < 1) {
    throw new Error(`swarm consensus: minSources must be a positive integer, got ${minSources}`);
  }
  const bySymbol = new Map<string, { sources: string[]; ranks: number[] }>();
  for (const o of outputs) {
    const once = new Set<string>();
    for (const s of o.symbols) {
      if (typeof s.symbol !== "string" || !s.symbol.trim() || once.has(s.symbol)) continue;
      once.add(s.symbol);
      let entry = bySymbol.get(s.symbol);
      if (!entry) {
        entry = { sources: [], ranks: [] };
        bySymbol.set(s.symbol, entry);
      }
      entry.sources.push(o.source);
      if (typeof s.rank === "number" && Number.isFinite(s.rank)) entry.ranks.push(s.rank);
    }
  }
  const consensus: SwarmConsensusSymbol[] = [];
  const dissent: Array<{ symbol: string; sources: string[] }> = [];
  for (const [symbol, entry] of bySymbol) {
    const agreement = entry.sources.length / outputs.length;
    const meanRank =
      entry.ranks.length > 0
        ? entry.ranks.reduce((a, b) => a + b, 0) / entry.ranks.length
        : null;
    const row: SwarmConsensusSymbol = {
      symbol,
      sources: [...entry.sources].sort(),
      agreement,
      meanRank,
    };
    if (entry.sources.length >= minSources && agreement >= minAgreement) {
      consensus.push(row);
    } else {
      dissent.push({ symbol, sources: row.sources });
    }
  }
  consensus.sort(
    (a, b) =>
      b.agreement - a.agreement ||
      (a.meanRank ?? Infinity) - (b.meanRank ?? Infinity) ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
  dissent.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { status: "DRAFT", sourcesCount: outputs.length, minAgreement, minSources, consensus, dissent };
}
