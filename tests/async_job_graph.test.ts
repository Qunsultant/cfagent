/**
 * Issue #1123 S1: the async-job graph — parent/sub-job tracking for the
 * screener follow-up pipeline. mas_async_jobs gains parent_job_id,
 * job_kind ('main'|'report'|'delivery'|'notification') and channel
 * ('email'|'slack'|'webhook') so a main job (a screen) can own tracked
 * sub-jobs, and the jobs panel renders the tree.
 *
 * Uses a purpose-built fake SqlStorage (the think-cutover precedent):
 * the shared MockSqlStorage does not register CREATE TABLE schemas, so
 * PRAGMA/ALTER fidelity for a brand-new table needs this harness. The
 * fake projects SELECT column lists faithfully, so a missing column in
 * a query fails the test like it would fail in production.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ensureAsyncJobGraphColumns,
  getAsyncJob,
  listAsyncJobs,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { buildJobTree } from "../src/client/AsyncJobsPanel";

const LEGACY_COLUMNS = [
  "job_id", "session_id", "capability", "display_name", "status",
  "payload_json", "result_json", "response_status", "error",
  "created_at", "updated_at", "started_at", "completed_at",
];

class FakeAsyncSql {
  columns: string[] = [];
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const done = (rowsWritten = 0) => Object.assign([...this.project(q, args)], { rowsWritten });
    if (/^CREATE TABLE/i.test(q)) {
      this.columns = [...LEGACY_COLUMNS];
      return done();
    }
    if (/^PRAGMA table_info/i.test(q)) {
      const cols = this.columns.map((name) => ({ name }));
      return Object.assign(cols, { rowsWritten: 0 });
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
      const valuesMatch = q.match(/VALUES \(([^)]+)\)/i);
      const valueTokens = valuesMatch![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let argIndex = 0;
      cols.forEach((col, i) => {
        const token = valueTokens[i];
        if (token === "?") {
          row[col] = args[argIndex++] ?? null;
        } else {
          row[col] = token.replace(/^'|'$/g, "");
        }
      });
      this.rows.push(row);
      return done(1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) return done(1);
    if (/^SELECT/i.test(q)) return done();
    throw new Error(`FakeAsyncSql: unsupported query: ${q.slice(0, 80)}`);
  }

  private project(query: string, args: unknown[]): Array<Record<string, unknown>> {
    if (!/^SELECT/i.test(query.trim())) return [];
    const listMatch = query.match(/SELECT (.+?) FROM mas_async_jobs/i);
    if (!listMatch) return [];
    const cols = listMatch[1].split(",").map((c) => c.trim());
    let rows = [...this.rows];
    if (/WHERE job_id = \?/i.test(query)) {
      rows = rows.filter((row) => row.job_id === args[0]);
    }
    if (/ORDER BY created_at DESC/i.test(query)) {
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    const limitMatch = query.match(/LIMIT \?/i);
    if (limitMatch) {
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

function makeCtx(sql: FakeAsyncSql): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: {},
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => {
      sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
      ensureAsyncJobGraphColumns(storage);
      return storage;
    },
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm in graph test");
    },
    routeRequest: async () => new Response("{}"),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
  } as unknown as AsyncJobsContext;
}

describe("ensureAsyncJobGraphColumns", () => {
  it("adds parent_job_id, job_kind and channel to a legacy table, idempotently", () => {
    const sql = new FakeAsyncSql();
    sql.exec("CREATE TABLE IF NOT EXISTS mas_async_jobs (job_id TEXT PRIMARY KEY)");
    expect(sql.columns).not.toContain("parent_job_id");
    ensureAsyncJobGraphColumns(sql as never);
    expect(sql.columns).toContain("parent_job_id");
    expect(sql.columns).toContain("job_kind");
    expect(sql.columns).toContain("channel");
    ensureAsyncJobGraphColumns(sql as never);
    expect(sql.columns.filter((c) => c === "parent_job_id")).toHaveLength(1);
  });
});

describe("job graph submissions", () => {
  it("persists parent/kind/channel + display-name override, and defaults legacy submissions to kind 'main'", async () => {
    const sql = new FakeAsyncSql();
    const ctx = makeCtx(sql);

    const main = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "Stock screen" },
    });
    const child = await submitAsyncJob(ctx, {
      capability: "task.draft",
      payload: { title: "ignored for label" },
      parentJobId: main.jobId,
      jobKind: "delivery",
      channel: "slack",
      displayName: "Deliver by Slack",
    });

    const jobs = listAsyncJobs(ctx);
    const mainRec = jobs.find((j) => j.jobId === main.jobId);
    const childRec = jobs.find((j) => j.jobId === child.jobId);
    expect(mainRec?.jobKind).toBe("main");
    expect(mainRec?.parentJobId).toBeUndefined();
    expect(mainRec?.channel).toBeUndefined();
    expect(mainRec?.label).toBe("Task: Stock screen");
    expect(childRec?.parentJobId).toBe(main.jobId);
    expect(childRec?.jobKind).toBe("delivery");
    expect(childRec?.channel).toBe("slack");
    expect(childRec?.label).toBe("Deliver by Slack");

    const fetched = getAsyncJob(ctx, child.jobId);
    expect(fetched?.parentJobId).toBe(main.jobId);
    expect(fetched?.jobKind).toBe("delivery");
    expect(fetched?.channel).toBe("slack");
  });
});

describe("buildJobTree (jobs panel)", () => {
  const job = (
    jobId: string,
    createdAt: string,
    extra: Record<string, unknown> = {},
  ) => ({
    jobId,
    capability: "http.request",
    label: jobId,
    status: "completed" as const,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  });

  it("nests sub-jobs under their main job in creation order and keeps orphans as roots", () => {
    const tree = buildJobTree([
      job("notif", "2026-10-23T03:00:03Z", { parentJobId: "main", jobKind: "notification" }),
      job("report", "2026-10-23T03:00:01Z", { parentJobId: "main", jobKind: "report" }),
      job("main", "2026-10-23T03:00:00Z", { jobKind: "main" }),
      job("orphan", "2026-10-23T02:59:00Z", { parentJobId: "gone", jobKind: "delivery" }),
      job("email", "2026-10-23T03:00:02Z", { parentJobId: "main", jobKind: "delivery", channel: "email" }),
    ]);
    const mainNode = tree.find((n) => n.job.jobId === "main");
    expect(mainNode?.children.map((c) => c.jobId)).toEqual(["report", "email", "notif"]);
    expect(tree.map((n) => n.job.jobId)).toEqual(["main", "orphan"]);
  });
});

describe("wiring pins", () => {
  it("orchestrator.ensureTables runs the graph migration", () => {
    // #2942: ensureTables moved into orchestrator/tableSchema.ts; the pin follows it.
    const src = readFileSync("src/agents/orchestrator/tableSchema.ts", "utf8");
    // #2358 (#1976 step 4a): the graph migration moved into the
    // async-job queue port's schema ensure; ensureTables runs it
    // via ensureAsyncJobTables (base table + indexes + the probed
    // graph migration in one ensure).
    expect(src).toContain("ensureAsyncJobTables");
  });
  it("types expose the job-kind and channel unions", () => {
    const src = readFileSync("src/types.ts", "utf8");
    expect(src).toContain('"main" | "report" | "delivery" | "notification"');
    expect(src).toContain('"email" | "slack" | "webhook"');
  });
});
