/**
 * Issue #4424 — shard-chain dispatch pacing, the single source of truth.
 *
 * The values live in `config/shard-pacing.json`; this module reads them and
 * applies explicit environment overrides (`SHARD_CHAIN_IN_FLIGHT_CAP`,
 * `SHARD_CHAIN_PACE_INTERVAL_MS`, `SHARD_CHAIN_STAGGER_MS`) so a deployment can
 * tune pacing without a code change. No dispatcher hardcodes a number.
 *
 * What the knobs mean:
 * - `inFlightCap` — how many shards of one chain are released in the initial
 *   burst of a dispatch;
 * - `paceIntervalMs` — the spacing applied to every shard released after that
 *   burst, i.e. the dispatch-rate backpressure;
 * - `staggerMs` — the spacing between starts inside the burst (previously the
 *   hardcoded `staggerMs: 1_000` in the scheduled options dispatcher).
 */
import raw from "../../config/shard-pacing.json";

export interface ShardPacing {
  inFlightCap: number;
  paceIntervalMs: number;
  staggerMs: number;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** The configured pacing, with the environment overrides applied. */
export function resolveShardPacing(env: Record<string, unknown> = {}): ShardPacing {
  return {
    inFlightCap: positiveInt(env.SHARD_CHAIN_IN_FLIGHT_CAP, raw.inFlightCap),
    paceIntervalMs: positiveInt(env.SHARD_CHAIN_PACE_INTERVAL_MS, raw.paceIntervalMs),
    staggerMs: positiveInt(env.SHARD_CHAIN_STAGGER_MS, raw.staggerMs),
  };
}

/** The file values, unmodified — the pins read this, never a second copy. */
export const SHARD_PACING: ShardPacing = resolveShardPacing({});
