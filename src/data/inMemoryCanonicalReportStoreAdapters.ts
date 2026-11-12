/**
 * Issue #2359 (#1976 step 4d) — the in-memory implementations
 * of the canonical-report store + usage-event ports (test
 * doubles for the conformance suite). Semantics mirror the
 * DO adapters: insert-or-throw on the id primary key AND on
 * the generation UNIQUE index (tenant-scoped since #2398 —
 * (user_login, generation_id), matching the tenant-scoped
 * dedupe lookup), owner scoping on the reads that carry it,
 * newest-first report orderings / oldest-first backfill
 * (insertion order breaks timestamp ties, matching the DO's
 * rowid order for equal keys), and the backfill pointer
 * rewrite's still-NULL guard.
 */
import type {
  CanonicalReportReadPort,
  CanonicalReportStoredContent,
  CanonicalReportStoredRow,
  CanonicalReportWritePort,
  InsertCanonicalReportRow,
  InsertUsageEventRow,
  UsageEventPort,
  UsageEventRow,
} from "./canonicalReportStorePorts";

interface StoredReport extends CanonicalReportStoredRow {
  generation_id: string | null;
  user_login: string | null;
  seq: number;
}

function toHit(r: StoredReport): CanonicalReportStoredRow {
  return {
    id: r.id,
    run_id: r.run_id,
    title: r.title,
    source: r.source,
    summary: r.summary,
    body: r.body,
    created_at: r.created_at,
    generation_id: r.generation_id,
    user_login: r.user_login,
    body_r2_key: r.body_r2_key,
    fanout_outcome: r.fanout_outcome,
  };
}

export class InMemoryCanonicalReportStore
  implements CanonicalReportWritePort, CanonicalReportReadPort
{
  private readonly rows = new Map<string, StoredReport>();
  private seq = 0;

  ensureSchema(): void {}

  findIdByGeneration(generationId: string, owner: string): string {
    for (const r of this.rows.values()) {
      if (r.generation_id === generationId && r.user_login === owner) return r.id;
    }
    return "";
  }

  findStoredContent(id: string): CanonicalReportStoredContent | null {
    const r = this.rows.get(id);
    if (!r) return null;
    return {
      title: r.title,
      source: r.source,
      summary: r.summary,
      body: r.body,
      bodyR2Key: r.body_r2_key,
      ...(r.user_login ? { userLogin: r.user_login } : {}),
    };
  }

  insertRow(row: InsertCanonicalReportRow): void {
    if (this.rows.has(row.id)) {
      throw new Error(`UNIQUE constraint failed: mas_reports.id`);
    }
    if (row.generationId !== null) {
      for (const r of this.rows.values()) {
        if (
          r.generation_id === row.generationId &&
          r.user_login === row.owner
        ) {
          throw new Error(
            `UNIQUE constraint failed: mas_reports.user_login, mas_reports.generation_id`
          );
        }
      }
    }
    this.rows.set(row.id, {
      id: row.id,
      run_id: row.runId,
      title: row.title,
      source: row.source,
      summary: row.summary,
      body: row.body,
      created_at: row.createdAt,
      body_r2_key: row.bodyR2Key,
      fanout_outcome: row.fanoutOutcomeJson,
      generation_id: row.generationId,
      user_login: row.owner,
      seq: this.seq++,
    });
  }

  updateFanoutOutcome(reportId: string, fanoutOutcomeJson: string): void {
    const r = this.rows.get(reportId);
    if (r) r.fanout_outcome = fanoutOutcomeJson;
  }

  updateBody(reportId: string, bodyJson: string): void {
    const r = this.rows.get(reportId);
    if (r) r.body = bodyJson;
  }

  getFanoutOutcomeRaw(reportId: string): string | null {
    return this.rows.get(reportId)?.fanout_outcome ?? null;
  }

  deleteRow(reportId: string): void {
    this.rows.delete(reportId);
  }

  backfillBodyPointer(reportId: string, bodyR2Key: string): void {
    const r = this.rows.get(reportId);
    if (r && r.body_r2_key === null) {
      r.body_r2_key = bodyR2Key;
      r.body = "";
    }
  }

  getRowById(reportId: string): CanonicalReportStoredRow | null {
    const r = this.rows.get(reportId);
    return r ? toHit(r) : null;
  }

  getRowByRunIdForOwner(
    runId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null {
    const matched = [...this.rows.values()].filter((r) => {
      if (r.run_id !== runId) return false;
      if (owner !== undefined && r.user_login !== owner) return false;
      return true;
    });
    matched.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.seq - a.seq));
    return matched[0] ? toHit(matched[0]) : null;
  }

  getRowByIdForOwner(
    reportId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null {
    const r = this.rows.get(reportId);
    if (!r) return null;
    if (owner !== undefined && r.user_login !== owner) return null;
    return toHit(r);
  }

  searchRows(
    tokens: string[],
    owner: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[] {
    const matched = [...this.rows.values()].filter((r) => {
      if (owner !== undefined && r.user_login !== owner) return false;
      return tokens.some((t) => {
        const like = t.toLowerCase();
        return (
          r.title.toLowerCase().includes(like) ||
          r.summary.toLowerCase().includes(like) ||
          r.body.toLowerCase().includes(like)
        );
      });
    });
    return matched
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.seq - a.seq))
      .slice(0, limit)
      .map(toHit);
  }

  listRows(
    owner: string | undefined,
    sourceFilter: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[] {
    const matched = [...this.rows.values()].filter((r) => {
      if (owner !== undefined && r.user_login !== owner) return false;
      if (sourceFilter !== undefined && r.source !== sourceFilter) return false;
      return true;
    });
    return matched
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.seq - a.seq))
      .slice(0, limit)
      .map(toHit);
  }

  findIdByRunId(runId: string): string | null {
    for (const r of this.rows.values()) {
      if (r.run_id === runId) return r.id;
    }
    return null;
  }

  listIndexBackfillRows(
    limit: number,
    offset: number
  ): Array<{
    id: string;
    title: string;
    source: string;
    summary: string;
    body: string;
    body_r2_key: string | null;
  }> {
    return [...this.rows.values()]
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.seq - b.seq))
      .slice(offset, offset + limit)
      .map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        summary: r.summary,
        body: r.body,
        body_r2_key: r.body_r2_key,
      }));
  }
}

export class InMemoryUsageEventStore implements UsageEventPort {
  private readonly rows: Array<InsertUsageEventRow & { seq: number }> = [];
  private seq = 0;

  ensureSchema(): void {}

  insertEvent(row: InsertUsageEventRow): void {
    if (this.rows.some((r) => r.id === row.id)) {
      throw new Error(`UNIQUE constraint failed: usage_events.id`);
    }
    this.rows.push({ ...row, seq: this.seq++ });
  }

  listByUser(userLogin: string, limit: number): UsageEventRow[] {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.seq - a.seq))
      .slice(0, limit)
      .map(({ id, userLogin: u, runId, category, createdAt }) => ({
        id,
        userLogin: u,
        runId,
        category,
        createdAt,
      }));
  }
}
