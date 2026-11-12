/**
 * Issue #3121 Slice S2 — the consolidated schedules home: one address,
 * sub-routes, and the retirement of the duplicate addresses.
 *
 * Home: `?tab=schedules` (owner-decided, inventory §8.3). Sub-route
 * scheme, following the app's existing `?tab=` + `?view=` deep-link
 * pattern (`src/client/router.ts` `parseViewFromSearch`):
 * `?tab=schedules&view=list|runs|ledger|goals|queue&schedule=<id>&run=<id>`.
 *
 * - `view=list` (default): the schedule list (today's `SchedulesPanel`
 *   capabilities, incl. the embedded `ScheduledOptionsManager`).
 * - `view=runs` / `view=ledger`: the consolidated run ledger, read from
 *   the S1 ledger (`job_run_records` with the §4 columns `trigger`,
 *   `scheduleId`, `asyncJobId`, `workflowId`). `runs` and `ledger` are
 *   the same view; `runs` is canonical. `run=<id>` deep-links one job's
 *   run history; `schedule=<id>` filters the ledger to that schedule.
 * - `view=goals`: goal schedules (`ScheduledGoalsPanel`, S3: on the
 *   S1 primitives — tick evaluation through the S1 re-exported
 *   `isDue`, ledger linkage through `buildLedgerLinkage`,
 *   provenance on every goal, lifecycle audit through the DO-side
 *   sink, and run history from the one consolidated ledger read.
 *   The routes stay `/api/schedule/goals` until #3123 unifies the
 *   schedule store; the store is not S3's to move.)
 * - `view=queue`: the admin queue (`AdminQueueWipePanel`), role-gated at
 *   the route — the same platform-admin overview probe that gated it
 *   inside IAAA Admin (see `ScheduleQueueView`); the server is the gate.
 *
 * Retired addresses (each maps to the home, or to null with the reason
 * recorded here — never silently kept):
 * - `?tab=screeners&view=schedules` (U-02) → `?tab=schedules`.
 * - `?tab=platform-admin&view=scheduled-goals` (U-04) →
 *   `?tab=schedules&view=goals`.
 * - `?tab=platform-admin&view=jobs` (U-05) → `?tab=schedules&view=runs`.
 * - `?tab=platform-admin&view=iaaa-admin&iaaaTab=queue` (U-06) →
 *   `?tab=schedules&view=queue`.
 * - `?tab=options&view=scheduled-screening` (U-03) → `?tab=schedules`,
 *   per the owner decision (#3121 comment 6669207975, 2026-11-05),
 *   reversing S2's keep-as-is. The address redirects (replace, so
 *   back/forward never re-lands on it); in-hub tab clicks write the
 *   same `?view=` URL the redirect matches, so the OptionsHub
 *   schedules mode is unreachable at any address after this slice.
 *   Its options-research content is NOT lost: the one-shot run form
 *   (#2545 `ScheduledOptionsRunForm`), the autonomous-runs record
 *   (#223 `AutonomousOptionsRuns`), and the screening activity log
 *   (#1162 `ScreeningActivityPanel`) now render on the Options Runs
 *   tab (`?tab=options&view=options-runs`, `ResearchRunsPanel`) —
 *   the one surface for manual + scheduled options runs (#319).
 *   Lossless + additive directive (#3121 comment 6669238775): the
 *   content keeps a live home at an existing address, no new
 *   surface, nothing retired silently.
 *
 * This module is pure: URLSearchParams in, values out. No window, no
 * fetch, no Cloudflare — the same hexagonal shape as the S1 primitives
 * (`src/services/consolidatedScheduling.ts`). The shell (`Chat.tsx`)
 * applies `legacySchedulesRedirect` with a replace (never a push, so
 * back/forward never re-lands on a retired address).
 */

import {
  isRunLedgerFilter,
  resolveRunLedgerDefaultFilter,
  resolveRunLedgerFilters,
  type RunLedgerFilter,
} from "../config/runLedgerModes";

/** The one schedules home tab id. */
export const SCHEDULES_HOME_TAB = "schedules";

/** The consolidated home's views; `ledger` is an alias of `runs`, not a fifth view. */
export type SchedulesHomeView = "list" | "runs" | "goals" | "queue";

export const SCHEDULES_HOME_VIEWS: readonly SchedulesHomeView[] = [
  "list",
  "runs",
  "goals",
  "queue",
];

export const SCHEDULES_HOME_VIEW_LABELS: Record<SchedulesHomeView, string> = {
  list: "Schedules",
  runs: "Run ledger",
  goals: "Goal schedules",
  queue: "Queue",
};

/** `ledger` is accepted as an alias of `runs` (inventory §8.3 (ii)). */
export function isSchedulesHomeView(value: unknown): value is SchedulesHomeView {
  return (
    typeof value === "string" &&
    (SCHEDULES_HOME_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Canonicalize a raw `?view=` value: `ledger` → `runs`; an unknown or
 * missing view falls back to `runs` when a run is deep-linked, else
 * to `list`. Never throws, never returns an invalid view.
 */
export function normalizeSchedulesHomeView(
  value: unknown,
  hasRunId: boolean = false,
): SchedulesHomeView {
  if (value === "ledger") return "runs";
  if (isSchedulesHomeView(value)) return value;
  return hasRunId ? "runs" : "list";
}

export interface SchedulesDeepLink {
  view: SchedulesHomeView;
  /** `schedule=<id>`: one schedule (list detail / ledger filter). */
  scheduleId: string | null;
  /** `run=<id>`: one job's run history (ledger filter; a run row's identity is its jobId). */
  runId: string | null;
  /**
   * `kind=<filter>` (issue #4262 S1): the ledger's selected kind filter.
   * Only the runs view reads it; every other view carries the resolved
   * default so the value is never undefined. An unknown id, or one the
   * configured filter set does not show, resolves to the configured default.
   */
  kind: RunLedgerFilter;
}

function nonEmptyParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Parse the home's deep link out of a query string. */
export function parseSchedulesDeepLink(search: string): SchedulesDeepLink {
  const params = new URLSearchParams(search);
  const runId = nonEmptyParam(params, "run");
  const scheduleId = nonEmptyParam(params, "schedule");
  const filters = resolveRunLedgerFilters();
  const rawKind = nonEmptyParam(params, "kind")?.toLowerCase() ?? null;
  const kind: RunLedgerFilter =
    rawKind && isRunLedgerFilter(rawKind) && filters.includes(rawKind)
      ? rawKind
      : resolveRunLedgerDefaultFilter({}, filters);
  return {
    view: normalizeSchedulesHomeView(params.get("view"), runId !== null),
    scheduleId,
    runId,
    kind,
  };
}

export interface LegacySchedulesRedirect {
  tab: string;
  view?: string;
  params?: Record<string, string>;
}

/**
 * The redirect for a retired schedules address, or null when the URL is
 * not one. The caller replaces the URL with the target; a
 * null means "leave the URL alone".
 */
export function legacySchedulesRedirect(search: string): LegacySchedulesRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const view = params.get("view") ?? "";
  if (tab === "screeners" && view === "schedules") {
    return { tab: SCHEDULES_HOME_TAB };
  }
  if (tab === "options" && view === "scheduled-screening") {
    return { tab: SCHEDULES_HOME_TAB };
  }
  if (tab === "platform-admin" && view === "scheduled-goals") {
    return { tab: SCHEDULES_HOME_TAB, view: "goals" };
  }
  if (tab === "platform-admin" && view === "jobs") {
    return { tab: SCHEDULES_HOME_TAB, view: "runs" };
  }
  // Issue #4262 (S2): the Workflow Runs address is a folded view of the one
  // ledger. It keeps working as a deep link (the issue's change-management
  // rule) and lands on the ledger with the workflow filter pre-set.
  if (tab === "workflow-runs") {
    return { tab: SCHEDULES_HOME_TAB, view: "runs", params: { kind: "workflow" } };
  }
  if (
    tab === "platform-admin" &&
    view === "iaaa-admin" &&
    params.get("iaaaTab") === "queue"
  ) {
    return { tab: SCHEDULES_HOME_TAB, view: "queue" };
  }
  return null;
}
