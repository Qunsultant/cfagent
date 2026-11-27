/**
 * Issue #278: tests for durable scheduled-run report persistence and
 * retrieval (src/services/scheduledReports.ts + the D1 agent_reports
 * table, #6101 step 8 — the DO mas_reports table is frozen at cutover
 * and receives no new writes; the seam reads/writes D1 directly).
 * Search semantics run against the real D1 adapter over the shared
 * MockD1Database (node:sqlite), plus one integration check that the
 * frozen mas_reports table still exists in the ORM schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { createD1AuditReportDb, ensureAuditReportSchema } from "../src/data/d1AuditReportAdapter";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
  searchScheduledReports,
  toScheduledReportRecord,
  SCHEDULED_REPORT_MAX_BODY_CHARS,
} from "../src/services/scheduledReports";
import type { SqlStorage } from "../src/orm";

type D1Database = any;

function d1() {
  const mock = new MockD1Database();
  const db = createD1AuditReportDb(mock as unknown as D1Database);
  const env = { AGENT_DB: mock as unknown as D1Database };
  return { mock, db, env };
}

const report = (over: Partial<Parameters<typeof toScheduledReportRecord>[0]> = {}) => ({
  runId: "screener:2026-10-18T10:00:00Z",
  title: "Autonomous market screen — Technology",
  source: "screener",
  summary: "Scanned 500 symbols, 12 matched, 3 opportunities.",
  body: { opportunities: [{ symbol: "NVDA" }] },
  createdAt: "2026-10-18T10:00:00.000Z",
  userLogin: "tenant@example.com",
  ...over,
});

describe("toScheduledReportRecord", () => {
  it("assigns an id, serializes the body, defaults createdAt", () => {
    const rec = toScheduledReportRecord(report({ createdAt: undefined }));
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(rec.body)).toEqual({
      opportunities: [{ symbol: "NVDA" }],
    });
    expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("caps the body to stay far under the SQLite row limit", () => {
    const rec = toScheduledReportRecord(report({ body: { x: "y".repeat(1_000_000) } }));
    expect(rec.body.length).toBeLessThanOrEqual(SCHEDULED_REPORT_MAX_BODY_CHARS);
  });

  it("survives a non-serializable body", () => {
    const circular: any = {};
    circular.self = circular;
    const rec = toScheduledReportRecord(report({ body: circular }));
    expect(rec.body).toBe("{}");
  });
});

describe("persist + search round trip (D1)", () => {
  let env: { AGENT_DB: D1Database };

  beforeEach(() => {
    env = d1().env;
  });

  it("persists and retrieves by title token", async () => {
    const stored = await storeReportAtGeneration(report(), env);
    expect(stored?.reportId).toBeTruthy();
    const hits = await searchScheduledReports(env, "technology");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(stored!.reportId);
    expect(hits[0].title).toContain("Technology");
  });

  it("matches summary and body tokens, not only titles", async () => {
    await storeReportAtGeneration(report(), env);
    expect(await searchScheduledReports(env, "opportunities")).toHaveLength(1);
    expect(await searchScheduledReports(env, "nvda")).toHaveLength(1);
  });

  it("returns newest first and honors the limit", async () => {
    await storeReportAtGeneration(report({ createdAt: "2026-10-18T09:00:00.000Z" }), env);
    await storeReportAtGeneration(report({ createdAt: "2026-10-18T11:00:00.000Z" }), env);
    const hits = await searchScheduledReports(env, "screen", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].createdAt).toBe("2026-10-18T11:00:00.000Z");
  });

  it("returns [] for empty or noise queries", async () => {
    await storeReportAtGeneration(report(), env);
    expect(await searchScheduledReports(env, "")).toEqual([]);
    expect(await searchScheduledReports(env, "a an")).toEqual([]);
    expect(await searchScheduledReports(env, "zzz-no-such-thing")).toEqual([]);
  });

  it("never throws on a broken store", async () => {
    const broken = {
      AGENT_DB: {
        prepare() {
          throw new Error("boom");
        },
      } as unknown as D1Database,
    };
    expect(await storeReportAtGeneration(report(), broken)).toBeNull();
    expect(await searchScheduledReports(broken, "screen")).toEqual([]);
    // ensure* intentionally lets DDL errors propagate — both public
    // entry points above catch it. Callers must not use it raw.
    // (The frozen DO ensure keeps this contract.)
    const brokenSql: SqlStorage = {
      exec: () => {
        throw new Error("boom");
      },
    };
    expect(() => ensureScheduledReportsTable(brokenSql)).toThrow("boom");
  });

  it("ensureAuditReportSchema is idempotent", async () => {
    const { db } = d1();
    await ensureAuditReportSchema(db);
    await ensureAuditReportSchema(db);
    await storeReportAtGeneration(report(), env);
    expect(await searchScheduledReports(env, "screen")).toHaveLength(1);
  });
});

describe("ORM integration (frozen DO table still in schema; D1 round-trips via the seam)", () => {
  it("mas_reports table still exists after initializeSchema; the seam round-trips through D1", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");

    const tables = orm.listTables().map((t) => t.name);
    expect(tables).toContain("mas_reports");

    const { env } = d1();
    const stored = await storeReportAtGeneration(report(), env);
    expect(stored?.reportId).toBeTruthy();
    const hits = await searchScheduledReports(env, "technology");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].title).toContain("Technology");
  });
});
