/**
 * Issue #3121 Phase 2 (#3123, reuse) — the ONE schedule management
 * service: pause / resume / trigger / delete / detail / update /
 * list for every schedule kind, as pure domain code over the
 * unified ScheduleStore port + an alarms port.
 *
 * Before #3123, management lived in ten paths (Phase 2 survey):
 * the T2 routes + two direct-fetch clients + jobsApi, the T3
 * routes + DO methods + scheduleApi, the T1 entry points, and the
 * T4/admin queue ops. The service is the one path behind both
 * route families; the routes stay thin adapters (URL + auth +
 * audit) and the clients converge onto the one wrapper set in
 * `src/client/jobsApi.ts`.
 *
 * The service is deterministic code: agent judgment stays out of
 * it (#3122 builds the agent-facing layer on top of this store).
 * Kind-specific execution stays kind-specific — an SDK alarm
 * schedule arms/cancels through the alarms port, a goal flips
 * record state only (its tick skips paused goals), a worker duty
 * has no management operation (deployment config), and a followup
 * is managed through the async-job queue — but every kind resolves
 * through this one service, and an unsupported operation is a
 * coded { ok: false } outcome, never a silent fall-through.
 *
 * Identity (the #273 churn, fixed): the record id is stable
 * across pause / resume / update. The Agents SDK `schedule()` API
 * takes no id, so the SDK alarm id is SDK-assigned and rides the
 * record as `alarmId`, updated on every re-arm. Resume re-arms
 * the SAME record id; only the alarm changes.
 *
 * `resolveScheduleUpdate` moved here verbatim from
 * `src/services/scheduleManagement.ts` (issue #273, #982) — that
 * module is retired by #3123 (see scheduleManagement.deprecated.ts).
 */
import { buildSchedulePayload, SCREENING_SCHEDULE_CALLBACKS } from "../trading";
import type {
  UnifiedScheduleKind,
  UnifiedScheduleRecord,
  UnifiedScheduleState,
} from "../data/unifiedSchedulePorts";
import { carryScheduleProvenance } from "./consolidatedScheduling";
import {
  WORKER_CRON_TRIGGERS_INVENTORY,
} from "./scheduleSystems";
import { resolveCronEntryPoint } from "./consolidatedCronEntries";
import type { ScheduledGoal } from "../schedule";

/** A store surface the service accepts (sync or async — awaited). */
export interface UnifiedStoreLike {
  save(record: UnifiedScheduleRecord): void | Promise<void>;
  get(id: string): UnifiedScheduleRecord | undefined | Promise<UnifiedScheduleRecord | undefined>;
  list(): UnifiedScheduleRecord[] | Promise<UnifiedScheduleRecord[]>;
  listByKind(kind: UnifiedScheduleKind): UnifiedScheduleRecord[] | Promise<UnifiedScheduleRecord[]>;
  listByState(state: UnifiedScheduleState): UnifiedScheduleRecord[] | Promise<UnifiedScheduleRecord[]>;
  remove(id: string): boolean | Promise<boolean>;
  clear(): void | Promise<void>;
  clearPaused(): number | Promise<number>;
}

/** One SDK alarm schedule, as the routes see it. */
export interface ScheduleAlarmLike {
  id: string;
  callback: string;
  type?: string;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  delayInSeconds?: number;
  payload?: unknown;
  nextRun?: number;
}

/** The alarms port: the Agents SDK scheduler behind an interface. */
export interface ScheduleAlarms {
  list(): Promise<ScheduleAlarmLike[]>;
  get(id: string): Promise<ScheduleAlarmLike | undefined>;
  cancel(id: string): Promise<boolean>;
  arm(
    timing: ResolvedScheduleTiming,
    callback: string,
    payload: unknown,
  ): Promise<ScheduleAlarmLike>;
}

export interface UnifiedManagementDeps {
  store: UnifiedStoreLike;
  alarms: ScheduleAlarms;
}

export type UnifiedOpResult<T = UnifiedScheduleRecord> =
  | { ok: true; record: T; alarm?: ScheduleAlarmLike; previousId?: string }
  | { ok: false; error: string; status: number };

function fail(error: string, status: number): { ok: false; error: string; status: number } {
  return { ok: false, error, status };
}

/* =================================================================
 * Projections: SDK schedule / goal / worker duty ↔ unified record.
 * ================================================================= */

/** The definition shape updates resolve against (SDK schedule or record). */
export interface ScheduleDefinitionLike {
  type: "cron" | "interval" | "delayed" | "scheduled";
  callback: string;
  payload?: unknown;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  delayInSeconds?: number;
}

export function screenScheduleToRecord(
  schedule: ScheduleAlarmLike,
  nowIso: string,
  ownerLogin?: string | null,
): UnifiedScheduleRecord {
  const definition: Record<string, unknown> = {
    type: schedule.type ?? "cron",
    callback: schedule.callback,
    ...(schedule.payload !== undefined ? { payload: schedule.payload } : {}),
    ...(schedule.cron !== undefined ? { cron: schedule.cron } : {}),
    ...(schedule.intervalSeconds !== undefined
      ? { intervalSeconds: schedule.intervalSeconds }
      : {}),
    ...(schedule.time !== undefined ? { time: schedule.time } : {}),
    ...(schedule.delayInSeconds !== undefined
      ? { delayInSeconds: schedule.delayInSeconds }
      : {}),
  };
  return {
    id: schedule.id,
    kind: "screen",
    state: "active",
    callback: schedule.callback,
    definition,
    ...(ownerLogin ? { ownerLogin } : {}),
    alarmId: schedule.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** The list-item shape the SchedulesPanel renders for one record. */
export function unifiedRecordToListItem(record: UnifiedScheduleRecord, nextRun?: number) {
  const def = record.definition as Partial<ScheduleDefinitionLike> & {
    type?: string;
  };
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    callback: record.callback ?? (typeof def.callback === "string" ? def.callback : ""),
    payload: def.payload,
    type: def.type,
    ...(typeof def.cron === "string" ? { cron: def.cron } : {}),
    ...(typeof def.intervalSeconds === "number"
      ? { intervalSeconds: def.intervalSeconds }
      : {}),
    ...(typeof def.delayInSeconds === "number"
      ? { delayInSeconds: def.delayInSeconds }
      : {}),
    ...(typeof def.time === "number" ? { time: def.time } : {}),
    paused: record.state === "paused",
    ...(record.pausedAt ? { pausedAt: record.pausedAt } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
  };
}

/** A goal's unified record: the goal object IS the definition. */
export function goalToRecord(goal: ScheduledGoal): UnifiedScheduleRecord {
  const nowIso = new Date().toISOString();
  return {
    id: goal.id,
    kind: "goal",
    state: goal.enabled ? "active" : "paused",
    operation: goal.operation,
    definition: { ...(goal as unknown as Record<string, unknown>) },
    ...(goal.provenance !== undefined ? { provenance: goal.provenance } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** A unified goal record back to the ScheduledGoal the routes return. */
export function recordToGoal(record: UnifiedScheduleRecord): ScheduledGoal | undefined {
  if (record.kind !== "goal") return undefined;
  const def = record.definition as unknown as ScheduledGoal;
  if (!def || typeof def.id !== "string") return undefined;
  return {
    ...def,
    enabled: record.state === "active",
  };
}

/**
 * Worker duties as unified records, derived from the inventory
 * (never stored: they are deployment config, and the derivation is
 * the record). One record per inventory cron (accounting, not a
 * literal size — 3123-P09); state `"disabled"` while the Worker
 * crons are OFF (#4112).
 */
export function workerDutiesFromInventory(nowIso: string): UnifiedScheduleRecord[] {
  return WORKER_CRON_TRIGGERS_INVENTORY.map((cron) => {
    const entryPoint = resolveCronEntryPoint(cron) ?? "unknown";
    return {
      id: `worker-duty:${cron}`,
      kind: "worker-duty",
      state: "disabled",
      callback: entryPoint,
      definition: { cron, entryPoint },
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });
}

/** The timing a record definition re-arms with (null when incomplete). */
export function timingFromRecordDefinition(def: Record<string, unknown>): ResolvedScheduleTiming | null {
  const type = typeof def.type === "string" ? def.type : "";
  if (type === "cron" && typeof def.cron === "string" && def.cron) {
    return { type: "cron", cron: def.cron };
  }
  if (type === "interval" && typeof def.intervalSeconds === "number") {
    return { type: "interval", intervalSeconds: def.intervalSeconds };
  }
  if ((type === "scheduled" || type === "delayed") && typeof def.time === "number") {
    return { type, time: def.time };
  }
  return null;
}

/* =================================================================
 * The merged list: live SDK alarms joined to their records, plus
 * paused records. A record's id is the list id; a legacy alarm
 * with no record keeps its SDK id until it is touched (adoption).
 * ================================================================= */

export async function listUnifiedScheduleItems(
  deps: UnifiedManagementDeps,
  typeParam?: string | null,
): Promise<Array<ReturnType<typeof unifiedRecordToListItem>>> {
  const [alarms, records] = await Promise.all([
    deps.alarms.list(),
    deps.store.list(),
  ]);
  const byAlarmId = new Map<string, UnifiedScheduleRecord>();
  const byId = new Map<string, UnifiedScheduleRecord>();
  for (const record of records) {
    byId.set(record.id, record);
    if (record.alarmId) byAlarmId.set(record.alarmId, record);
  }
  const items: Array<ReturnType<typeof unifiedRecordToListItem>> = [];
  for (const alarm of alarms) {
    const record = byAlarmId.get(alarm.id) ?? byId.get(alarm.id);
    if (record && record.kind !== "screen") continue;
    if (record) {
      const item = unifiedRecordToListItem(record, alarm.nextRun);
      if (!typeParam || item.type === typeParam) items.push(item);
      continue;
    }
    const def = alarm as Partial<ScheduleDefinitionLike>;
    if (!typeParam || alarm.type === typeParam) {
      // The SDK only arms the four timing types; anything else is a
      // data anomaly and the list item carries no type rather than a
      // fabricated one.
      const alarmType =
        alarm.type === "cron" ||
        alarm.type === "interval" ||
        alarm.type === "scheduled" ||
        alarm.type === "delayed"
          ? alarm.type
          : undefined;
      items.push({
        id: alarm.id,
        kind: "screen",
        state: "active",
        callback: alarm.callback,
        payload: alarm.payload,
        type: alarmType,
        ...(typeof def.cron === "string" ? { cron: def.cron } : {}),
        ...(typeof def.intervalSeconds === "number"
          ? { intervalSeconds: def.intervalSeconds }
          : {}),
        ...(typeof def.delayInSeconds === "number"
          ? { delayInSeconds: def.delayInSeconds }
          : {}),
        ...(typeof def.time === "number" ? { time: def.time } : {}),
        paused: false,
        ...(alarm.nextRun !== undefined ? { nextRun: alarm.nextRun } : {}),
      });
    }
  }
  for (const record of records) {
    if (record.kind !== "screen" || record.state !== "paused") continue;
    if (record.alarmId && alarms.some((a) => a.id === record.alarmId)) continue;
    const item = unifiedRecordToListItem(record);
    if (!typeParam || item.type === typeParam) items.push(item);
  }
  return items;
}

/* =================================================================
 * Pause / resume / delete / detail / trigger / update.
 * ================================================================= */

function goalSurfaceError(action: string): { ok: false; error: string; status: number } {
  return fail(
    `Goal schedules ${action} through the goals surface (/api/schedule/goals/:id), not the SDK schedule routes.`,
    400,
  );
}

export async function pauseUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  nowIso: string,
): Promise<UnifiedOpResult> {
  const existing = await deps.store.get(id);
  if (existing) {
    if (existing.kind === "goal") return goalSurfaceError("pause");
    if (existing.kind !== "screen") {
      return fail(`Schedule kind '${existing.kind}' cannot be paused.`, 400);
    }
    if (existing.state === "paused") return { ok: true, record: existing };
  }
  const alarm = await deps.alarms.get(existing?.alarmId ?? id);
  if (!alarm) {
    return fail(`Schedule '${id}' not found`, 404);
  }
  const record: UnifiedScheduleRecord = existing
    ? { ...existing, state: "paused", pausedAt: nowIso, alarmId: alarm.id, updatedAt: nowIso }
    : {
        ...screenScheduleToRecord(alarm, nowIso),
        id,
        state: "paused",
        pausedAt: nowIso,
      };
  await deps.store.save(record);
  await deps.alarms.cancel(alarm.id);
  return { ok: true, record };
}

export async function resumeUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  nowIso: string,
): Promise<UnifiedOpResult> {
  const record = await deps.store.get(id);
  if (!record) {
    return fail(`Schedule '${id}' is not paused`, 404);
  }
  if (record.kind === "goal") return goalSurfaceError("resume");
  if (record.kind !== "screen") {
    return fail(`Schedule kind '${record.kind}' cannot be resumed.`, 400);
  }
  if (record.state !== "paused") {
    return fail(`Schedule '${id}' is not paused`, 404);
  }
  const timing = timingFromRecordDefinition(record.definition);
  if (!timing) {
    return fail(
      `Paused schedule '${id}' has an incomplete definition and cannot be resumed`,
      500,
    );
  }
  const callback =
    record.callback ?? (typeof record.definition.callback === "string" ? record.definition.callback : "");
  const alarm = await deps.alarms.arm(timing, callback, record.definition.payload);
  const resumed: UnifiedScheduleRecord = {
    ...record,
    state: "active",
    alarmId: alarm.id,
    pausedAt: null,
    updatedAt: nowIso,
  };
  await deps.store.save(resumed);
  return { ok: true, record: resumed, alarm, previousId: id };
}

export async function deleteUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
): Promise<{ ok: true; cancelled: boolean }> {
  const record = await deps.store.get(id);
  if (record && record.kind !== "screen") {
    return { ok: true, cancelled: false };
  }
  const alarmId = record?.alarmId ?? id;
  const alarmCancelled = await deps.alarms.cancel(alarmId);
  let recordRemoved = false;
  if (record) recordRemoved = await deps.store.remove(id);
  return { ok: true, cancelled: alarmCancelled || recordRemoved };
}

/**
 * Detail for one schedule. A live alarm returns the raw SDK
 * schedule (today's shape), with `id` replaced by the record id
 * when a record exists — the panel addresses the record id for
 * every later call. A paused record returns its list item (today's
 * paused shape). Anything else is a 404.
 */
export async function getUnifiedScheduleDetail(
  deps: UnifiedManagementDeps,
  id: string,
): Promise<
  | { ok: true; detail: unknown }
  | { ok: false; error: string; status: number }
> {
  const alarm = await deps.alarms.get(id);
  const record = await deps.store.get(id);
  if (alarm) {
    const owned = record && record.alarmId === id ? record : undefined;
    if (owned) {
      return { ok: true, detail: { ...alarm, id: owned.id } };
    }
    return { ok: true, detail: alarm };
  }
  if (record) return { ok: true, detail: unifiedRecordToListItem(record) };
  return fail(`Schedule '${id}' not found`, 404);
}

export async function triggerUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  run: (callback: string, payload: unknown) => Promise<void>,
): Promise<
  | { ok: true; scheduleId: string; callback: string }
  | { ok: false; error: string; status: number }
> {
  const record = await deps.store.get(id);
  if (record && record.kind !== "screen") return goalSurfaceError("trigger");
  if (record?.state === "paused") {
    return fail("Schedule is paused — resume it before triggering.", 409);
  }
  const alarm = await deps.alarms.get(record?.alarmId ?? id);
  if (!alarm) {
    return fail(`Schedule '${id}' not found`, 404);
  }
  const payload =
    alarm.payload && typeof alarm.payload === "object"
      ? { ...(alarm.payload as Record<string, unknown>), trigger: "manual", scheduleId: record?.id ?? id }
      : alarm.payload;
  await run(alarm.callback, payload);
  return { ok: true, scheduleId: record?.id ?? id, callback: alarm.callback };
}

/* =================================================================
 * Update — resolveScheduleUpdate moved verbatim from
 * src/services/scheduleManagement.ts (#273, #982).
 * ================================================================= */

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
  nowMs: number,
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

export async function updateUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  body: ScheduleUpdateRequest,
  nowMs: number,
): Promise<UnifiedOpResult> {
  const nowIso = new Date(nowMs).toISOString();
  const record = await deps.store.get(id);
  if (record && record.kind !== "screen") return goalSurfaceError("update");
  if (record?.state === "paused") {
    const resolution = resolveScheduleUpdate(
      record.definition as unknown as ScheduleDefinitionLike,
      body,
      nowMs,
    );
    if (!resolution.ok) return fail(resolution.error, 400);
    const updated: UnifiedScheduleRecord = {
      ...record,
      // Issue #3121 S1 — a rebuilt payload keeps the original
      // creation provenance verbatim (an update never rewrites
      // creation time); a payload with no prior provenance is
      // returned untouched.
      definition: {
        ...(record.definition as Record<string, unknown>),
        type: resolution.timing.type,
        payload: carryScheduleProvenance(record.definition.payload, resolution.payload),
        ...(resolution.timing.type === "cron" ? { cron: resolution.timing.cron } : {}),
        ...(resolution.timing.type === "interval"
          ? { intervalSeconds: resolution.timing.intervalSeconds }
          : {}),
        ...(resolution.timing.type === "scheduled" || resolution.timing.type === "delayed"
          ? { time: resolution.timing.time }
          : {}),
      },
      updatedAt: nowIso,
    };
    await deps.store.save(updated);
    return { ok: true, record: updated };
  }
  const alarm = await deps.alarms.get(record?.alarmId ?? id);
  if (!alarm) {
    return fail(`Schedule '${id}' not found`, 404);
  }
  const current: ScheduleDefinitionLike = {
    type: (alarm.type ?? "cron") as ScheduleDefinitionLike["type"],
    callback: alarm.callback,
    payload: alarm.payload,
    ...(alarm.cron !== undefined ? { cron: alarm.cron } : {}),
    ...(alarm.intervalSeconds !== undefined ? { intervalSeconds: alarm.intervalSeconds } : {}),
    ...(alarm.time !== undefined ? { time: alarm.time } : {}),
    ...(alarm.delayInSeconds !== undefined ? { delayInSeconds: alarm.delayInSeconds } : {}),
  };
  const resolution = resolveScheduleUpdate(current, body, nowMs);
  if (!resolution.ok) return fail(resolution.error, 400);
  await deps.alarms.cancel(alarm.id);
  const rearmed = await deps.alarms.arm(
    resolution.timing,
    alarm.callback,
    carryScheduleProvenance(alarm.payload, resolution.payload),
  );
  // The record id is the id the user addressed (stable across the
  // cancel + re-arm); only the alarm id changes. A legacy alarm
  // with no record adopts one here.
  const updated: UnifiedScheduleRecord = record
    ? {
        ...record,
        state: "active",
        alarmId: rearmed.id,
        definition: {
          ...(record.definition as Record<string, unknown>),
          type: resolution.timing.type,
          payload: carryScheduleProvenance(record.definition.payload, resolution.payload),
          ...(resolution.timing.type === "cron" ? { cron: resolution.timing.cron } : {}),
          ...(resolution.timing.type === "interval"
            ? { intervalSeconds: resolution.timing.intervalSeconds }
            : {}),
          ...(resolution.timing.type === "scheduled" || resolution.timing.type === "delayed"
            ? { time: resolution.timing.time }
            : {}),
        },
        updatedAt: nowIso,
      }
    : {
        ...screenScheduleToRecord(rearmed, nowIso),
        id,
      };
  await deps.store.save(updated);
  return { ok: true, record: updated, alarm: rearmed, previousId: id };
}
