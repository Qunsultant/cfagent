/**
 * Issue #359-01: characterization for the reports + HITL route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handlers in
 * src/agents/routes/reports.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the same 7 (path, method) pairs in
 * the same sequence as the original inline blocks; and (b) the extracted
 * entry point's behavior with a mock context: each moved path responds as
 * before, non-matching paths return null (the orchestrator keeps routing).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { handleReportsRoutes, type ReportsRouteContext } from "../src/agents/routes/reports";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (tables: Record<string, any[]>) =>
  ({
    exec: (query: string, ..._params: unknown[]) => {
      for (const [table, rows] of Object.entries(tables)) {
        if (query.includes(table)) return rows;
      }
      return [];
    },
  }) as any;

const baseCtx = (overrides: Partial<ReportsRouteContext> = {}): ReportsRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    // Issue #1057 (S5): the Runs merge reads the ScreenerAgent feed
    // through these two accessors; the extraction fixtures serve an
    // empty feed.
    getScreenerAgent: () => ({ getHistory: async () => [] }) as any,
    getScreenerExecutionContext: async () => undefined,
    getReportDispatchHitl: () => false,
    setReportDispatchHitl: vi.fn(),
    getReportConfirmation: vi.fn(() => null),
    decideReportConfirmation: vi.fn(),
    createReportConfirmation: vi.fn(() => "conf-1"),
    confirmationDeliveryMeta: vi.fn(() => ({})),
    deliverStoredReportEmail: vi.fn(async () => "sent" as const),
    deliverStoredReportWebhook: vi.fn(async () => ({
      outcome: "sent" as const,
      result: { success: true, status: 200 },
    })),
    sendReportEmail: vi.fn(async () => true),
    sendReportWebhook: vi.fn(async () => ({ success: true, status: 200 })),
    storeResearchReportCanonicalAsync: vi.fn(async () => ({
      reportId: "r1",
      generationId: "g1",
    })),
    audit: vi.fn(),
    reportConfirmationTtlMs: () => 24 * 60 * 60 * 1000,
    ...overrides,
  }) as ReportsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

const xlsxB64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05]).toString("base64");

describe("reports/HITL route inventory (extraction #363)", () => {
  it("the 7 route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/reports.ts");
    const markers = [
      'path.endsWith("/trading/reports/pending") && request.method === "GET"',
      'path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "GET"',
      'path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "POST"',
      'path.endsWith("/trading/reports/confirm") && request.method === "POST"',
      'path.endsWith("/trading/reports/email") && request.method === "POST"',
      'path.endsWith("/trading/reports/webhook") && request.method === "POST"',
      'path.endsWith("/runs") && request.method === "GET"',
      'path.endsWith("/reports")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; the delegation stands in their place", () => {
    const orchSrc = src("agents/orchestrator.ts");
    expect(orchSrc).toContain("handleReportsRoutes(request, url, path, sessionId,");
    // Distinctive comment that headed the first inline block before extraction.
    expect(orchSrc).not.toContain("// Issue #277: list pending report-dispatch confirmations");
    expect(orchSrc).not.toContain("// List persisted reports (issue #309).");
    // The extracted module is the sole owner of these conditions now.
    const moduleSrc = src("agents/routes/reports.ts");
    expect(moduleSrc).toContain("// Issue #277: list pending report-dispatch confirmations");
  });
});

describe("handleReportsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    const url = new URL("https://agent.internal/trading/options/scan");
    expect(await handleReportsRoutes(req("POST", "/trading/options/scan"), url, "/trading/options/scan", "sess", ctx)).toBeNull();
    const url2 = new URL("https://agent.internal/trading/reports/email");
    expect(await handleReportsRoutes(req("GET", "/trading/reports/email"), url2, "/trading/reports/email", "sess", ctx)).toBeNull();
  });

  it("GET /trading/reports/pending lists pending confirmations", async () => {
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_report_confirmations: [
            {
              id: "c1",
              kind: "email",
              payload_json: JSON.stringify({ recipient: "a@b.com", fileName: "r.xlsx" }),
              // Issue #1324: the list sweeps expired rows, so the
              // fixture must be inside the 24h window to stay listed.
              created_at: new Date().toISOString(),
            },
          ],
        }),
    });
    const url = new URL("https://agent.internal/trading/reports/pending");
    const res = await handleReportsRoutes(req("GET", "/trading/reports/pending"), url, "/trading/reports/pending", "sess", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].confirmationId).toBe("c1");
    expect(body.pending[0].detail).toContain("a@b.com");
  });

  it("GET /trading/settings/report-dispatch-hitl returns the setting", async () => {
    const ctx = baseCtx({ getReportDispatchHitl: () => true });
    const url = new URL("https://agent.internal/trading/settings/report-dispatch-hitl");
    const res = await handleReportsRoutes(req("GET", "/trading/settings/report-dispatch-hitl"), url, "/trading/settings/report-dispatch-hitl", "sess", ctx);
    expect((await res!.json()) as any).toEqual({ enabled: true });
  });

  it("POST /trading/settings/report-dispatch-hitl validates then persists", async () => {
    const setHitl = vi.fn();
    const ctx = baseCtx({ setReportDispatchHitl: setHitl });
    const url = new URL("https://agent.internal/trading/settings/report-dispatch-hitl");
    const path = "/trading/settings/report-dispatch-hitl";
    const bad = await handleReportsRoutes(req("POST", path, { enabled: "yes" }), url, path, "sess", ctx);
    expect(bad!.status).toBe(400);
    const ok = await handleReportsRoutes(req("POST", path, { enabled: true }), url, path, "sess", ctx);
    expect((await ok!.json()) as any).toEqual({ enabled: true });
    expect(setHitl).toHaveBeenCalledWith(true);
  });

  it("POST /trading/reports/confirm dispatches the stored copy on approval", async () => {
    const deliver = vi.fn(async () => "sent" as const);
    const decide = vi.fn();
    const ctx = baseCtx({
      getReportConfirmation: vi.fn(() => ({
        id: "c1",
        kind: "email",
        status: "pending",
        created_at: new Date().toISOString(),
        report_id: "r1",
        created_by: "sess",
        payload_json: JSON.stringify({ recipient: "a@b.com" }),
      })),
      confirmationDeliveryMeta: vi.fn(() => ({ recipient: "a@b.com" })),
      deliverStoredReportEmail: deliver,
      decideReportConfirmation: decide,
    });
    const url = new URL("https://agent.internal/trading/reports/confirm");
    const path = "/trading/reports/confirm";
    const missing = await handleReportsRoutes(req("POST", path, {}), url, path, "sess", ctx);
    expect(missing!.status).toBe(400);
    const res = await handleReportsRoutes(
      req("POST", path, { confirmationId: "c1", decision: "approved" }),
      url,
      path,
      "sess",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true, status: "dispatched", confirmationId: "c1" });
    expect(deliver).toHaveBeenCalledWith("r1", "a@b.com", "sess");
    expect(decide).toHaveBeenCalledWith("c1", "approved", "sess");
  });

  it("POST /trading/reports/confirm rejects with status rejected", async () => {
    const decide = vi.fn();
    const ctx = baseCtx({
      getReportConfirmation: vi.fn(() => ({
        id: "c1",
        kind: "webhook",
        status: "pending",
        created_at: new Date().toISOString(),
        report_id: "r1",
        created_by: "sess",
        payload_json: "{}",
      })),
      decideReportConfirmation: decide,
    });
    const url = new URL("https://agent.internal/trading/reports/confirm");
    const path = "/trading/reports/confirm";
    const res = await handleReportsRoutes(
      req("POST", path, { confirmationId: "c1", decision: "rejected", note: "n/a" }),
      url,
      path,
      "sess",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true, status: "rejected", confirmationId: "c1" });
    expect(decide).toHaveBeenCalledWith("c1", "rejected", "sess");
  });

  it("POST /trading/reports/confirm 404s unknown ids and 410s expired ones", async () => {
    const url = new URL("https://agent.internal/trading/reports/confirm");
    const path = "/trading/reports/confirm";
    const ctxUnknown = baseCtx({ getReportConfirmation: vi.fn(() => null) });
    const r404 = await handleReportsRoutes(req("POST", path, { confirmationId: "zz" }), url, path, "sess", ctxUnknown);
    expect(r404!.status).toBe(404);
    const ctxExpired = baseCtx({
      getReportConfirmation: vi.fn(() => ({
        id: "c1",
        kind: "webhook",
        status: "pending",
        created_at: "2020-01-01T00:00:00Z",
        report_id: "r1",
        created_by: "sess",
        payload_json: "{}",
      })),
    });
    const r410 = await handleReportsRoutes(req("POST", path, { confirmationId: "c1" }), url, path, "sess", ctxExpired);
    expect(r410!.status).toBe(410);
  });

  it("POST /trading/reports/email validates the workbook, stores, then delivers", async () => {
    const url = new URL("https://agent.internal/trading/reports/email");
    const path = "/trading/reports/email";
    const ctx = baseCtx();
    const bad = await handleReportsRoutes(req("POST", path, { to: "not-an-email" }), url, path, "sess", ctx);
    expect(bad!.status).toBe(400);
    const res = await handleReportsRoutes(
      req("POST", path, { to: "a@b.com", fileName: "report.xlsx", attachmentBase64: xlsxB64, title: "Q" }),
      url,
      path,
      "sess",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true });
    expect(ctx.storeResearchReportCanonicalAsync).toHaveBeenCalled();
    expect(ctx.deliverStoredReportEmail).toHaveBeenCalledWith("r1", "a@b.com", "sess");
  });

  it("POST /trading/reports/email holds for confirmation when HITL is on", async () => {
    const ctx = baseCtx({ getReportDispatchHitl: () => true });
    const url = new URL("https://agent.internal/trading/reports/email");
    const path = "/trading/reports/email";
    const res = await handleReportsRoutes(
      req("POST", path, { to: "a@b.com", fileName: "report.xlsx", attachmentBase64: xlsxB64 }),
      url,
      path,
      "sess",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true, status: "pending_confirmation", confirmationId: "conf-1" });
    expect(ctx.createReportConfirmation).toHaveBeenCalled();
  });

  it("POST /trading/reports/webhook validates sheets, stores, then dispatches", async () => {
    const url = new URL("https://agent.internal/trading/reports/webhook");
    const path = "/trading/reports/webhook";
    const ctx = baseCtx();
    const bad = await handleReportsRoutes(req("POST", path, { sheets: [] }), url, path, "sess", ctx);
    expect(bad!.status).toBe(400);
    const res = await handleReportsRoutes(
      req("POST", path, { title: "T", sheets: [{ name: "s1", rows: [{ a: 1 }] }] }),
      url,
      path,
      "sess",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true, status: 200 });
    expect(ctx.deliverStoredReportWebhook).toHaveBeenCalledWith("r1", "sess");
  });

  it("tenant auto-refresh route: absent row defaults OFF, POST persists per tenant (#2481)", async () => {
    // Minimal D1Database stand-in over node:sqlite (same pattern
    // as tests/commercial_accounts.test.ts).
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
    }
    const mock = new MockD1Database();
    const ctx = baseCtx({ env: { AGENT_DB: mock as unknown as D1Database } });
    const path = "/tenant/settings/auto-refresh";
    const url = new URL(`https://agent.internal${path}`);
    const get = await handleReportsRoutes(req("GET", path), url, path, "sess", ctx);
    expect((await get!.json()) as any).toEqual({ tenantId: "primary", enabled: false, intervalS: 15 });
    const bad = await handleReportsRoutes(req("POST", path, { enabled: "yes" }), url, path, "sess", ctx);
    expect(bad!.status).toBe(400);
    const ok = await handleReportsRoutes(req("POST", path, { enabled: true, intervalS: 60 }), url, path, "sess", ctx);
    const saved = (await ok!.json()) as any;
    expect(saved.enabled).toBe(true);
    expect(saved.intervalS).toBe(60);
    const reread = await handleReportsRoutes(req("GET", path), url, path, "sess", ctx);
    expect((await reread!.json()) as any).toEqual({ tenantId: "primary", enabled: true, intervalS: 60 });
    expect(ctx.audit).toHaveBeenCalledWith(
      "tenant_auto_refresh.changed",
      "orchestrator",
      expect.objectContaining({ tenantId: "primary", enabled: true }),
    );
  });

  it("tenant auto-refresh route without a store binding is a 503, not a local fallback (#2481)", async () => {
    const ctx = baseCtx();
    const path = "/tenant/settings/auto-refresh";
    const url = new URL(`https://agent.internal${path}`);
    const res = await handleReportsRoutes(req("GET", path), url, path, "sess", ctx);
    expect(res!.status).toBe(503);
  });

  it("GET /reports lists the stored canonical reports", async () => {
    const ctx = baseCtx({
      ensureTables: () =>
        makeSql({
          mas_reports: [
            { id: "r1", runId: "g1", title: "T1", source: "research_report", summary: "s", createdAt: "2026-10-19T00:00:00Z" },
          ],
        }),
    });
    const url = new URL("https://agent.internal/api/reports");
    const res = await handleReportsRoutes(req("GET", "/api/reports"), url, "/api/reports", "sess", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.reports[0].title).toBe("T1");
  });
});
