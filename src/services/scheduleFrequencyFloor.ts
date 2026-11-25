/**
 * Issue #6482 — the ONE hard-reject helper for schedule arming.
 *
 * Every arming surface refuses through this helper — the REST
 * create route, the agent capability classifier, and the alarms
 * port (the generic arm) — so a below-floor interval or cron is
 * REFUSED with the coded outcome `SCHEDULE_BELOW_FREQUENCY_FLOOR`
 * at arm time, never approval-bound and never armed. The sub-daily
 * opt-in (body.subDailyOptIn) does not reach this helper and cannot
 * override the floor: the opt-in gates sub-daily cadence, the floor
 * gates frequency, and the floor wins.
 *
 * One-shot timings (delayed/scheduled) carry no frequency and pass
 * through. An unparsable cron is refused fail-closed (it cannot be
 * proven at or above the floor).
 *
 * This module is pure and imports nothing from the capability: the
 * classifier (src/services/agentScheduleCapability.ts) calls it, so
 * it cannot live there without a cycle. The cron-gap estimator
 * moved here verbatim from the capability (#3122); the capability
 * re-exports it, so existing import sites keep working.
 */

export const SCHEDULE_BELOW_FREQUENCY_FLOOR = "SCHEDULE_BELOW_FREQUENCY_FLOOR";

/** A timing that carries a frequency (interval or cron) or one that does not (one-shot). */
export type ScheduleFloorTiming =
  | { type: "interval"; intervalSeconds: number }
  | { type: "cron"; cron: string }
  | { type: "scheduled"; time: number }
  | { type: "delayed"; delayInSeconds: number };

/**
 * Estimate the minimum gap between firings of a 5-field cron, in minutes.
 * Minute/hour fields only (the day pattern can only widen the gap, so the
 * estimate is an upper bound on frequency — it errs toward refusal,
 * never away from it). Unparsable ⇒ undefined (the caller refuses
 * on uncertainty).
 */
/**
 * Estimate the minimum gap between consecutive firings of a cron
 * expression, in minutes, or undefined when the expression cannot
 * be parsed (fail-closed: the caller refuses an unparsable cron).
 *
 * Issue #6482 — the estimate is day-aware: it enumerates real
 * occurrences over a five-year horizon from a fixed start and takes
 * the smallest gap, so a monthly or yearly cron is measured by its
 * true cadence, not by its minute/hour fields alone. The previous
 * minute/hour-only estimate capped every cron at a 1440-minute gap,
 * which made every cron arm impossible under the monthly floor.
 * Day matching follows Vixie cron: when both day-of-month and
 * day-of-week are restricted, either matches; when one is `*`, the
 * other governs. The horizon covers February (a 1st-of-month cron's
 * tightest gap is 28 days, below the 30-day floor — strict by
 * design) and leap years. Enumeration exits early at a 1-minute gap
 * (the cron resolution), so dense patterns cost almost nothing.
 */
export function estimateCronMinGapMinutes(cron: string): number | undefined {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return undefined;
  const parseField = (field: string, min: number, max: number): Set<number> | undefined => {
    const values = new Set<number>();
    const addRange = (lo: number, hi: number, step: number): boolean => {
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || !Number.isSafeInteger(step)) return false;
      if (lo < min || hi > max || lo > hi || step <= 0) return false;
      for (let v = lo; v <= hi; v += step) values.add(v);
      return true;
    };
    for (const part of field.split(",")) {
      if (part === "*") {
        if (!addRange(min, max, 1)) return undefined;
      } else if (part.startsWith("*/")) {
        const step = Number(part.slice(2));
        if (!addRange(min, max, step)) return undefined;
      } else if (part.includes("/")) {
        const [range, stepText] = part.split("/");
        const step = Number(stepText);
        if (range.includes("-")) {
          const [lo, hi] = range.split("-").map(Number);
          if (!addRange(lo, hi, step)) return undefined;
        } else {
          const lo = Number(range);
          if (!addRange(lo, max, step)) return undefined;
        }
      } else if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number);
        if (!addRange(lo, hi, 1)) return undefined;
      } else {
        const v = Number(part);
        if (!Number.isSafeInteger(v) || v < min || v > max) return undefined;
        values.add(v);
      }
    }
    return values.size > 0 ? values : undefined;
  };
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);
  if (!minutes || !hours || !dom || !months || !dowRaw) return undefined;
  // Day-of-week 7 is Sunday (0).
  const dow = new Set<number>([...dowRaw].map((v) => (v === 7 ? 0 : v)));
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const sortedMinutes = [...minutes].sort((a, b) => a - b);
  const sortedHours = [...hours].sort((a, b) => a - b);
  const startMs = Date.UTC(2026, 0, 1);
  const dayMs = 86_400_000;
  let previous: number | undefined;
  let minGap: number | undefined;
  for (let day = 0; day < 5 * 366; day++) {
    const date = new Date(startMs + day * dayMs);
    const month = date.getUTCMonth() + 1;
    if (!months.has(month)) continue;
    const domMatch = dom.has(date.getUTCDate());
    const dowMatch = dow.has(date.getUTCDay());
    const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domRestricted ? domMatch : dowRestricted ? dowMatch : true;
    if (!dayMatch) continue;
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const at = day * 1440 + hour * 60 + minute;
        if (previous !== undefined) {
          const gap = at - previous;
          if (minGap === undefined || gap < minGap) minGap = gap;
          if (minGap === 1) return 1;
        }
        previous = at;
      }
    }
  }
  return minGap;
}

export type BelowFloorRefusal =
  | { ok: true }
  | { ok: false; code: typeof SCHEDULE_BELOW_FREQUENCY_FLOOR; message: string; error: ScheduleBelowFrequencyFloorError };

/**
 * The one hard-reject check. A below-floor interval or cron gap is
 * refused with the coded outcome; an at-or-above-floor timing and
 * any one-shot timing pass. The floor arrives resolved (managed >
 * env > default) — this helper never reads configuration itself.
 */
export function refuseBelowFloorTiming(
  timing: ScheduleFloorTiming,
  floorSeconds: number,
): BelowFloorRefusal {
  const refuse = (message: string): BelowFloorRefusal => ({
    ok: false,
    code: SCHEDULE_BELOW_FREQUENCY_FLOOR,
    message,
    error: new ScheduleBelowFrequencyFloorError(message),
  });
  if (timing.type === "interval") {
    if (typeof timing.intervalSeconds !== "number" || !Number.isFinite(timing.intervalSeconds) || timing.intervalSeconds <= 0) {
      return refuse(
        `${SCHEDULE_BELOW_FREQUENCY_FLOOR}: interval ${String(timing.intervalSeconds)}s is not a positive interval.`,
      );
    }
    if (timing.intervalSeconds < floorSeconds) {
      return refuse(
        `${SCHEDULE_BELOW_FREQUENCY_FLOOR}: interval ${timing.intervalSeconds}s is below the configured floor ${floorSeconds}s — the schedule was not armed.`,
      );
    }
    return { ok: true };
  }
  if (timing.type === "cron") {
    const gapMinutes = estimateCronMinGapMinutes(timing.cron);
    if (gapMinutes === undefined) {
      return refuse(
        `${SCHEDULE_BELOW_FREQUENCY_FLOOR}: cron '${timing.cron}' could not be parsed, so its frequency cannot be proven at or above the floor ${floorSeconds}s — the schedule was not armed.`,
      );
    }
    if (gapMinutes * 60 < floorSeconds) {
      return refuse(
        `${SCHEDULE_BELOW_FREQUENCY_FLOOR}: cron '${timing.cron}' fires about every ${gapMinutes}m, below the configured floor ${floorSeconds}s — the schedule was not armed.`,
      );
    }
    return { ok: true };
  }
  return { ok: true };
}

/** The typed refusal the alarms port throws and the routes map to HTTP 400. */
export class ScheduleBelowFrequencyFloorError extends Error {
  readonly code: typeof SCHEDULE_BELOW_FREQUENCY_FLOOR = SCHEDULE_BELOW_FREQUENCY_FLOOR;
  constructor(message: string) {
    super(message);
    this.name = "ScheduleBelowFrequencyFloorError";
  }
}

/** True when the error is a floor refusal (by code, never by message substring). */
export function isBelowFrequencyFloorError(err: unknown): boolean {
  return (
    err instanceof ScheduleBelowFrequencyFloorError ||
    (typeof err === "object" &&
      err !== null &&
      (err as Record<string, unknown>).code === SCHEDULE_BELOW_FREQUENCY_FLOOR)
  );
}
