/**
 * Issue #4329 S4 (#4333) — the schedules home's section vocabularies.
 *
 * The home is four views (`?tab=schedules&view=list|runs|goals|queue`,
 * `src/client/schedulesHomeView.ts`). Two of those views carry more than one
 * section on one page, and the owner asked for them organised as sub-tabs
 * rather than one long scroll: the goals view (goals · add · resource goals ·
 * seed · ticks · goal runs) and the admin queue (dump · cancel-all · wipe ·
 * recreate). This module is that vocabulary plus its configuration seam, in
 * the same idiom as the list filters (`src/config/scheduleListModes.ts`) and
 * the run ledger's kinds (`src/config/runLedgerModes.ts`): a deployment can
 * show fewer sections, or open on a different one, without a code change.
 *
 *   SCHEDULE_GOAL_SECTIONS          comma-separated ids, in tab order
 *   SCHEDULE_GOAL_DEFAULT_SECTION   the section the goals view opens with
 *   SCHEDULE_QUEUE_SECTIONS         comma-separated ids, in tab order
 *   SCHEDULE_QUEUE_DEFAULT_SECTION  the section the queue view opens with
 *
 * Rules, applied in this order: the FIRST id in each list is the view's own
 * section (the list, the dump) and cannot be removed — a page that hid its
 * primary section would have nothing to show; unknown ids are dropped;
 * duplicates collapse; a blank or wholly-unknown value falls back to the
 * built-in set; a default outside the resolved set falls back to the first.
 *
 * The sub-tabs write `?section=<id>` (the home's one param for "which
 * section" — `SCHEDULE_SECTION_PARAM`), so a section is a stable deep link,
 * the same contract the home's `view=` and the ledger's `kind=` follow.
 */

/** The query param every schedules sub-tab writes. */
export const SCHEDULE_SECTION_PARAM = "section";

/* ------------------------------------------------------------------ goals */

/** The goals view's sections, in the owner's order. */
export const GOAL_SCHEDULE_SECTION_IDS = [
  "goals",
  "add",
  "resources",
  "seed",
  "ticks",
  "runs",
] as const;

export type GoalScheduleSection = (typeof GOAL_SCHEDULE_SECTION_IDS)[number];

export const GOAL_SCHEDULE_SECTION_LABELS: Record<GoalScheduleSection, string> = {
  goals: "Goals",
  add: "Add goal",
  resources: "Resource goals",
  seed: "Seed built-in goals",
  ticks: "Ticks",
  runs: "Goal runs",
};

export const GOAL_SECTIONS_ENV_VAR = "SCHEDULE_GOAL_SECTIONS";
export const GOAL_DEFAULT_SECTION_ENV_VAR = "SCHEDULE_GOAL_DEFAULT_SECTION";

/** The built-in goals sections: exactly the owner's order. */
export const DEFAULT_GOAL_SCHEDULE_SECTIONS: readonly GoalScheduleSection[] = [
  ...GOAL_SCHEDULE_SECTION_IDS,
];

export const DEFAULT_GOAL_SCHEDULE_SECTION: GoalScheduleSection = "goals";

/* ------------------------------------------------------------------ queue */

/** The admin queue's sections, in the owner's order. */
export const QUEUE_SCHEDULE_SECTION_IDS = ["queue", "cancel", "wipe", "recreate"] as const;

export type QueueScheduleSection = (typeof QUEUE_SCHEDULE_SECTION_IDS)[number];

export const QUEUE_SCHEDULE_SECTION_LABELS: Record<QueueScheduleSection, string> = {
  queue: "Queue dump",
  cancel: "Cancel all",
  wipe: "Wipe",
  recreate: "Recreate Track 1",
};

export const QUEUE_SECTIONS_ENV_VAR = "SCHEDULE_QUEUE_SECTIONS";
export const QUEUE_DEFAULT_SECTION_ENV_VAR = "SCHEDULE_QUEUE_DEFAULT_SECTION";

/** The built-in queue sections: exactly the owner's order. */
export const DEFAULT_QUEUE_SCHEDULE_SECTIONS: readonly QueueScheduleSection[] = [
  ...QUEUE_SCHEDULE_SECTION_IDS,
];

export const DEFAULT_QUEUE_SCHEDULE_SECTION: QueueScheduleSection = "queue";

/* ----------------------------------------------------------------- shared */

export interface ScheduleSectionEnv {
  SCHEDULE_GOAL_SECTIONS?: string;
  SCHEDULE_GOAL_DEFAULT_SECTION?: string;
  SCHEDULE_QUEUE_SECTIONS?: string;
  SCHEDULE_QUEUE_DEFAULT_SECTION?: string;
}

export function isGoalScheduleSection(value: unknown): value is GoalScheduleSection {
  return (
    typeof value === "string" &&
    (GOAL_SCHEDULE_SECTION_IDS as readonly string[]).includes(value)
  );
}

export function isQueueScheduleSection(value: unknown): value is QueueScheduleSection {
  return (
    typeof value === "string" &&
    (QUEUE_SCHEDULE_SECTION_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve a section list: the first entry is mandatory and always leads,
 * unknown ids are dropped, duplicates collapse, and a blank value keeps the
 * built-in set.
 */
function resolveSections<T extends string>(
  raw: string | undefined,
  isValid: (value: unknown) => value is T,
  builtIn: readonly T[],
): T[] {
  if (typeof raw !== "string") return [...builtIn];
  const out: T[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!isValid(id) || out.includes(id)) continue;
    out.push(id);
  }
  if (out.length === 0) return [...builtIn];
  const primary = builtIn[0];
  return out.includes(primary) ? out : [primary, ...out];
}

/** Resolve a default: an unreachable section falls back to the view's own. */
function resolveSectionDefault<T extends string>(
  raw: string | undefined,
  isValid: (value: unknown) => value is T,
  sections: readonly T[],
  fallback: T,
): T {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || !isValid(value) || !sections.includes(value)) return sections[0] ?? fallback;
  return value;
}

/** The goals view's sections, in tab order; never empty, `goals` always first. */
export function resolveGoalScheduleSections(
  env: ScheduleSectionEnv = {},
): GoalScheduleSection[] {
  return resolveSections(
    env[GOAL_SECTIONS_ENV_VAR],
    isGoalScheduleSection,
    DEFAULT_GOAL_SCHEDULE_SECTIONS,
  );
}

/** The section the goals view opens with. */
export function resolveGoalScheduleDefaultSection(
  env: ScheduleSectionEnv = {},
  sections: readonly GoalScheduleSection[] = resolveGoalScheduleSections(env),
): GoalScheduleSection {
  return resolveSectionDefault(
    env[GOAL_DEFAULT_SECTION_ENV_VAR],
    isGoalScheduleSection,
    sections,
    DEFAULT_GOAL_SCHEDULE_SECTION,
  );
}

/** The queue view's sections, in tab order; never empty, `queue` always first. */
export function resolveQueueScheduleSections(
  env: ScheduleSectionEnv = {},
): QueueScheduleSection[] {
  return resolveSections(
    env[QUEUE_SECTIONS_ENV_VAR],
    isQueueScheduleSection,
    DEFAULT_QUEUE_SCHEDULE_SECTIONS,
  );
}

/** The section the queue view opens with. */
export function resolveQueueScheduleDefaultSection(
  env: ScheduleSectionEnv = {},
  sections: readonly QueueScheduleSection[] = resolveQueueScheduleSections(env),
): QueueScheduleSection {
  return resolveSectionDefault(
    env[QUEUE_DEFAULT_SECTION_ENV_VAR],
    isQueueScheduleSection,
    sections,
    DEFAULT_QUEUE_SCHEDULE_SECTION,
  );
}
