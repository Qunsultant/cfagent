/**
 * Issue #4329 S2 (#4331) — the one schedule list's filter vocabulary.
 *
 * The owner named the filters: All, Stocks, Options, Strategy, Goal, Payment,
 * Trading, System, Queued, Other. This module is that vocabulary plus the
 * configuration seam, in the same idiom as the run ledger's kinds
 * (`src/config/runLedgerModes.ts`) — the page reads its filters from config, so
 * a deployment can show fewer of them without a code change:
 *
 *   SCHEDULE_LIST_FILTERS         comma-separated ids, in button order
 *   SCHEDULE_LIST_DEFAULT_FILTER  the filter the list opens with
 *   SCHEDULE_LIST_STATUSES        the status buttons beside the kinds
 *                                 (issue #4389: all, active, paused)
 *
 * Rules, applied in this order: "all" always leads and cannot be removed;
 * unknown ids are dropped; duplicates collapse; a blank or wholly-unknown
 * value falls back to the built-in set; a default outside the resolved set
 * falls back to "all".
 */
/** The kinds a schedule can be classified into. */
export const SCHEDULE_LIST_KIND_IDS = [
  "stocks",
  "options",
  "strategy",
  "goal",
  "payment",
  "trading",
  "system",
  "queued",
  "other",
] as const;

export type ScheduleListKind = (typeof SCHEDULE_LIST_KIND_IDS)[number];

export const SCHEDULE_LIST_ALL_FILTER = "all" as const;

export type ScheduleListFilter = typeof SCHEDULE_LIST_ALL_FILTER | ScheduleListKind;

export const SCHEDULE_LIST_FILTER_LABELS: Record<ScheduleListFilter, string> = {
  all: "All",
  stocks: "Stocks",
  options: "Options",
  strategy: "Strategy",
  goal: "Goal",
  payment: "Payment",
  trading: "Trading",
  system: "System",
  queued: "Queued",
  other: "Other",
};

export const SCHEDULE_LIST_FILTERS_ENV_VAR = "SCHEDULE_LIST_FILTERS";
export const SCHEDULE_LIST_DEFAULT_FILTER_ENV_VAR = "SCHEDULE_LIST_DEFAULT_FILTER";

/**
 * Issue #4389 — the list's SECOND filter dimension: status. The owner asked
 * for "paused and active buttons" beside the kinds; the two compose (Options +
 * Paused), so status is its own vocabulary rather than four more kind ids.
 * "all" leads, cannot be removed, and is the default.
 */
export const SCHEDULE_LIST_STATUS_IDS = ["all", "active", "paused"] as const;

export type ScheduleListStatusFilter = (typeof SCHEDULE_LIST_STATUS_IDS)[number];

export const SCHEDULE_LIST_STATUS_LABELS: Record<ScheduleListStatusFilter, string> = {
  all: "All statuses",
  active: "Active",
  paused: "Paused",
};

export const SCHEDULE_LIST_STATUSES_ENV_VAR = "SCHEDULE_LIST_STATUSES";

export const DEFAULT_SCHEDULE_LIST_STATUSES: readonly ScheduleListStatusFilter[] = [
  ...SCHEDULE_LIST_STATUS_IDS,
];

export interface ScheduleListStatusEnv {
  SCHEDULE_LIST_STATUSES?: string;
}

export function isScheduleListStatusFilter(
  value: unknown,
): value is ScheduleListStatusFilter {
  return (
    typeof value === "string" &&
    (SCHEDULE_LIST_STATUS_IDS as readonly string[]).includes(value)
  );
}

/** The status buttons the list shows; never empty, always "all" first. */
export function resolveScheduleListStatusFilters(
  env: ScheduleListStatusEnv = {},
): ScheduleListStatusFilter[] {
  const raw = env[SCHEDULE_LIST_STATUSES_ENV_VAR];
  if (typeof raw !== "string") return [...DEFAULT_SCHEDULE_LIST_STATUSES];
  const out: ScheduleListStatusFilter[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!isScheduleListStatusFilter(id) || out.includes(id)) continue;
    out.push(id);
  }
  if (out.length === 0) return [...DEFAULT_SCHEDULE_LIST_STATUSES];
  return out.includes("all") ? out : ["all", ...out];
}

/** The built-in set: exactly the owner's ten filters, in the owner's order. */
export const DEFAULT_SCHEDULE_LIST_FILTERS: readonly ScheduleListFilter[] = [
  SCHEDULE_LIST_ALL_FILTER,
  "stocks",
  "options",
  "strategy",
  "goal",
  "payment",
  "trading",
  "system",
  "queued",
  "other",
];

export const DEFAULT_SCHEDULE_LIST_FILTER: ScheduleListFilter = SCHEDULE_LIST_ALL_FILTER;

export interface ScheduleListFilterEnv {
  SCHEDULE_LIST_FILTERS?: string;
  SCHEDULE_LIST_DEFAULT_FILTER?: string;
}

const FILTER_IDS: readonly string[] = [SCHEDULE_LIST_ALL_FILTER, ...SCHEDULE_LIST_KIND_IDS];

export function isScheduleListFilter(value: unknown): value is ScheduleListFilter {
  return typeof value === "string" && FILTER_IDS.includes(value);
}

function parseFilterList(raw: string | undefined): ScheduleListFilter[] {
  if (typeof raw !== "string") return [];
  const out: ScheduleListFilter[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!id || !isScheduleListFilter(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The filter buttons the list shows; never empty, always "all" first. */
export function resolveScheduleListFilters(
  env: ScheduleListFilterEnv = {},
): ScheduleListFilter[] {
  const configured = parseFilterList(env[SCHEDULE_LIST_FILTERS_ENV_VAR]);
  if (configured.length === 0) return [...DEFAULT_SCHEDULE_LIST_FILTERS];
  return configured.includes(SCHEDULE_LIST_ALL_FILTER)
    ? configured
    : [SCHEDULE_LIST_ALL_FILTER, ...configured];
}

/** The filter the list opens with; an unreachable default falls back to "all". */
export function resolveScheduleListDefaultFilter(
  env: ScheduleListFilterEnv = {},
  filters: readonly ScheduleListFilter[] = resolveScheduleListFilters(env),
): ScheduleListFilter {
  const raw = typeof env[SCHEDULE_LIST_DEFAULT_FILTER_ENV_VAR] === "string"
    ? env[SCHEDULE_LIST_DEFAULT_FILTER_ENV_VAR]!.trim().toLowerCase()
    : "";
  if (!raw || !isScheduleListFilter(raw)) return DEFAULT_SCHEDULE_LIST_FILTER;
  return filters.includes(raw) ? raw : SCHEDULE_LIST_ALL_FILTER;
}
