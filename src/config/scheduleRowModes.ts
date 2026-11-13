/**
 * Issue #4329 S4 (#4333) — the one row vocabulary of the schedules home.
 *
 * The owner's rule for the three row lists on the schedules page (the one
 * schedule list, the goals tab, the admin queue) is: one row per item, the
 * actions on the same line, and the same columns wherever the same object is
 * shown — schedules plus the surface's own columns, never a second shape for
 * the same thing.
 *
 * This module is that vocabulary. Each surface resolves the columns it shows
 * from here, so "the goals tab carries the schedules tab's columns plus its
 * own" is a property of the configuration, not a claim two files repeat:
 *
 *   base          schedule · id · cadence — the row's identity, on every list
 *   list extras   status · scope         — the state, then the payload
 *   goal extras   operation · budget · lastRun · provenance
 *   queue extras  scope · status
 *   actions       appended last where the surface owns per-row actions
 *
 * Configuration seam, in the idiom of `src/config/scheduleListModes.ts`:
 * `SCHEDULE_ROW_LIST_COLUMNS`, `SCHEDULE_ROW_GOAL_COLUMNS` and
 * `SCHEDULE_ROW_QUEUE_COLUMNS` narrow or reorder a surface's OWN extras. The
 * base identity columns always show and always lead (a row with no name, id
 * or cadence is not a row), and an extra a surface does not carry is dropped
 * — the seam can hide a column, never invent one.
 */

/** Every column id a schedules-surface row can carry. */
export const SCHEDULE_ROW_COLUMN_IDS = [
  "schedule",
  "id",
  "cadence",
  "scope",
  "operation",
  "budget",
  "lastRun",
  "provenance",
  "status",
  "actions",
] as const;

export type ScheduleRowColumn = (typeof SCHEDULE_ROW_COLUMN_IDS)[number];

export const SCHEDULE_ROW_COLUMN_LABELS: Record<ScheduleRowColumn, string> = {
  schedule: "Schedule",
  id: "Schedule ID",
  cadence: "Cadence",
  scope: "Scope",
  operation: "Operation",
  budget: "Budget",
  lastRun: "Last run",
  provenance: "Provenance",
  status: "Status",
  actions: "Actions",
};

/** The identity columns every row list carries, in this order. */
export const SCHEDULE_ROW_BASE_COLUMNS: readonly ScheduleRowColumn[] = [
  "schedule",
  "id",
  "cadence",
];

/** The surfaces that render a row table on the schedules home. */
export const SCHEDULE_ROW_SURFACES = ["list", "goals", "queue"] as const;

export type ScheduleRowSurface = (typeof SCHEDULE_ROW_SURFACES)[number];

/** Each surface's own columns (never the base, never the action column). */
export const SCHEDULE_ROW_SURFACE_EXTRAS: Record<
  ScheduleRowSurface,
  readonly ScheduleRowColumn[]
> = {
  // Issue #4389 — status is its own column on the list (the owner: "status
  // must be its own column"), not a badge inside the name cell.
  list: ["status", "scope"],
  goals: ["operation", "budget", "lastRun", "provenance"],
  queue: ["scope", "status"],
};

/** Whether the surface owns per-row actions (the queue dump is read-only). */
export const SCHEDULE_ROW_SURFACE_ACTIONS: Record<ScheduleRowSurface, boolean> = {
  list: true,
  goals: true,
  queue: false,
};

export const SCHEDULE_ROW_COLUMNS_ENV_VARS: Record<ScheduleRowSurface, string> = {
  list: "SCHEDULE_ROW_LIST_COLUMNS",
  goals: "SCHEDULE_ROW_GOAL_COLUMNS",
  queue: "SCHEDULE_ROW_QUEUE_COLUMNS",
};

export interface ScheduleRowColumnsEnv {
  SCHEDULE_ROW_LIST_COLUMNS?: string;
  SCHEDULE_ROW_GOAL_COLUMNS?: string;
  SCHEDULE_ROW_QUEUE_COLUMNS?: string;
}

/** The built-in column list for one surface, before configuration. */
export function defaultScheduleRowColumns(
  surface: ScheduleRowSurface,
): ScheduleRowColumn[] {
  const columns = [...SCHEDULE_ROW_BASE_COLUMNS, ...SCHEDULE_ROW_SURFACE_EXTRAS[surface]];
  if (SCHEDULE_ROW_SURFACE_ACTIONS[surface]) columns.push("actions");
  return columns;
}

/**
 * The columns one surface shows. A configured value narrows or reorders that
 * surface's own extras (an id it does not carry, the base columns, or the
 * action column are ignored there); a blank or wholly-unknown value keeps the
 * built-in list.
 */
export function resolveScheduleRowColumns(
  surface: ScheduleRowSurface,
  env: ScheduleRowColumnsEnv = {},
): ScheduleRowColumn[] {
  const builtIn = defaultScheduleRowColumns(surface);
  const extras = SCHEDULE_ROW_SURFACE_EXTRAS[surface];
  const raw = env[SCHEDULE_ROW_COLUMNS_ENV_VARS[surface] as keyof ScheduleRowColumnsEnv];
  if (typeof raw !== "string") return builtIn;
  const configured: ScheduleRowColumn[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || !(extras as readonly string[]).includes(id)) continue;
    if (!configured.includes(id as ScheduleRowColumn)) configured.push(id as ScheduleRowColumn);
  }
  if (configured.length === 0) return builtIn;
  const columns = [...SCHEDULE_ROW_BASE_COLUMNS, ...configured];
  if (SCHEDULE_ROW_SURFACE_ACTIONS[surface]) columns.push("actions");
  return columns;
}
