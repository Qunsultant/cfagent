/**
 * Issue #2964 — Jobs UI API client. Issue #3121 Phase 2 (#3123):
 * THE schedule client module — the goal wrappers moved here from
 * scheduleApi.ts (now deprecated) so every schedule surface reads
 * through one shared set of wrappers, and the run reads converge
 * onto the one merged ledger read (`listAllRuns`). The `x-environment`
 * / `x-user-login` identity headers the panels carry ride as an
 * optional `headers` argument on the wrappers that need them
 * (withCsrfInit merges the CSRF header alongside).
 */
import type { JobRunRecord } from "../services/jobRunRecords";
import type { UnifiedScheduleRecord } from "../data/unifiedSchedulePorts";
import type { ScheduleProvenance } from "../schedule";
// The one transport for this module: apiFetch polls the 202
// async-job contract (#3309) — a queued list/create/detail call
// answers 202 with a statusUrl and the caller gets the completed
// body, never the receipt. The schedule panels relied on that
// through the old direct fetch (apiFetch as fetch); routing the
// converged wrappers through raw fetch dropped it (the 202 receipt
// came back as the "list" and the panel rendered nothing — caught
// by the #71 transport test). withCsrfInit is applied twice
// (here and inside apiFetch) — the merge is idempotent.
import { apiFetch as fetch, withCsrfInit } from "./apiFetch";

export type { JobRunRecord };
export type { UnifiedScheduleRecord };

export interface ScheduleListItem {
  id: string;
  callback: string;
  type?: string;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  delayInSeconds?: number;
  payload?: unknown;
  paused?: boolean;
  pausedAt?: string;
  nextRun?: number;
}

/** A schedule detail: the raw SDK schedule, or a paused list item. */
export type ScheduleDetail = ScheduleListItem & Record<string, unknown>;

export interface ScheduleSystemInfo {
  id: string;
  name: string;
  owner: string;
  storage: string;
  creation: string;
  execution: string;
}

export interface SystemsResponse {
  systems: ScheduleSystemInfo[];
  cronTriggers: string[];
  /** Issue #3121 Phase 2 (#3123) — worker duties as unified records. */
  workerDuties?: UnifiedScheduleRecord[];
}

/**
 * Issue #159 — a scheduled goal (moved from scheduleApi.ts, #3123).
 */
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

export type PresetGoalResult =
  | { id: string; status: "added" }
  | { id: string; status: "skipped"; reason: string }
  | { id: string; status: "failed"; error: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, withCsrfInit(init));
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.ok === false || data.success === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

/* =================================================================
 * Goals (moved verbatim from scheduleApi.ts, #3123 — the one client
 * module for every schedule surface).
 * ================================================================= */

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

/* =================================================================
 * The one merged ledger read (issue #3121 Phase 2, #3123).
 * Replaces listGoalRuns + listScheduleRuns: one call, both halves
 * (orchestrator DO-SQLite + ScheduledAgent KV), merged newest-first
 * server-side. `partial` is true when a half failed — the runs that
 * did arrive are still returned, never a bare failure.
 * ================================================================= */

export async function listAllRuns(
  jobId?: string,
  limit = 50,
): Promise<{ runs: JobRunRecord[]; partial: boolean }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (jobId) params.set("jobId", jobId);
  const data = await api<{ runs: JobRunRecord[]; partial?: boolean }>(
    `/api/ledger/runs?${params}`,
  );
  return { runs: data.runs || [], partial: data.partial === true };
}

/* =================================================================
 * Systems inventory + orchestrator schedules.
 * ================================================================= */

/** The schedule-systems inventory + Worker cron triggers (read-only). */
export async function listSystems(): Promise<SystemsResponse> {
  return api<SystemsResponse>("/api/schedule/systems");
}

/** Orchestrator durable schedules (existing list endpoint). */
export async function listSchedules(
  headers?: Record<string, string>,
): Promise<ScheduleListItem[]> {
  const res = await fetch("/api/schedules", { headers });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.schedules || data || [];
}

/** One schedule's detail (the raw SDK schedule, or a paused list item). */
export async function getSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<ScheduleDetail> {
  const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, { headers });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data || typeof data.id !== "string") {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as ScheduleDetail;
}

/** The gated creatable-callback allow-list for the create form. */
export async function listScheduleCallbacks(): Promise<string[]> {
  const data = await api<{ callbacks: string[] }>("/api/schedules/callbacks");
  return data.callbacks || [];
}

export async function triggerSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/trigger`, {
    method: "POST",
    headers,
  });
}

export async function pauseSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/pause`, {
    method: "POST",
    headers,
  });
}

export async function resumeSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    headers,
  });
}

export async function deleteSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers,
  });
}

/** Cancel through the POST /api/schedules/cancel endpoint. */
export async function cancelSchedule(
  id: string,
  headers?: Record<string, string>,
): Promise<{ scheduleId: string; cancelled: boolean }> {
  return api<{ scheduleId: string; cancelled: boolean }>(
    "/api/schedules/cancel",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    },
  );
}

export interface CreateScheduleBody {
  scheduleType: "cron" | "interval";
  callback: string;
  payload: Record<string, unknown>;
  cron?: string;
  intervalSeconds?: number;
}

/** Create through the EXISTING endpoint (gated callbacks only). */
export async function createSchedule(
  body: CreateScheduleBody,
  headers?: Record<string, string>,
): Promise<{ success?: boolean; schedule?: ScheduleListItem; error?: string }> {
  return api<{ success?: boolean; schedule?: ScheduleListItem; error?: string }>(
    "/api/schedules/create",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** Update a schedule's timing and/or payload (PUT /api/schedules/:id). */
export async function updateSchedule(
  id: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ success?: boolean; schedule?: ScheduleDetail; error?: string }> {
  return api<{ success?: boolean; schedule?: ScheduleDetail; error?: string }>(
    `/api/schedules/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Run one system job on demand through its trigger route (e.g.
 * /api/schedules/trigger-options-analysis). Returns the trigger
 * route's own body — the caller classifies success from
 * `data.success` / `data.error`, as before.
 */
export async function triggerSystemJob(
  route: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return api(route, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
