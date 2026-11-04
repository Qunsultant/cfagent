/**
 * Issue #2964 — Jobs UI API client. Goal CRUD stays in scheduleApi;
 * this module owns only the NEW reads (per-run records, systems
 * inventory, schedule callbacks) and the orchestrator-schedule
 * actions, all through the EXISTING endpoints — no duplicated
 * creation logic lives here.
 */
import type { JobRunRecord } from "../services/jobRunRecords";
import { withCsrfInit } from "./apiFetch";

export type { JobRunRecord };

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
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, withCsrfInit(init));
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.ok === false || data.success === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

/** Per-run records for ScheduledAgent goals (newest first). */
export async function listGoalRuns(jobId?: string, limit = 50): Promise<JobRunRecord[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (jobId) params.set("jobId", jobId);
  const data = await api<{ runs: JobRunRecord[] }>(`/api/schedule/runs?${params}`);
  return data.runs || [];
}

/** The schedule-systems inventory + Worker cron triggers (read-only). */
export async function listSystems(): Promise<SystemsResponse> {
  return api<SystemsResponse>("/api/schedule/systems");
}

/** Orchestrator durable schedules (existing list endpoint). */
export async function listSchedules(): Promise<ScheduleListItem[]> {
  const res = await fetch("/api/schedules");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as any;
  return data.schedules || data || [];
}

/** Per-run records for orchestrator schedules (newest first). */
export async function listScheduleRuns(scheduleId?: string, limit = 50): Promise<JobRunRecord[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (scheduleId) params.set("scheduleId", scheduleId);
  const data = await api<{ runs: JobRunRecord[] }>(`/api/schedules/runs?${params}`);
  return data.runs || [];
}

/** The gated creatable-callback allow-list for the create form. */
export async function listScheduleCallbacks(): Promise<string[]> {
  const data = await api<{ callbacks: string[] }>("/api/schedules/callbacks");
  return data.callbacks || [];
}

export async function triggerSchedule(id: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/trigger`, { method: "POST" });
}

export async function pauseSchedule(id: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: "POST" });
}

export async function resumeSchedule(id: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export async function deleteSchedule(id: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface CreateScheduleBody {
  scheduleType: "cron" | "interval";
  callback: string;
  payload: Record<string, unknown>;
  cron?: string;
  intervalSeconds?: number;
}

/** Create through the EXISTING endpoint (gated callbacks only). */
export async function createSchedule(body: CreateScheduleBody): Promise<void> {
  await api("/api/schedules/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
