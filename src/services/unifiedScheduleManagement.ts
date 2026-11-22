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
import { carryScheduleProvenance, provenanceFromPayload, stampScheduleProvenance, systemProvenance } from "./consolidatedScheduling";
import type { ScheduleProvenance } from "../schedule";
import { isBuiltinScheduledGoalId } from "../config/builtinScheduledGoals";
import {
  jobCatalogueEntryForCallback,
  jobCatalogueEntryForId,
  jobCatalogueEntryForOperation,
} from "../config/jobCatalogue";
import type { ScheduleSource } from "../config/scheduleSourceModes";
import {
  WORKER_CRON_TRIGGERS_INVENTORY,
} from "./scheduleSystems";
import { resolveCronEntryPoint } from "./consolidatedCronEntries";
import { canonicalJson } from "./scheduleDedupe";
import { classifyScheduleKind } from "./scheduleKinds";
import { SCHEDULE_LIST_KIND_IDS, type ScheduleListKind } from "../config/scheduleListModes";
import { RENEWAL_DISPATCH_CRON, RETENTION_DISPATCH_CRON, RETENTION_RECORD_ID, TOKEN_RENEWAL_RECORD_ID } from "./heartbeatDueChecks";
import {
  nightlyResearchDispatchCron,
  NIGHTLY_RESEARCH_RECORD_ID,
  type ResearchFireHourConfig,
} from "./researchScheduleGuard";
import { DEFAULT_RESEARCH_JOB_CONFIG } from "../config/researchJobConfig";
import {
  STALE_LEDGER_SWEEP_DISPATCH_CRON,
  STALE_LEDGER_SWEEP_RECORD_ID,
  STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON,
  STALE_ASYNC_JOB_SWEEP_RECORD_ID,
  SCHEDULE_WATCHDOG_DISPATCH_CRON,
  SCHEDULE_WATCHDOG_RECORD_ID,
} from "./sweepWatchdogSchedule";

/** Issue #4239 — re-exported beside the builder that uses it. */
export { TOKEN_RENEWAL_RECORD_ID } from "./heartbeatDueChecks";

/** Issue #4240 — re-exported beside the builder that uses it. */
export { RETENTION_RECORD_ID } from "./heartbeatDueChecks";

/** Issue #4241 — re-exported beside the builder that uses it. */
export { NIGHTLY_RESEARCH_RECORD_ID } from "./researchScheduleGuard";

/** Issue #4242 — re-exported beside the builders that use them. */
export {
  STALE_LEDGER_SWEEP_RECORD_ID,
  STALE_ASYNC_JOB_SWEEP_RECORD_ID,
  SCHEDULE_WATCHDOG_RECORD_ID,
} from "./sweepWatchdogSchedule";
import type { ScheduledGoal } from "../schedule";
import { isSubDailyCron, isSubDailyInterval, isValidCron } from "../schedule";

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

/**
 * Issue #4351 — the SDK callback a code-declared scheduled task runs under.
 * Think arms every task `getScheduledTasks()` returns under this callback with
 * a payload of { taskId, scheduleHash, scheduledFor }, so the payload is the
 * ONLY place the task id appears: a declaration cannot be paused or deleted by
 * alarm id, only by this id.
 */
export const DECLARED_TASK_CALLBACK = "_runDeclaredScheduledTask";

/**
 * Issue #5890 — the ONE job identity a schedule row keys on.
 *
 * - A code-declared task keys by its TASK id (`declaredTaskIdOf`,
 *   #4351) — never by `scheduleHash`: Think computes the hash from
 *   `{schedule, retry}` only, so two different tasks that resolved
 *   to the same schedule share one hash (both declared tasks show
 *   `1cc4bdea8e8b678cdc2258188071a26f`).
 * - A derived-record duty keys by its catalogue id: the live alarm
 *   (by callback) and the derived record (by id) are the same job —
 *   but ONLY when the catalogue entry's source is `derived-record`.
 *   A creatable callback (`autonomousMarketScreen`, …) is a job
 *   family, not one job: two user screens under it are two jobs, so
 *   they never collapse.
 * - Anything else keys by its own row id, so distinct user
 *   schedules keep distinct rows.
 */
export type ScheduleJobKeyInput =
  | {
      callback?: unknown;
      payload?: unknown;
      definition?: unknown;
      id?: unknown;
      operation?: unknown;
    }
  | null
  | undefined;

export function scheduleJobKeyOf(input: ScheduleJobKeyInput): string {
  const declared = declaredTaskIdOf(
    input as { callback?: unknown; payload?: unknown; definition?: unknown },
  );
  if (declared) return `declared:${declared}`;
  const holder = (input ?? {}) as {
    callback?: unknown;
    definition?: unknown;
    id?: unknown;
  };
  const definition =
    holder.definition && typeof holder.definition === "object"
      ? (holder.definition as { callback?: unknown })
      : undefined;
  const callback =
    typeof holder.callback === "string"
      ? holder.callback
      : typeof definition?.callback === "string"
        ? (definition.callback as string)
        : undefined;
  if (callback) {
    const byCallback = jobCatalogueEntryForCallback(callback);
    if (byCallback?.source === "derived-record") return `job:${byCallback.id}`;
  }
  const id = typeof holder.id === "string" ? holder.id : undefined;
  if (id) {
    const byId = jobCatalogueEntryForId(id);
    if (byId?.source === "derived-record") return `job:${byId.id}`;
  }
  return `row:${id ?? "unknown"}`;
}
/**
 * Issue #4351 — the declared task id an alarm (or a stored record's
 * definition) carries, or null for a schedule the user created. One reader
 * for both shapes, so the declaration filter and the pause/delete/resume
 * paths can never disagree about which task they mean.
 */
export function declaredTaskIdOf(
  value:
    | { callback?: unknown; payload?: unknown }
    | { definition?: unknown }
    | null
    | undefined,
): string | null {
  if (!value || typeof value !== "object") return null;
  const holder = value as { callback?: unknown; payload?: unknown; definition?: unknown };
  const definition =
    holder.definition && typeof holder.definition === "object"
      ? (holder.definition as { callback?: unknown; payload?: unknown })
      : holder;
  if (definition.callback !== DECLARED_TASK_CALLBACK) return null;
  const payload = definition.payload;
  if (!payload || typeof payload !== "object") return null;
  const taskId = (payload as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId : null;
}

/* =================================================================
 * Issue #5889 — schedule provenance: one source per row.
 *
 * The Schedules home merges at least seven sources into one table
 * with no source identity. The derivation below is the one reader
 * that attributes a row: it runs over the list shape
 * (`unifiedRecordToListItem`, the route-appended derived rows, and
 * the no-record alarm branch), so the row, its Source column, its
 * filter value and its detail dialog can never disagree. Pure and
 * total: every input yields exactly one source — a row whose
 * creation was never recorded reads "unknown" / "not recorded",
 * never a fabricated source.
 *
 * Rule order is load-bearing (first match wins): a ticker-push row
 * IS a derived-record catalogue entry, so the kind check precedes
 * the catalogue check; a sweep interval alarm runs under the same
 * callback as the derived sweep record, so the derived-record check
 * (stable id, provenance reason) precedes the callback check. The
 * #5880 job catalogue is the home of job identity: a derived
 * record resolves by its catalogue id, a callback/operation row by
 * its catalogue entry — no second id scheme is invented here.
 * ================================================================= */

/** The three sweep/watchdog `scheduleEvery` guard callbacks (`src/agents/orchestrator.ts`). */
const SWEEP_ALARM_CALLBACKS: readonly string[] = [
  "sweepStaleLedgerTasks",
  "sweepStaleAsyncJobs",
  "watchdogMissedSchedules",
];

/** The shapes a schedule, alarm, record or goal definition arrives in. */
export interface ScheduleSourceInput {
  id: string;
  kind?: string;
  callback?: string;
  operation?: string;
  payload?: unknown;
  provenance?: unknown;
  jobId?: string;
  definition?: Record<string, unknown> | unknown;
}

/** The validated provenance a payload or a record carries, if any. */
function scheduleSourceProvenance(input: ScheduleSourceInput): ScheduleProvenance | undefined {
  const definition =
    input.definition && typeof input.definition === "object"
      ? (input.definition as Record<string, unknown>)
      : undefined;
  const payload = input.payload ?? definition?.payload;
  return (
    provenanceFromPayload(payload) ?? provenanceFromPayload({ provenance: input.provenance })
  );
}

function scheduleSourceJobId(input: ScheduleSourceInput, payload: unknown): string | undefined {
  if (typeof input.jobId === "string" && input.jobId) return input.jobId;
  const definition =
    input.definition && typeof input.definition === "object"
      ? (input.definition as Record<string, unknown>)
      : undefined;
  if (typeof definition?.jobId === "string" && definition.jobId) {
    return definition.jobId as string;
  }
  if (payload && typeof payload === "object") {
    const jobId = (payload as Record<string, unknown>).jobId;
    if (typeof jobId === "string" && jobId) return jobId;
  }
  return undefined;
}

/** The catalogue job an input names (callback, operation, then id), or null. */
function catalogueJobOf(
  callback: string,
  operation: string | undefined,
  id: string,
): string | null {
  if (callback) {
    const byCallback = jobCatalogueEntryForCallback(callback);
    if (byCallback) return byCallback.id;
  }
  if (operation) {
    const byOperation = jobCatalogueEntryForOperation(operation);
    if (byOperation) return byOperation.id;
  }
  const byId = jobCatalogueEntryForId(id);
  if (byId) return byId.id;
  return null;
}

/** The arming origin a provenance value states, in plain words. */
function provenanceOrigin(provenance: ScheduleProvenance | undefined): string {
  if (!provenance) return "not recorded";
  if (provenance.origin === "user") {
    return provenance.createdBy ? `user ${provenance.createdBy}` : "user";
  }
  if (provenance.origin === "agent") {
    return `agent ${provenance.agentId ?? "unknown"}`;
  }
  return provenance.reason ? `system · ${provenance.reason}` : "system";
}

/**
 * The one source for a schedule row: kind + job identity + arming
 * origin (+ owning agent / workflow when the row names one).
 * Deterministic; the rule order above is part of the contract.
 */
export function resolveScheduleSource(input: ScheduleSourceInput): ScheduleSource {
  const definition =
    input.definition && typeof input.definition === "object"
      ? (input.definition as Record<string, unknown>)
      : undefined;
  const callback =
    typeof input.callback === "string"
      ? input.callback
      : typeof definition?.callback === "string"
        ? (definition.callback as string)
        : "";
  const operation =
    typeof input.operation === "string"
      ? input.operation
      : typeof definition?.operation === "string"
        ? (definition.operation as string)
        : undefined;
  const payload = input.payload ?? definition?.payload;
  const provenance = scheduleSourceProvenance(input);
  const jobId = scheduleSourceJobId(input, payload);
  const catalogueJob = catalogueJobOf(callback, operation, input.id);

  // The live feed's own row: the TickerAgent's push, not a due-check record.
  if (input.kind === "ticker-push") {
    return { kind: "ticker-push", job: input.id, origin: "TickerAgent feed", agent: "TickerAgent" };
  }
  // A derived record, by its stable catalogue id — or, for the IV
  // collection (whose record id is its alarm id), by the provenance
  // reason the builder stamps on the record and the payload.
  const derivedById = jobCatalogueEntryForId(input.id);
  if (derivedById?.source === "derived-record") {
    return { kind: "derived", job: input.id, origin: "system due-check" };
  }
  if (typeof provenance?.reason === "string" && provenance.reason) {
    const derivedByReason = jobCatalogueEntryForId(provenance.reason);
    if (derivedByReason?.source === "derived-record") {
      return { kind: "derived", job: provenance.reason, origin: "system due-check" };
    }
  }
  // A seeded built-in goal: tick-polled by the ScheduledAgent.
  if (input.kind === "goal" && isBuiltinScheduledGoalId(input.id)) {
    return { kind: "seeded", job: input.id, origin: "ScheduledAgent tick", agent: "ScheduledAgent" };
  }
  // A Think declared task: the payload's task id is the job identity.
  const declared = declaredTaskIdOf({ callback, payload });
  if (declared) {
    return {
      kind: "declared-task",
      job: declared,
      origin: "OrchestratorAgent declaration",
      agent: "OrchestratorAgent",
    };
  }
  // A workflow-stage schedule: the job id is the workflow it belongs to.
  if (input.kind === "workflow-stage" || callback === "runWorkflowStage") {
    return {
      kind: "workflow",
      job: jobId ?? input.id,
      origin: provenanceOrigin(provenance),
      ...(jobId ? { workflow: jobId } : {}),
    };
  }
  // A pipeline job schedule: the jobdef id is the job identity.
  if (callback === "runPipelineJobSchedule" || (jobId !== undefined && jobId.startsWith("jobdef:"))) {
    return { kind: "pipeline-job", job: jobId ?? input.id, origin: provenanceOrigin(provenance) };
  }
  // A sweep/watchdog interval alarm: the same job as the derived
  // row, a different row — the callback names the duty, never the
  // derived record's id.
  if ((SWEEP_ALARM_CALLBACKS as readonly string[]).includes(callback)) {
    return {
      kind: "sweep-alarm",
      job: callback,
      origin: "OrchestratorAgent interval guard",
      agent: "OrchestratorAgent",
    };
  }
  // A worker duty: deployment config, state disabled while Worker crons are OFF (#4112).
  if (input.kind === "worker-duty") {
    return { kind: "worker-duty", job: input.id, origin: "Worker cron (disabled)" };
  }
  // Provenance, where the record carries it: user, agent, system.
  if (provenance?.origin === "user") {
    return {
      kind: "user-created",
      job: catalogueJob ?? callback ?? input.id,
      origin: provenance.createdBy ? `user ${provenance.createdBy}` : "user",
    };
  }
  if (provenance?.origin === "agent") {
    return {
      kind: "agent-created",
      job: catalogueJob ?? callback ?? input.id,
      origin: `agent ${provenance.agentId ?? "unknown"}`,
      agent: provenance.agentId,
    };
  }
  if (provenance?.origin === "system") {
    return {
      kind: "system",
      job: catalogueJob ?? callback ?? input.id,
      origin: provenance.reason ? `system · ${provenance.reason}` : "system",
    };
  }
  // No provenance, no structural rule: not recorded, never invented.
  return { kind: "unknown", job: catalogueJob ?? callback ?? input.id, origin: "not recorded" };
}

/**
 * Issue #4351 — the declaration filter: drop the declared tasks the user
 * paused or deleted.
 *
 * Think reconciles declarations by task id. A task that disappears from
 * `getScheduledTasks()` has its armed schedule CANCELLED
 * (`_reconcileDeclaredScheduledTasks` prunes the rows it no longer sees), and
 * a task that reappears is armed again. So the user's decision is expressed
 * exactly here — one filter both declarers share — instead of hoping a re-arm
 * preserves it. A missing store (a host without DO SQLite) declares as before;
 * an UNREADABLE store fails closed — it may hold the user's pause, so the task
 * is not declared, and the next reconcile with a healthy store arms it again.
 */
export async function filterUndeclaredTasks<T>(
  store: Pick<UnifiedStoreLike, "get"> | null | undefined,
  tasks: Record<string, T>,
): Promise<Record<string, T>> {
  if (!store) return tasks;
  const out: Record<string, T> = {};
  for (const [taskId, task] of Object.entries(tasks)) {
    let record: UnifiedScheduleRecord | undefined;
    try {
      record = await store.get(taskId);
    } catch {
      // Fail closed: the store may hold the user's pause (4351's acceptance).
      continue;
    }
    if (record && (record.state === "paused" || record.state === "deleted")) continue;
    out[taskId] = task;
  }
  return out;
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
  /**
   * Issue #4351 — re-declare the code-declared scheduled tasks (the SDK's
   * `internal_reconcileScheduledTasks`). Resuming a DECLARED task arms nothing
   * itself: it flips the record to active and asks the declaration to
   * re-appear, so the next reconcile arms it. Absent on hosts without a
   * declaration; the resume then takes effect on the next wake.
   */
  reconcileDeclared?: (() => Promise<void>) | undefined;
}

export type UnifiedOpResult<T = UnifiedScheduleRecord> =
  | { ok: true; record: T; alarm?: ScheduleAlarmLike; previousId?: string }
  | { ok: false; error: string; status: number };

function fail(error: string, status: number): { ok: false; error: string; status: number } {
  return { ok: false, error, status };
}

/**
 * Issue #3121 #4238 — the kinds the one management path serves
 * like a screen: the list shows them, and pause / resume / delete /
 * trigger / update operate on them. `screen` is the creatable set,
 * `workflow-stage` the internal-only stage callback (#3310), and
 * `internal` the internal-only callbacks (#4238: IV collection;
 * token renewal and the sweeps/watchdog follow in #4239/#4242).
 * Every other kind refuses with its own name (goal via its own
 * surface, worker-duty and ticker-push as unmanageable here).
 */
function isManagedAlarmKind(kind: UnifiedScheduleKind): boolean {
  return kind === "screen" || kind === "workflow-stage" || kind === "internal";
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
  /**
   * Issue #4235 — the schedule's recorded opt-in to a sub-daily
   * cadence (see ScheduledGoal.subDailyOptIn). Absent means the
   * default daily ceiling applies.
   */
  subDailyOptIn?: boolean;
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
    // Issue #4235 — the create route stamps the sub-daily opt-in
    // onto the armed payload; the record lifts it to the definition
    // top level so updates read it as the schedule's recorded opt-in.
    ...((schedule.payload as Record<string, unknown> | undefined)?.subDailyOptIn === true
      ? { subDailyOptIn: true }
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

/**
 * Issue #3121 #4236 — the strategy-scan baseline's origin, named
 * once: the system-armed hourly full-catalog scan
 * (autonomousOptionsAnalysis, NASDAQ100). The audit already carries
 * this origin; the record and the armed payload carry it too, so
 * the Schedules home can name it.
 */
export const STRATEGY_SCAN_BASELINE_ORIGIN = "strategy-scan-baseline";

/** The inputs a baseline record needs beyond the armed alarm. */
export interface StrategyScanBaselineRecordInput {
  userLogin: string;
  cron: string;
}

/**
 * A strategy-scan baseline unified record, from its armed alarm
 * (record id = alarm id, the #3123 screen precedent). The armed
 * payload is stamped with the system provenance — a no-op when
 * already stamped, so a re-arm keeps the original creation time —
 * and the record carries the same provenance value, so the record
 * and the firing payload never disagree about the origin. An
 * `existing` record keeps its creation time.
 */
export function strategyScanBaselineToRecord(
  alarm: ScheduleAlarmLike,
  input: StrategyScanBaselineRecordInput,
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  const minted = systemProvenance(
    STRATEGY_SCAN_BASELINE_ORIGIN,
    new Date(nowIso),
  );
  const payload = stampScheduleProvenance(alarm.payload ?? {}, minted);
  const provenance = provenanceFromPayload(payload) ?? minted;
  const record = screenScheduleToRecord(
    { ...alarm, payload },
    existing?.createdAt ?? nowIso,
    input.userLogin,
  );
  return {
    ...record,
    definition: {
      ...record.definition,
      cron: input.cron,
    },
    provenance,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Issue #3121 #4238 — the IV history collection's origin, named
 * once: the system-armed daily IV collection (collectIvHistory,
 * weekdays 22:15 UTC). The ledger already carries the runs (#3394);
 * the record and the armed payload carry this origin too, so the
 * Schedules home can name it.
 */
export const IV_HISTORY_COLLECTION_ORIGIN = "iv-history-collection";

/** The inputs an IV collection record needs beyond the armed alarm. */
export interface IvHistoryCollectionRecordInput {
  userLogin: string;
  cron: string;
}

/**
 * An IV history collection unified record, from its armed alarm
 * (record id = alarm id, the #3123 screen precedent; kind
 * `internal`, the seventh kind — an internal-only callback, never
 * user-creatable). The armed payload is stamped with the system
 * provenance — a no-op when already stamped, so a re-arm keeps the
 * original creation time — and the record carries the same
 * provenance value, so the record and the firing payload never
 * disagree about the origin. An `existing` record keeps its
 * creation time. The ledger join needs nothing new: the #3394
 * recording stamps the firing alarm's id as the run's scheduleId,
 * which is this record's id.
 */
export function ivHistoryCollectionToRecord(
  alarm: ScheduleAlarmLike,
  input: IvHistoryCollectionRecordInput,
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  const minted = systemProvenance(
    IV_HISTORY_COLLECTION_ORIGIN,
    new Date(nowIso),
  );
  const payload = stampScheduleProvenance(alarm.payload ?? {}, minted);
  const provenance = provenanceFromPayload(payload) ?? minted;
  const record = screenScheduleToRecord(
    { ...alarm, payload },
    existing?.createdAt ?? nowIso,
    input.userLogin,
  );
  return {
    ...record,
    kind: "internal",
    definition: {
      ...record.definition,
      cron: input.cron,
    },
    provenance,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Issue #3121 #4239 — the token-renewal record's origin, named
 * once. One shared duty (the heartbeat due-check renews the
 * broker tokens daily), so one stable record id (the id itself
 * lives in heartbeatDueChecks, beside the ledger job id).
 */
export const TOKEN_RENEWAL_ORIGIN = "token-renewal";

/** The last renewal a token-renewal list item carries (ledger-joined). */
export interface TokenRenewalLastRun {
  started: string;
  finished?: string;
  outcome?: string;
}

/**
 * A token-renewal unified record, DERIVED — not stored, not
 * alarm-adopted. There is no steady-state alarm to adopt: the
 * duty fires through the heartbeat due-check (#4234,
 * runRenewTokensEntryPoint, RENEWAL_DISPATCH_CRON), and legacy
 * alarms are removed by migrateLegacyScreenSchedules. The cron
 * is read from RENEWAL_DISPATCH_CRON, never re-literalized, so
 * the record and the firing check can never disagree about the
 * cadence; the entry point is the ledger job id the runs join
 * on. Kind `internal` (the #4238 seventh kind), state `active`
 * — the duty IS live through the heartbeat, not disabled like
 * the Worker-cron inventory rows. An `existing` record keeps its
 * creation time.
 */
export function tokenRenewalToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  return {
    id: TOKEN_RENEWAL_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "autoRenewETradeTokens",
    definition: {
      type: "cron",
      cron: RENEWAL_DISPATCH_CRON,
      entryPoint: "renewTokens",
    },
    provenance: systemProvenance(TOKEN_RENEWAL_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Issue #3121 #4240 — the retention record's origin, named
 * once. One shared duty (the heartbeat due-check runs the
 * retention pass daily), so one stable record id (the id itself
 * lives in heartbeatDueChecks, beside the ledger job id).
 */
export const RETENTION_ORIGIN = "retention";

/** The last pass a retention list item carries (ledger-joined). */
export interface RetentionLastRun {
  started: string;
  finished?: string;
  outcome?: string;
  /** The pass-outcome summary the entry point stored as the dispatch detail. */
  detail?: string;
}

/**
 * A retention unified record, DERIVED — not stored, not
 * alarm-adopted. There is no steady-state alarm to adopt: the
 * duty fires through the heartbeat due-check (#4234,
 * runRetentionEntryPoint, RETENTION_DISPATCH_CRON), and the
 * Worker cron is OFF per #4112. The cron is read from
 * RETENTION_DISPATCH_CRON, never re-literalized, so the record
 * and the firing check can never disagree about the cadence; the
 * entry point is the ledger job id the runs join on. Kind
 * `internal` (the #4238 seventh kind), state `active` — the duty
 * IS live through the heartbeat, not disabled like the
 * Worker-cron inventory rows. An `existing` record keeps its
 * creation time.
 */
export function retentionToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  return {
    id: RETENTION_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "retention",
    definition: {
      type: "cron",
      cron: RETENTION_DISPATCH_CRON,
      entryPoint: "retention",
    },
    provenance: systemProvenance(RETENTION_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Issue #3121 #4241 — the nightly research record's origin, named
 * once. One shared duty (the #354 daily options-research run,
 * POST /research/scheduled-tick), so one stable record id (the id
 * itself lives in researchScheduleGuard, beside the firing rule).
 */
export const NIGHTLY_RESEARCH_ORIGIN = "nightly-research";

/** The last run a nightly research list item carries (ledger-joined). */
export interface NightlyResearchLastRun {
  started: string;
  finished?: string;
  outcome?: string;
}

/**
 * A nightly research unified record, DERIVED — not stored, not
 * alarm-adopted. There is no steady-state alarm to adopt: the duty
 * fires through the every-30-minute tick rider (#354, dispatchTickRiders posts
 * /research/scheduled-tick on every tick; the route's guard decides
 * fire/no-fire), and the Worker cron is OFF per #4112. The cron is
 * read from nightlyResearchDispatchCron (derived from the resolved
 * research config, issue #6030), never re-literalized, so
 * the record and the firing guard can never disagree about the
 * cadence; the entry point is the ledger job id the runs join on
 * (jobId = record id). Kind `internal` (the #4238 seventh kind),
 * state `active` — the duty IS live through the tick, not disabled
 * like the Worker-cron inventory rows. (The Nov-12 definition
 * recorded `disabled` — "firing waits on #4234"; #4234 has since
 * landed as 55e3e1f, the alarm tick dispatches the research POST,
 * so the wait is over. A failed run writes no ledger row — its
 * failure is recorded by the #2037 tick-outcome sink — so the
 * last run shown is the last successful firing.) An `existing`
 * record keeps its creation time.
 */
export function nightlyResearchToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
  config: ResearchFireHourConfig = DEFAULT_RESEARCH_JOB_CONFIG,
): UnifiedScheduleRecord {
  return {
    id: NIGHTLY_RESEARCH_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "nightly-research",
    definition: {
      type: "cron",
      cron: nightlyResearchDispatchCron(config),
      entryPoint: "nightly-research",
    },
    provenance: systemProvenance(NIGHTLY_RESEARCH_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Issue #3121 #4242 — the stale-ledger-task sweep record's origin,
 * named once. One shared duty (the #618 sweep, armed once per user
 * on a 6-hour interval), so one stable record id (the id itself
 * lives in sweepWatchdogSchedule, beside the firing rule).
 */
export const STALE_LEDGER_SWEEP_ORIGIN = "sweep-stale-ledger-tasks";

/**
 * Issue #3121 #4242 — the stale-async-job sweep record's origin,
 * named once. One shared duty (the #3784 sweep, armed once per
 * instance on a 15-minute interval), so one stable record id (the
 * id itself lives in sweepWatchdogSchedule, beside the firing rule).
 */
export const STALE_ASYNC_JOB_SWEEP_ORIGIN = "sweep-stale-async-jobs";

/**
 * Issue #3121 #4242 — the missed-schedule watchdog record's
 * origin, named once. One shared duty (the #3788 watchdog, armed
 * once per instance on the same 15-minute tick as the async-job
 * sweep), so one stable record id (the id itself lives in
 * sweepWatchdogSchedule, beside the firing rule).
 */
export const SCHEDULE_WATCHDOG_ORIGIN = "schedule-watchdog";

/** The last run a stale-ledger-sweep list item carries (ledger-joined). */
export interface StaleLedgerSweepLastRun {
  started: string;
  finished?: string;
  outcome?: string;
  detail?: string;
}

/** The last run a stale-async-job-sweep list item carries (ledger-joined). */
export interface StaleAsyncJobSweepLastRun {
  started: string;
  finished?: string;
  outcome?: string;
  detail?: string;
}

/** The last run a schedule-watchdog list item carries (ledger-joined). */
export interface ScheduleWatchdogLastRun {
  started: string;
  finished?: string;
  outcome?: string;
  detail?: string;
}

/**
 * A stale-ledger-task sweep unified record, DERIVED — not stored,
 * not alarm-adopted. The sweep IS live through its SDK alarm (armed
 * once per user from onStart, 6-hour interval), so the record reads
 * state `active`. The cron is read from
 * STALE_LEDGER_SWEEP_DISPATCH_CRON, never re-literalized, so the
 * record and the arming can never disagree about the cadence; the
 * entry point is the ledger job id the runs join on (jobId =
 * record id). Kind `internal` (the #4238 seventh kind). An
 * `existing` record keeps its creation time.
 */
export function staleLedgerSweepToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  return {
    id: STALE_LEDGER_SWEEP_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "sweepStaleLedgerTasks",
    definition: {
      type: "cron",
      cron: STALE_LEDGER_SWEEP_DISPATCH_CRON,
      entryPoint: "sweep-stale-ledger-tasks",
    },
    provenance: systemProvenance(STALE_LEDGER_SWEEP_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * A stale-async-job sweep unified record, DERIVED — not stored, not
 * alarm-adopted. The sweep IS live through its SDK alarm (armed
 * once per instance from onStart, 15-minute interval), so the
 * record reads state `active`. The cron is read from
 * STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON, never re-literalized; the
 * entry point is the ledger job id the runs join on (jobId =
 * record id). Kind `internal` (the #4238 seventh kind). An
 * `existing` record keeps its creation time.
 */
export function staleAsyncJobSweepToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  return {
    id: STALE_ASYNC_JOB_SWEEP_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "sweepStaleAsyncJobs",
    definition: {
      type: "cron",
      cron: STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON,
      entryPoint: "sweep-stale-async-jobs",
    },
    provenance: systemProvenance(STALE_ASYNC_JOB_SWEEP_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * A missed-schedule watchdog unified record, DERIVED — not stored,
 * not alarm-adopted. The watchdog IS live through its SDK alarm
 * (armed once per instance from onStart, 15-minute interval), so
 * the record reads state `active`. The cron is read from
 * SCHEDULE_WATCHDOG_DISPATCH_CRON, never re-literalized; the entry
 * point is the record id (its runs join on the pre-existing
 * heartbeat job id — see scheduleIdToLedgerJobId). Kind `internal`
 * (the #4238 seventh kind). An `existing` record keeps its
 * creation time.
 */
export function scheduleWatchdogToRecord(
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  return {
    id: SCHEDULE_WATCHDOG_RECORD_ID,
    kind: "internal",
    state: "active",
    callback: "watchdogMissedSchedules",
    definition: {
      type: "cron",
      cron: SCHEDULE_WATCHDOG_DISPATCH_CRON,
      entryPoint: "schedule-watchdog",
    },
    provenance: systemProvenance(SCHEDULE_WATCHDOG_ORIGIN, new Date(nowIso)),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/** True when an alarm payload carries a stage address (jobId + nodePath). */
function isStageAlarmPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.jobId === "string" && typeof p.nodePath === "string";
}

/** A stage-schedule's unified record, from its armed alarm (record id = alarm id, #3123). */
export function workflowStageScheduleToRecord(
  alarm: ScheduleAlarmLike,
  nowIso: string,
  ownerLogin?: string | null,
): UnifiedScheduleRecord {
  const payload = (alarm.payload ?? {}) as Record<string, unknown>;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
  const nodePath = typeof payload.nodePath === "string" ? payload.nodePath : "";
  const stageId = typeof payload.stageId === "string" ? payload.stageId : "";
  return {
    id: alarm.id,
    kind: "workflow-stage",
    state: "active",
    callback: alarm.callback,
    definition: {
      type: alarm.type ?? "cron",
      callback: alarm.callback,
      payload: alarm.payload,
      ...(typeof alarm.cron === "string" ? { cron: alarm.cron } : {}),
      ...(typeof alarm.intervalSeconds === "number"
        ? { intervalSeconds: alarm.intervalSeconds }
        : {}),
      ...(typeof alarm.time === "number" ? { time: alarm.time } : {}),
      jobId,
      nodePath,
      stageId,
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    },
    ...(ownerLogin ? { ownerLogin } : {}),
    ...(payload.provenance !== undefined ? { provenance: payload.provenance } : {}),
    alarmId: alarm.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** The one ticker-push record's stable id (one shared feed, #4237). */
export const TICKER_PUSH_RECORD_ID = "ticker-push";

/** The TickerAgent feed facts one ticker-push record carries. */
export interface TickerPushRecordInput {
  intervalSeconds: number;
  alarmId?: string | null;
  lastPushAt?: string | null;
  armed: boolean;
  /** Issue #4352 — the operator paused the feed; a pause survives every start. */
  paused?: boolean;
}

/**
 * A ticker-push unified record, from the TickerAgent's live feed
 * state (issue #4237). The record id is stable (one shared feed);
 * the SDK alarm id rides as `alarmId` and changes on every re-arm
 * (the #3123 screen precedent). An `existing` record keeps its
 * creation time: a push updates the record in place, it never
 * recreates it. The feed writes no ledger rows — one record,
 * updated per push, is the whole visibility surface.
 */
export function tickerPushScheduleToRecord(
  input: TickerPushRecordInput,
  nowIso: string,
  existing?: UnifiedScheduleRecord | null,
): UnifiedScheduleRecord {
  // A push that carries no timestamp keeps the previous one: the
  // record's lastPushAt only ever moves forward to a real push.
  const prevLastPushAt =
    existing?.definition !== undefined &&
    typeof (existing.definition as Record<string, unknown>).lastPushAt === "string"
      ? ((existing.definition as Record<string, unknown>).lastPushAt as string)
      : undefined;
  const lastPushAt = input.lastPushAt ?? prevLastPushAt;
  // Issue #4352 — the pause is a fact of the record: a push, an idle-cancel
  // or a restart never clears it, only a resume does.
  const prevPaused =
    existing?.definition !== undefined &&
    (existing.definition as Record<string, unknown>).paused === true;
  const paused = input.paused ?? prevPaused;
  return {
    id: TICKER_PUSH_RECORD_ID,
    kind: "ticker-push",
    state: paused ? "paused" : "active",
    callback: "pushTicks",
    definition: {
      type: "interval",
      callback: "pushTicks",
      intervalSeconds: input.intervalSeconds,
      armed: input.armed,
      paused,
      ...(lastPushAt !== undefined ? { lastPushAt } : {}),
    },
    ...(paused ? { pausedAt: existing?.pausedAt ?? nowIso } : {}),
    ...(input.alarmId !== undefined && input.alarmId !== null
      ? { alarmId: input.alarmId }
      : existing?.alarmId !== undefined
        ? { alarmId: existing.alarmId }
        : {}),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/** The create input for a stage-schedule: the stage address, timing, and firing payload. */
export interface WorkflowStageScheduleCreateInput {
  jobId: string;
  nodePath: string;
  stageId: string;
  callback: string;
  timing: ResolvedScheduleTiming;
  payload?: unknown;
  ownerLogin?: string | null;
}

/**
 * Create a stage-schedule: arm the firing alarm, then save the record
 * with id = alarm id (the #3123 screen precedent). The caller owns
 * validation (registry + timing) — this service arms and stores.
 */
export async function createWorkflowStageSchedule(
  deps: UnifiedManagementDeps,
  input: WorkflowStageScheduleCreateInput,
  nowIso: string,
): Promise<UnifiedOpResult> {
  const alarm = await deps.alarms.arm(input.timing, input.callback, input.payload);
  const record = workflowStageScheduleToRecord(
    { ...alarm, payload: input.payload ?? alarm.payload },
    nowIso,
    input.ownerLogin ?? null,
  );
  await deps.store.save(record);
  return { ok: true, record, alarm };
}

/** Ticker-push health as the Schedules home renders it (#4237). */
export type TickerPushHealth = "healthy" | "idle" | "stale";

/**
 * Derive ticker-push health from the record, purely (issue #4237).
 * - idle: the feed is disarmed (no listeners) — nothing is missed,
 *   however old the last push is.
 * - healthy: armed and the last push (or the record's creation, when
 *   armed but never pushed) is within `staleAfterIntervals` cadences.
 * - stale: armed and older than that — the stopped push, visible as
 *   a missed run. An unparseable baseline or an unknown cadence is
 *   stale (fail toward visible, never toward silent health).
 */
export function tickerPushHealth(
  record: UnifiedScheduleRecord,
  nowMs: number,
  staleAfterIntervals: number,
): TickerPushHealth {
  const def = record.definition as Record<string, unknown>;
  if (def.armed === false) return "idle";
  const intervalSeconds =
    typeof def.intervalSeconds === "number" &&
    Number.isFinite(def.intervalSeconds) &&
    def.intervalSeconds > 0
      ? def.intervalSeconds
      : null;
  if (intervalSeconds === null) return "stale";
  const baseline =
    typeof def.lastPushAt === "string" ? def.lastPushAt : record.createdAt;
  const baselineMs = Date.parse(baseline);
  if (!Number.isFinite(baselineMs)) return "stale";
  return nowMs - baselineMs > staleAfterIntervals * intervalSeconds * 1000
    ? "stale"
    : "healthy";
}

/**
 * A ticker-push record as a Schedules home list item: the shared
 * list shape plus the derived health (issue #4237). The caller
 * supplies `nowMs` and the owner-configured stale threshold; the
 * health is computed here, never on the client.
 */
export function tickerPushRecordToListItem(
  record: UnifiedScheduleRecord,
  nowMs: number,
  staleAfterIntervals: number,
): ReturnType<typeof unifiedRecordToListItem> & { health: TickerPushHealth } {
  return {
    ...unifiedRecordToListItem(record),
    health: tickerPushHealth(record, nowMs, staleAfterIntervals),
  };
}

/**
 * A token-renewal record as a Schedules home list item: the shared
 * list shape plus the last renewal joined from the ledger (issue
 * #4239). The caller supplies the ledger's latest run, if any; a
 * duty that has never fired carries no last run, and the home
 * renders "never" — a missed renewal is visible, not silent.
 */
export function tokenRenewalRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: TokenRenewalLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
  };
}

/**
 * A retention record as a Schedules home list item: the shared
 * list shape plus the last pass joined from the ledger (issue
 * #4240). The caller supplies the ledger's latest run, if any; a
 * duty that has never fired carries no last run, and the home
 * renders "never" — a missed pass is visible, not silent. The
 * pass-outcome summary rides `lastRunDetail`, rendered verbatim
 * by the home — no second parser.
 */
export function retentionRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: RetentionLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
  lastRunDetail?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
    ...(lastRun?.detail ? { lastRunDetail: lastRun.detail } : {}),
  };
}

/**
 * A nightly research record as a Schedules home list item: the shared
 * list shape plus the last run joined from the ledger (issue #4241).
 * The caller supplies the ledger's latest run, if any; a duty that
 * has never fired carries no last run, and the home renders "never" —
 * a missed run is visible, not silent.
 */
export function nightlyResearchRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: NightlyResearchLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
  };
}

/**
 * A stale-ledger-task sweep record as a Schedules home list item:
 * the shared list shape plus the last run joined from the ledger
 * (issue #4242). The caller supplies the ledger's latest run, if
 * any; a duty that has never fired carries no last run, and the
 * home renders "never" — a missed run is visible, not silent. The
 * run's counts ride `lastRunDetail`, so the row shows them.
 */
export function staleLedgerSweepRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: StaleLedgerSweepLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
  lastRunDetail?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
    ...(lastRun?.detail ? { lastRunDetail: lastRun.detail } : {}),
  };
}

/**
 * A stale-async-job sweep record as a Schedules home list item, the
 * same shape as the ledger sweep (issue #4242): last run joined
 * from the ledger, counts in `lastRunDetail`.
 */
export function staleAsyncJobSweepRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: StaleAsyncJobSweepLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
  lastRunDetail?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
    ...(lastRun?.detail ? { lastRunDetail: lastRun.detail } : {}),
  };
}

/**
 * A schedule-watchdog record as a Schedules home list item, the
 * same shape as the sweeps (issue #4242): last run joined from the
 * ledger's heartbeat rows, examined/missed/skipped counts in
 * `lastRunDetail`.
 */
export function scheduleWatchdogRecordToListItem(
  record: UnifiedScheduleRecord,
  lastRun?: ScheduleWatchdogLastRun | null,
): ReturnType<typeof unifiedRecordToListItem> & {
  lastRunAt?: string;
  lastRunOutcome?: string;
  lastRunDetail?: string;
} {
  return {
    ...unifiedRecordToListItem(record),
    ...(lastRun ? { lastRunAt: lastRun.started } : {}),
    ...(lastRun?.outcome ? { lastRunOutcome: lastRun.outcome } : {}),
    ...(lastRun?.detail ? { lastRunDetail: lastRun.detail } : {}),
  };
}

/** The list-item shape the SchedulesPanel renders for one record. */
export function unifiedRecordToListItem(record: UnifiedScheduleRecord, nextRun?: number) {
  const def = record.definition as Partial<ScheduleDefinitionLike> & {
    type?: string;
  };
  // Issue #5889 — the record's provenance rides the list item (the
  // payload's stamp wins; a record-only stamp, like the derived
  // builders', is the fallback), and the row's source is derived
  // from it once, here, so the column, the filters and the detail
  // dialog can never disagree.
  const provenance =
    provenanceFromPayload(def.payload) ??
    provenanceFromPayload({ provenance: record.provenance });
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
    ...(provenance !== undefined ? { provenance } : {}),
    source: resolveScheduleSource({
      id: record.id,
      kind: record.kind,
      callback: record.callback,
      operation: record.operation,
      payload: def.payload,
      provenance: record.provenance,
      jobId:
        typeof (def as Record<string, unknown>).jobId === "string"
          ? ((def as Record<string, unknown>).jobId as string)
          : undefined,
      definition: record.definition as Record<string, unknown>,
    }),
    // Issue #3310 — a stage-schedule names its workflow + stage, so
    // the home renders the stage, not just the firing callback.
    ...(typeof (def as Record<string, unknown>).jobId === "string"
      ? { jobId: (def as Record<string, unknown>).jobId as string }
      : {}),
    ...(typeof (def as Record<string, unknown>).stageId === "string"
      ? { stageId: (def as Record<string, unknown>).stageId as string }
      : {}),
    // Issue #4237 — a ticker-push row shows its last push and
    // whether the feed is armed, so the home can render health.
    ...(record.kind === "ticker-push" &&
    typeof (def as Record<string, unknown>).lastPushAt === "string"
      ? { lastPushAt: (def as Record<string, unknown>).lastPushAt as string }
      : {}),
    ...(record.kind === "ticker-push" &&
    typeof (def as Record<string, unknown>).armed === "boolean"
      ? { armed: (def as Record<string, unknown>).armed as boolean }
      : {}),
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

/**
 * Issue #4205 — dirty-check saves: whether a record-to-be-written
 * carries any persisted change against the loaded record. The
 * comparison is order-insensitive deep equality (`canonicalJson`
 * from `./scheduleDedupe`, reused — no new equality helper) over
 * every persisted field EXCEPT `updatedAt`, which the save always
 * bumps on a real write and which therefore never counts as a
 * change. `createdAt` IS compared: the caller preserves it from
 * the loaded record before comparing, so a preserved stamp matches
 * and a genuinely new record (no loaded row) is never "unchanged"
 * — the caller only calls this when a loaded row exists. A goal
 * whose definition, state, operation, or provenance differs is
 * changed; an untouched goal compares equal and its re-save is
 * skipped, so a tick over not-due goals writes nothing.
 */
export function isUnchangedGoalRecord(
  prev: UnifiedScheduleRecord,
  next: UnifiedScheduleRecord,
): boolean {
  const { updatedAt: _prevUpdatedAt, ...prevRest } = prev;
  const { updatedAt: _nextUpdatedAt, ...nextRest } = next;
  return canonicalJson(prevRest) === canonicalJson(nextRest);
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
 * Issue #5890 — one row per job: the collapse and the arm-time
 * hygiene. Pure functions over the list shape, so the service list
 * and the route list (which appends the derived rows after this
 * service) collapse through the same reader.
 * ================================================================= */

/** The canonical id a job key names, or the row id for a row key. */
function canonicalIdOfJobKey(key: string): string {
  const sep = key.indexOf(":");
  return sep === -1 ? key : key.slice(sep + 1);
}

/** Winner rank inside one job: the canonical row, then a live row, then a paused row. */
function collapseRank(
  item: { id: string; paused: boolean },
  canonicalId: string,
): number {
  if (item.id === canonicalId) return 0;
  return item.paused ? 2 : 1;
}

/**
 * Whether the candidate wins over the incumbent inside one job.
 * Same rank: a live row wins on the soonest firing; a paused row
 * wins on the most recent pause; a canonical row is unique, so its
 * tie-break is the id. A live row beats a stale paused record
 * because the job IS firing — a per-alarm paused record does not
 * block re-declaration (the filter reads by task id), so the paused
 * record is a stale per-occurrence artifact, not the job's state.
 * A canonical paused record beats a live alarm because it DOES
 * block re-declaration: the alarm beside it is an orphan that fires
 * into an early return, not the job.
 */
function collapseWinsOver(
  candidate: {
    id: string;
    paused: boolean;
    nextRun?: number;
    time?: number;
    pausedAt?: string;
  },
  incumbent: {
    id: string;
    paused: boolean;
    nextRun?: number;
    time?: number;
    pausedAt?: string;
  },
  canonicalId: string,
): boolean {
  const candidateRank = collapseRank(candidate, canonicalId);
  const incumbentRank = collapseRank(incumbent, canonicalId);
  if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;
  if (candidateRank === 0) return candidate.id < incumbent.id;
  if (candidateRank === 1) {
    const candidateNext = candidate.nextRun ?? Number.POSITIVE_INFINITY;
    const incumbentNext = incumbent.nextRun ?? Number.POSITIVE_INFINITY;
    if (candidateNext !== incumbentNext) return candidateNext < incumbentNext;
    const candidateTime = candidate.time ?? Number.POSITIVE_INFINITY;
    const incumbentTime = incumbent.time ?? Number.POSITIVE_INFINITY;
    if (candidateTime !== incumbentTime) return candidateTime < incumbentTime;
    return candidate.id < incumbent.id;
  }
  const candidatePaused = candidate.pausedAt ?? "";
  const incumbentPaused = incumbent.pausedAt ?? "";
  if (candidatePaused !== incumbentPaused) return candidatePaused > incumbentPaused;
  const candidateTime = candidate.time ?? Number.NEGATIVE_INFINITY;
  const incumbentTime = incumbent.time ?? Number.NEGATIVE_INFINITY;
  if (candidateTime !== incumbentTime) return candidateTime > incumbentTime;
  return candidate.id < incumbent.id;
}

/**
 * Issue #5890 — collapse a schedule list to one row per job.
 * Groups by `scheduleJobKeyOf` and keeps one winner per key; rows
 * keep the position of their key's first appearance, so a list
 * with no duplicates is byte-identical in order. Pure and total:
 * a list of distinct jobs passes through unchanged.
 */
export function collapseScheduleListItems<
  T extends ReturnType<typeof unifiedRecordToListItem>,
>(items: readonly T[]): T[] {
  const winners = new Map<string, { firstIndex: number; item: T }>();
  items.forEach((item, index) => {
    const key = scheduleJobKeyOf(item);
    const existing = winners.get(key);
    if (!existing) {
      winners.set(key, { firstIndex: index, item });
      return;
    }
    if (collapseWinsOver(item, existing.item, canonicalIdOfJobKey(key))) {
      winners.set(key, { firstIndex: existing.firstIndex, item });
    }
  });
  return [...winners.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((entry) => entry.item);
}

/** The shapes the arm-time helpers read (an alarm row, SDK or port). */
export interface DeclaredTaskAlarmInput {
  id: string;
  callback?: unknown;
  payload?: unknown;
  time?: unknown;
}

/**
 * Issue #5890 — the superseded declared-task occurrence alarms to
 * cancel: every alarm past the first for one (taskId, scheduledFor)
 * group. Two reconciles that both find `schedule_id` missing arm
 * the same occurrence twice (the Agents SDK mints a fresh id per
 * arming; `idempotent: true` does not dedupe by payload), so the
 * same occurrence can hold two SDK ids. Keeps the most recently
 * armed (last in list order — the SDK lists in arming order, and
 * Think's last reconcile tracked the last arm it wrote). Cancelling
 * the tracked one is still safe: the next reconcile re-arms exactly
 * one, so a wrong guess converges instead of accumulating.
 */
export function supersededDeclaredTaskAlarmIds(
  alarms: readonly DeclaredTaskAlarmInput[],
): string[] {
  const groups = new Map<string, string[]>();
  for (const alarm of alarms) {
    const taskId = declaredTaskIdOf(alarm);
    if (!taskId) continue;
    const payload =
      alarm.payload && typeof alarm.payload === "object"
        ? (alarm.payload as { scheduledFor?: unknown })
        : undefined;
    const scheduledFor =
      typeof payload?.scheduledFor === "number"
        ? payload.scheduledFor
        : typeof alarm.time === "number"
          ? alarm.time
          : null;
    const key = `${taskId}:${scheduledFor === null ? "none" : scheduledFor}`;
    const group = groups.get(key) ?? [];
    group.push(alarm.id);
    groups.set(key, group);
  }
  const superseded: string[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    superseded.push(...ids.slice(0, -1));
  }
  return superseded.sort();
}

/** The shapes the ensure-guard plan reads (an alarm row, SDK or port). */
export interface GuardAlarmInput {
  id: string;
  callback?: unknown;
  payload?: unknown;
}

/**
 * Issue #5890 — one ensure-guard's decision for a duty callback:
 * arm only when no matching alarm exists; when matches exist, do
 * not arm, and cancel every match past the first (a superseded arm
 * from an earlier guard run, e.g. one that armed while the list
 * failed). The caller owns the list failure: a failed list must
 * never reach this function as an empty list, or the guard arms
 * blind and mints a second alarm for the same callback.
 */
export function planGuardAlarm(
  alarms: readonly GuardAlarmInput[],
  callback: string,
  payloadMatches: (payload: unknown) => boolean,
): { arm: boolean; cancelIds: string[] } {
  const matching = alarms.filter(
    (alarm) => alarm.callback === callback && payloadMatches(alarm.payload),
  );
  if (matching.length === 0) return { arm: true, cancelIds: [] };
  return { arm: false, cancelIds: matching.slice(1).map((alarm) => alarm.id) };
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
    // Issue #4351 — a deleted schedule's tombstone hides its alarm, in the
    // window before the next declaration prunes it.
    if (record && record.state === "deleted") continue;
    if (record && !isManagedAlarmKind(record.kind)) continue;
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
      // Issue #5889 — a legacy alarm with no record carries its
      // source too, derived from the alarm alone (its payload's
      // stamp, if any); a row with no provenance reads Unknown.
      const alarmProvenance = provenanceFromPayload(alarm.payload);
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
        ...(alarmProvenance !== undefined ? { provenance: alarmProvenance } : {}),
        source: resolveScheduleSource({
          id: alarm.id,
          callback: alarm.callback,
          payload: alarm.payload,
        }),
      });
    }
  }
  for (const record of records) {
    if (!isManagedAlarmKind(record.kind) || record.state !== "paused") {
      continue;
    }
    if (record.alarmId && alarms.some((a) => a.id === record.alarmId)) continue;
    const item = unifiedRecordToListItem(record);
    if (!typeParam || item.type === typeParam) items.push(item);
  }
  // Issue #5890 — one row per job: the same taskId / derived duty
  // rendered as several rows (duplicate arms, stale per-alarm paused
  // records) collapses to its winner here, so every reader of this
  // list sees the one row.
  return collapseScheduleListItems(items);
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

/**
 * Issue #4239 — the token-renewal record is derived, not stored:
 * there is no alarm to pause, resume, trigger, or update, and
 * nothing to delete. Management refuses with the record's own
 * name instead of a 404 for a row the home lists (a 404 would
 * say the schedule does not exist; it does — it is derived).
 * The manual trigger stays on its existing route,
 * POST /api/schedules/trigger-renew.
 */
function isDerivedTokenRenewalRecord(id: string): boolean {
  return id === TOKEN_RENEWAL_RECORD_ID;
}

function derivedTokenRenewalError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'token-renewal' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

/**
 * Issue #4240 — the retention record is derived, not stored:
 * there is no alarm to pause, resume, trigger, or update, and
 * nothing to delete. Management refuses with the record's own
 * name instead of a 404 for a row the home lists (a 404 would
 * say the schedule does not exist; it does — it is derived).
 * The manual trigger stays on its existing route,
 * POST /api/schedules/trigger-retention.
 */
function isDerivedRetentionRecord(id: string): boolean {
  return id === RETENTION_RECORD_ID;
}

function derivedRetentionError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'retention' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

/**
 * Issue #4241 — the nightly research record is derived, not stored:
 * there is no alarm to pause, resume, trigger, or update, and
 * nothing to delete. Management refuses with the record's own
 * name instead of a 404 for a row the home lists (a 404 would
 * say the schedule does not exist; it does — it is derived).
 * The run fires on the tick; there is no manual trigger route
 * for it (the manual research route is unchanged).
 */
function isDerivedNightlyResearchRecord(id: string): boolean {
  return id === NIGHTLY_RESEARCH_RECORD_ID;
}

function derivedNightlyResearchError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'nightly-research' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

/**
 * Issue #4242 — the three sweep/watchdog records are derived, not
 * stored: there is no alarm to pause, resume, trigger, or update,
 * and nothing to delete. Management refuses with the record's own
 * name instead of a 404 for a row the home lists (a 404 would
 * say the schedule does not exist; it does — it is derived). The
 * duties fire on their own SDK alarms; there is no manual trigger
 * route for them.
 */
function isDerivedStaleLedgerSweepRecord(id: string): boolean {
  return id === STALE_LEDGER_SWEEP_RECORD_ID;
}

function isDerivedStaleAsyncJobSweepRecord(id: string): boolean {
  return id === STALE_ASYNC_JOB_SWEEP_RECORD_ID;
}

function isDerivedScheduleWatchdogRecord(id: string): boolean {
  return id === SCHEDULE_WATCHDOG_RECORD_ID;
}

function derivedStaleLedgerSweepError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'sweep-stale-ledger-tasks' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

function derivedStaleAsyncJobSweepError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'sweep-stale-async-jobs' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

function derivedScheduleWatchdogError(
  verb: string,
): { ok: false; error: string; status: number } {
  return fail(
    `Schedule 'schedule-watchdog' is a derived record with no alarm to ${verb}.`,
    400,
  );
}

export async function pauseUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  nowIso: string,
): Promise<UnifiedOpResult> {
  // Issue #4239 — a derived record has no alarm to pause.
  if (isDerivedTokenRenewalRecord(id)) return derivedTokenRenewalError("pause");
  // Issue #4240 — a derived record has no alarm to pause.
  if (isDerivedRetentionRecord(id)) return derivedRetentionError("pause");
  // Issue #4241 — a derived record has no alarm to pause.
  if (isDerivedNightlyResearchRecord(id)) return derivedNightlyResearchError("pause");
  // Issue #4242 — derived records have no alarm to pause.
  if (isDerivedStaleLedgerSweepRecord(id)) return derivedStaleLedgerSweepError("pause");
  if (isDerivedStaleAsyncJobSweepRecord(id)) return derivedStaleAsyncJobSweepError("pause");
  if (isDerivedScheduleWatchdogRecord(id)) return derivedScheduleWatchdogError("pause");
  const existing = await deps.store.get(id);
  if (existing) {
    if (existing.kind === "goal") return goalSurfaceError("pause");
    if (!isManagedAlarmKind(existing.kind)) {
      return fail(`Schedule kind '${existing.kind}' cannot be paused.`, 400);
    }
  }
  const alarm = await deps.alarms.get(existing?.alarmId ?? id);
  if (!alarm && !existing) {
    return fail(`Schedule '${id}' not found`, 404);
  }
  // Issue #4351 — a code-declared task is identified by its TASK id (the id
  // `getScheduledTasks()` declares it under), not by the SDK's alarm id: the
  // declaration filter reads the record by task id, so pausing has to store it
  // there. A user-created schedule keeps the id the caller addressed.
  // Issue #5890 — the task id is read from the RECORD first: a stale row's
  // alarm is already gone, so the alarm alone cannot name the task, and
  // pausing that row stored a separate record under the SDK alarm id.
  const declaredTaskId = declaredTaskIdOf(existing) ?? declaredTaskIdOf(alarm);
  const recordId = declaredTaskId ?? id;
  // Issue #5890 — a declared task's occurrences are one job: pausing
  // cancels EVERY live alarm for the task, not just the addressed one,
  // so no superseded occurrence is left listed (or firing into the
  // handler's early return). Runs before the already-paused return
  // too, so a re-pause still clears strays the duplicate-arming race
  // left behind.
  const cancelSupersededTaskAlarms = async (): Promise<void> => {
    if (!declaredTaskId) return;
    const live = await deps.alarms.list();
    for (const other of live) {
      if (other.id === alarm?.id) continue;
      if (declaredTaskIdOf(other) === declaredTaskId) {
        await deps.alarms.cancel(other.id);
      }
    }
  };
  if (existing && existing.state === "paused" && existing.id === recordId) {
    await cancelSupersededTaskAlarms();
    return { ok: true, record: existing };
  }
  let record: UnifiedScheduleRecord;
  if (existing) {
    // Issue #5890 — the merge: an existing record under a per-alarm id
    // is re-keyed to the task id instead of kept as a second row. (The
    // pre-#5890 spread kept `existing.id`, so pausing a row whose
    // record already lived under the alarm id never collapsed it.)
    record = {
      ...existing,
      id: recordId,
      state: "paused",
      pausedAt: nowIso,
      alarmId: alarm?.id ?? existing.alarmId,
      updatedAt: nowIso,
    };
  } else if (alarm) {
    record = {
      ...(isStageAlarmPayload(alarm.payload)
        ? workflowStageScheduleToRecord(alarm, nowIso)
        : screenScheduleToRecord(alarm, nowIso)),
      id: recordId,
      state: "paused",
      pausedAt: nowIso,
    };
  } else {
    // Unreachable: the 404 above fires when both are missing.
    return fail(`Schedule '${id}' not found`, 404);
  }
  await deps.store.save(record);
  // Issue #5890 — merge: every other stored record for this declared
  // task (a legacy per-alarm record, from a pause before #4351 keyed
  // it by task id) folds into the one record under the task id.
  if (declaredTaskId) {
    const stored = await deps.store.list();
    for (const other of stored) {
      if (other.id !== recordId && declaredTaskIdOf(other) === declaredTaskId) {
        await deps.store.remove(other.id);
      }
    }
  }
  if (alarm) await deps.alarms.cancel(alarm.id);
  await cancelSupersededTaskAlarms();
  return { ok: true, record };
}

export async function resumeUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
  nowIso: string,
): Promise<UnifiedOpResult> {
  // Issue #4239 — a derived record has no alarm to resume.
  if (isDerivedTokenRenewalRecord(id)) return derivedTokenRenewalError("resume");
  // Issue #4240 — a derived record has no alarm to resume.
  if (isDerivedRetentionRecord(id)) return derivedRetentionError("resume");
  // Issue #4241 — a derived record has no alarm to resume.
  if (isDerivedNightlyResearchRecord(id)) return derivedNightlyResearchError("resume");
  // Issue #4242 — derived records have no alarm to resume.
  if (isDerivedStaleLedgerSweepRecord(id)) return derivedStaleLedgerSweepError("resume");
  if (isDerivedStaleAsyncJobSweepRecord(id)) return derivedStaleAsyncJobSweepError("resume");
  if (isDerivedScheduleWatchdogRecord(id)) return derivedScheduleWatchdogError("resume");
  const record = await deps.store.get(id);
  if (!record) {
    return fail(`Schedule '${id}' is not paused`, 404);
  }
  if (record.kind === "goal") return goalSurfaceError("resume");
  if (!isManagedAlarmKind(record.kind)) {
    return fail(`Schedule kind '${record.kind}' cannot be resumed.`, 400);
  }
  if (record.state !== "paused") {
    return fail(`Schedule '${id}' is not paused`, 404);
  }
  // Issue #4351 — a declared task has no timing of its own: its cadence lives
  // in the code declaration. Resume flips the record to active and re-runs the
  // declaration, which arms it again (Think's reconcile is the supported hook
  // for "app-owned data getScheduledTasks() reads").
  if (declaredTaskIdOf(record)) {
    const taskId = declaredTaskIdOf(record) as string;
    const resumed: UnifiedScheduleRecord = {
      ...record,
      id: taskId,
      state: "active",
      pausedAt: null,
      updatedAt: nowIso,
    };
    await deps.store.save(resumed);
    // Issue #5890 — merge: a resume addressed by a stale per-alarm id
    // moves the record under the task id, and every other stored
    // record for the same task folds into it, so the one row the list
    // shows is the one the declaration reads.
    if (record.id !== taskId) await deps.store.remove(record.id);
    const stored = await deps.store.list();
    for (const other of stored) {
      if (other.id !== taskId && declaredTaskIdOf(other) === taskId) {
        await deps.store.remove(other.id);
      }
    }
    await deps.reconcileDeclared?.();
    return { ok: true, record: resumed, previousId: id };
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

/**
 * Issue #5891 — the result of a delete: either the row is gone
 * (`cancelled: true`) or the delete is refused with the named
 * error, like pause / resume / trigger / update refuse. There is
 * no silent `{ok: true, cancelled: false}` any more: that shape
 * told the UI the delete had succeeded while the row stayed.
 */
export type DeleteUnifiedScheduleResult =
  | { ok: true; cancelled: boolean }
  | { ok: false; error: string; status: number };

export async function deleteUnifiedSchedule(
  deps: UnifiedManagementDeps,
  id: string,
): Promise<DeleteUnifiedScheduleResult> {
  // Issue #5891 — a derived record refuses delete with a named
  // error, like pause / resume / trigger / update refuse it
  // (#4239–#4242). The #4237 no-op precedent is retired: it told
  // the UI the delete had succeeded while the row re-derived on
  // every list.
  if (isDerivedTokenRenewalRecord(id)) return derivedTokenRenewalError("delete");
  // Issue #5891 — a derived record refuses delete (see above).
  if (isDerivedRetentionRecord(id)) return derivedRetentionError("delete");
  // Issue #5891 — a derived record refuses delete (see above).
  if (isDerivedNightlyResearchRecord(id)) return derivedNightlyResearchError("delete");
  // Issue #5891 — derived records refuse delete (see above).
  if (isDerivedStaleLedgerSweepRecord(id)) return derivedStaleLedgerSweepError("delete");
  if (isDerivedStaleAsyncJobSweepRecord(id)) return derivedStaleAsyncJobSweepError("delete");
  if (isDerivedScheduleWatchdogRecord(id)) return derivedScheduleWatchdogError("delete");
  const record = await deps.store.get(id);
  if (record) {
    // Issue #5891 — a goal deletes through the goals surface, and
    // any other non-managed kind names itself, like trigger refuses
    // it — never a silent no-op.
    if (record.kind === "goal") return goalSurfaceError("delete");
    if (!isManagedAlarmKind(record.kind)) {
      return fail(`Schedule kind '${record.kind}' cannot be deleted.`, 400);
    }
  }
  const alarm = record ? undefined : await deps.alarms.get(id);
  const alarmId = record?.alarmId ?? id;
  const alarmCancelled = await deps.alarms.cancel(alarmId);
  // Issue #4351 — a code-declared task is re-created by the next boot's
  // declaration, so deleting it cancels the alarm AND writes a tombstone under
  // the id the declaration uses; the filter then stops declaring it. A
  // user-created schedule has no declaration to come back, so its record is
  // simply removed (the pre-#4351 behaviour).
  const declaredTaskId = declaredTaskIdOf(record) ?? declaredTaskIdOf(alarm);
  if (declaredTaskId) {
    const nowIso = new Date().toISOString();
    const base = record ?? screenScheduleToRecord(alarm as ScheduleAlarmLike, nowIso);
    await deps.store.save({
      ...base,
      id: declaredTaskId,
      state: "deleted",
      alarmId: null,
      updatedAt: nowIso,
    });
    return { ok: true, cancelled: true };
  }
  let recordRemoved = false;
  if (record) recordRemoved = await deps.store.remove(id);
  // Issue #5891 — nothing was there to delete: a 404 names the
  // id instead of the silent `{ok: true, cancelled: false}` the
  // route used to answer 200 with.
  if (!alarmCancelled && !recordRemoved) {
    return fail(`Schedule '${id}' not found`, 404);
  }
  return { ok: true, cancelled: true };
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
  // Issue #4351 — a tombstone is not a schedule: a deleted id is not found,
  // even in the window before the declaration prunes its stale alarm.
  if (record && record.state === "deleted") {
    return fail(`Schedule '${id}' not found`, 404);
  }
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
  // Issue #4239 — a derived record has no alarm to trigger.
  if (isDerivedTokenRenewalRecord(id)) return derivedTokenRenewalError("trigger");
  // Issue #4240 — a derived record has no alarm to trigger.
  if (isDerivedRetentionRecord(id)) return derivedRetentionError("trigger");
  // Issue #4241 — a derived record has no alarm to trigger.
  if (isDerivedNightlyResearchRecord(id)) return derivedNightlyResearchError("trigger");
  // Issue #4242 — derived records have no alarm to trigger.
  if (isDerivedStaleLedgerSweepRecord(id)) return derivedStaleLedgerSweepError("trigger");
  if (isDerivedStaleAsyncJobSweepRecord(id)) return derivedStaleAsyncJobSweepError("trigger");
  if (isDerivedScheduleWatchdogRecord(id)) return derivedScheduleWatchdogError("trigger");
  const record = await deps.store.get(id);
  // Issue #4237 — a non-screen kind is refused with its own name:
  // the goal-surface text is wrong for a live feed (or a worker
  // duty), and a wrong refusal is worse than a terse one.
  if (record && !isManagedAlarmKind(record.kind)) {
    if (record.kind === "goal") return goalSurfaceError("trigger");
    return fail(`Schedule kind '${record.kind}' cannot be triggered.`, 400);
  }
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
 * Bulk — pause / resume / trigger in bulk and per category (#5878).
 * ================================================================= */

/** The three bulk verbs: the same verbs the single-row path offers. */
export type BulkScheduleVerb = "pause" | "resume" | "trigger";

/**
 * A bulk scope: `all` (every row the home lists) or one filter kind
 * (the kinds `src/config/scheduleListModes.ts` already names).
 */
export type BulkScheduleScope = "all" | ScheduleListKind;

/** A bulk scope is valid when it is `all` or one of the filter kinds. */
export function isBulkScheduleScope(value: unknown): value is BulkScheduleScope {
  return (
    value === "all" ||
    (typeof value === "string" &&
      (SCHEDULE_LIST_KIND_IDS as readonly string[]).includes(value))
  );
}

/**
 * One row of the Schedules home list, as the bulk verb sees it: the
 * fields the kind classifier reads, plus the paused flag the list
 * already rendered. The row's record is re-read from the store at
 * execution time (below), so a row paused after the list loaded is
 * still reported correctly — the flag here is classification input
 * only, never the execution state.
 */
export interface BulkScheduleRow {
  id: string;
  callback?: string;
  type?: string;
  payload?: unknown;
  paused?: boolean;
}

/** One row's outcome in a bulk summary. */
export type BulkScheduleOutcome =
  | "paused"
  | "already-paused"
  | "resumed"
  | "already-active"
  | "triggered"
  | "refused";

/** One row's result: its id, its filter kind, its outcome, and — for a refusal — why. */
export interface BulkScheduleRowResult {
  id: string;
  kind: ScheduleListKind;
  outcome: BulkScheduleOutcome;
  reason?: string;
}

/** A bulk verb's summary: counts plus one result per in-scope row, in list order. */
export interface BulkScheduleSummary {
  verb: BulkScheduleVerb;
  scope: BulkScheduleScope;
  total: number;
  /** Rows the verb acted on (paused / resumed / triggered). */
  applied: number;
  /** Rows already in the desired state (already-paused / already-active). */
  already: number;
  /** Rows refused, each with its reason in `results`. */
  refused: number;
  results: BulkScheduleRowResult[];
}

/**
 * A row-level override for rows the one management path does not own
 * (the live-feed row, whose pause / resume / trigger go through its
 * own host, not the unified store). Returning `undefined` falls
 * through to the standard path; `already: true` on an ok result
 * reports the row as already in the desired state (a feed that is
 * already paused, on a bulk pause).
 */
export type BulkScheduleRowExecutor = (
  row: BulkScheduleRow,
  verb: BulkScheduleVerb,
) => Promise<
  | { ok: true; already?: boolean }
  | { ok: false; error: string }
  | undefined
>;

function bulkAppliedOutcome(verb: BulkScheduleVerb): BulkScheduleOutcome {
  return verb === "pause" ? "paused" : verb === "resume" ? "resumed" : "triggered";
}

function bulkAlreadyOutcome(verb: BulkScheduleVerb): BulkScheduleOutcome {
  return verb === "pause" ? "already-paused" : "already-active";
}

function bulkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Issue #5878 — one bulk verb over a scope: filter the home-list rows
 * to the scope, then run the single-row verb per row and report
 * per-row outcomes. A row's refusal (derived record, goal surface,
 * unmanageable kind, missing alarm, a thrown store/alarm error)
 * refuses only that row — the batch always runs to the end and the
 * summary counts what happened.
 *
 * The per-row dispatch re-reads the row's stored record at execution
 * time, so the already-in-state outcomes come from the store, not
 * from the list snapshot:
 * - pause: a stored paused record is `already-paused`; a stored goal
 *   or unmanageable record is refused by the single-row verb (its
 *   named error), never silently skipped as already-paused.
 * - resume: a stored non-paused record is `already-active`; a stored
 *   goal or unmanageable record is refused by the single-row verb.
 * - trigger: no pre-skip — the single-row verb itself refuses a
 *   paused row with its 409, and every other refusal, so the reason
 *   is always the single-row reason.
 * A row with no stored record (a derived row, a legacy alarm with no
 * record, a row that vanished after the list loaded) goes straight
 * to the single-row verb: derived ids refuse with their named
 * errors, legacy alarms act, a missing row 404s — each as a per-row
 * refusal. A resume over a record-less row first asks the alarms
 * port: a live alarm means the row is active (`already-active`), so
 * a live legacy alarm is never misreported as refused-not-paused.
 */
async function runBulkSchedules(
  deps: UnifiedManagementDeps,
  verb: BulkScheduleVerb,
  scope: BulkScheduleScope,
  rows: readonly BulkScheduleRow[],
  nowIso: string,
  run: ((callback: string, payload: unknown) => Promise<void>) | undefined,
  executeRow: BulkScheduleRowExecutor | undefined,
): Promise<BulkScheduleSummary> {
  const inScope = rows.filter(
    (row) => scope === "all" || classifyScheduleKind(row) === scope,
  );
  const results: BulkScheduleRowResult[] = [];
  for (const row of inScope) {
    const kind = classifyScheduleKind(row);
    try {
      const handled = executeRow ? await executeRow(row, verb) : undefined;
      if (handled !== undefined) {
        if (handled.ok) {
          results.push({
            id: row.id,
            kind,
            outcome:
              handled.already === true
                ? bulkAlreadyOutcome(verb)
                : bulkAppliedOutcome(verb),
          });
        } else {
          results.push({ id: row.id, kind, outcome: "refused", reason: handled.error });
        }
        continue;
      }
      const record = await deps.store.get(row.id);
      if (record && (record.kind === "goal" || !isManagedAlarmKind(record.kind))) {
        // A stored goal / unmanageable row is refused by the
        // single-row verb with its named error — never reported as
        // already-in-state on the strength of its stored state.
        const outcome = await runSingleRowVerb(deps, verb, row.id, nowIso, run);
        results.push(mapSingleRowOutcome(row.id, kind, verb, outcome));
        continue;
      }
      if (verb === "pause") {
        if (record?.state === "paused") {
          results.push({ id: row.id, kind, outcome: "already-paused" });
          continue;
        }
        const outcome = await pauseUnifiedSchedule(deps, row.id, nowIso);
        results.push(mapSingleRowOutcome(row.id, kind, verb, outcome));
        continue;
      }
      if (verb === "resume") {
        if (record && record.state !== "paused") {
          results.push({ id: row.id, kind, outcome: "already-active" });
          continue;
        }
        if (!record) {
          // No stored record: a live alarm means the row is active
          // (a legacy alarm with no record); only a row with no
          // alarm at all goes to the verb, which refuses it.
          const alarm = await deps.alarms.get(row.id);
          if (alarm) {
            results.push({ id: row.id, kind, outcome: "already-active" });
            continue;
          }
        }
        const outcome = await resumeUnifiedSchedule(deps, row.id, nowIso);
        results.push(mapSingleRowOutcome(row.id, kind, verb, outcome));
        continue;
      }
      const outcome = await triggerUnifiedSchedule(
        deps,
        row.id,
        run as (callback: string, payload: unknown) => Promise<void>,
      );
      results.push(mapSingleRowOutcome(row.id, kind, verb, outcome));
    } catch (err) {
      results.push({ id: row.id, kind, outcome: "refused", reason: bulkErrorMessage(err) });
    }
  }
  const applied = results.filter((r) => r.outcome === bulkAppliedOutcome(verb)).length;
  const already = results.filter(
    (r) => r.outcome === "already-paused" || r.outcome === "already-active",
  ).length;
  return {
    verb,
    scope,
    total: results.length,
    applied,
    already,
    refused: results.length - applied - already,
    results,
  };
}

async function runSingleRowVerb(
  deps: UnifiedManagementDeps,
  verb: BulkScheduleVerb,
  id: string,
  nowIso: string,
  run: ((callback: string, payload: unknown) => Promise<void>) | undefined,
): Promise<UnifiedOpResult | { ok: true; scheduleId: string; callback: string } | { ok: false; error: string; status: number }> {
  if (verb === "pause") return pauseUnifiedSchedule(deps, id, nowIso);
  if (verb === "resume") return resumeUnifiedSchedule(deps, id, nowIso);
  return triggerUnifiedSchedule(
    deps,
    id,
    run as (callback: string, payload: unknown) => Promise<void>,
  );
}

function mapSingleRowOutcome(
  id: string,
  kind: ScheduleListKind,
  verb: BulkScheduleVerb,
  outcome:
    | UnifiedOpResult
    | { ok: true; scheduleId: string; callback: string }
    | { ok: false; error: string; status: number },
): BulkScheduleRowResult {
  if (outcome.ok) return { id, kind, outcome: bulkAppliedOutcome(verb) };
  return { id, kind, outcome: "refused", reason: outcome.error };
}

/**
 * Issue #5878 — bulk pause over a scope: every in-scope row paused
 * through `pauseUnifiedSchedule`, per-row outcomes reported.
 */
export async function pauseSchedulesInScope(
  deps: UnifiedManagementDeps,
  scope: BulkScheduleScope,
  rows: readonly BulkScheduleRow[],
  nowIso: string,
  executeRow?: BulkScheduleRowExecutor,
): Promise<BulkScheduleSummary> {
  return runBulkSchedules(deps, "pause", scope, rows, nowIso, undefined, executeRow);
}

/**
 * Issue #5878 — bulk resume over a scope: every in-scope paused row
 * resumed through `resumeUnifiedSchedule`, per-row outcomes reported.
 */
export async function resumeSchedulesInScope(
  deps: UnifiedManagementDeps,
  scope: BulkScheduleScope,
  rows: readonly BulkScheduleRow[],
  nowIso: string,
  executeRow?: BulkScheduleRowExecutor,
): Promise<BulkScheduleSummary> {
  return runBulkSchedules(deps, "resume", scope, rows, nowIso, undefined, executeRow);
}

/**
 * Issue #5878 — bulk run-now over a scope: every in-scope row
 * triggered through `triggerUnifiedSchedule` with the caller's `run`
 * (the same callback runner the single-row trigger route uses),
 * per-row outcomes reported.
 */
export async function triggerSchedulesInScope(
  deps: UnifiedManagementDeps,
  scope: BulkScheduleScope,
  rows: readonly BulkScheduleRow[],
  run: (callback: string, payload: unknown) => Promise<void>,
  executeRow?: BulkScheduleRowExecutor,
): Promise<BulkScheduleSummary> {
  return runBulkSchedules(deps, "trigger", scope, rows, new Date().toISOString(), run, executeRow);
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
  /**
   * Issue #4235 — explicit owner opt-in to a sub-daily cadence for
   * this schedule. The opt-in is per schedule and sticky: once
   * recorded it authorizes later sub-daily timing changes on the
   * same schedule without re-supplying it.
   */
  subDailyOptIn?: boolean;
}

export type ResolvedScheduleTiming =
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalSeconds: number }
  | { type: "scheduled" | "delayed"; time: number };

export type ScheduleUpdateResolution =
  | {
      ok: true;
      timing: ResolvedScheduleTiming;
      payload: unknown;
      /**
       * Issue #4235 — the schedule's opt-in after this update (only
       * present when opted in). The writer persists it on the
       * record; absent means no opt-in is recorded.
       */
      subDailyOptIn?: boolean;
    }
  | { ok: false; error: string };

/**
 * Issue #4235 — the sub-daily opt-in error: a new sub-daily timing
 * without a recorded opt-in is refused, never silently armed.
 */
const SUB_DAILY_OPT_IN_ERROR =
  "Sub-daily cadence runs more than once per day: pass subDailyOptIn: true to opt-in explicitly.";

/**
 * Validate an update against the current definition. A provided cron
 * or intervalSeconds switches the timing kind; otherwise the current
 * timing is kept (payload-only update). One-time schedules whose time
 * has already passed cannot be re-armed — recreating them would fire
 * immediately or never, so the caller is told to create a new job.
 *
 * Issue #4235 — granularity first: a NEW sub-daily timing needs the
 * explicit per-schedule opt-in (supplied in this update, or already
 * recorded on the schedule — the opt-in is sticky per schedule).
 * Keeping the current timing (payload-only or scheduleType-keep)
 * never needs a fresh opt-in: the stored timing stays under its
 * stored opt-in. A new timing that is daily-or-less needs none.
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

  // Issue #4235 — the effective opt-in for this update: supplied
  // in the body, or already recorded on the schedule (sticky per
  // schedule). A new sub-daily timing needs it; keeping the current
  // timing never needs a fresh one.
  const effectiveOptIn = body.subDailyOptIn === true || current.subDailyOptIn === true;
  const carryOptIn = effectiveOptIn ? { subDailyOptIn: true as const } : {};

  if (body.cron !== undefined) {
    const cron = String(body.cron).trim();
    if (!isValidCron(cron)) {
      return { ok: false, error: `Invalid cron expression '${body.cron}': expected a valid 5-field cron expression (minute hour day-of-month month day-of-week, each field in range).` };
    }
    if (isSubDailyCron(cron) && !effectiveOptIn) {
      return { ok: false, error: SUB_DAILY_OPT_IN_ERROR };
    }
    return { ok: true, timing: { type: "cron", cron }, payload, ...carryOptIn };
  }
  if (body.intervalSeconds !== undefined) {
    const seconds = Number(body.intervalSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return { ok: false, error: "intervalSeconds must be a positive whole number of seconds." };
    }
    if (isSubDailyInterval(seconds) && !effectiveOptIn) {
      return { ok: false, error: SUB_DAILY_OPT_IN_ERROR };
    }
    return { ok: true, timing: { type: "interval", intervalSeconds: seconds }, payload, ...carryOptIn };
  }
  if (body.scheduleType === "cron") {
    if (current.type !== "cron" || !current.cron) {
      return { ok: false, error: "This job has no cron expression to keep — provide one in 'cron'." };
    }
    return { ok: true, timing: { type: "cron", cron: current.cron }, payload, ...carryOptIn };
  }
  if (body.scheduleType === "interval") {
    if (current.type !== "interval" || !current.intervalSeconds) {
      return { ok: false, error: "This job has no interval to keep — provide one in 'intervalSeconds'." };
    }
    return { ok: true, timing: { type: "interval", intervalSeconds: current.intervalSeconds }, payload, ...carryOptIn };
  }

  // Payload-only update: keep the current timing.
  if (current.type === "cron" && current.cron) {
    return { ok: true, timing: { type: "cron", cron: current.cron }, payload, ...carryOptIn };
  }
  if (current.type === "interval" && current.intervalSeconds) {
    return { ok: true, timing: { type: "interval", intervalSeconds: current.intervalSeconds }, payload, ...carryOptIn };
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
  // Issue #4239 — a derived record has no alarm to update.
  if (isDerivedTokenRenewalRecord(id)) return derivedTokenRenewalError("update");
  // Issue #4240 — a derived record has no alarm to update.
  if (isDerivedRetentionRecord(id)) return derivedRetentionError("update");
  // Issue #4241 — a derived record has no alarm to update.
  if (isDerivedNightlyResearchRecord(id)) return derivedNightlyResearchError("update");
  // Issue #4242 — derived records have no alarm to update.
  if (isDerivedStaleLedgerSweepRecord(id)) return derivedStaleLedgerSweepError("update");
  if (isDerivedStaleAsyncJobSweepRecord(id)) return derivedStaleAsyncJobSweepError("update");
  if (isDerivedScheduleWatchdogRecord(id)) return derivedScheduleWatchdogError("update");
  const nowIso = new Date(nowMs).toISOString();
  const record = await deps.store.get(id);
  // Issue #4237 — see triggerUnifiedSchedule: refuse a non-screen
  // kind with its own name, not the goal-surface text.
  if (record && !isManagedAlarmKind(record.kind)) {
    if (record.kind === "goal") return goalSurfaceError("update");
    return fail(`Schedule kind '${record.kind}' cannot be updated.`, 400);
  }
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
        // Issue #4235 — the update's opt-in is recorded on the
        // schedule; absent means no opt-in is recorded.
        ...(resolution.subDailyOptIn === true ? { subDailyOptIn: true } : {}),
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
    // Issue #4235 — the recorded opt-in for an armed schedule lives
    // on the record's definition (lifted from the armed payload at
    // adoption) or on the alarm payload itself; either source counts.
    ...((record?.definition as Record<string, unknown> | undefined)?.subDailyOptIn === true ||
    (alarm.payload as Record<string, unknown> | undefined)?.subDailyOptIn === true
      ? { subDailyOptIn: true }
      : {}),
  };
  const resolution = resolveScheduleUpdate(current, body, nowMs);
  if (!resolution.ok) return fail(resolution.error, 400);
  await deps.alarms.cancel(alarm.id);
  // Issue #4235 — the re-armed alarm carries the recorded opt-in
  // in its payload, exactly as creation stamps it, so a later
  // update reads it back from the alarm (and the adopted record
  // lifts it, as at creation).
  const baseRearmedPayload = carryScheduleProvenance(alarm.payload, resolution.payload);
  const rearmedPayload =
    resolution.subDailyOptIn === true &&
    baseRearmedPayload !== null &&
    typeof baseRearmedPayload === "object"
      ? { ...(baseRearmedPayload as Record<string, unknown>), subDailyOptIn: true }
      : baseRearmedPayload;
  const rearmed = await deps.alarms.arm(
    resolution.timing,
    alarm.callback,
    rearmedPayload,
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
          // Issue #4235 — the update's opt-in is recorded on the
          // schedule (see the paused branch above).
          ...(resolution.subDailyOptIn === true ? { subDailyOptIn: true } : {}),
        },
        updatedAt: nowIso,
      }
    : {
        ...(isStageAlarmPayload(rearmed.payload)
          ? workflowStageScheduleToRecord(rearmed, nowIso)
          : screenScheduleToRecord(rearmed, nowIso)),
        id,
      };
  await deps.store.save(updated);
  return { ok: true, record: updated, alarm: rearmed, previousId: id };
}
