/**
 * Issue #5889 — the one schedule list's SOURCE vocabulary.
 *
 * Every row in the Schedules home carries exactly one source: where
 * the row came from and which job it is. The kinds below are the
 * sources the issue enumerates (seeded, derived, declared task,
 * sweep/watchdog alarm, user-created, pipeline job, worker duty,
 * workflow, cron), plus the kinds a row needs to be honestly
 * attributable at all: ticker-push (the live feed's own row, not a
 * #4238–#4242 due-check record), agent-created (an agent acting for
 * a tenant, #3122), system (a system-armed row with a named reason),
 * and unknown (a legacy row whose creation was never recorded —
 * "not recorded", never a fabricated source).
 *
 * The vocabulary is configuration, in the same idiom as the list's
 * kind filters (`src/config/scheduleListModes.ts`): the page reads
 * its Source buttons from here, so a deployment can show fewer of
 * them without a code change:
 *
 *   SCHEDULE_SOURCE_FILTERS  comma-separated ids, in button order
 *
 * Rules, applied in this order: "all" always leads and cannot be
 * removed; unknown ids are dropped; duplicates collapse; a blank or
 * wholly-unknown value falls back to the built-in set.
 *
 * The "cron" button is NOT a source kind: it is a timing slice over
 * the one list — every row armed on a cron expression, whatever its
 * source (issue caveat (b): the Cron view largely overlaps Derived,
 * because the #4238–#4242 due-check records are cron-timed). Each
 * row still carries exactly one source, so nothing is
 * double-counted; the Cron view just selects by timing instead.
 *
 * The per-agent and per-workflow views are dynamic, not configured:
 * their values are the agents and workflows the loaded rows
 * actually name (`scheduleSourceAgents` /
 * `scheduleSourceWorkflows`). A view for an agent or workflow with
 * no rows is never invented — the group simply does not render.
 * Seeded goals are tick-polled by the ScheduledAgent, declared
 * tasks are declared by the OrchestratorAgent, and the ticker push
 * is fed by the TickerAgent, so those three hosts are the named
 * per-agent views; any other agent value is the provenance
 * agentId, verbatim.
 */

/** One row's source: kind + job identity + arming origin. */
export interface ScheduleSource {
  /** The source kind — the filter value and the column's first line. */
  kind: ScheduleSourceKind;
  /**
   * The job identity: the catalogue id, the declared task id, the
   * workflow job id, the jobdef id, or the callback — the stable
   * name the row's job is known by, never the SDK alarm id.
   */
  job: string;
  /** Arming origin, in plain words: who or what armed the row. */
  origin: string;
  /** The owning agent, when the source names one (per-agent views). */
  agent?: string;
  /** The workflow the row belongs to, when it names one (per-workflow views). */
  workflow?: string;
}

/** The source kinds a schedule row can carry. */
export const SCHEDULE_SOURCE_KIND_IDS = [
  "seeded",
  "derived",
  "declared-task",
  "sweep-alarm",
  "user-created",
  "agent-created",
  "pipeline-job",
  "worker-duty",
  "workflow",
  "ticker-push",
  "system",
  "unknown",
] as const;

export type ScheduleSourceKind = (typeof SCHEDULE_SOURCE_KIND_IDS)[number];

/** The Cron timing slice: a filter value, never a source kind. */
export const SCHEDULE_SOURCE_CRON_FILTER = "cron" as const;

export const SCHEDULE_SOURCE_ALL_FILTER = "all" as const;

export type ScheduleSourceFilter =
  | typeof SCHEDULE_SOURCE_ALL_FILTER
  | ScheduleSourceKind
  | typeof SCHEDULE_SOURCE_CRON_FILTER;

export const SCHEDULE_SOURCE_KIND_LABELS: Record<ScheduleSourceKind, string> = {
  seeded: "Seeded",
  derived: "Derived",
  "declared-task": "Declared task",
  "sweep-alarm": "Sweep alarm",
  "user-created": "User-created",
  "agent-created": "Agent-created",
  "pipeline-job": "Pipeline job",
  "worker-duty": "Worker duty",
  workflow: "Workflow",
  "ticker-push": "Ticker push",
  system: "System",
  unknown: "Unknown",
};

export const SCHEDULE_SOURCE_FILTER_LABELS: Record<ScheduleSourceFilter, string> = {
  ...SCHEDULE_SOURCE_KIND_LABELS,
  all: "All",
  cron: "Cron",
};

export const SCHEDULE_SOURCE_FILTERS_ENV_VAR = "SCHEDULE_SOURCE_FILTERS";

/** The built-in set: every source kind, then the Cron timing slice. */
export const DEFAULT_SCHEDULE_SOURCE_FILTERS: readonly ScheduleSourceFilter[] = [
  SCHEDULE_SOURCE_ALL_FILTER,
  ...SCHEDULE_SOURCE_KIND_IDS,
  SCHEDULE_SOURCE_CRON_FILTER,
];

export interface ScheduleSourceFilterEnv {
  SCHEDULE_SOURCE_FILTERS?: string;
}

const FILTER_IDS: readonly string[] = [
  SCHEDULE_SOURCE_ALL_FILTER,
  ...SCHEDULE_SOURCE_KIND_IDS,
  SCHEDULE_SOURCE_CRON_FILTER,
];

export function isScheduleSourceKind(value: unknown): value is ScheduleSourceKind {
  return (
    typeof value === "string" &&
    (SCHEDULE_SOURCE_KIND_IDS as readonly string[]).includes(value)
  );
}

export function isScheduleSourceFilter(value: unknown): value is ScheduleSourceFilter {
  return typeof value === "string" && FILTER_IDS.includes(value);
}

/** The Source buttons the list shows; never empty, always "all" first. */
export function resolveScheduleSourceFilters(
  env: ScheduleSourceFilterEnv = {},
): ScheduleSourceFilter[] {
  const raw = env[SCHEDULE_SOURCE_FILTERS_ENV_VAR];
  if (typeof raw !== "string") return [...DEFAULT_SCHEDULE_SOURCE_FILTERS];
  const out: ScheduleSourceFilter[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!id || !isScheduleSourceFilter(id) || out.includes(id as ScheduleSourceFilter)) continue;
    out.push(id as ScheduleSourceFilter);
  }
  if (out.length === 0) return [...DEFAULT_SCHEDULE_SOURCE_FILTERS];
  return out.includes(SCHEDULE_SOURCE_ALL_FILTER)
    ? out
    : [SCHEDULE_SOURCE_ALL_FILTER, ...out];
}

/** A row's source kind for matching and display — absent reads as Unknown. */
export function scheduleSourceKindOf(row: { source?: ScheduleSource | null }): ScheduleSourceKind {
  return row.source && isScheduleSourceKind(row.source.kind) ? row.source.kind : "unknown";
}

/**
 * The display triple for one row's source: the label, the job
 * identity, and the arming origin. A row with no source reads
 * Unknown / its own id / "not recorded" — the honest fallback, never
 * a fabricated source.
 */
export function scheduleSourceDisplay(row: {
  id: string;
  source?: ScheduleSource | null;
}): { label: string; job: string; origin: string; agent?: string; workflow?: string } {
  const source = row.source;
  if (!source || !isScheduleSourceKind(source.kind)) {
    return { label: "Unknown", job: row.id, origin: "not recorded" };
  }
  return {
    label: SCHEDULE_SOURCE_KIND_LABELS[source.kind],
    job: source.job,
    origin: source.origin,
    ...(source.agent !== undefined ? { agent: source.agent } : {}),
    ...(source.workflow !== undefined ? { workflow: source.workflow } : {}),
  };
}

/** The distinct agents the rows name, in first-seen order. */
export function scheduleSourceAgents(
  rows: readonly { source?: ScheduleSource | null }[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const agent = row.source?.agent;
    if (typeof agent === "string" && agent && !out.includes(agent)) out.push(agent);
  }
  return out;
}

/** The distinct workflows the rows name, in first-seen order. */
export function scheduleSourceWorkflows(
  rows: readonly { source?: ScheduleSource | null }[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const workflow = row.source?.workflow;
    if (typeof workflow === "string" && workflow && !out.includes(workflow)) out.push(workflow);
  }
  return out;
}
