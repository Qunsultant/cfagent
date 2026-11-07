/**
 * Shared async-job test harness (extracted from
 * tests/async_jobs_modes_1724.test.ts, #3309 — the harness is one
 * module now so the 202-parity test reuses the exact same fake SQL
 * and context builder instead of a third copy).
 *
 * Purpose-built fake SqlStorage (async_job_graph precedent) + UPDATE
 * support, and the AsyncJobsContext builder the J01 contract tests
 * run against. Session-scoped reads, idempotent schedule arming,
 * and the audit spy are the same in every consumer.
 */
import { vi } from "vitest";
import {
  ensureAsyncJobGraphColumns,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

export const LEGACY_ASYNC_COLUMNS = [
  "job_id", "session_id", "capability", "display_name", "status",
  "payload_json", "result_json", "response_status", "error",
  "created_at", "updated_at", "started_at", "completed_at",
];

/** Purpose-built fake SqlStorage (async_job_graph precedent) + UPDATE support. */
export class FakeAsyncSql {
  columns: string[] = [];
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const done = (rowsWritten = 0) => Object.assign([...this.project(q, args)], { rowsWritten });
    if (/^CREATE TABLE/i.test(q)) {
      this.columns = [...LEGACY_ASYNC_COLUMNS];
      return done();
    }
    if (/^PRAGMA table_info/i.test(q)) {
      return Object.assign(this.columns.map((name) => ({ name })), { rowsWritten: 0 });
    }
    const alter = q.match(/^ALTER TABLE mas_async_jobs ADD COLUMN (\w+)/i);
    if (alter) {
      if (!this.columns.includes(alter[1])) this.columns.push(alter[1]);
      return done();
    }
    if (/^CREATE INDEX/i.test(q)) return done();
    if (/^DELETE FROM mas_async_jobs/i.test(q)) return done();
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const valueTokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let argIndex = 0;
      cols.forEach((col, i) => {
        const token = valueTokens[i];
        row[col] = token === "?" ? (args[argIndex++] ?? null) : token.replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return done(1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      // SET tokens in order (? consumes args sequentially); WHERE job_id = ? consumes the next arg.
      const setClause = q.match(/SET (.+?) WHERE/i)![1];
      const assignments: Array<{ col: string; value: unknown }> = [];
      let argIndex = 0;
      for (const token of setClause.split(",")) {
        const m = token.trim().match(/^(\w+) = (\?|'[^']*')$/);
        if (!m) throw new Error(`FakeAsyncSql: unsupported SET token: ${token}`);
        assignments.push({ col: m[1], value: m[2] === "?" ? args[argIndex++] : m[2].replace(/^'|'$/g, "") });
      }
      const whereJobId = args[argIndex];
      let written = 0;
      for (const row of this.rows) {
        if (row.job_id !== whereJobId) continue;
        if (/AND status = 'running'/i.test(q) && row.status !== "running") continue;
        if (/AND status = 'queued'/i.test(q) && row.status !== "queued") continue;
        for (const a of assignments) row[a.col] = a.value;
        written++;
      }
      return Object.assign([], { rowsWritten: written });
    }
    if (/^SELECT/i.test(q)) return done();
    throw new Error(`FakeAsyncSql: unsupported query: ${q.slice(0, 80)}`);
  }

  private project(query: string, args: unknown[]): Array<Record<string, unknown>> {
    if (!/^SELECT/i.test(query.trim())) return [];
    const listMatch = query.match(/SELECT (.+?) FROM mas_async_jobs/i);
    if (!listMatch) return [];
    const cols = listMatch[1].split(",").map((c) => c.trim());
    let rows = [...this.rows];
    if (/WHERE job_id = \? AND session_id = \?/i.test(query)) {
      rows = rows.filter((row) => row.job_id === args[0] && row.session_id === args[1]);
    } else if (/WHERE session_id = \?/i.test(query)) {
      rows = rows.filter((row) => row.session_id === args[0]);
    }
    if (/ORDER BY created_at DESC/i.test(query)) {
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (/LIMIT \?/i.test(query)) {
      const limit = Number(args[args.length - 1]);
      if (Number.isFinite(limit)) rows = rows.slice(0, limit);
    }
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of cols) out[col] = row[col] ?? null;
      return out;
    });
  }
}

export function makeAsyncCtx(sql: FakeAsyncSql, session = "session-1") {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const schedule = vi.fn().mockResolvedValue(undefined);
  const audit = vi.fn();
  const ctx = {
    env: {},
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => {
      sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
      ensureAsyncJobGraphColumns(storage);
      return storage;
    },
    sessionKey: () => session,
    schedule: ((...a: any[]) => schedule(...a)) as any,
    audit: ((...a: any[]) => audit(...a)) as any,
    getOrm: () => ({}) as any,
    routeRequest: async () => new Response("ok"),
    nlqSchedulingPort: () => undefined as any,
    nlqStockScreenPort: () => undefined as any,
    followupReportPort: () => ({}) as any,
    followupDeliveryPort: () => ({}) as any,
  } as unknown as AsyncJobsContext;
  return { ctx, schedule, audit };
}
