/**
 * Issue #159: client API for the ScheduledAgent dashboard.
 */
import { withCsrfInit } from "./apiFetch";
import type { ScheduleProvenance } from "../schedule";

export interface ScheduledGoal {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled: boolean;
  lastRun?: string;
  timeZone?: string;
  /**
   * Issue #3121 S3 — creation provenance (S1), carried with the
   * goal. Absent on legacy goals whose creation predates stamping
   * ("not recorded", never backfilled).
   */
  provenance?: ScheduleProvenance;
}

export interface CatalogOperation {
  operation: string;
  agent: string;
  blurb: string;
}

export interface ScheduleTick {
  timestamp: string;
  goalsEvaluated: number;
  jobsCreated: number;
  jobsSkipped: number;
  errors: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(path, withCsrfInit(init));
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

export function listGoals() {
  return api<{ ok: boolean; goals: ScheduledGoal[] }>("/api/schedule/goals");
}

export function getTickHistory(limit = 20) {
  return api<{ ok: boolean; ticks: ScheduleTick[] }>(
    `/api/schedule/ticks?limit=${limit}`
  );
}

export function addGoal(goal: {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled?: boolean;
  timeZone?: string;
}) {
  return api<{ ok: boolean; goal: ScheduledGoal }>("/api/schedule/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(goal),
  });
}

export function listOperations() {
  return api<{ ok: boolean; operations: CatalogOperation[] }>("/api/schedule/operations");
}

/**
 * Issue #3996 — built-in scheduled goals, the single source of
 * truth for the goals UI dropdown and the seed-all button. The
 * canonical definitions live in src/schedule.ts DEFAULT_SCHEDULES
 * and are read from this server endpoint at load time — the client
 * carries no second copy of the values.
 */
export function listBuiltinGoals() {
  return api<{ ok: boolean; goals: ScheduledGoal[] }>("/api/schedule/builtin-goals");
}

/**
 * Issue #3996 — posts each built-in goal in order and reports
 * per-goal results. A goal the loaded list already contains is
 * SKIPPED without posting, and one the server reports as already
 * existing is SKIPPED too — the batch never fails wholesale and
 * never duplicates. The goal's own `enabled` value is posted
 * as-is, so the disabled-by-design goals seed as disabled.
 */
export async function addBuiltinGoals(
  goals: ScheduledGoal[],
  existingIds: string[],
): Promise<PresetGoalResult[]> {
  const existing = new Set(existingIds);
  const results: PresetGoalResult[] = [];
  for (const goal of goals) {
    if (existing.has(goal.id)) {
      results.push({ id: goal.id, status: "skipped", reason: "already exists" });
      continue;
    }
    try {
      await addGoal({
        id: goal.id,
        name: goal.name,
        cron: goal.cron,
        operation: goal.operation,
        budgetCents: goal.budgetCents,
        enabled: goal.enabled,
        ...(goal.timeZone ? { timeZone: goal.timeZone } : {}),
      });
      results.push({ id: goal.id, status: "added" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not add goal.";
      if (message.toLowerCase().includes("already exists")) {
        results.push({ id: goal.id, status: "skipped", reason: message });
      } else {
        results.push({ id: goal.id, status: "failed", error: message });
      }
    }
  }
  return results;
}

/**
 * Issue #1922 — SessionStore resource goals preset. Values are exactly
 * the activation payloads in
 * docs/architecture/security/sessionstore-resource-rollup-alert-1819.md
 * (issue #1819): all three carry budgetCents 1, enabled true, and
 * timeZone "UTC" explicitly — the rollup day is a UTC day and an
 * absent timeZone would fall back to America/New_York firing.
 */
export const RESOURCE_GOALS_PRESET: {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled: boolean;
  timeZone: string;
}[] = [
  {
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
];

export type PresetGoalResult =
  | { id: string; status: "added" }
  | { id: string; status: "skipped"; reason: string }
  | { id: string; status: "failed"; error: string };

/**
 * Posts each preset goal in order and reports per-goal results.
 * A goal the server reports as already existing is SKIPPED, not
 * failed — the batch never fails wholesale and never duplicates.
 */
export async function addResourceGoals(): Promise<PresetGoalResult[]> {
  const results: PresetGoalResult[] = [];
  for (const goal of RESOURCE_GOALS_PRESET) {
    try {
      await addGoal(goal);
      results.push({ id: goal.id, status: "added" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not add goal.";
      if (message.toLowerCase().includes("already exists")) {
        results.push({ id: goal.id, status: "skipped", reason: message });
      } else {
        results.push({ id: goal.id, status: "failed", error: message });
      }
    }
  }
  return results;
}

export function setGoalEnabled(id: string, enabled: boolean) {
  return api<{ ok: boolean }>(`/api/schedule/goals/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function triggerGoal(id: string) {
  return api<{ ok: boolean; tick: ScheduleTick }>(
    `/api/schedule/goals/${encodeURIComponent(id)}/trigger`,
    { method: "POST" }
  );
}

export function removeGoal(id: string) {
  return api<{ ok: boolean }>(`/api/schedule/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
