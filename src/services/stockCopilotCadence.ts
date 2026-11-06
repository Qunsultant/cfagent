/**
 * Issue #3452 — Stock Copilot cycle cadence externalization (AOP).
 *
 * Owner directive (2026-11-06): all Stock Copilot settings are externalized
 * per AOP — cadence included. The cadence defaults to "every 30 minutes",
 * matching the Worker tick floor.
 *
 * Platform Floor:
 * The Worker cron ticks at * /30 (* /30 * * * *). A cadence configured finer
 * than 30 minutes cannot fire more often — the effective cadence is the
 * coarser of the two, and all status/telemetry surfaces report the
 * EFFECTIVE cadence honestly alongside the configured input.
 */

export const DEFAULT_STOCK_COPILOT_SCHEDULE = "every 30 minutes" as const;
export const PLATFORM_MINIMUM_CADENCE_MINUTES = 30;

/** The per-login settings key for mas_settings. */
export const COPILOT_CADENCE_SETTING_KEY = "stock_copilot:cadence";

export interface ResolvedCopilotCadence {
  /** What the configuration requested (e.g. "every 1 hour", "every 15 minutes"). */
  configured: string;
  /** What the platform can honestly execute (floor: 30 minutes). */
  effective: string;
  /** Effective cadence in minutes. */
  minutes: number;
}

/**
 * Parses a human cadence string into integer minutes.
 * Supports:
 * - "every X minutes" / "every X minute"
 * - "every X hours" / "every X hour"
 * - "Xm" / "Xmin" / "X minutes"
 * - "Xh" / "Xhr" / "X hour" / "X hours"
 */
export function parseCadenceMinutes(val: string): number | null {
  if (!val || typeof val !== "string") return null;
  const s = val.trim().toLowerCase();

  // "every 30 minutes", "30 minutes", "30m", "30 min"
  const minMatch = s.match(/^(?:every\s+)?(\d+)\s*(?:m|min|minute|minutes)$/);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    return Number.isFinite(mins) && mins > 0 ? mins : null;
  }

  // "every 1 hour", "every 2 hours", "1h", "2 hrs"
  const hrMatch = s.match(/^(?:every\s+)?(\d+)\s*(?:h|hr|hour|hours)$/);
  if (hrMatch) {
    const hrs = parseInt(hrMatch[1], 10);
    return Number.isFinite(hrs) && hrs > 0 ? hrs * 60 : null;
  }

  return null;
}

/**
 * Normalizes minutes into standard schedule format ("every X minutes" / "every X hour(s)").
 */
export function formatCadenceString(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hrs = minutes / 60;
    return `every ${hrs} hour${hrs === 1 ? "" : "s"}`;
  }
  return `every ${minutes} minutes`;
}

/**
 * Resolves the configured and effective Stock Copilot cadence from
 * 1) mas_settings (`stock_copilot:cadence`)
 * 2) env (`STOCK_COPILOT_CADENCE`)
 * 3) Default fallback ("every 30 minutes")
 */
export function resolveCopilotCadence(deps: {
  env?: { STOCK_COPILOT_CADENCE?: string } | null;
  readSettingRaw?: (key: string) => string | null;
}): ResolvedCopilotCadence {
  // 1. Check user stored setting
  const stored = deps.readSettingRaw?.(COPILOT_CADENCE_SETTING_KEY)
    ?? deps.readSettingRaw?.("stock_copilot_cadence");

  // 2. Check deployment environment
  const envVal = deps.env?.STOCK_COPILOT_CADENCE;

  const rawConfigured = (stored || envVal || DEFAULT_STOCK_COPILOT_SCHEDULE).trim();
  const parsed = parseCadenceMinutes(rawConfigured);

  if (parsed === null) {
    return {
      configured: rawConfigured,
      effective: DEFAULT_STOCK_COPILOT_SCHEDULE,
      minutes: PLATFORM_MINIMUM_CADENCE_MINUTES,
    };
  }

  const configured = formatCadenceString(parsed);
  // Coarsen to platform floor if finer than 30 minutes
  const effectiveMinutes = Math.max(parsed, PLATFORM_MINIMUM_CADENCE_MINUTES);
  const effective = formatCadenceString(effectiveMinutes);

  return {
    configured,
    effective,
    minutes: effectiveMinutes,
  };
}
