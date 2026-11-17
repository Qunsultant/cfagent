/**
 * Issue #4673 (matrix gap 19) — the Public data adapter's settings.
 *
 * The provider's wire vocabulary (period / aggregation / instrument
 * type) and the account-activity page size are DATA, not code: they
 * live in `config/public-data.json` so a schema or policy change is a
 * configuration change, never a source edit. This module is the one
 * loader — nothing else may hardcode a period name, an aggregation
 * name, or the activity page size.
 *
 * A request the configuration cannot answer is refused by name
 * (never silently served as a daily bar), and a limit past the
 * configured ceiling throws rather than truncating behind the
 * caller's back (gitops §17.3, no silent truncation).
 */
import raw from "../../config/public-data.json";

export interface PublicBarsRequest {
  /** The provider's own period token (e.g. QUARTER). */
  period: string;
  /** The provider's own aggregation token (e.g. ONE_DAY). */
  aggregation: string;
  /** Bars asked for; <= the configured ceiling. */
  limit: number;
}

interface PublicDataSettings {
  activity: { pageSize: number };
  bars: {
    instrumentType: string;
    defaultLimit: number;
    maxLimit: number;
    defaultPeriod: string;
    intradayPeriod: string;
    intradayAggregations: string[];
    aggregations: Record<string, string>;
    periodsByLimit: Array<{ maxLimit: number; period: string }>;
  };
}

const settings = raw as PublicDataSettings;

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`config/public-data.json: ${name} must be a positive integer.`);
  }
  return value;
}

/** The account-activity page size the history read asks for. */
export function publicActivityPageSize(): number {
  return positiveInt(settings.activity.pageSize, "activity.pageSize");
}

/** The instrument type the bar read declares (equity; the neutral engines are equity). */
export function publicBarsInstrumentType(): string {
  const value = settings.bars.instrumentType;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("config/public-data.json: bars.instrumentType must be a non-empty string.");
  }
  return value;
}

/**
 * Map a neutral timeframe + bar count onto the provider's own period
 * and aggregation vocabulary, using only the configured tables.
 *
 * - a timeframe the aggregation table does not name is refused;
 * - an intraday aggregation uses the configured intraday period
 *   (the provider's day window) and returns the tail on read;
 * - a daily/weekly/monthly aggregation picks the smallest configured
 *   period that covers the requested bar count.
 */
export function resolvePublicBarsRequest(timeframe?: string, limit?: number): PublicBarsRequest {
  const requestedLimit = limit === undefined ? settings.bars.defaultLimit : limit;
  if (typeof requestedLimit !== "number" || !Number.isFinite(requestedLimit) || requestedLimit < 1) {
    throw new Error(`A bar limit must be a positive number; received ${String(limit)}.`);
  }
  const maxLimit = positiveInt(settings.bars.maxLimit, "bars.maxLimit");
  if (requestedLimit > maxLimit) {
    throw new Error(
      `The bar limit ${requestedLimit} exceeds the configured ceiling ${maxLimit}; refusing to truncate silently.`
    );
  }

  const normalized = String(timeframe ?? "1D").trim().toUpperCase();
  const aggregation = settings.bars.aggregations[normalized];
  if (!aggregation) {
    throw new Error(
      `Unsupported bar timeframe "${timeframe}"; this provider's configured aggregations are ${Object.keys(
        settings.bars.aggregations
      ).join(", ")}.`
    );
  }

  if (settings.bars.intradayAggregations.includes(aggregation)) {
    return {
      period: settings.bars.intradayPeriod,
      aggregation,
      limit: Math.floor(requestedLimit),
    };
  }

  const cover = settings.bars.periodsByLimit.find((entry) => requestedLimit <= entry.maxLimit);
  return {
    period: cover?.period ?? settings.bars.defaultPeriod,
    aggregation,
    limit: Math.floor(requestedLimit),
  };
}
