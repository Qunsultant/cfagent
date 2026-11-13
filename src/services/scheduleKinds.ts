/**
 * Issue #4329 S2 (#4331) — the one schedule list's classifier.
 *
 * Pure: a recorded schedule in, one of the owner's kinds out. The vocabulary
 * and the filter set live in `src/config/scheduleListModes.ts` (configuration);
 * this module only applies the ordered rule table.
 *
 * Classification is by the recorded callback name and the schedule's type —
 * the only fields the store carries. A callback that matches no rule is
 * `other`: a schedule is never dropped and never guessed into a family.
 */
import type { ScheduleListKind } from "../config/scheduleListModes";

/** The fields classification reads — never the whole record. */
export interface ScheduleKindCandidate {
  callback?: string | null;
  type?: string | null;
  payload?: unknown;
}

/** One rule: the first whose `match` is true wins. */
export interface ScheduleKindRule {
  kind: ScheduleListKind;
  /** Substrings of the lowercased callback. */
  callbacks?: readonly string[];
  /** The schedule's own type value (e.g. "delayed"). */
  types?: readonly string[];
  /** The payload carries a universe — the stock-screen marker. */
  payloadUniverse?: boolean;
}

/**
 * Ordered rules. `queued` first (a delayed job is queued whatever it would
 * do), then the families most specific first: `options` before `trading`
 * (an options scan places no order), `strategy` before `trading`, `stocks`
 * last among the screening families. `system` covers the platform's own
 * upkeep callbacks; anything unmatched is `other`.
 */
export const SCHEDULE_KIND_RULES: readonly ScheduleKindRule[] = [
  { kind: "queued", types: ["delayed"], callbacks: ["executeasyncjob"] },
  { kind: "options", callbacks: ["options"] },
  { kind: "strategy", callbacks: ["strategydiscovery", "strategy"] },
  { kind: "stocks", callbacks: ["marketscreen", "screener"], payloadUniverse: true },
  { kind: "goal", callbacks: ["goal"] },
  { kind: "payment", callbacks: ["payment", "checkout", "billing", "subscription"] },
  { kind: "trading", callbacks: ["trade", "order", "broker"] },
  // A stage schedule fires a workflow stage (callback runWorkflowStage); it is a
  // platform mechanism (#3121 #3310), not a family, so it stays `system`.
  {
    kind: "system",
    callbacks: [
      "pushticks",
      "token",
      "iv",
      "index",
      "refresh",
      "reminder",
      "watchdog",
      "workflowstage",
    ],
  },
];

function matches(rule: ScheduleKindRule, s: ScheduleKindCandidate): boolean {
  const type = typeof s.type === "string" ? s.type.trim().toLowerCase() : "";
  if (rule.types?.some((t) => t.toLowerCase() === type)) return true;
  const callback = typeof s.callback === "string" ? s.callback.trim().toLowerCase() : "";
  if (callback && rule.callbacks?.some((c) => callback.includes(c.toLowerCase()))) return true;
  if (rule.payloadUniverse) {
    const payload = s.payload as { universe?: unknown } | null | undefined;
    if (payload && typeof payload === "object" && payload.universe != null) return true;
  }
  return false;
}

/** Classify one schedule; nothing matches → "other". */
export function classifyScheduleKind(
  s: ScheduleKindCandidate,
  rules: readonly ScheduleKindRule[] = SCHEDULE_KIND_RULES,
): ScheduleListKind {
  for (const rule of rules) {
    if (matches(rule, s)) return rule.kind;
  }
  return "other";
}

/** Count schedules per kind for the filter buttons. */
export function countSchedulesByKind<T extends ScheduleKindCandidate>(
  schedules: readonly T[],
  rules: readonly ScheduleKindRule[] = SCHEDULE_KIND_RULES,
): Record<ScheduleListKind, number> {
  const counts = {
    stocks: 0,
    options: 0,
    strategy: 0,
    goal: 0,
    payment: 0,
    trading: 0,
    system: 0,
    queued: 0,
    other: 0,
  } as Record<ScheduleListKind, number>;
  for (const s of schedules) counts[classifyScheduleKind(s, rules)] += 1;
  return counts;
}
