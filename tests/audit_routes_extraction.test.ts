/**
 * Issue #359-04: characterization for the audit route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/audit.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the 3 (path, method) pairs in the
 * same sequence as the original inline blocks; and (b) the extracted entry
 * point's behavior with a mock context: each moved path responds as before,
 * non-matching paths return null (the orchestrator keeps routing).
 *
 * The audit writes stay funneled through the single owner recordAudit()
 * (issue #270) — the route shell delegates via the context, never inline SQL.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleAuditRoutes,
  type AuditRouteContext,
} from "../src/agents/routes/audit";

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

const baseCtx = (overrides: Partial<AuditRouteContext> = {}): AuditRouteContext =>
  ({
    ensureTables: () => makeSql({}),
    audit: vi.fn(),
    recordAudit: vi.fn((type: string, agent: string, payload: Record<string, unknown>) => ({
      id: "rec-1",
      type,
      agent,
      payload,
      created_at: new Date().toISOString(),
    })),
    ...overrides,
  }) as AuditRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("audit route inventory (extraction #367)", () => {
  it("the 3 route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/audit.ts");
    const markers = [
      'path.endsWith("/audit") && request.method === "GET"',
      'path.endsWith("/audit") && request.method === "POST"',
      'path.endsWith("/audit/event") && request.method === "POST"',
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
    // Issue #2942: the delegation call moved with routeRequest into
    // src/agents/orchestrator/routeRequest.ts; it must still exist exactly once there.
    expect(src("agents/orchestrator/routeRequest.ts")).toContain("handleAuditRoutes(request, url, path, sessionId,");
    // Distinctive comments that headed the inline blocks before extraction.
    expect(orchSrc).not.toContain("// Audit logs endpoint");
    expect(orchSrc).not.toContain("// Audit event append");
    expect(orchSrc).not.toContain('if (path.endsWith("/audit/event") && request.method === "POST") {');
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/audit.ts");
    expect(moduleSrc).toContain("// Audit logs endpoint");
    expect(moduleSrc).toContain("// Audit event append");
  });

  it("the audit blocks remain a single contiguous handler (no second position this slice)", () => {
    const orchSrc = src("agents/orchestrator/routeRequest.ts");
    const calls = [...orchSrc.matchAll(/handleAuditRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });
});

describe("handleAuditRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handleAuditRoutes(req("GET", "/autopilot"), new URL("https://x/autopilot"), "/autopilot", "s", ctx)).toBeNull();
    expect(await handleAuditRoutes(req("POST", "/audit/other"), new URL("https://x/audit/other"), "/audit/other", "s", ctx)).toBeNull();
  });

  it("GET /audit returns parsed events, wrapping unparseable payloads as { raw }", async () => {
    // #1644: rows carry session_id (production rows always do — recordAudit
    // writes the instance session key), because the route now filters the
    // command output by session before projecting.
    const rows = [
      { id: "e1", session_id: "s1", type: "t.a", agent: "trading", payload: JSON.stringify({ k: 1 }), created_at: "2026-10-19T05:00:00Z" },
      { id: "e2", session_id: "s1", type: "t.b", agent: "orchestrator", payload: "not-json{", created_at: "2026-10-19T06:00:00Z" },
    ];
    const ctx = baseCtx({ ensureTables: () => makeSql({ mas_events: rows }) });
    const res = await handleAuditRoutes(req("GET", "/api/audit"), new URL("https://x/api/audit"), "/api/audit", "s1", ctx);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.count).toBe(2);
    expect(body.events[0].payload).toEqual({ k: 1 });
    expect(body.events[1].payload).toEqual({ raw: "not-json{" });
  });

  it("GET /audit clamps the limit param to 1..100", async () => {
    // #1644: the route no longer issues the LIMIT ? SQL — the 100-cap is
    // now the route's slice over get_audit_events output, so the cap is
    // pinned by returned count, not by a SQL parameter. A non-numeric
    // limit clamps through Math.max/min to NaN, and slice(0, NaN) yields
    // zero rows — deterministic empty, replacing the old NaN-param quirk.
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: `e${i}`,
      session_id: "s",
      type: "t",
      agent: "trading",
      payload: JSON.stringify({ k: i }),
      created_at: `2026-10-19T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    const ctx = baseCtx({ ensureTables: () => makeSql({ mas_events: rows }) });
    const capped = await handleAuditRoutes(req("GET", "/api/audit?limit=5000"), new URL("https://x/api/audit?limit=5000"), "/api/audit", "s", ctx);
    expect((await capped!.json()).count).toBe(100);
    const nan = await handleAuditRoutes(req("GET", "/api/audit?limit=abc"), new URL("https://x/api/audit?limit=abc"), "/api/audit", "s", ctx);
    expect((await nan!.json()).count).toBe(0);
  });

  it("GET /audit 500s when the store throws", async () => {
    const ctx = baseCtx({
      ensureTables: () =>
        ({
          exec: () => {
            throw new Error("boom");
          },
        }) as any,
    });
    const res = await handleAuditRoutes(req("GET", "/api/audit"), new URL("https://x/api/audit"), "/api/audit", "s", ctx);
    expect(res!.status).toBe(500);
  });

  it("POST /audit applies defaults and funnels through ctx.audit", async () => {
    const audit = vi.fn();
    const ctx = baseCtx({ audit });
    const res = await handleAuditRoutes(req("POST", "/api/audit", {}), new URL("https://x/api/audit"), "/api/audit", "s", ctx);
    expect(res!.status).toBe(200);
    expect(audit).toHaveBeenCalledWith("autopilot.policy_check", "trading", {});
    expect(await res!.json()).toEqual({ success: true, message: "Audit event recorded" });
  });

  it("POST /audit/event rejects a non-object body", async () => {
    const ctx = baseCtx();
    const raw = new Request("https://x/api/audit/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2]",
    });
    const res = await handleAuditRoutes(raw, new URL("https://x/api/audit/event"), "/api/audit/event", "s", ctx);
    expect(res!.status).toBe(400);
  });

  it("POST /audit/event rejects missing/overlong type and oversized payload", async () => {
    const ctx = baseCtx();
    const missing = await handleAuditRoutes(
      req("POST", "/api/audit/event", { type: "   " }), new URL("https://x/api/audit/event"), "/api/audit/event", "s", ctx);
    expect(missing!.status).toBe(400);
    const long = await handleAuditRoutes(
      req("POST", "/api/audit/event", { type: "t".repeat(121) }), new URL("https://x/api/audit/event"), "/api/audit/event", "s", ctx);
    expect(long!.status).toBe(400);
    const big = await handleAuditRoutes(
      req("POST", "/api/audit/event", { type: "t.big", payload: { blob: "x".repeat(70000) } }),
      new URL("https://x/api/audit/event"), "/api/audit/event", "s", ctx);
    expect(big!.status).toBe(400);
  });

  it("POST /audit/event delegates to the single-owner recordAudit() and echoes the record (201)", async () => {
    const recordAudit = vi.fn((type: string, agent: string, payload: Record<string, unknown>) => ({
      id: "rec-9",
      type,
      agent,
      payload,
      created_at: "2026-10-19T05:40:00Z",
    }));
    const ctx = baseCtx({ recordAudit });
    const res = await handleAuditRoutes(
      req("POST", "/api/audit/event", { type: "ui.click", payload: { k: "v" } }),
      new URL("https://x/api/audit/event"), "/api/audit/event", "s", ctx);
    expect(res!.status).toBe(201);
    expect(recordAudit).toHaveBeenCalledWith("ui.click", "orchestrator", { k: "v" });
    const body = await res!.json();
    expect(body).toEqual({
      id: "rec-9",
      type: "ui.click",
      agent: "orchestrator",
      payload: { k: "v" },
      created_at: "2026-10-19T05:40:00Z",
    });
  });
});
