/**
 * Issue #4253 — the built-in scheduled goals, externalized to config.
 *
 * The nine goals the schedules home ships with live in
 * `config/builtin-scheduled-goals.json` — id, name, cron, operation,
 * budgetCents, timeZone, enabled for each — and this module is the
 * one reader. Nothing about the built-in goals remains a literal in
 * code: `src/schedule.ts` re-exports these values as
 * `DEFAULT_SCHEDULES` (a derived alias, so existing pins keep
 * compiling), the seed rule in `src/agents/scheduled-agent.ts`
 * seeds from here, and `GET /api/schedule/builtin-goals` serves
 * from here. Change the JSON to change a default's cron, budget,
 * or enabled state — no code change, no redeploy of code.
 *
 * Per-goal rationale (moved here from the old `src/schedule.ts`
 * literal, values unchanged except where the daily-defaults
 * directive applies — see below):
 * - daily-qa-sweep (0 6 * * *): the daily QA sweep, `qa.run_sweep`.
 * - opportunity-hunt: daily 07:00. It shipped as `0 *\/6 * * *`
 *   (every 6h), which the no-timeZone `isDue` branch could never
 *   fire (the step hour maps through Number() to NaN) — and which
 *   violated the daily-defaults directive (all defaults daily or
 *   less). Daily at 07:00, right after the QA sweep, makes it a
 *   real daily default.
 * - daily-social-post (0 9 * * 1-5, America/New_York): the social
 *   posting schedule (#1077 Phase 5b), shipped DISABLED. The owner
 *   enables it via the schedule dashboard once tokens and a content
 *   source are in place. budgetCents is a cap, not a charge:
 *   posting spends nothing, so the 1-cent floor exists only because
 *   addGoal requires a positive budget.
 * - resource-daily-rollup (30 1 * * *, UTC): the SessionStore
 *   daily resource rollup (#1819). Rollup 01:30 UTC = 90-minute
 *   buffer after the D1 midnight-UTC reset for in-flight writes.
 * - resource-cap-alert (0 0 * * *, UTC): the SessionStore 70% cap
 *   alert (#1819). It shipped hourly (`0 * * * *`), violating the
 *   daily-defaults directive; daily at 00:00 UTC. The alert never
 *   stamps lastRun by design — dedup lives in alert state per
 *   (budget, day) — so a daily cadence needs no new dedup.
 * - resource-dashboard-comparison (0 2 * * *, UTC): 02:00 UTC =
 *   after the rollup (#1819).
 * - index-refresh-wikipedia (0 4 * * 0, UTC): weekly Sunday 04:00
 *   UTC (#1980) — the Wikipedia indices within the #1852 10-day
 *   freshness cap. The production path is live: D1 store via
 *   AGENT_DB + global fetch over the adapter's own Wikipedia URLs.
 * - index-refresh-holdings (0 3 * * *, UTC): daily 03:00 UTC,
 *   shipped DISABLED (#1980, #2962): no ETF holdings-file fetcher
 *   binding exists in code, so enabling it would tick-error daily.
 *   The operator enables it via Settings → Scheduled goals once
 *   the holdings fetcher is bound (see
 *   docs/architecture/security/index-list-snapshots-1980.md).
 * - autopilot-monthly-evaluation (0 9 1 * *, UTC): the one
 *   Autopilot schedule (#4411) — a monthly run of the
 *   policy-envelope evaluation (dry-run only, never places
 *   orders). Monthly is exactly at the platform's 30-day interval
 *   cap, so no staleness threshold is attached to its outputs.
 *
 * Fail-closed: the file values are validated on every read, and
 * the override seam (`setBuiltinScheduledGoals`, used by tests to
 * prove a config change applies without a code change) validates
 * before it replaces anything — an invalid definition throws and
 * the previous values stay in place. The cron-shape check mirrors
 * `isValidCron` in `src/schedule.ts` and is kept local on purpose:
 * `src/schedule.ts` imports this module for the
 * `DEFAULT_SCHEDULES` alias, so importing `isValidCron` back from
 * it would be a module cycle.
 */
import raw from "../../config/builtin-scheduled-goals.json";
import type { ScheduledGoal } from "../schedule";

/** The file values, validated once at first read. */
let fileGoals: ScheduledGoal[] | null = null;

/**
 * The test/override seam: a replacement goal list (validated), or
 * null to restore the file values. Module-global and reset by
 * `afterEach` in the #4253 pins — never a production input.
 */
let overrideGoals: ScheduledGoal[] | null = null;

function isValidCronShape(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return fields.every((field, i) => {
    const [min, max] = ranges[i];
    for (const part of field.split(",")) {
      if (part === "") return false;
      const segments = part.split("/");
      if (segments.length > 2) return false;
      const step = segments.length === 2 ? Number(segments[1]) : 1;
      if (!Number.isInteger(step) || step < 1) return false;
      const base = segments[0];
      if (base === "*") continue;
      if (base.includes("-")) {
        const bounds = base.split("-");
        if (bounds.length !== 2) return false;
        const start = Number(bounds[0]);
        const end = Number(bounds[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
        if (start < min || end > max || start > end) return false;
        continue;
      }
      const value = Number(base);
      if (!Number.isInteger(value) || value < min || value > max) return false;
    }
    return true;
  });
}

/**
 * Fail-closed validation of a goal list: every goal needs a
 * non-empty id, name, and operation, a well-formed five-field cron
 * in range, a positive budget, a boolean enabled, and (when
 * present) a known IANA time zone; ids must be unique and the list
 * non-empty. Throws naming the offending field; a rejected list is
 * never installed.
 */
export function validateBuiltinScheduledGoals(goals: unknown): ScheduledGoal[] {
  if (!Array.isArray(goals) || goals.length === 0) {
    throw new Error("builtin scheduled goals: config must be a non-empty list");
  }
  const seen = new Set<string>();
  for (const goal of goals) {
    if (!goal || typeof goal !== "object") {
      throw new Error("builtin scheduled goals: each goal must be an object");
    }
    const candidate = goal as Partial<ScheduledGoal>;
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      throw new Error("builtin scheduled goals: each goal needs a non-empty id");
    }
    if (seen.has(candidate.id)) {
      throw new Error(`builtin scheduled goals: duplicate id ${candidate.id}`);
    }
    seen.add(candidate.id);
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
      throw new Error(`builtin scheduled goals: goal ${candidate.id} needs a non-empty name`);
    }
    if (typeof candidate.cron !== "string" || !isValidCronShape(candidate.cron)) {
      throw new Error(`builtin scheduled goals: goal ${candidate.id} has an invalid cron`);
    }
    if (typeof candidate.operation !== "string" || candidate.operation.trim() === "") {
      throw new Error(`builtin scheduled goals: goal ${candidate.id} needs a non-empty operation`);
    }
    if (
      typeof candidate.budgetCents !== "number" ||
      !Number.isFinite(candidate.budgetCents) ||
      candidate.budgetCents <= 0
    ) {
      throw new Error(`builtin scheduled goals: goal ${candidate.id} needs a positive budget`);
    }
    if (typeof candidate.enabled !== "boolean") {
      throw new Error(`builtin scheduled goals: goal ${candidate.id} needs a boolean enabled`);
    }
    if (candidate.timeZone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: candidate.timeZone });
      } catch {
        throw new Error(
          `builtin scheduled goals: goal ${candidate.id} has an unknown timeZone`,
        );
      }
    }
  }
  return (goals as ScheduledGoal[]).map((goal) => ({ ...goal }));
}

/** The built-in goals from config, in config order. A fresh copy on every call. */
export function getBuiltinScheduledGoals(): ScheduledGoal[] {
  if (overrideGoals) return overrideGoals.map((goal) => ({ ...goal }));
  if (!fileGoals) fileGoals = validateBuiltinScheduledGoals(raw);
  return fileGoals.map((goal) => ({ ...goal }));
}

/**
 * Override seam for the #4253 pins: install a replacement goal
 * list (validated — an invalid list throws and the current values
 * stay), or pass null to restore the file values.
 */
export function setBuiltinScheduledGoals(goals: ScheduledGoal[] | null): void {
  if (goals === null) {
    overrideGoals = null;
    return;
  }
  overrideGoals = validateBuiltinScheduledGoals(goals);
}

/** Whether an id is one of the config's built-in goal ids. */
export function isBuiltinScheduledGoalId(id: string): boolean {
  return getBuiltinScheduledGoals().some((goal) => goal.id === id);
}
