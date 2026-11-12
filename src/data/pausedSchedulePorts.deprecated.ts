/**
 * @deprecated Issue #3121 Phase 2 (#3123) — retired by deprecation
 * rename only (gitops §22: never deleted). Superseded by
 * `src/data/unifiedSchedulePorts.ts`. Pause is now a record
 * state in the unified store: successor
 * `src/data/unifiedSchedulePorts.ts` (+
 * `src/data/doSqliteUnifiedScheduleAdapter.ts` /
 * `src/data/inMemoryUnifiedScheduleAdapter.ts`), management in
 * `src/services/unifiedScheduleManagement.ts`. This file is FROZEN:
 * no new features, no new consumers; delete only when it has zero
 * consumers and the owner decides (see
 * `docs/architecture/transition/deprecations.md`).
 *
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — paused-
 * schedule port: pause/resume state for durable schedules
 * (issue #273).
 *
 * The Agents SDK has no native pause: pausing persists the
 * job's full definition in the OrchestratorAgent's own SQLite
 * and cancels the SDK schedule; resuming re-arms from the
 * stored definition. The job never disappears from the user's
 * list — it renders with status "paused" and no next run.
 *
 * ADR D-0 ruled this family DO-resident, decisively (step-2
 * audit §2.9): the record is one half of a single mechanism
 * whose other half — the Agents SDK schedule table — lives in
 * the same DO's storage. It is execution machinery of the
 * instance ((c)-adjacent scheduling, (b) serialization), is
 * not read cross-instance, and moving it to D1 would split one
 * mechanism across two stores for no reader.
 *
 * This module carries the record types and the port interface
 * ONLY (ADR 0002 R1/R2). Adapters:
 * doSqlitePausedScheduleAdapter.ts (production — also carries
 * the legacy synchronous surface the shim re-exports),
 * inMemoryPausedScheduleAdapter.ts (test double, new with
 * this port). The types moved here from
 * src/services/scheduleManagement.ts, which keeps its pure
 * domain code (resolveScheduleUpdate, the record/list-item
 * projections) and re-exports the store from the layer.
 *
 * TRANSACTION SEAM (ADR D-C): save() is a DELETE + INSERT
 * upsert pair — one unit on the DO adapter when the host
 * supplies the transaction-capable storage object; sequential
 * over a bare sql handle, exactly today's behaviour under the
 * DO's per-instance serialization. The wider pause operation
 * (record + SDK-schedule cancel) is cross-store and stays
 * honestly sequenced; no atomicity is claimed there.
 */

export const PAUSED_SCHEDULES_TABLE = "paused_schedules";

/** A paused job's full definition, exactly as needed to re-arm it. */
export interface PausedScheduleRecord {
  id: string;
  callback: string;
  payload: unknown;
  type: "cron" | "interval" | "delayed" | "scheduled";
  cron?: string;
  intervalSeconds?: number;
  /** Unix seconds — the SDK schedule's next/former run time. */
  time?: number;
  delayInSeconds?: number;
  /** ISO timestamp of when the job was paused. */
  pausedAt: string;
}

/** The definition shape updates resolve against (SDK schedule or paused record). */
export interface ScheduleDefinitionLike {
  type: "cron" | "interval" | "delayed" | "scheduled";
  callback: string;
  payload?: unknown;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
  delayInSeconds?: number;
}

/** The paused-schedule store surface (async, port-shaped). */
export interface PausedScheduleStore {
  /** Upsert the record for its id (DELETE + INSERT as one unit). */
  save(record: PausedScheduleRecord): Promise<void>;
  /** The stored record, or undefined when the id is not paused. */
  get(id: string): Promise<PausedScheduleRecord | undefined>;
  /** Every paused record, paused_at ascending. */
  list(): Promise<PausedScheduleRecord[]>;
  /** Delete the record; returns true when a record was removed. */
  remove(id: string): Promise<boolean>;
  /** Delete EVERY record (added #2358, step 4a — the maintenance
   *  route's bulk clear of this table was a named bypass of this
   *  port; the clear now flows through it). */
  clear(): Promise<void>;
}
