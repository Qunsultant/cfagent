/**
 * Issue #6372 — the Docs run details must resolve the row the panel names.
 *
 * The panel fetches `/api/runs/details?id=<canonical report id>`
 * (`run.documents.reportId` = the D1 `agent_reports` row id). The endpoint's
 * lookup matches `runId` / `id` / `scanRunId` over the newest-100 lists — so a
 * canonical row that exists but sits outside that window 404'd by
 * construction, and a bare report id could never match on its own.
 *
 * Issue #6103 — the lookup is D1-only now (the DO fallback is gone):
 * the by-id read is `latestReport` on the D1 audit report adapter,
 * under the same owner scope the DO fallback kept (resolve regardless
 * when no login is present; require row.userLogin === reportLogin
 * when one is). The body resolves from R2, read-only.
 *
 * What this file pins:
 *
 *  D1  by report id, a row outside the newest-100 window still resolves
 *      (the D1 ledger the list is built from, same owner scope);
 *  D2  an unknown id is still an honest 404 — the fallback invents nothing,
 *      and the 404 carries no read mode anymore (there is one mode now);
 *  D3  another owner's report id does not resolve for this caller (the
 *      fallback keeps the list's owner scoping).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import type { CanonicalReportRow } from "../src/data/auditReportPorts";

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
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
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

async function seed(mock: MockD1Database, count: number, owner: string): Promise<string[]> {
  const db = createD1AuditReportDb(mock as never);
  await ensureAuditReportSchema(db);
  const store = new D1AuditReportAdapter(db);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const createdAtMs = Date.UTC(2026, 10, 1, 0, i);
    const row: CanonicalReportRow = {
      tenantId: "primary",
      workspaceId: "primary",
      reportId: `rep-${owner}-${i}`,
      runId: `run-${owner}-${i}`,
      generationId: `options_research:run-${owner}-${i}`,
      title: `Options research — row ${i}`,
      source: "options_research",
      summary: `row ${i}`,
      body: JSON.stringify({
        success: true,
        trigger: "manual",
        userLogin: owner,
        runId: `run-${owner}-${i}`,
        summary: `row ${i}`,
        ideas: [],
      }),
      createdAtMs,
      updatedAtMs: createdAtMs,
      version: 1,
      provenanceWriter: "test",
      provenanceSourceDo: "Orchestrator",
      provenanceSourceVersion: "1",
      linkedJobRunId: null,
      userLogin: owner,
      bodyR2Key: null,
    };
    await store.recordReport(row);
    ids.push(row.reportId);
  }
  return ids;
}

async function details(mock: MockD1Database, id: string, login: string | null) {
  const url = new URL(`https://x/api/runs/details?id=${encodeURIComponent(id)}`);
  return handleReportsRoutes(
    new Request(url.toString(), {
      headers: login ? { "x-user-login": login } : {},
    }),
    url,
    "/api/runs/details",
    null,
    {
      env: { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" },
      jobRunRecordReader: async () => [],
    } as never,
  );
}

describe("#6372 — Docs run details resolve by the canonical report id", () => {
  it("D1: a row outside the newest-100 window still resolves by report id", async () => {
    const mock = new MockD1Database();
    const ids = await seed(mock, 130, "alice");
    const oldest = ids[0];
    const res = await details(mock, oldest, "alice");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { detail?: { runId?: string } };
    expect(payload.detail).toBeTruthy();
    expect(payload.detail?.runId).toBe("run-alice-0");
  });

  it("D2: an unknown id stays an honest 404 with no read mode", async () => {
    const mock = new MockD1Database();
    await seed(mock, 3, "alice");
    const res = await details(mock, "00000000-0000-4000-8000-000000000000", "alice");
    expect(res.status).toBe(404);
    // Issue #6103 (Q5) — there is one read mode now, so the 404
    // carries no mode field at all; the error alone names the miss.
    const payload = (await res.json()) as { error?: string; ledgerReadMode?: string };
    expect(payload.error).toBe("run not found");
    expect("ledgerReadMode" in payload).toBe(false);
  });

  it("D3: another owner's report id does not resolve", async () => {
    const mock = new MockD1Database();
    const bobIds = await seed(mock, 2, "bob");
    const res = await details(mock, bobIds[0], "alice");
    expect(res.status).toBe(404);
  });
});
