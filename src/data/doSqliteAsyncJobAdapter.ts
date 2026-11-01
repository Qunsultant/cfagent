/**
 * Issue #2358 (#1976 step 4a) — the DO-SQLite implementation
 * of the async-job ports: every statement of the legacy family
 * (src/agents/orchestrator/asyncJobs.ts' queue statements,
 * src/services/asyncJobGate.ts' index, the readers in
 * shardJobs / workflowRuns, and the maintenance route's
 * async-job clears), moved into the data layer statement-for-
 * statement. The legacy modules are now domain logic over
 * these ports.
 *
 * One class serves all three ports (queue / read / maintenance
 * are roles over one table in one instance; the composition
 * root hands the same store out under each role).
 *
 * THE CLAIM (audit R-7): claim() is the legacy guarded UPDATE,
 * verbatim — `AND status = 'queued'` — and its verification is
 * the cursor's rowsWritten, exactly as the legacy executor
 * checked it (`!== 1` meant not claimed). No transaction wrap.
 */
import {
  ACTIVE_JOB_PAYLOADS_SQL,
  type AsyncJobChainRow,
  type AsyncJobListRow,
  type AsyncJobMaintenancePort,
  type AsyncJobQueuePort,
  type AsyncJobReadPort,
  type AsyncJobSqlExecutor,
  type AsyncJobStoredRow,
  type AsyncJobWorkflowRow,
  type InsertQueuedJobInput,
  type InsertTerminalJobInput,
} from "./asyncJobPorts";

function rowsWritten(result: unknown): number {
  const cursor = result as { rowsWritten?: number };
  return typeof cursor.rowsWritten === "number" ? cursor.rowsWritten : 0;
}

export class DoSqliteAsyncJobStore
  implements AsyncJobQueuePort, AsyncJobReadPort, AsyncJobMaintenancePort
{
  constructor(private readonly sql: AsyncJobSqlExecutor) {}

  // ------------------------------------------------------------------
  // Queue: DDL — the family's ONE schema home (audit §4.1: the
  // base CREATE lived in orchestrator.ensureTables, the graph
  // migration in asyncJobs, the gate index in asyncJobGate).
  // ------------------------------------------------------------------

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_async_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        response_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_session_created ON mas_async_jobs(session_id, created_at DESC)");
    this.ensureGateIndexes();
    this.ensureGraphColumns();
  }

  ensureGateIndexes(): void {
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_status_created ON mas_async_jobs(status, created_at)",
    );
  }

  /** The probed graph migration (issue #1123 + consolidation
   *  C3 #1277): additive columns, added when missing so existing
   *  DO tables upgrade in place. */
  private ensureGraphColumns(): void {
    const cols = Array.from(this.sql.exec("PRAGMA table_info(mas_async_jobs)")) as Array<{ name?: unknown }>;
    const names = new Set(cols.map((c) => String(c?.name ?? "")));
    if (!names.has("parent_job_id")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN parent_job_id TEXT");
    }
    if (!names.has("job_kind")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'main'");
    }
    if (!names.has("channel")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN channel TEXT");
    }
    if (!names.has("not_before")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN not_before TEXT");
    }
    if (!names.has("stage")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN stage TEXT");
    }
    if (!names.has("chain_id")) {
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN chain_id TEXT");
    }
    if (!names.has("stuck_alerted_at")) {
      // Issue #2567: the stuck-running alert claim stamp.
      this.sql.exec("ALTER TABLE mas_async_jobs ADD COLUMN stuck_alerted_at TEXT");
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_parent ON mas_async_jobs(parent_job_id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_chain ON mas_async_jobs(chain_id)");
  }

  // ------------------------------------------------------------------
  // Queue: retention prunes (at submit)
  // ------------------------------------------------------------------

  pruneTerminalBefore(sessionId: string, cutoffIso: string): void {
    this.sql.exec(
      "DELETE FROM mas_async_jobs WHERE session_id = ? AND status IN ('completed', 'failed') AND created_at < ?",
      sessionId,
      cutoffIso,
    );
  }

  pruneTerminalToCap(sessionId: string, keep: number): void {
    const cap = Math.max(0, Math.floor(keep));
    this.sql.exec(
      `DELETE FROM mas_async_jobs WHERE job_id IN (
      SELECT job_id FROM mas_async_jobs WHERE session_id = ?
      AND status IN ('completed', 'failed') ORDER BY created_at DESC LIMIT -1 OFFSET ${cap}
    )`,
      sessionId,
    );
  }

  // ------------------------------------------------------------------
  // Queue: lifecycle transitions
  // ------------------------------------------------------------------

  insertQueued(input: InsertQueuedJobInput): void {
    // Single-line column list: the shared MockSqlStorage INSERT parser does
    // not span newlines inside the column list (tests would silently drop
    // the row) — keep this statement on one line.
    this.sql.exec(
      "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, parent_job_id, job_kind, channel, not_before, stage, chain_id) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.jobId,
      input.sessionId,
      input.capability,
      input.displayName,
      input.payloadJson,
      input.nowIso,
      input.nowIso,
      input.parentJobId ?? null,
      input.jobKind ?? "main",
      input.channel ?? null,
      input.notBefore ?? null,
      input.stage ?? null,
      input.chainId ?? null,
    );
  }

  failQueued(jobId: string, error: string, nowIso: string): number {
    const cursor = this.sql.exec(
      "UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'",
      error,
      nowIso,
      nowIso,
      jobId,
    );
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor);
  }

  insertTerminal(input: InsertTerminalJobInput): void {
    // Single-line INSERT per the MockSqlStorage lesson (multi-line
    // column lists silently no-op in the shared mock).
    this.sql.exec(
      "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, completed_at, job_kind, stage, chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.jobId,
      input.sessionId,
      input.capability,
      input.displayName,
      input.status,
      input.payloadJson,
      input.resultJson,
      input.error,
      input.nowIso,
      input.nowIso,
      input.nowIso,
      input.jobKind ?? "main",
      input.stage ?? null,
      input.chainId ?? null,
    );
  }

  claim(jobId: string, sessionId: string, nowIso: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE mas_async_jobs SET status = 'running', started_at = ?, updated_at = ?
     WHERE job_id = ? AND session_id = ? AND status = 'queued'`,
      nowIso,
      nowIso,
      jobId,
      sessionId,
    );
    // The cursor must be consumed before rowsWritten is final
    // (the legacy executor read it directly off the exec result;
    // consuming first is the same value on the real cursor).
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor) === 1;
  }

  complete(jobId: string, resultJson: string, responseStatus: number | null, nowIso: string): number {
    const cursor = this.sql.exec(
      `UPDATE mas_async_jobs SET status = 'completed', result_json = ?, response_status = ?,
       updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
      resultJson,
      responseStatus,
      nowIso,
      nowIso,
      jobId,
    );
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor);
  }

  failRunning(jobId: string, error: string, nowIso: string): number {
    const cursor = this.sql.exec(
      `UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
       WHERE job_id = ? AND status = 'running'`,
      error,
      nowIso,
      nowIso,
      jobId,
    );
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor);
  }

  reapStaleRunning(jobId: string, error: string, nowIso: string): number {
    const cursor = this.sql.exec(
      `UPDATE mas_async_jobs SET status = 'failed',
       error = ?,
       updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
      error,
      nowIso,
      nowIso,
      jobId,
    );
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor);
  }

  markStuckAlerted(jobId: string, nowIso: string): number {
    const cursor = this.sql.exec(
      `UPDATE mas_async_jobs SET stuck_alerted_at = ?
       WHERE job_id = ? AND status = 'running' AND stuck_alerted_at IS NULL`,
      nowIso,
      jobId,
    );
    Array.from(cursor as Iterable<unknown>);
    return rowsWritten(cursor);
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  getRow(jobId: string, sessionId: string): AsyncJobStoredRow | undefined {
    const rows = Array.from(this.sql.exec(
      `SELECT job_id, session_id, capability, display_name, status, result_json, response_status,
            error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at
     FROM mas_async_jobs WHERE job_id = ? AND session_id = ?`,
      jobId,
      sessionId,
    )) as unknown as AsyncJobStoredRow[];
    return rows[0];
  }

  listRows(sessionId: string, limit: number): AsyncJobListRow[] {
    return Array.from(this.sql.exec(
      `SELECT job_id, session_id, capability, display_name, status, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at
     FROM mas_async_jobs WHERE session_id = ?
     ORDER BY created_at DESC LIMIT ?`,
      sessionId,
      limit,
    )) as unknown as AsyncJobListRow[];
  }

  listQueued(sessionId: string): Array<{ job_id: string; not_before: string | null }> {
    return Array.from(this.sql.exec(
      "SELECT job_id, not_before FROM mas_async_jobs WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 100",
      sessionId,
    )) as Array<{ job_id: string; not_before: string | null }>;
  }

  getExecutionState(jobId: string, sessionId: string): { status: string; not_before: string | null } | undefined {
    const rows = Array.from(this.sql.exec(
      "SELECT status, not_before FROM mas_async_jobs WHERE job_id = ? AND session_id = ?",
      jobId,
      sessionId,
    )) as Array<{ status: string; not_before: string | null }>;
    return rows[0];
  }

  getClaimed(jobId: string, sessionId: string): { capability: string; payload_json: string; stage: string | null; chain_id: string | null } | undefined {
    const rows = Array.from(this.sql.exec(
      "SELECT capability, payload_json, stage, chain_id FROM mas_async_jobs WHERE job_id = ? AND session_id = ?",
      jobId,
      sessionId,
    )) as Array<{ capability: string; payload_json: string; stage: string | null; chain_id: string | null }>;
    return rows[0];
  }

  getRetrySource(jobId: string, sessionId: string) {
    const rows = Array.from(this.sql.exec(
      `SELECT job_id, capability, display_name, status, payload_json, parent_job_id, job_kind, channel, stage, chain_id
     FROM mas_async_jobs WHERE job_id = ? AND session_id = ?`,
      jobId,
      sessionId,
    )) as Array<{
      job_id: string;
      capability: string;
      display_name: string;
      status: string;
      payload_json: string;
      parent_job_id: string | null;
      job_kind: string | null;
      channel: string | null;
      stage: string | null;
      chain_id: string | null;
    }>;
    return rows[0];
  }

  listSessionPayloads(sessionId: string): Array<{ job_id: string; status: string; payload_json: string }> {
    return Array.from(this.sql.exec(
      "SELECT job_id, status, payload_json FROM mas_async_jobs WHERE session_id = ?",
      sessionId,
    )) as Array<{ job_id: string; status: string; payload_json: string }>;
  }

  chainRows(chainId: string, sessionId: string): AsyncJobChainRow[] {
    return Array.from(this.sql.exec(
      "SELECT job_id, stage, status, payload_json, result_json, error, created_at, parent_job_id FROM mas_async_jobs WHERE chain_id = ? AND session_id = ? ORDER BY created_at ASC",
      chainId,
      sessionId,
    )) as unknown as AsyncJobChainRow[];
  }

  workflowRunRows(sessionId: string, limit: number): AsyncJobWorkflowRow[] {
    return Array.from(this.sql.exec(
      "SELECT job_id, capability, display_name, status, payload_json, result_json, error, created_at, updated_at, started_at, completed_at, parent_job_id, job_kind, channel, not_before, stage, chain_id, stuck_alerted_at FROM mas_async_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      sessionId,
      limit,
    )) as unknown as AsyncJobWorkflowRow[];
  }

  activeJobPayloads(): Array<{ payload_json: string }> {
    return Array.from(this.sql.exec(ACTIVE_JOB_PAYLOADS_SQL)) as Array<{ payload_json: string }>;
  }

  // ------------------------------------------------------------------
  // Maintenance
  // ------------------------------------------------------------------

  countByStatus(sessionId: string): Array<{ status: string; n: number }> {
    return Array.from(this.sql.exec(
      "SELECT status, COUNT(*) AS n FROM mas_async_jobs WHERE session_id = ? GROUP BY status",
      sessionId,
    )) as Array<{ status: string; n: number }>;
  }

  deleteByStatuses(sessionId: string, statuses: string[]): void {
    const placeholders = statuses.map(() => "?").join(", ");
    this.sql.exec(
      `DELETE FROM mas_async_jobs WHERE session_id = ? AND status IN (${placeholders})`,
      sessionId,
      ...statuses,
    );
  }

  deleteAllNonRunning(sessionId: string): void {
    this.sql.exec(
      "DELETE FROM mas_async_jobs WHERE session_id = ? AND status <> 'running'",
      sessionId,
    );
  }
}
