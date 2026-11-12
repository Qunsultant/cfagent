/**
 * @deprecated Issue #3121 Phase 2 (#3123) — retired by deprecation
 * rename only (gitops §22: never deleted). Superseded by
 * `src/services/unifiedScheduleManagement.ts`. Pause/resume/trigger/
 * update/detail now live in `src/services/unifiedScheduleManagement.ts`
 * (`resolveScheduleUpdate` moved there verbatim); the pure list
 * projections live there too. This file is FROZEN: no new features,
 * no new consumers; delete only when it has zero consumers and the
 * owner decides (see `docs/architecture/transition/deprecations.md`).
 *
 * Issue #273 — schedule management core behind the Schedules tab:
 * pause/resume and frequency/payload updates for durable schedules.
 *
 * The Agents SDK has no native pause: pausing persists the job's full
 * definition in the OrchestratorAgent's own SQLite (paused_schedules,
 * ensured lazily like the scan-run stores) and cancels the SDK
 * schedule; resuming re-arms from the stored definition. The job never
 * disappears from the user's list — it renders with status "paused"
 * and no next run.
 *
 * Updates follow the issue's own shape — cancel + recreate under the
 * hood: resolveScheduleUpdate (pure) validates the requested timing /
 * payload against the current definition, and the route performs the
 * swap. Paused jobs update in place inside the store.
 *
 * Issue #2337 (#1976 step 2): the paused-schedule STORE moved behind
 * its port in the data layer (src/data/pausedSchedulePorts.ts +
 * src/data/doSqlitePausedScheduleAdapter.ts +
 * src/data/inMemoryPausedScheduleAdapter.ts) and is re-exported below
 * so every existing import path is preserved. This module keeps the
 * pure domain code: the record/list-item projections and
 * resolveScheduleUpdate.
 */

import type { Schedule } from "agents";
import { buildSchedulePayload, SCREENING_SCHEDULE_CALLBACKS } from "../trading";
import type {
  PausedScheduleRecord,
  ScheduleDefinitionLike,
} from "../data/pausedSchedulePorts.deprecated";

export {
  PAUSED_SCHEDULES_TABLE,
  type PausedScheduleRecord,
  type PausedScheduleStore,
  type ScheduleDefinitionLike,
} from "../data/pausedSchedulePorts.deprecated";
export { SqlPausedScheduleStore } from "../data/doSqlitePausedScheduleAdapter.deprecated";

export function scheduleToPausedRecord(
  schedule: Schedule<unknown>,
  pausedAt: string
): PausedScheduleRecord {
  const s = schedule as Schedule<unknown> & {
    cron?: string;
    intervalSeconds?: number;
    delayInSeconds?: number;
    time?: number;
  };
  return {
    id: s.id,
    callback: s.callback,
    payload: s.payload,
    type: s.type,
    ...(s.cron !== undefined ? { cron: s.cron } : {}),
    ...(s.intervalSeconds !== undefined ? { intervalSeconds: s.intervalSeconds } : {}),
    ...(s.time !== undefined ? { time: s.time } : {}),
    ...(s.delayInSeconds !== undefined ? { delayInSeconds: s.delayInSeconds } : {}),
    pausedAt,
  };
}

/** The list-item shape the SchedulesPanel renders for a paused job:
 * the stored definition, flagged paused, with no next run. */
export function pausedRecordToListItem(record: PausedScheduleRecord) {
  return {
    id: record.id,
    callback: record.callback,
    payload: record.payload,
    type: record.type,
    ...(record.cron !== undefined ? { cron: record.cron } : {}),
    ...(record.intervalSeconds !== undefined ? { intervalSeconds: record.intervalSeconds } : {}),
    ...(record.delayInSeconds !== undefined ? { delayInSeconds: record.delayInSeconds } : {}),
    paused: true,
    pausedAt: record.pausedAt,
  };
}

/** PUT /api/schedules/:id body (issue #273). */
export interface ScheduleUpdateRequest {
  scheduleType?: string;
  cron?: string;
  intervalSeconds?: number;
  payload?: unknown;
}

export type ResolvedScheduleTiming =
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalSeconds: number }
  | { type: "scheduled" | "delayed"; time: number };

export type ScheduleUpdateResolution =
  | { ok: true; timing: ResolvedScheduleTiming; payload: unknown }
  | { ok: false; error: string };

/**
 * Validate an update against the current definition. A provided cron
 * or intervalSeconds switches the timing kind; otherwise the current
 * timing is kept (payload-only update). One-time schedules whose time
 * has already passed cannot be re-armed — recreating them would fire
 * immediately or never, so the caller is told to create a new job.
 */
export function resolveScheduleUpdate(
  current: ScheduleDefinitionLike,
  body: ScheduleUpdateRequest,
  nowMs: number
): ScheduleUpdateResolution {
  let payload = body.payload !== undefined ? body.payload : current.payload;

  // Issue #982 (screening consolidation S2): a NEWLY SUPPLIED payload
  // for a screening schedule validates through the ONE shared builder
  // (buildSchedulePayload, #959) — creation parity for updates. The
  // caller's identity fields are stripped exactly as the create route
  // strips them, and identity is re-stamped from the EXISTING
  // schedule's payload (the trusted context an update has), never
  // from the request. Creation defaults do not apply: the criteria
  // are validated and identity-stamped as given (the trigger routes'
  // semantics). Timing-only updates (no payload in the body) are not
  // re-validated — a legacy payload stays updatable — and
  // non-screening callbacks' payloads are not screening criteria.
  if (
    body.payload !== undefined &&
    (SCREENING_SCHEDULE_CALLBACKS as readonly string[]).includes(current.callback)
  ) {
    const currentPayload =
      current.payload && typeof current.payload === "object"
        ? (current.payload as Record<string, unknown>)
        : {};
    const { userLogin: _untrustedUserLogin, environment: _untrustedEnvironment, ...criteria } =
      body.payload && typeof body.payload === "object"
        ? (body.payload as Record<string, unknown>)
        : {};
    const built = buildSchedulePayload(current.callback, criteria, {
      userLogin: typeof currentPayload.userLogin === "string" ? currentPayload.userLogin : undefined,
      environment: typeof currentPayload.environment === "string" ? currentPayload.environment : undefined,
      trigger: "scheduled",
    }, { applyCreationDefaults: false });
    if (!built.ok) {
      return { ok: false, error: built.error };
    }
    payload = built.value;
  }

  if (body.cron !== undefined) {
    const cron = String(body.cron).trim();
    if (cron.split(/\s+/).filter(Boolean).length !== 5) {
      return { ok: false, error: `Invalid cron expression '${body.cron}': expected 5 fields (minute hour day-of-month month day-of-week).` };
    }
    return { ok: true, timing: { type: "cron", cron }, payload };
  }
  if (body.intervalSeconds !== undefined) {
    const seconds = Number(body.intervalSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return { ok: false, error: "intervalSeconds must be a positive whole number of seconds." };
    }
    return { ok: true, timing: { type: "interval", intervalSeconds: seconds }, payload };
  }
  if (body.scheduleType === "cron") {
    if (current.type !== "cron" || !current.cron) {
      return { ok: false, error: "This job has no cron expression to keep — provide one in 'cron'." };
    }
    return { ok: true, timing: { type: "cron", cron: current.cron }, payload };
  }
  if (body.scheduleType === "interval") {
    if (current.type !== "interval" || !current.intervalSeconds) {
      return { ok: false, error: "This job has no interval to keep — provide one in 'intervalSeconds'." };
    }
    return { ok: true, timing: { type: "interval", intervalSeconds: current.intervalSeconds }, payload };
  }

  // Payload-only update: keep the current timing.
  if (current.type === "cron" && current.cron) {
    return { ok: true, timing: { type: "cron", cron: current.cron }, payload };
  }
  if (current.type === "interval" && current.intervalSeconds) {
    return { ok: true, timing: { type: "interval", intervalSeconds: current.intervalSeconds }, payload };
  }
  if ((current.type === "scheduled" || current.type === "delayed") && current.time !== undefined) {
    if (current.time * 1000 <= nowMs) {
      return { ok: false, error: "This one-time schedule has already fired — create a new schedule instead of updating it." };
    }
    return { ok: true, timing: { type: current.type, time: current.time }, payload };
  }
  return { ok: false, error: "Could not determine the schedule's current timing to update it." };
}
