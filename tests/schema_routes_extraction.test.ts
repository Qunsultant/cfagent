/**
 * Issue #359-17: characterization for the schema routes extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler
 * in src/agents/routes/schema.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the delegation call
 * site in orchestrator.ts — one call site, between the MCP/chat/NLQ
 * handler and the ads/revenue/referrals handler; and (c) the extracted
 * entry point's behavior with a mock context: each moved path responds as
 * before, non-matching paths return null (the orchestrator keeps
 * routing) — the handler ends with an explicit `return null`, never
 * undefined.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS
 * (handleMcpChatNlqRoutes / handleAdsRevenueReferralsRoutes), never to a
 * neighboring domain's inline comments or blocks — those move when their
 * domain is extracted.
 *
 * This is one of the two blocks extracted by slice #359-17, the FINAL
 * slice of the #359 orchestrator breakup: after it, routeRequest holds no
 * inline route handlers (pinned globally by
 * tests/thin_router_inventory.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleSchemaRoutes,
  type SchemaRouteContext,
} from "../src/agents/routes/schema";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeOrm = () => ({
  listTables: vi.fn(() => ["mas_categories", "mas_events"]),
  getTableData: vi.fn((table: string, opts: Record<string, unknown>) => ({
    table,
    rows: [{ id: 1 }],
    ...opts,
  })),
});

const baseCtx = (orm = makeOrm()): SchemaRouteContext =>
  ({
    getOrm: vi.fn(() => orm),
  }) as unknown as SchemaRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("schema route inventory (extraction #380)", () => {
  it("the route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/schema.ts");
    const markers = [
      'path.endsWith("/schema/tables")',
      'path.endsWith("/schema/query")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `marker missing from schema module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    // The extracted module is the sole owner of these blocks now.
    expect(moduleSrc).toContain("// Schema Introspection & Database Tables via ORM");
    expect(moduleSrc).toContain("// Direct Table Query Execution via ORM");
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(orchSrc).not.toContain('path.endsWith("/schema/tables")');
    expect(orchSrc).not.toContain('path.endsWith("/schema/query")');
    expect(orchSrc).not.toContain("// Schema Introspection & Database Tables via ORM");
    // Single call site.
    const calls = [...dispatchSrc.matchAll(/handleSchemaRoutes\(request, url, path, sessionId,/g)];
    expect(calls).toHaveLength(1);
  });

  it("the delegation sits between the MCP/chat/NLQ handler and the ads/revenue/referrals handler", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const myIdx = dispatchSrc.indexOf("handleSchemaRoutes(request, url, path, sessionId,");
    const mcpIdx = dispatchSrc.indexOf("handleMcpChatNlqRoutes(request, url, path, sessionId,");
    const adsIdx = dispatchSrc.indexOf("handleAdsRevenueReferralsRoutes(request, url, path, sessionId,");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(adsIdx).toBeGreaterThan(-1);
    expect(myIdx, "schema delegation must follow the MCP/chat/NLQ handler").toBeGreaterThan(mcpIdx);
    expect(myIdx, "schema delegation must precede the ads/revenue/referrals handler").toBeLessThan(adsIdx);
  });
});

describe("handleSchemaRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(await handleSchemaRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)).toBeNull();
    // Right path, wrong method — the original conditions are method-pinned.
    expect(await handleSchemaRoutes(req("GET", "/api/schema/query"), urlOf("/api/schema/query"), "/api/schema/query", "s", ctx)).toBeNull();
    expect(await handleSchemaRoutes(req("POST", "/api/schema/tables"), urlOf("/api/schema/tables"), "/api/schema/tables", "s", ctx)).toBeNull();
  });

  it("GET /schema/tables returns the ORM table inventory", async () => {
    const orm = makeOrm();
    const res = await handleSchemaRoutes(req("GET", "/api/schema/tables"), urlOf("/api/schema/tables"), "/api/schema/tables", "s", baseCtx(orm));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 2, tables: ["mas_categories", "mas_events"] });
    expect(orm.listTables).toHaveBeenCalledTimes(1);
  });

  it("GET /schema/tables surfaces an ORM failure as a 500 with the error message", async () => {
    const orm = makeOrm();
    orm.listTables.mockImplementation(() => {
      throw new Error("db gone");
    });
    const res = await handleSchemaRoutes(req("GET", "/api/schema/tables"), urlOf("/api/schema/tables"), "/api/schema/tables", "s", baseCtx(orm));
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "db gone" });
  });

  it("POST /schema/query defaults to mas_categories and passes paging through", async () => {
    const orm = makeOrm();
    const res = await handleSchemaRoutes(req("POST", "/api/schema/query", {}), urlOf("/api/schema/query"), "/api/schema/query", "s", baseCtx(orm));
    expect(res!.status).toBe(200);
    expect(orm.getTableData).toHaveBeenCalledWith("mas_categories", {
      search: undefined,
      limit: undefined,
      offset: undefined,
    });
    expect(await res!.json()).toEqual({ table: "mas_categories", rows: [{ id: 1 }] });
  });

  it("POST /schema/query forwards table/search/limit/offset to the ORM", async () => {
    const orm = makeOrm();
    const body = { table: "mas_events", search: "audit", limit: 5, offset: 10 };
    const res = await handleSchemaRoutes(req("POST", "/api/schema/query", body), urlOf("/api/schema/query"), "/api/schema/query", "s", baseCtx(orm));
    expect(res!.status).toBe(200);
    expect(orm.getTableData).toHaveBeenCalledWith("mas_events", {
      search: "audit",
      limit: 5,
      offset: 10,
    });
  });

  it("POST /schema/query surfaces an ORM failure as a 500 with the error message", async () => {
    const orm = makeOrm();
    orm.getTableData.mockImplementation(() => {
      throw new Error("no such table");
    });
    const res = await handleSchemaRoutes(req("POST", "/api/schema/query", { table: "nope" }), urlOf("/api/schema/query"), "/api/schema/query", "s", baseCtx(orm));
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({ error: "no such table" });
  });
});
