/**
 * Issue #3122 — the DO-SQLite implementation of the pending-approvals
 * port for agent schedules: the pending approval records the
 * capability mints when a consequential schedule is refused
 * (`approval-required`), until an approver approves or rejects them
 * through the approvals API.
 *
 * One table, `pending_schedule_approvals`, ensured lazily on every
 * operation (CREATE TABLE IF NOT EXISTS), exactly as the paused-
 * schedule adapter does. The store is DO-agnostic: the orchestrator
 * DO (SDK schedules) and the ScheduledAgent DO (goal schedules) each
 * construct it with their own sql handle, so each DO owns its own
 * pending approvals. Save is replace-all (delete + insert), the same
 * shape as the paused-schedule upsert pair.
 */
import type { SqlStorage } from "../orm";
import type { PendingScheduleApproval } from "../services/agentScheduleCapability";

export const PENDING_SCHEDULE_APPROVALS_TABLE = "pending_schedule_approvals";

function ensureTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${PENDING_SCHEDULE_APPROVALS_TABLE} (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      approval_reasons_json TEXT NOT NULL,
      status TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT
    )`);
}

function rowToApproval(row: Record<string, unknown>): PendingScheduleApproval {
  return {
    id: String(row.id),
    kind: row.kind === "goal" ? "goal" : "sdk",
    requestedBy: String(row.requested_by),
    agentId: String(row.agent_id),
    requestedAt: String(row.requested_at),
    definition: JSON.parse(String(row.definition_json)) as unknown,
    approvalReasons: JSON.parse(String(row.approval_reasons_json)) as string[],
    status: row.status === "approved" || row.status === "rejected" ? row.status : "pending",
    ...(typeof row.decided_by === "string" && row.decided_by
      ? { decidedBy: row.decided_by }
      : {}),
    ...(typeof row.decided_at === "string" && row.decided_at
      ? { decidedAt: row.decided_at }
      : {}),
  };
}

/** Synchronous DO-SQLite pending-approvals store (mirrors SqlPausedScheduleStore). */
export class SqlPendingScheduleApprovalStore {
  constructor(private sql: SqlStorage) {}

  loadAll(): PendingScheduleApproval[] {
    ensureTable(this.sql);
    const rows = Array.from(
      this.sql.exec(`SELECT * FROM ${PENDING_SCHEDULE_APPROVALS_TABLE} ORDER BY requested_at ASC`),
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToApproval);
  }

  saveAll(list: PendingScheduleApproval[]): void {
    ensureTable(this.sql);
    this.sql.exec(`DELETE FROM ${PENDING_SCHEDULE_APPROVALS_TABLE}`);
    for (const entry of list) {
      this.sql.exec(
        `INSERT INTO ${PENDING_SCHEDULE_APPROVALS_TABLE}
           (id, kind, requested_by, agent_id, requested_at, definition_json, approval_reasons_json, status, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.id,
        entry.kind,
        entry.requestedBy,
        entry.agentId,
        entry.requestedAt,
        JSON.stringify(entry.definition),
        JSON.stringify(entry.approvalReasons),
        entry.status,
        entry.decidedBy ?? null,
        entry.decidedAt ?? null,
      );
    }
  }
}

/** Async load/save pair shaped for the capability's `pendingApprovals` dep. */
export function createPendingScheduleApprovalPort(sql: SqlStorage): {
  load(): Promise<PendingScheduleApproval[]>;
  save(list: PendingScheduleApproval[]): Promise<void>;
} {
  const store = new SqlPendingScheduleApprovalStore(sql);
  return {
    load: async () => store.loadAll(),
    save: async (list) => {
      store.saveAll(list);
    },
  };
}
