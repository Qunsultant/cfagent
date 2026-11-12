/**
 * #4065 — the dataset-backed option chain source: an
 * OptionChainSource that answers from a persisted
 * options-chains feed artifact instead of a live broker
 * client. This is the seam through which chainFetch consumes
 * a persisted dataset: the options workflow builds its
 * screener on this source (with the artifact the feed step
 * just produced) instead of on the entry's live client, and
 * the screener's fetchChains runs identically — same chains,
 * same fetchErrors, same terminal — because the source
 * answers the same two questions from stored rows.
 *
 * Deterministic by construction: a dataset read never fetches,
 * never retries, never charges a budget. The source does NOT
 * set supportsOptionRequestBudget (it meters nothing — there
 * is no outbound call to meter); the screener then spends its
 * own budget bookkeeping per symbol, exactly as it does for
 * any unmetered source. A symbol with no row answers [] / null
 * (uncovered, not an error — the screener names it in
 * fetchErrors, as it does for a live miss); an expiry the row
 * does not carry answers null.
 *
 * Chain→expiry matching is by the chain's selectedExpiry stamp
 * (the feed runner guarantees the stamp names the expiry the
 * chain was fetched for). The positional fallback (the i-th
 * chain is the i-th expiry's) applies ONLY when the row is
 * complete (chains.length === expiries.length) — a row with a
 * failed fetch is shorter, and positional matching there would
 * serve the wrong expiry's chain. An unscoped request (no
 * expiry) answers the nearest expiry's chain — the first
 * stored, rows being stored in ascending-expiry order — the
 * dataset equivalent of the live unscoped fetch.
 */
import type {
  BrokerOptionChain,
  BrokerOptionExpireDate,
} from "../types";
import type {
  OptionChainParams,
  OptionChainSource,
} from "../trading";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedOptionsChainRow,
} from "../data/feedDatasetPorts";
import type { DataProviderId } from "../trading";

function expiryKey(expiry: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${expiry.year}-${expiry.month}-${expiry.day}`;
}

/**
 * Build a source over one persisted chains artifact. Pure: the
 * artifact is the only input — a read NEVER fetches.
 */
export function createDatasetOptionChainSource(
  artifact: FeedDatasetArtifact,
): OptionChainSource {
  const bySymbol = new Map<string, FeedOptionsChainRow>();
  for (const row of artifact.chains ?? []) {
    const symbol = row.symbol.toUpperCase();
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, row);
  }
  return {
    async getOptionExpireDates(
      symbol: string,
    ): Promise<BrokerOptionExpireDate[]> {
      const row = bySymbol.get(symbol.toUpperCase());
      return row ? [...row.expiries] : [];
    },
    async getOptionChains(
      params: OptionChainParams,
    ): Promise<BrokerOptionChain | null> {
      const row = bySymbol.get(params.symbol.toUpperCase());
      if (!row || row.chains.length === 0) return null;
      if (
        params.expiryYear === undefined ||
        params.expiryMonth === undefined ||
        params.expiryDay === undefined
      ) {
        return row.chains[0] ?? null;
      }
      const wanted = `${params.expiryYear}-${params.expiryMonth}-${params.expiryDay}`;
      const stamped = row.chains.find(
        (chain) =>
          chain.selectedExpiry &&
          expiryKey(chain.selectedExpiry) === wanted,
      );
      if (stamped) return stamped;
      if (row.chains.length === row.expiries.length) {
        const index = row.expiries.findIndex(
          (expiry) => expiryKey(expiry) === wanted,
        );
        return index >= 0 ? (row.chains[index] ?? null) : null;
      }
      return null;
    },
  };
}

/** One persisted-chains read: rows by symbol + provenance. */
export interface PersistedOptionsChainsRead {
  /** Chain rows per symbol (the producing run's rows, verbatim). */
  chainsBySymbol: Map<string, FeedOptionsChainRow>;
  /** The label for these rows (names the persisted source). */
  label: string;
  /** When the rows were fetched (the producing run's finish time). */
  asOf: string;
  /** The universe whose copy this is (rows are per-symbol facts;
   *  the universe names which list — or which explicit symbols —
   *  the job pulled, not a filter). */
  universeLabel: string;
  ageSeconds: number;
  /** True when the copy is older than the caller's bound (or,
   *  absent a bound, reported false — staleness is judged only
   *  against a bound the caller actually set). */
  stale: boolean;
}

/**
 * Read the newest usable chains copy for one source. A read
 * NEVER fetches — the store is the only input. Absent or
 * unusable ⇒ undefined (the caller falls back to the live
 * fetch); a stale copy is returned WITH stale: true so the
 * caller can fall back to live instead of serving old chains
 * as current.
 */
export async function readPersistedOptionsChains(
  store: FeedDatasetStore,
  sourceId: DataProviderId,
  args: {
    maxAgeSeconds?: number;
    nowMs: number;
  },
): Promise<PersistedOptionsChainsRead | undefined> {
  const artifact = await store.latestUsable(sourceId, "options-chains");
  if (!artifact || !artifact.chains || artifact.chains.length === 0) {
    return undefined;
  }
  const chainsBySymbol = new Map<string, FeedOptionsChainRow>();
  for (const row of artifact.chains) {
    const symbol = row.symbol.toUpperCase();
    if (symbol && !chainsBySymbol.has(symbol)) {
      chainsBySymbol.set(symbol, row);
    }
  }
  if (chainsBySymbol.size === 0) return undefined;
  const asOfMs = Date.parse(artifact.asOf);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((args.nowMs - asOfMs) / 1000));
  return {
    chainsBySymbol,
    label: `Persisted ${sourceId} option chains (as of ${artifact.asOf.slice(0, 10)})`,
    asOf: artifact.asOf,
    universeLabel: artifact.universe.label,
    ageSeconds,
    stale: args.maxAgeSeconds !== undefined && ageSeconds > args.maxAgeSeconds,
  };
}
