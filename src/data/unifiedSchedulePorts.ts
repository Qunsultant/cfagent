/**
 * Issue #3121 Phase 2 (#3123, reuse) — the ONE schedule store port.
 *
 * Before #3123, schedule definitions lived in six places (Phase 2
 * survey on main 20d26df2): the Agents SDK alarm table
 * `cf_agents_jobs` (framework-owned), the legacy paused-schedule DO
 * SQLite table, the ScheduledAgent DO key-value `"goals"` key, the
 * D1 `agent_chains` / `agent_synthesized_schedules` projection,
 * the `mas_async_jobs` DO SQLite table, and the (disabled)
 * `wrangler.jsonc` cron config. This port replaces the cfagent-owned
 * schedule stores with one record model, one table, and one port.
 *
 * Placement follows ADR D-0 (the paused-schedule precedent, issue
 * #2337): a record lives in the same Durable Object as the
 * mechanism it belongs to. The table is therefore instantiated in
 * the owning DO — OrchestratorAgent instances host screen,
 * followup, and worker-duty records; ScheduledAgent hosts goal
 * records — behind this one port, one schema, and one adapter
 * pair. `cf_agents_jobs` stays the alarm substrate
 * (framework-owned, cannot be replaced): the store records the
 * definition + state and the SDK arms the alarm. The D1 chain
 * tables stay a projection, not the live store; `mas_async_jobs`
 * stays the async-job execution record and `mas_job_outcomes` the
 * outcome sink (recorded scoping decisions, #3123).
 *
 * Pause is a record state, not a copy: pausing flips `state` to
 * paused and cancels the SDK alarm; resuming flips it back and
 * re-arms. The record id is stable across pause/resume — the SDK
 * alarm id is SDK-assigned (the SDK `schedule()` API takes no id)
 * and rides the record as `alarmId`, updated on every re-arm.
 * Worker duties are recorded as a kind (they had no store —
 * config only); while the Worker crons are OFF (#4112) their
 * records carry state disabled.
 *
 * This module carries the record types, the table name, the
 * kind/state vocabularies, and the store interfaces ONLY
 * (ADR 0002 R1/R2). Adapters: doSqliteUnifiedScheduleAdapter.ts
 * (production — sync class + async port adapter, DO SQLite),
 * inMemoryUnifiedScheduleAdapter.ts (test double). Factory:
 * createUnifiedSchedulePorts.ts.
 *
 * The store is trigger-agnostic: it stores records and evaluation
 * is a pure function over the store. The S5 named entry points
 * (src/services/consolidatedCronEntries.ts) remain the dispatch
 * targets and stay intact; restoring firing is an uncomment of the
 * wrangler.jsonc crons, not a code change.
 */

export const UNIFIED_SCHEDULES_TABLE = "unified_schedules";

/**
 * The six schedule kinds, each declared exactly once (3123-P01).
 * - screen: an Agents SDK alarm schedule (creatable callbacks).
 * - goal: a tick-polled ScheduledAgent goal (DEFAULT_SCHEDULES + user goals).
 * - followup: an async-job follow-up chain step. Followup rows are
 *   NOT stored here — their execution record is `mas_async_jobs`
 *   (S4 design); the kind exists so the management service can
 *   name the kind explicitly instead of falling through silently.
 * - worker-duty: a Worker cron duty from WORKER_CRON_TRIGGERS_INVENTORY.
 * - workflow-stage: one pipeline job stage on its own schedule
 *   (#3310) — armed through the SDK alarm substrate with the
 *   internal-only `runWorkflowStage` callback, managed through the
 *   one management service like a screen.
 * - ticker-push: the TickerAgent pushTicks live feed (#4237) — a
 *   record-only kind (one record, updated in place with
 *   intervalSeconds + lastPushAt + armed; no per-push ledger rows).
 *   The record lives in the TickerAgent's own store (ADR 0029 D-0)
 *   and is read into the Schedules home list by RPC.
 */
export const UNIFIED_SCHEDULE_KINDS = [
  "screen",
  "goal",
  "followup",
  "worker-duty",
  "workflow-stage",
  "ticker-push",
] as const;

export type UnifiedScheduleKind = (typeof UNIFIED_SCHEDULE_KINDS)[number];

/**
 * The three record states, each declared exactly once (3123-P01).
 * - active: armed (screen) or due-evaluated (goal).
 * - paused: the user paused it; the SDK alarm is cancelled (screen)
 *   or the tick skips it (goal); resume re-arms the SAME record id.
 * - disabled: deployment-disabled (worker duties while the Worker
 *   crons are OFF, #4112). Not a user pause.
 * - deleted: the user deleted it (issue #4351). A tombstone, not a
 *   row: it keeps the id a code declaration would otherwise
 *   re-create, so a deleted declared task stays deleted. The list
 *   never renders it, and it arms no alarm.
 */
export const UNIFIED_SCHEDULE_STATES = ["active", "paused", "disabled", "deleted"] as const;

export type UnifiedScheduleState = (typeof UNIFIED_SCHEDULE_STATES)[number];

/** The timing half of a screen record's definition. */
export interface UnifiedScreenDefinition {
  type: "cron" | "interval" | "delayed" | "scheduled";
  callback: string;
  payload?: unknown;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  delayInSeconds?: number;
}

/** The definition half of a goal record: the ScheduledGoal itself. */
export interface UnifiedGoalDefinition {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled: boolean;
  lastRun?: string;
  timeZone?: string;
  provenance?: unknown;
}

/** The definition half of a worker-duty record. */
export interface UnifiedWorkerDutyDefinition {
  cron: string;
  entryPoint: string;
}

/**
 * One schedule record. `definition` is the kind-specific
 * definition object (screen timing, goal object, worker-duty
 * cron+entryPoint); `followup` records are never stored (see the
 * kind note above). `alarmId` is the Agents SDK schedule id for
 * screen records (SDK-assigned, updated on every re-arm); null
 * for kinds with no alarm. `ownerLogin` is the creating login
 * where the creating path knows it (never invented — #3122 F4:
 * no tenant field is invented here).
 */
export interface UnifiedScheduleRecord {
  id: string;
  kind: UnifiedScheduleKind;
  state: UnifiedScheduleState;
  /** The SDK callback (screen) — mirrors definition.callback. */
  callback?: string;
  /** The goal operation (goal) — mirrors definition.operation. */
  operation?: string;
  definition: Record<string, unknown>;
  ownerLogin?: string | null;
  provenance?: unknown;
  alarmId?: string | null;
  /** ISO timestamp of when the record was paused, if paused. */
  pausedAt?: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** The unified schedule store surface (async, port-shaped). */
export interface ScheduleStore {
  /** Upsert the record for its id. */
  save(record: UnifiedScheduleRecord): Promise<void>;
  /** The stored record, or undefined when the id is not stored. */
  get(id: string): Promise<UnifiedScheduleRecord | undefined>;
  /** Every record, created_at ascending. */
  list(): Promise<UnifiedScheduleRecord[]>;
  /** Every record of one kind, created_at ascending. */
  listByKind(kind: UnifiedScheduleKind): Promise<UnifiedScheduleRecord[]>;
  /** Every record in one state, created_at ascending. */
  listByState(state: UnifiedScheduleState): Promise<UnifiedScheduleRecord[]>;
  /** Delete the record; returns true when a record was removed. */
  remove(id: string): Promise<boolean>;
  /** Delete EVERY record. */
  clear(): Promise<void>;
  /**
   * Delete every PAUSED record and return how many were removed.
   * The maintenance wipe's behavior is preserved: it clears paused
   * schedules only, never live definitions (#3123 — the wipe used
   * to clear the legacy paused-schedule table, which held paused rows
   * only; the unified table also holds live rows).
   */
  clearPaused(): Promise<number>;
}

/** The synchronous twin (DO SQLite is sync; routes use this). */
export interface SyncScheduleStore {
  save(record: UnifiedScheduleRecord): void;
  get(id: string): UnifiedScheduleRecord | undefined;
  list(): UnifiedScheduleRecord[];
  listByKind(kind: UnifiedScheduleKind): UnifiedScheduleRecord[];
  listByState(state: UnifiedScheduleState): UnifiedScheduleRecord[];
  remove(id: string): boolean;
  clear(): void;
  clearPaused(): number;
}
