/**
 * Issue #1888: daily enrichment + minute bars — domain ports.
 *
 * Port-first: this module depends on no provider, store, or runtime.
 * Providers are always named (Yahoo, Alpaca); selection rides the
 * existing feature-flag port (`enrichment_alpaca`), never a new flag
 * system. The recursive-self-improvement (RSI) loop here is the
 * repo's measure/report/calibrate loop (#1742), NOT an indicator.
 *
 * Discipline carried from #1743: envelopes and run summaries carry
 * counts + ids only — never prices, thesis text, or secrets.
 * Discipline carried from #1745: provider failure degrades to a
 * fallback or a qualified partial, never a hard failure (the
 * service layer owns that; this module owns the pure rules).
 */

import type { MessageEnvelope } from "../messaging/messagingPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "enrichment/enrichmentPorts",
});

/** Existing feature-flag port name for Alpaca enrichment. */
export const ENRICHMENT_ALPACA_FLAG = "enrichment_alpaca";

/** Dedicated manual killswitch key for this loop (distinct from the
 *  global #756 `adaptation.killSwitch`). Stored in the same
 *  settings table the global halt reads, so either switch stops
 *  this loop; the keys never alias. */
export const ENRICHMENT_KILLSWITCH_KEY = "enrichment.killSwitch";

export type EnrichmentProviderId = "yahoo" | "alpaca";

/**
 * Selection modes. `alpaca-fallback` is the flag-on shape: Alpaca
 * primary with Yahoo fallback. There is no flag-on pure-Alpaca
 * mode: an unconfigured or failing Alpaca must degrade, not die.
 */
export type EnrichmentMode = "yahoo" | "alpaca-fallback";

export interface EnrichmentSelection {
  mode: EnrichmentMode;
  primary: EnrichmentProviderId;
  fallback: EnrichmentProviderId | null;
  reason: string;
}

/**
 * Resolve the active provider from the flag + Alpaca configuration.
 * Fail-safe: flag on but Alpaca unconfigured (no keys) selects
 * Yahoo — the code never invents credentials or blocks on them.
 */
export function resolveEnrichmentSelection(opts: {
  alpacaFlagOn: boolean;
  alpacaConfigured: boolean;
}): EnrichmentSelection {
  if (!opts.alpacaFlagOn) {
    return {
      mode: "yahoo",
      primary: "yahoo",
      fallback: null,
      reason: "enrichment_alpaca flag off — Yahoo active",
    };
  }
  if (!opts.alpacaConfigured) {
    return {
      mode: "yahoo",
      primary: "yahoo",
      fallback: null,
      reason:
        "enrichment_alpaca flag on but Alpaca unconfigured — fail-safe to Yahoo",
    };
  }
  return {
    mode: "alpaca-fallback",
    primary: "alpaca",
    fallback: "yahoo",
    reason: "enrichment_alpaca flag on — Alpaca primary with Yahoo fallback",
  };
}

/** Yahoo minute intervals (60Min is the documented alias for 1h). */
export const YAHOO_MINUTE_INTERVALS = [1, 2, 5, 15, 30, 60, 90] as const;
/** Alpaca minute intervals: every whole minute 1–59. */
export const ALPACA_MINUTE_MAX = 59;

export const DEFAULT_MINUTE_TIMEFRAME = "1Min";
export const DAILY_TIMEFRAME = "1D";

export function isMinuteTimeframe(timeframe: string): boolean {
  return /^\d+MIN$/i.test(timeframe.trim());
}

export type MinuteResolution =
  | { supported: true; minutes: number }
  | { supported: false; error: string };

/**
 * Validate a minute timeframe for a provider BEFORE any fetch, so an
 * unsupported interval fails explicit instead of silently serving
 * daily bars. Only the MIN suffix denotes minutes ("15M" is monthly).
 */
export function resolveMinuteTimeframe(
  provider: EnrichmentProviderId,
  timeframe: string,
): MinuteResolution {
  const match = timeframe.trim().match(/^(\d+)MIN$/i);
  if (!match) {
    return {
      supported: false,
      error: `Timeframe "${timeframe}" is not a minute timeframe (expected NMin)`,
    };
  }
  const minutes = Number(match[1]);
  if (provider === "yahoo") {
    if ((YAHOO_MINUTE_INTERVALS as readonly number[]).includes(minutes)) {
      return { supported: true, minutes };
    }
    return {
      supported: false,
      error:
        `Unsupported Yahoo minute timeframe "${timeframe}": ` +
        `minute intervals are 1m/2m/5m/15m/30m/90m (60Min aliases to 1h)`,
    };
  }
  if (minutes >= 1 && minutes <= ALPACA_MINUTE_MAX) {
    return { supported: true, minutes };
  }
  return {
    supported: false,
    error:
      `Unsupported Alpaca minute timeframe "${timeframe}": ` +
      `minute timeframes are 1–59Min`,
  };
}

export interface Coverage {
  requested: number;
  served: number;
  failed: number;
  partial: boolean;
  coveragePct: number;
}

export function computeCoverage(requested: number, served: number): Coverage {
  const failed = Math.max(0, requested - served);
  return {
    requested,
    served,
    failed,
    partial: failed > 0,
    coveragePct: requested === 0 ? 100 : Math.round((served / requested) * 100),
  };
}

/** Minimal key/value reader for the killswitch (settings table or memory). */
export interface KillswitchReader {
  getValue(key: string): string | null | undefined;
}

export type EnrichmentKillswitchState = "halted" | "clear";

export function parseKillswitchValue(
  value: string | null | undefined,
): EnrichmentKillswitchState {
  if (value == null) return "clear";
  const v = String(value).trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" ? "halted" : "clear";
}

/**
 * Read the dedicated killswitch, mirroring `isAdaptationHalted`:
 * an unreadable state fails CLOSED (thrown), never silently clear —
 * a safety switch that cannot be read is treated as thrown.
 */
export function isEnrichmentKillswitchThrown(
  reader: KillswitchReader,
): boolean {
  try {
    return parseKillswitchValue(reader.getValue(ENRICHMENT_KILLSWITCH_KEY)) === "halted";
  } catch (err) {
    structuredLog.error("enrichment.killswitch_read_failed", {
      message: "[Enrichment] Killswitch read failed; halting enrichment (fail-closed)",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
    });
    return true;
  }
}

/** Either switch stops this loop: dedicated OR global halt. */
export function enrichmentLoopStopped(opts: {
  killswitchThrown: boolean;
  globalHalted: boolean;
}): boolean {
  return opts.killswitchThrown || opts.globalHalted;
}

export interface EnrichmentBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EnrichmentSymbolResult {
  symbol: string;
  served: boolean;
  complete: boolean;
  quote: boolean;
  fundamentals: boolean;
  fundamentalsProvider: EnrichmentProviderId | null;
  dailyBars: number;
  minuteBars: number;
  provider: EnrichmentProviderId | null;
  fallbackUsed: boolean;
  error?: string;
}

export interface BreakerStateView {
  providerId: string;
  state: string;
}

/**
 * One enrichment run, persisted as the stage-persisted output for a
 * job + stage (Feed/Gather per #1737). Addressable by job + stage,
 * resumable by re-running the same job + stage. Bars themselves are
 * NOT stored here — this record is coverage + accounting; the
 * per-symbol payloads ride the existing stage output.
 */
export interface EnrichmentRunRecord {
  id: string;
  jobId: string;
  stage: "feed" | "gather";
  provider: EnrichmentProviderId;
  mode: EnrichmentMode;
  minuteTimeframe: string;
  symbolsRequested: number;
  symbolsServed: number;
  barsFetched: number;
  dailyBars: number;
  minuteBars: number;
  fallbacks: number;
  errors: string[];
  partial: boolean;
  stopped: boolean;
  stopReason?: string;
  breakerState: BreakerStateView[];
  killswitchState: EnrichmentKillswitchState;
  createdAt: string;
  results: EnrichmentSymbolResult[];
}

export interface EnrichmentRunStore {
  recordRun(run: EnrichmentRunRecord): Promise<void> | void;
  listRuns(limit?: number): Promise<EnrichmentRunRecord[]> | EnrichmentRunRecord[];
}

export interface ProviderQuality {
  runs: number;
  successes: number;
  failures: number;
  barsFetched: number;
  coveragePct: number;
}

export interface EnrichmentQualitySummary {
  runs: number;
  symbolsRequested: number;
  symbolsServed: number;
  barsFetched: number;
  fallbacks: number;
  partialRuns: number;
  stoppedRuns: number;
  coveragePct: number;
  byProvider: Record<EnrichmentProviderId, ProviderQuality>;
}

/** Quality summary over run records — the telemetry feed for this loop. */
export function summarizeEnrichmentQuality(
  records: readonly EnrichmentRunRecord[],
): EnrichmentQualitySummary {
  const empty = (): ProviderQuality => ({
    runs: 0,
    successes: 0,
    failures: 0,
    barsFetched: 0,
    coveragePct: 100,
  });
  const byProvider: Record<EnrichmentProviderId, ProviderQuality> = {
    yahoo: empty(),
    alpaca: empty(),
  };
  let symbolsRequested = 0;
  let symbolsServed = 0;
  let barsFetched = 0;
  let fallbacks = 0;
  let partialRuns = 0;
  let stoppedRuns = 0;
  for (const r of records) {
    const q = byProvider[r.provider];
    q.runs += 1;
    q.barsFetched += r.barsFetched;
    if (r.stopped) {
      stoppedRuns += 1;
    } else if (r.partial) {
      q.failures += 1;
      partialRuns += 1;
    } else {
      q.successes += 1;
    }
    symbolsRequested += r.symbolsRequested;
    symbolsServed += r.symbolsServed;
    barsFetched += r.barsFetched;
    fallbacks += r.fallbacks;
  }
  for (const q of Object.values(byProvider)) {
    const judged = q.successes + q.failures;
    q.coveragePct = judged === 0 ? 100 : Math.round((q.successes / judged) * 100);
  }
  return {
    runs: records.length,
    symbolsRequested,
    symbolsServed,
    barsFetched,
    fallbacks,
    partialRuns,
    stoppedRuns,
    coveragePct:
      symbolsRequested === 0
        ? 100
        : Math.round((symbolsServed / symbolsRequested) * 100),
    byProvider,
  };
}

/** CloudEvents envelope for a completed run — counts + ids only. */
export function toEnrichmentCompletedEnvelope(
  run: EnrichmentRunRecord,
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `enrichment.completed:${run.id}`,
    source: "enrichment",
    type: "enrichment.completed",
    time: run.createdAt,
    subject: run.jobId,
    jobid: run.jobId,
    stage: run.stage,
    data: {
      runId: run.id,
      jobId: run.jobId,
      stage: run.stage,
      provider: run.provider,
      mode: run.mode,
      symbolsRequested: run.symbolsRequested,
      symbolsServed: run.symbolsServed,
      barsFetched: run.barsFetched,
      fallbacks: run.fallbacks,
      partial: run.partial,
      stopped: run.stopped,
    },
  };
}

/** CloudEvents envelope for a killswitch change — state + actor id only. */
export function toEnrichmentKillswitchEnvelope(input: {
  state: EnrichmentKillswitchState;
  setBy: string;
  atMs: number;
}): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `enrichment.killswitch_changed:${input.atMs}:${input.state}`,
    source: "enrichment",
    type: "enrichment.killswitch_changed",
    time: new Date(input.atMs).toISOString(),
    data: { state: input.state, setBy: input.setBy },
  };
}

export interface EnrichmentCalibrationProposal {
  id: string;
  action: "consider-provider-flip";
  fromProvider: EnrichmentProviderId;
  toProvider: EnrichmentProviderId;
  reason: string;
  proposedAtMs: number;
  /** Governed pattern: proposed only. Application is a human flag
   *  flip by the operator — this system never rewrites selection
   *  itself, and never applies while the loop is stopped. */
  status: "proposed";
}

/**
 * Propose (never apply) a provider flip when the active provider's
 * failure rate clears the threshold over enough runs. Returns null
 * below the sample floor or the threshold: no proposal, no noise.
 */
export function buildEnrichmentCalibrationProposal(
  summary: EnrichmentQualitySummary,
  opts: { alpacaConfigured: boolean; minRuns?: number; failureRateThreshold?: number },
): EnrichmentCalibrationProposal | null {
  const minRuns = opts.minRuns ?? 5;
  const threshold = opts.failureRateThreshold ?? 0.5;
  const candidates: EnrichmentProviderId[] = ["alpaca", "yahoo"];
  for (const provider of candidates) {
    const q = summary.byProvider[provider];
    const judged = q.successes + q.failures;
    if (judged < minRuns) continue;
    const failureRate = q.failures / judged;
    if (failureRate <= threshold) continue;
    const toProvider: EnrichmentProviderId =
      provider === "alpaca" ? "yahoo" : "alpaca";
    if (toProvider === "alpaca" && !opts.alpacaConfigured) continue;
    return {
      id: `enrichment-calibration:${provider}:${Date.now()}`,
      action: "consider-provider-flip",
      fromProvider: provider,
      toProvider,
      reason:
        `${provider} failed ${q.failures}/${judged} recent enrichment runs ` +
        `(failure rate ${(failureRate * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}% threshold); ` +
        `operator may flip the ${ENRICHMENT_ALPACA_FLAG} flag to ${toProvider}`,
      proposedAtMs: Date.now(),
      status: "proposed",
    };
  }
  return null;
}
