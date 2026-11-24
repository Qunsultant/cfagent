/**
 * Issue #6372 — the Docs run details must resolve the row the panel names.
 *
 * The panel fetches `/api/runs/details?id=<canonical report id>`
 * (`run.documents.reportId` = the `mas_reports` row id). The endpoint's lookup
 * matched `runId` / `id` / `scanRunId` over the merged newest-100 lists — so a
 * canonical row that exists but sits outside that window 404'd by
 * construction, and a bare report id could never match on its own.
 *
 * What this file pins:
 *
 *  D1  by report id, a row outside the newest-100 window still resolves
 *      (the same store the list is built from, same owner scope);
 *  D2  an unknown id is still an honest 404 — the fallback invents nothing;
 *  D3  another owner's report id does not resolve for this caller (the
 *      fallback keeps the list's owner scoping).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import { storeReportAtGeneration } from "../src/services/scheduledReports";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function seed(sql: SqliteTestStorage, count: number, owner: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
    const stored = storeReportAtGeneration(sql as never, {
      runId: `run-${owner}-${i}`,
      generationId: `options_research:run-${owner}-${i}`,
      title: `Options research — row ${i}`,
      source: "options_research",
      summary: `row ${i}`,
      userLogin: owner,
      createdAt,
      body: {
        success: true,
        trigger: "manual",
        userLogin: owner,
        runId: `run-${owner}-${i}`,
        summary: `row ${i}`,
        ideas: [],
      },
    });
    ids.push(stored.reportId);
  }
  return ids;
}

async function details(sql: SqliteTestStorage, id: string, login: string | null) {
  const url = new URL(`https://x/api/runs/details?id=${encodeURIComponent(id)}`);
  return handleReportsRoutes(
    new Request(url.toString(), {
      headers: login ? { "x-user-login": login } : {},
    }),
    url,
    "/api/runs/details",
    null,
    { ensureTables: () => sql as never, env: {}, jobRunRecordReader: async () => [] } as never,
  );
}

describe("#6372 — Docs run details resolve by the canonical report id", () => {
  it("D1: a row outside the newest-100 window still resolves by report id", async () => {
    const sql = new SqliteTestStorage();
    const ids = seed(sql, 130, "alice");
    const oldest = ids[0];
    const res = await details(sql, oldest, "alice");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { detail?: { runId?: string } };
    expect(payload.detail).toBeTruthy();
    expect(payload.detail?.runId).toBe("run-alice-0");
  });

  it("D2: an unknown id stays an honest 404", async () => {
    const sql = new SqliteTestStorage();
    seed(sql, 3, "alice");
    const res = await details(sql, "00000000-0000-4000-8000-000000000000", "alice");
    expect(res.status).toBe(404);
  });

  it("D3: another owner's report id does not resolve", async () => {
    const sql = new SqliteTestStorage();
    const bobIds = seed(sql, 2, "bob");
    const res = await details(sql, bobIds[0], "alice");
    expect(res.status).toBe(404);
  });
});
