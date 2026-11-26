/**
 * Issue #1057 (consolidation S5): GET /api/runs — the one Runs read
 * surface over the run stores.
 *
 * Issue #6103 (D1-only): the merged DO view is gone. /api/runs reads
 * the D1 ledgers alone — projected canonical reports (agent_reports),
 * the engine's D1 job run records, and the outcomes folded onto them.
 * There is no per-tenant mode switch and no ledgerReadMode response
 * field. Scans, discovery, and the screener feed are NOT projected:
 * those lists are empty and named in storeErrors, never silent. The
 * tests below pin the D1-only equivalents of the old merged-view
 * pins, at the same assertion strength:
 *  1. kind=all serves the projected canonical rows + the engine's D1
 *     rows newest-first; a job-run-record twin named by a projected
 *     report's link is absorbed into the canonical row (one run,
 *     one row) — the old canonical de-duplication, now at the D1
 *     twin link.
 *  2. kind filters server-side: kind=discovery returns no rows and
 *     names discovery as not projected; the projected canonical rows
 *     never leak into the discovery read.
 *  3. kind=screener returns the canonical screener rows only; the
 *     feed is gone and named in storeErrors.
 *  4. Scoping: the scan store is gone, so the caller-scoping
 *     assertion now pins the reports owner scope — the projected
 *     reports are filtered by the caller's x-user-login header,
 *     exactly as the DO read scoped them.
 *  5. Round-trip: a run written straight to D1 agent_reports
 *     (the D1 writer — no DO row, no projection) is returned by
 *     /api/runs with the same id — write path and read surface
 *     agree on the row.
 *  6. An invalid kind is a 400 with the S1 field-named error.
 *  7. The panel reads the Runs surface: ReportsPanel fetches
 *     /api/runs (not the old /api/reports list) and offers the
 *     discovery kind.
 *
 * Seeding (#6101, D1-first): every row is written straight to D1 —
 * canonical reports via D1AuditReportAdapter.recordReport (the D1
 * writer), engine rows via D1JobRunRecordStore.record, outcomes
 * via the fold. There is no DO row, no projection, no carrier row.
 * A report's twin link (linkedJobRunId) is stamped from the twinned
 * D1 record's d1 id. storeErrors.runs names the #6101 freeze: new
 * reports have no D1 row until the step-8 writer lands.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleReportsRoutes, type ReportsRouteContext } from "../src/agents/routes/reports";
import { MockSqlStorage } from "./mock-sql";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { d1JobRunRecordId } from "../src/services/jobRunRecordReads";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";

/** Minimal D1Database stand-in over node:sqlite (the J1 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const TS = {
  discovery: "2026-10-22T11:00:00.000Z",
  options: "2026-10-22T10:00:00.000Z",
  screener: "2026-10-22T08:00:00.000Z",
};

const OPTIONS_RUN_ID = `options_scanner:${TS.options}:balanced`;
const SCREENER_RUN_ID = `screener:${TS.screener}`;

/** The frozen-reports entry every /api/runs read names (#6101). */
const FROZEN_RUNS = "frozen at the #6101 cutover";

export interface SeedReportInput {
  runId: string;
  generationId?: string | null;
  title: string;
  source: string;
  summary: string;
  userLogin: string;
  body: unknown;
  createdAt: string;
  linkedJobRunId?: string | null;
}

/**
 * Issue #6101 — write one canonical report DIRECTLY into D1
 * agent_reports (the D1 writer's shape; the id is a fresh UUID,
 * exactly as the canonical write path mints it). The twin link
 * is stamped by the caller when the report twins a D1 job run
 * record — no projector resolves it anymore.
 */
async function seedReportD1(mock: MockD1Database, input: SeedReportInput): Promise<string> {
  const auditDb = createD1AuditReportDb(mock as never);
  await ensureAuditReportSchema(auditDb);
  const audit = new D1AuditReportAdapter(auditDb);
  const reportId = crypto.randomUUID();
  const createdAtMs = Date.parse(input.createdAt);
  await audit.recordReport({
    tenantId: "primary",
    workspaceId: "primary",
    reportId,
    runId: input.runId,
    generationId: input.generationId ?? null,
    title: input.title,
    source: input.source,
    summary: input.summary,
    body: typeof input.body === "string" ? input.body : JSON.stringify(input.body),
    createdAtMs,
    updatedAtMs: createdAtMs,
    version: 1,
    provenanceWriter: "test-d1-seed",
    provenanceSourceDo: "test",
    provenanceSourceVersion: "1",
    linkedJobRunId: input.linkedJobRunId ?? null,
    userLogin: input.userLogin,
    bodyR2Key: null,
  });
  return reportId;
}

async function d1Fixture() {
  const mock = new MockD1Database();
  const sql = new MockSqlStorage();
  const jobDb = createD1JobRunRecordDb(mock as never);
  await ensureJobRunRecordsSchema(jobDb);
  const jobStore = new D1JobRunRecordStore(jobDb);
  // The engine's D1 twin of the options report: same run id — the
  // report below stamps the twin link from this record's d1 id
  // and the list absorbs this row into the canonical row.
  const twin = buildJobRunRecord({
    system: "job-pipeline",
    jobId: OPTIONS_RUN_ID,
    operation: "run",
    started: TS.options,
    finished: "2026-10-22T10:05:00.000Z",
    outcome: "success",
    triggeredBy: "manual",
  });
  await jobStore.record(twin);
  // A standalone engine row (no report twin): the newest run.
  const pipeline = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "pipeline-feed-quotes",
    operation: "job",
    started: TS.discovery,
    finished: "2026-10-22T11:02:30.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    descriptor: "run run-abc123: 12 step executions, 3 artifacts",
  });
  await jobStore.record(pipeline);
  const optionsReportId = await seedReportD1(mock, {
    runId: OPTIONS_RUN_ID,
    generationId: OPTIONS_RUN_ID,
    title: "Options scanner — balanced",
    source: "options_scanner",
    summary: "Options scan summary.",
    userLogin: "alice",
    body: { report: { result: { scanRunId: "scan-1", withTrades: 7 } } },
    createdAt: TS.options,
    linkedJobRunId: d1JobRunRecordId(twin),
  });
  const screenerReportId = await seedReportD1(mock, {
    runId: SCREENER_RUN_ID,
    generationId: SCREENER_RUN_ID,
    title: "Market screen — NASDAQ100 (scheduled)",
    source: "screener",
    summary: "Scanned 100 symbols, 5 matched.",
    userLogin: "alice",
    body: { trigger: "scheduled", success: true, matchedCount: 5, timestamp: TS.screener },
    createdAt: TS.screener,
  });
  // A second owner's report: the owner-scoping pin's other side.
  const bobReportId = await seedReportD1(mock, {
    runId: "screener:2026-10-22T07:00:00.000Z",
    generationId: "screener:2026-10-22T07:00:00.000Z",
    title: "Market screen — NASDAQ100 (scheduled)",
    source: "screener",
    summary: "Scanned 100 symbols, 1 matched.",
    userLogin: "bob",
    body: { trigger: "scheduled", success: true, matchedCount: 1, timestamp: "2026-10-22T07:00:00.000Z" },
    createdAt: "2026-10-22T07:00:00.000Z",
  });
  const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
  return {
    mock,
    sql,
    env,
    twinId: d1JobRunRecordId(twin),
    pipelineId: d1JobRunRecordId(pipeline),
    optionsReportId,
    screenerReportId,
    bobReportId,
  };
}

function runsCtx(fx: Awaited<ReturnType<typeof d1Fixture>>): ReportsRouteContext {
  return {
    ensureTables: () => fx.sql as never,
    env: fx.env as never,
  } as ReportsRouteContext;
}

function bareCtx(): ReportsRouteContext {
  return {
    ensureTables: () => new MockSqlStorage() as never,
    env: { AGENT_DB: new MockD1Database() as never, IAAA_TENANT_ID: "primary" },
  } as ReportsRouteContext;
}

function runsRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://x${path}`, init);
}

async function call(path: string, ctx: ReportsRouteContext, init: RequestInit = {}) {
  const url = new URL(`https://x${path}`);
  return handleReportsRoutes(new Request(url, init), url, url.pathname, null, ctx);
}

describe("GET /api/runs (S5)", () => {
  it("D1-only (#6103): serves projected canonical rows newest-first with the twin absorbed", async () => {
    const fx = await d1Fixture();
    const res = await call("/api/runs?kind=all", runsCtx(fx), {
      headers: { "x-user-login": "alice" },
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.kind).toBe("all");
    // Issue #6103 (Q5) — no mode rides the response anymore.
    expect("ledgerReadMode" in data).toBe(false);
    // Newest first: the standalone engine row (11:00), the options
    // report (10:00), the screener report (08:00). Bob's report is
    // owner-scoped out by the alice header; the twin job-run-record
    // row is absorbed into the canonical options row, never a
    // second row.
    expect(data.runs.map((r: any) => r.id)).toEqual([
      fx.pipelineId,
      fx.optionsReportId,
      fx.screenerReportId,
    ]);
    expect(data.count).toBe(3);
    expect(data.runs.map((r: any) => r.id)).not.toContain(fx.twinId);
    expect(data.runs.map((r: any) => r.id)).not.toContain(fx.bobReportId);
    const canonical = data.runs.find((r: any) => r.id === fx.optionsReportId);
    expect(canonical.reportId).toBe(fx.optionsReportId);
    expect(canonical.scanRunId).toBe("scan-1");
    const screener = data.runs.find((r: any) => r.id === fx.screenerReportId);
    expect(screener.kind).toBe("screener");
    expect(screener.status).toBe("completed");
    expect(screener.resultCount).toBe(5);
    // The projected stores land; the unprojected families are empty
    // + named, never silent.
    expect(data.storeErrors?.reports).toBeUndefined();
    expect(data.storeErrors?.jobRunRecords).toBeUndefined();
    expect(data.storeErrors?.runs).toMatch(FROZEN_RUNS);
    expect(data.storeErrors?.scans).toMatch("not projected");
    expect(data.storeErrors?.discovery).toMatch("not projected");
    expect(data.storeErrors?.screener).toMatch("not projected");
  });

  it("kind=discovery (#6103): no discovery rows — discovery is not projected, named in storeErrors", async () => {
    const fx = await d1Fixture();
    const res = await call("/api/runs?kind=discovery", runsCtx(fx), {
      headers: { "x-user-login": "alice" },
    });
    const data = (await res!.json()) as any;
    expect("ledgerReadMode" in data).toBe(false);
    expect(data.runs).toEqual([]);
    expect(data.storeErrors?.discovery).toMatch("not projected");
    // The projected canonical rows never leak into the discovery
    // read — the discovery family is empty by itself.
    expect(data.storeErrors?.reports).toBeUndefined();
  });

  it("kind=screener (#6103): canonical screener rows only — the feed is gone, named in storeErrors", async () => {
    const fx = await d1Fixture();
    const res = await call("/api/runs?kind=screener", runsCtx(fx), {
      headers: { "x-user-login": "alice" },
    });
    const data = (await res!.json()) as any;
    expect(data.runs.map((r: any) => r.id)).toEqual([fx.screenerReportId]);
    expect(data.runs[0].kind).toBe("screener");
    expect(data.storeErrors?.screener).toMatch("not projected");
    expect(data.storeErrors?.discovery).toBeUndefined();
    expect(data.storeErrors?.scans).toBeUndefined();
  });

  it("an invalid kind is a 400 with the S1 field-named error", async () => {
    const res = await call("/api/runs?kind=bogus", bareCtx());
    expect(res!.status).toBe(400);
    const data = (await res!.json()) as any;
    expect(data.error).toContain("kind:");
    expect(data.runs).toEqual([]);
  });

  it("scopes the projected reports by the caller's x-user-login header (#6103: the scan store is gone — the caller-scoping assertion now pins the reports owner scope)", async () => {
    const fx = await d1Fixture();
    const alice = (await (
      await call("/api/runs?kind=all", runsCtx(fx), { headers: { "x-user-login": "alice" } })
    )!.json()) as any;
    expect(alice.runs.map((r: any) => r.id)).toEqual([
      fx.pipelineId,
      fx.optionsReportId,
      fx.screenerReportId,
    ]);
    expect(alice.runs.map((r: any) => r.id)).not.toContain(fx.bobReportId);
    const bob = (await (
      await call("/api/runs?kind=all", runsCtx(fx), { headers: { "x-user-login": "bob" } })
    )!.json()) as any;
    // Bob sees his own report + the ownerless engine row — but the
    // twin ALSO surfaces here: its canonical report is owner-scoped
    // out of bob's read, so the absorption link (which rides the
    // owner-filtered reports list) never names it. Alice's report
    // rows themselves never leak; only the ownerless twin row shows.
    expect(bob.runs.map((r: any) => r.id)).toEqual([fx.pipelineId, fx.twinId, fx.bobReportId]);
    expect(bob.runs.map((r: any) => r.id)).not.toContain(fx.optionsReportId);
    expect(bob.runs.map((r: any) => r.id)).not.toContain(fx.screenerReportId);
    // No header: tenant-scoped, both owners' rows show.
    const unscoped = (await (await call("/api/runs?kind=all", runsCtx(fx)))!.json()) as any;
    expect(unscoped.runs.map((r: any) => r.id)).toEqual([
      fx.pipelineId,
      fx.optionsReportId,
      fx.screenerReportId,
      fx.bobReportId,
    ]);
  });

  it("does not claim POST /api/runs (falls through to the next family)", async () => {
    const res = await call("/api/runs", bareCtx(), { method: "POST" });
    expect(res).toBeNull();
  });

  it("round-trip (#6101): a run written straight to D1 agent_reports is returned with its id from D1", async () => {
    const mock = new MockSqlStorage() as any;
    const d1 = new MockD1Database();
    const persistedId = await seedReportD1(d1, {
      runId: `screener:${TS.screener}`,
      generationId: `screener:${TS.screener}`,
      userLogin: "alice",
      title: "Market screen — NASDAQ100 (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols, 5 matched.",
      body: { trigger: "scheduled", success: true, matchedCount: 5, timestamp: TS.screener },
      createdAt: TS.screener,
    });
    const env = { AGENT_DB: d1 as never, IAAA_TENANT_ID: "primary" };
    const res = await call(
      "/api/runs?kind=all",
      { ensureTables: () => mock, env: env as never } as ReportsRouteContext,
      { headers: { "x-user-login": "alice" } },
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const row = data.runs.find((r: any) => r.id === persistedId);
    expect(row).toBeDefined();
    expect(row.kind).toBe("screener");
    expect(row.reportId).toBe(persistedId);
    expect(row.resultCount).toBe(5);
    expect(row.status).toBe("completed");
    expect(data.storeErrors?.reports).toBeUndefined();
  });
});

describe("ReportsPanel runs surface (S5)", () => {
  const panel = readFileSync(join(process.cwd(), "src/client/ReportsPanel.tsx"), "utf8");

  it("lists from /api/runs and no longer fetches the /api/reports list", () => {
    expect(panel).toContain("/api/runs?kind=");
    expect(panel).not.toContain("`/api/reports?${params}`");
  });

  it("offers the discovery kind with a badge label", () => {
    expect(panel).toContain('"discovery"');
    expect(panel).toContain("Discovery");
  });

  it("keeps the semantic-search + detail hydration endpoints untouched", () => {
    expect(panel).toContain("/api/reports/semantic-search");
    expect(panel).toContain("/api/reports/");
  });
});
