/**
 * Schedule definitions for autonomous agent triggers.
 *
 * The ScheduledAgent Durable Object (src/agents/scheduled-agent.ts)
 * consumes these on each cron tick: it pulls active goals from SQL,
 * budget-checks via PaymentsAgent, and creates Orchestrator jobs —
 * except goals whose operation is "social.publish", which it executes
 * through the social goal executor instead (issue #1077 Phase 5b).
 */

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
  /** Last time this goal was evaluated (ISO timestamp) */
  lastRun?: string;
  /**
   * IANA time zone the cron wall-clock is read in. Absent means the
   * historical UTC behavior of isDue (see below). Goals created with
   * a timeZone use zone wall-clock matching instead.
   */
  timeZone?: string;
  /**
   * Issue #3121 S1 — creation provenance (#2366 items 3–4, on the
   * consolidated path). Stamped at creation by the creating route;
   * carried with the goal thereafter. Absent on legacy goals whose
   * creation predates stamping — "not recorded", never backfilled.
   */
  provenance?: ScheduleProvenance;
}

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

/**
 * Issue #3787: the feed-refresh goal's operation. The branch in
 * ScheduledAgent.onCron dispatches every J2 feed job through
 * the pipeline control plane's own scheduled-firing seam.
 */
export const FEED_REFRESH_OPERATION = "feed.refresh_all";

/**
 * Default schedules. Goals themselves live in the ScheduledAgent's
 * SQL; these are the built-in evaluations that ship with the system.
 * Stored goals are seeded from this list only when storage is empty,
 * so adding an entry here does not inject it into already-running
 * deployments — an operator adds it via the schedule dashboard API.
 */
export const DEFAULT_SCHEDULES: ScheduledGoal[] = [
  {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
  },
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
  {
    // #1077 Phase 5b slice 1: the social posting schedule, shipped
    // DISABLED. The owner enables it via the schedule dashboard API
    // (POST /api/schedule/goals or the enabled toggle) once tokens and
    // a content source are in place. budgetCents is a cap, not a
    // charge: posting spends nothing, so the 1-cent floor exists only
    // because addGoal requires a positive budget.
    id: "daily-social-post",
    name: "Daily social post",
    cron: "0 9 * * 1-5",
    timeZone: "America/New_York",
    operation: "social.publish",
    budgetCents: 1,
    enabled: false,
  },
  {
    // #1819 rollup slice: resource measurement goals. Canonical
    // definitions: fresh deployments seed from here; the running
    // deployment needs operator dashboard-API adds (see the rollup
    // doc). All timeZone "UTC" explicitly — the rollup day is the UTC
    // calendar day (Cloudflare D1 midnight-UTC reset; DO metering
    // matches D1). Rollup 01:30 UTC = 90-minute buffer after midnight
    // for in-flight writes; comparison 02:00 UTC = after the rollup;
    // alert hourly. The alert goal never stamps lastRun by design
    // (isDue's 23h guard would suppress hourly evaluation) — dedup
    // lives in alert state per (budget, day).
    id: "resource-daily-rollup",
    name: "SessionStore daily resource rollup",
    cron: "30 1 * * *",
    operation: "resource.rollup_daily",
    budgetCents: 1,
    enabled: true,
    timeZone: "UTC",
  },
  {
    id: "resource-cap-alert",
    name: "SessionStore 70% cap alert",
    cron: "0 * * * *",
    operation: "resource.cap_alert",
    budgetCents: 1,
    enabled: true,
    timeZone: "UTC",
  },
  {
    id: "resource-dashboard-comparison",
    name: "SessionStore dashboard comparison",
    cron: "0 2 * * *",
    operation: "resource.dashboard_comparison",
    budgetCents: 1,
    enabled: true,
    timeZone: "UTC",
  },
  {
    // #1980 index-list refresh goals. Canonical definitions:
    // fresh deployments seed from here; the running deployment
    // needs operator dashboard-API adds (the #1819 pattern) —
    // adding an entry here does not inject it into an already-
    // running deployment. Both run on the existing */30 tick;
    // no new scheduler, no new wrangler cron triggers.
    // Wikipedia weekly (Sunday 04:00 UTC): the Wikipedia
    // indices — dow, sp500, sp100, nasdaq100, sp400 (#2962),
    // and the 11 GICS sector keys (#2962, filtered from the
    // S&P 500 table's GICS Sector column) — within the #1852
    // 10-day freshness cap. The production path is live: D1
    // store via AGENT_DB + global fetch over the adapter's own
    // Wikipedia URLs.
    // Holdings daily (03:00 UTC) ships DISABLED, the
    // daily-social-post precedent: no ETF holdings-file fetcher
    // binding exists in code (no holdings URL is established
    // anywhere in the repo, and none is invented here), so
    // enabling it would tick-error daily. The operator enables
    // it via Settings → Scheduled goals once the holdings
    // fetcher is bound (see docs/architecture/security/
    // index-list-snapshots-1980.md); forced triggerGoal still
    // exercises it before then. #2962 adds russell3000 (IWB +
    // IWM union) to this disabled group — its stored refresh
    // is a carried item until the binding lands.
    id: "index-refresh-wikipedia",
    name: "Index-list refresh (Wikipedia)",
    cron: "0 4 * * 0",
    operation: "index.refresh_wikipedia",
    budgetCents: 1,
    enabled: true,
    timeZone: "UTC",
  },
  {
    id: "index-refresh-holdings",
    name: "Index-list refresh (ETF holdings)",
    cron: "0 3 * * *",
    operation: "index.refresh_holdings",
    budgetCents: 1,
    enabled: false,
    timeZone: "UTC",
  },
  {
    // #3787: feed datasets on a schedule — the J2 feed jobs
    // (provider quotes + fundamentals)
    // dispatch hourly through the pipeline control plane's own
    // feed-job seam (dispatchScheduledPipelineJob), on the
    // existing */30 tick; no new scheduler, no new wrangler
    // cron triggers. Canonical definition: fresh deployments
    // seed from here; the running deployment needs the operator
    // dashboard-API add (the #1819 pattern) — adding an entry
    // here does not inject it into an already-running
    // deployment. The branch never stamps lastRun (isDue's 23h
    // guard would suppress an hourly goal — the
    // resource.cap_alert precedent); hourly dedup lives in the
    // goal's latest run record.
    id: "feed-refresh",
    name: "Feed refresh (all feed jobs)",
    cron: "0 * * * *",
    operation: FEED_REFRESH_OPERATION,
    budgetCents: 1,
    enabled: true,
    timeZone: "UTC",
  },
];

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
  if (lastRun) {
    const last = new Date(lastRun).getTime();
    if (now.getTime() - last < 23 * 60 * 60 * 1000) return false;
  }
  return true;
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

/**
 * Check whether a cron expression is due given the last run time.
 *
 * Without a timeZone this is the historical behavior, preserved
 * byte-for-byte: minimal parser supporting the built-in schedules
 * ("minute hour * * *") read in UTC, day fields ignored. That
 * includes the opportunity-hunt quirk: "0 *\/6 * * *" maps the hour
 * through Number() to NaN and is therefore NEVER due. The quirk is
 * deliberately preserved here, not fixed — fixing it would change
 * the firing behavior of a shipped goal.
 *
 * With a timeZone, the cron is matched against wall-clock parts in
 * that zone, with lists, ranges, and steps in every field and weekday
 * matching (0 = Sunday … 6 = Saturday, 7 also Sunday). isDue never
 * throws: an unparseable cron or an unknown zone returns false.
 */
export function isDue(
  cron: string,
  lastRun: string | undefined,
  now: Date,
  timeZone?: string,
): boolean {
  if (timeZone === undefined) {
    const [minute, hour] = cron.split(" ").map(Number);
    if (Number.isNaN(minute) || Number.isNaN(hour)) return false;

    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();

    // Due if we're in the target hour/minute window
    if (currentHour !== hour || currentMinute < minute) return false;

    // And we haven't run in the last 23 hours (avoid double-fire)
    if (lastRun) {
      const last = new Date(lastRun).getTime();
      if (now.getTime() - last < 23 * 60 * 60 * 1000) return false;
    }
    return true;
  }
  try {
    return isDueInZone(cron, lastRun, now, timeZone);
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
 * - Without a timeZone the no-timeZone branch is mirrored exactly
 *   (minute/hour only, day fields ignored; a non-numeric minute or
 *   hour — the opportunity-hunt step-hour quirk — has no tick,
 *   exactly as isDue never fires it).
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
    const minute = Number(fields[0]);
    const hour = Number(fields[1]);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) return undefined;
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return undefined;
    for (let step = 0; step <= PREVIOUS_CRON_TICK_SCAN_MINUTES; step++) {
      const t = startMinute - step * 60000;
      const d = new Date(t);
      if (d.getUTCMinutes() === minute && d.getUTCHours() === hour) return t;
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
