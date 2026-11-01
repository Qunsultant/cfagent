/**
 * Issue #2358 (#1976 step 4a) — the in-memory implementation
 * of the async-job ports, with semantics identical to the
 * DO-SQLite adapter: the guarded claim (exactly one winner),
 * guarded terminal transitions, submit-time retention prunes,
 * and the maintenance clears that never touch running rows.
 * NEW with this port — the legacy family had no in-memory twin.
 */
import type {
  AsyncJobChainRow,
  AsyncJobListRow,
  AsyncJobMaintenancePort,
  AsyncJobQueuePort,
  AsyncJobReadPort,
  AsyncJobStoredRow,
  AsyncJobWorkflowRow,
  InsertQueuedJobInput,
  InsertTerminalJobInput,
} from "./asyncJobPorts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryAsyncJobStore
  implements AsyncJobQueuePort, AsyncJobReadPort, AsyncJobMaintenancePort
{
  private rows = new Map<string, AsyncJobStoredRow>();

  ensureSchema(): void {
    // In-memory: nothing to ensure.
  }

  ensureGateIndexes(): void {
    // In-memory: nothing to ensure.
  }

  pruneTerminalBefore(sessionId: string, cutoffIso: string): void {
    for (const [id, row] of this.rows) {
      if (
        row.session_id === sessionId &&
        (row.status === "completed" || row.status === "failed") &&
        row.created_at < cutoffIso
      ) {
        this.rows.delete(id);
      }
    }
  }

  pruneTerminalToCap(sessionId: string, keep: number): void {
    const cap = Math.max(0, Math.floor(keep));
    const terminal = [...this.rows.values()]
      .filter(
        (r) =>
          r.session_id === sessionId &&
          (r.status === "completed" || r.status === "failed"),
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    for (const row of terminal.slice(cap)) {
      this.rows.delete(row.job_id);
    }
  }

  insertQueued(input: InsertQueuedJobInput): void {
    if (this.rows.has(input.jobId)) {
      throw new Error(`UNIQUE constraint failed: mas_async_jobs.job_id`);
    }
    this.rows.set(input.jobId, {
      job_id: input.jobId,
      session_id: input.sessionId,
      capability: input.capability,
      display_name: input.displayName,
      status: "queued",
      payload_json: input.payloadJson,
      result_json: null,
      response_status: null,
      error: null,
      created_at: input.nowIso,
      updated_at: input.nowIso,
      started_at: null,
      completed_at: null,
      parent_job_id: input.parentJobId ?? null,
      job_kind: input.jobKind ?? "main",
      channel: input.channel ?? null,
      not_before: input.notBefore ?? null,
      stage: input.stage ?? null,
      chain_id: input.chainId ?? null,
      stuck_alerted_at: null,
    });
  }

  failQueued(jobId: string, error: string, nowIso: string): number {
    const row = this.rows.get(jobId);
    if (!row || row.status !== "queued") return 0;
    row.status = "failed";
    row.error = error;
    row.updated_at = nowIso;
    row.completed_at = nowIso;
    return 1;
  }

  insertTerminal(input: InsertTerminalJobInput): void {
    if (this.rows.has(input.jobId)) {
      throw new Error(`UNIQUE constraint failed: mas_async_jobs.job_id`);
    }
    this.rows.set(input.jobId, {
      job_id: input.jobId,
      session_id: input.sessionId,
      capability: input.capability,
      display_name: input.displayName,
      status: input.status,
      payload_json: input.payloadJson,
      result_json: input.resultJson,
      response_status: null,
      error: input.error,
      created_at: input.nowIso,
      updated_at: input.nowIso,
      started_at: null,
      completed_at: input.nowIso,
      parent_job_id: null,
      job_kind: input.jobKind ?? "main",
      channel: null,
      not_before: null,
      stage: input.stage ?? null,
      chain_id: input.chainId ?? null,
      stuck_alerted_at: null,
    });
  }

  claim(jobId: string, sessionId: string, nowIso: string): boolean {
    const row = this.rows.get(jobId);
    if (!row || row.session_id !== sessionId || row.status !== "queued") return false;
    row.status = "running";
    row.started_at = nowIso;
    row.updated_at = nowIso;
    return true;
  }

  complete(jobId: string, resultJson: string, responseStatus: number | null, nowIso: string): number {
    const row = this.rows.get(jobId);
    if (!row || row.status !== "running") return 0;
    row.status = "completed";
    row.result_json = resultJson;
    row.response_status = responseStatus;
    row.updated_at = nowIso;
    row.completed_at = nowIso;
    return 1;
  }

  failRunning(jobId: string, error: string, nowIso: string): number {
    const row = this.rows.get(jobId);
    if (!row || row.status !== "running") return 0;
    row.status = "failed";
    row.error = error;
    row.updated_at = nowIso;
    row.completed_at = nowIso;
    return 1;
  }

  reapStaleRunning(jobId: string, error: string, nowIso: string): number {
    return this.failRunning(jobId, error, nowIso);
  }

  markStuckAlerted(jobId: string, nowIso: string): number {
    const row = this.rows.get(jobId);
    if (!row || row.status !== "running" || row.stuck_alerted_at !== null) return 0;
    row.stuck_alerted_at = nowIso;
    return 1;
  }

  getRow(jobId: string, sessionId: string): AsyncJobStoredRow | undefined {
    const row = this.rows.get(jobId);
    if (!row || row.session_id !== sessionId) return undefined;
    return clone(row);
  }

  listRows(sessionId: string, limit: number): AsyncJobListRow[] {
    return [...this.rows.values()]
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, limit)
      .map((r) => {
        const { response_status: _responseStatus, ...rest } = clone(r);
        return rest;
      });
  }

  listQueued(sessionId: string): Array<{ job_id: string; not_before: string | null }> {
    return [...this.rows.values()]
      .filter((r) => r.session_id === sessionId && r.status === "queued")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .slice(0, 100)
      .map((r) => ({ job_id: r.job_id, not_before: r.not_before }));
  }

  getExecutionState(jobId: string, sessionId: string): { status: string; not_before: string | null } | undefined {
    const row = this.rows.get(jobId);
    if (!row || row.session_id !== sessionId) return undefined;
    return { status: row.status, not_before: row.not_before };
  }

  getClaimed(jobId: string, sessionId: string): { capability: string; payload_json: string; stage: string | null; chain_id: string | null } | undefined {
    const row = this.rows.get(jobId);
    if (!row || row.session_id !== sessionId) return undefined;
    return {
      capability: row.capability,
      payload_json: row.payload_json as string,
      stage: row.stage,
      chain_id: row.chain_id,
    };
  }

  getRetrySource(jobId: string, sessionId: string) {
    const row = this.rows.get(jobId);
    if (!row || row.session_id !== sessionId) return undefined;
    return {
      job_id: row.job_id,
      capability: row.capability,
      display_name: row.display_name,
      status: row.status,
      payload_json: row.payload_json as string,
      parent_job_id: row.parent_job_id,
      job_kind: row.job_kind,
      channel: row.channel,
      stage: row.stage,
      chain_id: row.chain_id,
    };
  }

  listSessionPayloads(sessionId: string): Array<{ job_id: string; status: string; payload_json: string }> {
    return [...this.rows.values()]
      .filter((r) => r.session_id === sessionId)
      .map((r) => ({ job_id: r.job_id, status: r.status, payload_json: r.payload_json as string }));
  }

  chainRows(chainId: string, sessionId: string): AsyncJobChainRow[] {
    return [...this.rows.values()]
      .filter((r) => r.chain_id === chainId && r.session_id === sessionId)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
      .map((r) => ({
        job_id: r.job_id,
        stage: r.stage,
        status: r.status,
        payload_json: r.payload_json,
        result_json: r.result_json,
        error: r.error,
        created_at: r.created_at,
        parent_job_id: r.parent_job_id,
      }));
  }

  workflowRunRows(sessionId: string, limit: number): AsyncJobWorkflowRow[] {
    return [...this.rows.values()]
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, limit)
      .map((r) => clone(r));
  }

  activeJobPayloads(): Array<{ payload_json: string }> {
    return [...this.rows.values()]
      .filter((r) => r.status === "queued" || r.status === "running")
      .map((r) => ({ payload_json: r.payload_json as string }));
  }

  countByStatus(sessionId: string): Array<{ status: string; n: number }> {
    const counts = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (row.session_id !== sessionId) continue;
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, n]) => ({ status, n }));
  }

  deleteByStatuses(sessionId: string, statuses: string[]): void {
    for (const [id, row] of this.rows) {
      if (row.session_id === sessionId && statuses.includes(row.status)) {
        this.rows.delete(id);
      }
    }
  }

  deleteAllNonRunning(sessionId: string): void {
    for (const [id, row] of this.rows) {
      if (row.session_id === sessionId && row.status !== "running") {
        this.rows.delete(id);
      }
    }
  }
}
