/**
 * Schedule definitions for autonomous agent triggers.
 *
 * The ScheduledAgent Durable Object (src/agents/scheduled-agent.ts)
 * consumes these on each cron tick: it pulls active goals from SQL,
 * budget-checks via PaymentsAgent, and creates Orchestrator jobs —
 * except goals whose operation is "social.publish", which it executes
 * through the social goal executor instead (issue #1077 Phase 5b).
 */
import { DEFAULT_SCHEDULE_DUE_GUARD_MS } from "./config/scheduleDueGuard";


export interface ScheduledGoal {
  id: string;
  name: string;
  /** Cron expression for when this goal should be evaluated */
  cron: string;
  /** Agent operation to invoke (from the orchestrate.ts catalog) */
  operation: string;
  /** Max spend per evaluation, in cents */
  budgetCents: number;
  /** Whether this goal is currently active */
  enabled: boolean;
  /** Execution strategy selected at creation; legacy records default to deterministic. */
  executionMode?: "deterministic" | "agentic-loop";
  /** Last time this goal was evaluated (ISO timestamp) */
  lastRun?: string;
  /**
   * IANA time zone the cron wall-clock is read in. Absent means the
   * historical UTC behavior of isDue (see below). Goals created with
   * a timeZone use zone wall-clock matching instead.
   */
  timeZone?: string;
  /**
   * Issue #4235 — explicit per-schedule opt-in to a sub-daily
   * cadence. Absent (the default) means the schedule runs at most
   * once per day: a sub-daily cron is capped by isDue's 23h guard,
   * and creation/update refuse a sub-daily timing without this flag.
   * Set only by an explicit owner opt-in, recorded here at creation
   * (addGoal) or update (resolveScheduleUpdate) — never inferred,
   * never defaulted.
   */
  subDailyOptIn?: boolean;
  /**
   * Issue #3121 S1 — creation provenance (#2366 items 3–4, on the
   * consolidated path). Stamped at creation by the creating route;
   * carried with the goal thereafter. Absent on legacy goals whose
   * creation predates stamping — "not recorded", never backfilled.
   */
  provenance?: ScheduleProvenance;
}

export const AGENTIC_LOOP_UNAVAILABLE_REASON =
  "Agentic-loop scheduling requires valid owner-managed turn, duration, and model-token bounds with the kill switch enabled.";

/**
 * Issue #3121 S1 — schedule creation provenance (#2366 items 3–4).
 *
 * Travels in the schedule payload (the SDK-owned table schema is
 * untouched: the payload is the app's JSON blob on the row). `origin`
 * is who created the schedule: a user-facing route (`user`), an
 * agent acting for a tenant (`agent`, #3122 — `agentId` names the
 * acting agent), or framework machinery (`system`). `createdBy` is
 * the creator identity when one was established at creation — the
 * session login for a user create, the principal login for an agent
 * create, `"system"` for framework-internal rows — and `null` when no
 * creator identity was established (recorded explicitly, never
 * invented). `reason` names the framework cause for system rows
 * (`"recovery"` for recovery re-arms, `"async-job-arm"` for the
 * executeAsyncJob arming); user rows carry it only when the creator
 * supplied one. `createdAt` is the creation ISO timestamp.
 */
export interface ScheduleProvenance {
  origin: "user" | "system" | "agent";
  createdBy: string | null;
  /** Issue #3122 — the acting agent id for `origin: "agent"` rows. */
  agentId?: string;
  reason?: string;
  createdAt: string;
}

export interface ScheduleTick {
  timestamp: string;
  goalsEvaluated: number;
  jobsCreated: number;
  jobsSkipped: number;
  errors: string[];
}

import { getBuiltinScheduledGoals } from "./config/builtinScheduledGoals";

/**
 * Default schedules. Goals themselves live in the ScheduledAgent's
 * SQL; these are the built-in evaluations that ship with the system.
 * Stored goals are seeded from this list only when storage is empty,
 * so adding an entry here does not inject it into already-running
 * deployments — an operator adds it via the schedule dashboard API.
 *
 * Issue #4253 — the values live in
 * `config/builtin-scheduled-goals.json`, read through
 * `src/config/builtinScheduledGoals.ts`; this export is a derived
 * alias (no literals remain here), kept so the existing pins and
 * readers keep compiling. The per-goal rationale moved to the
 * config port's header with the values.
 */
export const DEFAULT_SCHEDULES: ScheduledGoal[] = getBuiltinScheduledGoals();

/** Weekday convention: 0 = Sunday … 6 = Saturday (JS Date convention). */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface ZonedDateParts {
  /** YYYY-MM-DD in the zone. */
  date: string;
  weekday: number;
  hour: number;
  minute: number;
  day: number;
  month: number;
  year: number;
}

/**
 * Wall-clock parts of an instant in an IANA time zone. Pure; throws
 * RangeError for an unknown zone (callers that must never throw, like
 * isDue, catch it and treat the instant as not due).
 */
export function zonedDateParts(nowMs: number, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_NAMES.indexOf(get("weekday") as (typeof WEEKDAY_NAMES)[number]),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    day: Number(get("day")),
    month: Number(get("month")),
    year: Number(get("year")),
  };
}

/**
 * Expand one cron field into its value set, or null when invalid.
 * Supports "*", "*\/step", single values, comma lists, and "a-b"
 * ranges (with an optional "/step"). Values must fall in [min, max].
 */
function expandField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") return null;
    let base = part;
    let step = 1;
    if (part.includes("/")) {
      const segments = part.split("/");
      if (segments.length !== 2) return null;
      [base, ] = segments;
      step = Number(segments[1]);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    if (base === "*") {
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) return null;
      const start = Number(bounds[0]);
      const end = Number(bounds[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < min || end > max || start > end) return null;
      for (let v = start; v <= end; v += step) out.add(v);
    } else {
      if (part.includes("/")) return null;
      const value = Number(base);
      if (!Number.isInteger(value) || value < min || value > max) return null;
      out.add(value);
    }
  }
  return out.size > 0 ? out : null;
}

function isDueInZone(
  cron: string,
  lastRun: string | undefined,
  now: Date,
  timeZone: string,
  opts?: IsDueOptions,
): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  const days = expandField(domField, 1, 31);
  const months = expandField(monthField, 1, 12);
  const weekdaysRaw = expandField(dowField, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return false;
  // Cron convention: 7 is also Sunday.
  const weekdays = new Set([...weekdaysRaw].map((d) => (d === 7 ? 0 : d)));
  const parts = zonedDateParts(now.getTime(), timeZone);
  // Minute window rule (same tolerance as the historical code): any
  // tick inside the matching hour at or after a scheduled minute
  // counts as due; the 23h guard below prevents a second firing.
  const minuteDue = [...minutes].some((m) => m <= parts.minute);
  if (!minuteDue) return false;
  if (!hours.has(parts.hour)) return false;
  if (!days.has(parts.day)) return false;
  if (!months.has(parts.month)) return false;
  if (!weekdays.has(parts.weekday)) return false;
  return dueGuardPassed(cron, lastRun, now, timeZone, opts);
}

/**
 * Whether a cron string is well-formed for isDue: exactly five fields,
 * each expanding to a non-empty value set in its range. Used by
 * addGoal so invalid schedules are rejected at creation, not at the
 * first tick. (isDue itself never throws and returns false instead.)
 */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return fields.every((field, i) => expandField(field, ranges[i][0], ranges[i][1]) !== null);
}

/** Seconds in one day — the default granularity ceiling (issue #4235). */
export const SECONDS_PER_DAY = 86400;

/**
 * Issue #4235 — how many times a cron can fire per day: the number
 * of (minute, hour) pairs its first two fields expand to. Day fields
 * restrict WHICH days fire, never the per-day count. Undefined for
 * an invalid cron.
 */
export function cronRunsPerDay(cron: string): number | undefined {
  if (!isValidCron(cron)) return undefined;
  const fields = cron.trim().split(/\s+/);
  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  if (!minutes || !hours) return undefined;
  return minutes.size * hours.size;
}

/**
 * Issue #4235 — true exactly when a cron can fire more than once a
 * day (and false for an invalid cron, which can never fire).
 */
export function isSubDailyCron(cron: string): boolean {
  return (cronRunsPerDay(cron) ?? 0) > 1;
}

/**
 * Issue #4235 — true exactly for intervals under one day (and above
 * zero): a second or less is not an interval, a day or more is not
 * sub-daily.
 */
export function isSubDailyInterval(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0 && seconds < SECONDS_PER_DAY;
}

/**
 * Issue #4235 — the isDue evaluation options. `subDailyOptIn` is the
 * schedule's recorded opt-in to a sub-daily cadence: without it the
 * 23h guard caps every schedule at one firing per day; with it the
 * guard is per-tick — the schedule fires when its most recent
 * scheduled tick is after its last run, and not twice in one tick.
 *
 * Issue #6503 (G3) — `paused` is the schedule's stored state at
 * the call site: a paused row (state "paused", or a goal with
 * enabled=false) is never due, no matter how due its cron is. The
 * due-check is the single choke point, so the state is enforced
 * here as well as at the call sites that skip paused rows first —
 * a firing path that reaches isDue with a paused row still answers
 * false instead of firing on timing alone.
 */
export interface IsDueOptions {
  subDailyOptIn?: boolean;
  paused?: boolean;
  /**
   * Issue #6503 step 13 — the anti-double-fire guard window in
   * milliseconds, resolved from the managed setting
   * `schedule.dueGuardMs` (managed > env > default 23h). Absent
   * (or non-positive / non-finite) → the default 23h guard, exactly
   * as before: no firing within 23 hours of the last run.
   */
  dueGuardMs?: number;
}

/**
 * The anti-double-fire guard, shared by both isDue branches. Default
 * (no opt-in): no firing within 23 hours of the last run — the daily
 * ceiling. Opted in: the most recent scheduled tick must be after
 * the last run, so a sub-daily schedule fires on its next tick and
 * never twice in one tick. Fail-closed: no attributable tick means
 * not due.
 */
function dueGuardPassed(
  cron: string,
  lastRun: string | undefined,
  now: Date,
  timeZone: string | undefined,
  opts?: IsDueOptions,
): boolean {
  if (!lastRun) return true;
  const last = new Date(lastRun).getTime();
  if (opts?.subDailyOptIn === true) {
    const prevTick = previousCronTickMs(cron, now.getTime(), timeZone);
    if (prevTick === undefined) return false;
    return last < prevTick;
  }
  // Issue #6503 step 13 — the guard window is externalized
  // (`schedule.dueGuardMs`); absent or invalid → the 23h default.
  const guardMs =
    typeof opts?.dueGuardMs === "number" &&
    Number.isFinite(opts.dueGuardMs) &&
    opts.dueGuardMs > 0
      ? opts.dueGuardMs
      : DEFAULT_SCHEDULE_DUE_GUARD_MS;
  return now.getTime() - last >= guardMs;
}

/**
 * Check whether a cron expression is due given the last run time.
 *
 * Issue #4235 — both branches honor all five cron fields (lists,
 * ranges, and steps in every field; weekday 7 is also Sunday), with
 * the same minute-tolerance window: any tick inside the matching
 * hour at or after a scheduled minute counts as due. The historical
 * no-timeZone branch used to read minute/hour only (day fields
 * ignored) and never fired a step hour ("0 *\/6 * * *" mapped
 * through Number() to NaN); that quirk is gone — the step hours
 * fire, and a monthly cron fires monthly, not daily. The 23h guard
 * still caps every schedule at one firing per day by default; a
 * recorded sub-daily opt-in (opts.subDailyOptIn) switches the guard
 * to per-tick instead (see dueGuardPassed). isDue never throws: an
 * unparseable cron or an unknown zone returns false.
 */
export function isDue(
  cron: string,
  lastRun: string | undefined,
  now: Date,
  timeZone?: string,
  opts?: IsDueOptions,
): boolean {
  // Issue #6503 (G3) — a paused row is never due. The guard is
  // first, before any timing read: a paused schedule has no
  // expected tick at all, so the cron match below must not run.
  if (opts?.paused === true) return false;
  if (timeZone === undefined) {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minuteField, hourField, domField, monthField, dowField] = fields;
    const minutes = expandField(minuteField, 0, 59);
    const hours = expandField(hourField, 0, 23);
    const days = expandField(domField, 1, 31);
    const months = expandField(monthField, 1, 12);
    const weekdaysRaw = expandField(dowField, 0, 7);
    if (!minutes || !hours || !days || !months || !weekdaysRaw) return false;
    // Cron convention: 7 is also Sunday.
    const weekdays = new Set([...weekdaysRaw].map((d) => (d === 7 ? 0 : d)));
    // Minute window rule (same tolerance as the zoned branch): any
    // tick inside the matching hour at or after a scheduled minute
    // counts as due.
    const minuteDue = [...minutes].some((m) => m <= now.getUTCMinutes());
    if (!minuteDue) return false;
    if (!hours.has(now.getUTCHours())) return false;
    if (!days.has(now.getUTCDate())) return false;
    if (!months.has(now.getUTCMonth() + 1)) return false;
    if (!weekdays.has(now.getUTCDay())) return false;
    return dueGuardPassed(cron, lastRun, now, undefined, opts);
  }
  try {
    return isDueInZone(cron, lastRun, now, timeZone, opts);
  } catch {
    return false;
  }
}

/**
 * Issue #3788 — the most recent expected cron tick before `nowMs`
 * (start of the matching minute, epoch ms), or undefined when the
 * cron has no tick in the scan window.
 *
 * This is the watchdog's half of isDue: it answers "when should this
 * schedule last have fired?" with the SAME matching rules isDue
 * fires by, so a schedule the firing predicate can never fire is
 * never flagged as missed, and a schedule it should have fired is
 * flagged exactly once per tick.
 *
 * - Without a timeZone the UTC read honors all five fields (lists,
 *   ranges, steps, weekdays; 7 is Sunday) — the same match isDue
 *   applies since #4235 removed the old minute/hour-only read (and
 *   its step-hour never-fires quirk).
 * - With a timeZone the full field match runs against wall-clock
 *   parts in that zone (lists, ranges, steps, weekdays; 7 is Sunday).
 *   The match is EXACT at the minute (unlike isDue's within-hour
 *   minute-tolerance window, which exists because Worker ticks land
 *   up to 30 minutes after the scheduled minute — the expected tick
 *   itself is the scheduled minute).
 * - The scan walks back minute by minute, at most 8 days: a valid
 *   cron whose only tick is older than that (e.g. monthly) has no
 *   attributable tick yet and never alerts. An unparseable cron or
 *   an unknown zone returns undefined (never throws). "UTC" /
 *   "Etc/UTC" take the UTC-parts fast path instead of Intl.
 */
const PREVIOUS_CRON_TICK_SCAN_MINUTES = 8 * 24 * 60;

export function previousCronTickMs(
  cron: string,
  nowMs: number,
  timeZone?: string,
): number | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const startMinute = Math.floor(nowMs / 60000) * 60000;
  if (timeZone === undefined) {
    const minutes = expandField(fields[0], 0, 59);
    const hours = expandField(fields[1], 0, 23);
    const days = expandField(fields[2], 1, 31);
    const months = expandField(fields[3], 1, 12);
    const weekdaysRaw = expandField(fields[4], 0, 7);
    if (!minutes || !hours || !days || !months || !weekdaysRaw) return undefined;
    const weekdays = new Set([...weekdaysRaw].map((d) => (d === 7 ? 0 : d)));
    for (let step = 0; step <= PREVIOUS_CRON_TICK_SCAN_MINUTES; step++) {
      const t = startMinute - step * 60000;
      const d = new Date(t);
      if (!minutes.has(d.getUTCMinutes())) continue;
      if (!hours.has(d.getUTCHours())) continue;
      if (!days.has(d.getUTCDate())) continue;
      if (!months.has(d.getUTCMonth() + 1)) continue;
      if (!weekdays.has(d.getUTCDay())) continue;
      return t;
    }
    return undefined;
  }
  const minutes = expandField(fields[0], 0, 59);
  const hours = expandField(fields[1], 0, 23);
  const days = expandField(fields[2], 1, 31);
  const months = expandField(fields[3], 1, 12);
  const weekdaysRaw = expandField(fields[4], 0, 7);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return undefined;
  const weekdays = new Set([...weekdaysRaw].map((d) => (d === 7 ? 0 : d)));
  const utcFastPath = timeZone === "UTC" || timeZone === "Etc/UTC";
  for (let step = 0; step <= PREVIOUS_CRON_TICK_SCAN_MINUTES; step++) {
    const t = startMinute - step * 60000;
    let parts: ZonedDateParts;
    try {
      if (utcFastPath) {
        const d = new Date(t);
        parts = {
          date: "",
          weekday: d.getUTCDay(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          day: d.getUTCDate(),
          month: d.getUTCMonth() + 1,
          year: d.getUTCFullYear(),
        };
      } else {
        parts = zonedDateParts(t, timeZone);
      }
    } catch {
      return undefined;
    }
    if (!minutes.has(parts.minute)) continue;
    if (!hours.has(parts.hour)) continue;
    if (!days.has(parts.day)) continue;
    if (!months.has(parts.month)) continue;
    if (!weekdays.has(parts.weekday)) continue;
    return t;
  }
  return undefined;
}
