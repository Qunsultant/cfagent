/**
 * Issue #1257 — post-hoc live check route (owner go-ahead 2026-11-03):
 * read-only GET /adaptation/promotions/active-check, SELECT-only against
 * the Orchestrator DO SQLite mas_promotions table, same session auth as
 * the surrounding adaptation routes. Per the owner's 2026-11-03 direction
 * the route is landed AND LEFT IN PLACE until the owner directs removal
 * (the draft's "never ship permanently" line is superseded).
 *
 * Route-level pins via handleScreenerResearchRoutes + a stub sql object
 * (MockSqlStorage has no GROUP BY support, so the two raw queries are
 * stubbed at the getSql seam — the route's own contract is what is
 * pinned here: auth, JSON shape, SELECT-only statements).
 */
import { describe, it, expect } from "vitest";
import { codedMessage } from "../src/outcomes/outcomeAspects";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";

const PATH = "/adaptation/promotions/active-check";

function stubSql(opts: {
  inFlight?: Array<Record<string, unknown>>;
  byStage?: Array<Record<string, unknown>>;
  throws?: boolean;
} = {}) {
  const issued: string[] = [];
  const inFlight = opts.inFlight ?? [
    { id: "p-1", candidate_id: "c-1", stage: "shadow", stage_started_at: "2026-10-20T00:00:00.000Z", created_at: "2026-10-20T00:00:00.000Z" },
    { id: "p-2", candidate_id: "c-2", stage: "partial", stage_started_at: "2026-10-21T00:00:00.000Z", created_at: "2026-10-21T00:00:00.000Z" },
  ];
  const byStage = opts.byStage ?? [
    { stage: "shadow", count: 1 },
    { stage: "partial", count: 1 },
    { stage: "completed", count: 3 },
  ];
  return {
    issued,
    exec: (query: string): Iterable<unknown> => {
      issued.push(query);
      if (opts.throws) throw new Error("no such table: mas_promotions");
      if (/GROUP BY/i.test(query)) return byStage;
      return inFlight;
    },
  };
}

function routeCtx(sql: { exec: (query: string) => Iterable<unknown> }) {
  return {
    getOrm: () => ({ getSql: () => sql }),
  } as unknown as ScreenerResearchRouteContext;
}

async function call(
  ctx: ScreenerResearchRouteContext,
  method: string,
  headers: Record<string, string> = {},
  sessionId = ""
) {
  const res = await handleScreenerResearchRoutes(
    new Request(`https://agent.internal${PATH}`, { method, headers }),
    new URL(`https://agent.internal${PATH}`),
    PATH,
    sessionId,
    ctx
  );
  return res;
}

describe("GET /adaptation/promotions/active-check (#1257)", () => {
  it("unauthenticated (no header, no session) → 401 unauthenticated response", async () => {
    const sql = stubSql();
    const res = await call(routeCtx(sql), "GET");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const data = (await res!.json()) as any;
    expect(data.success).toBe(false);
    expect(sql.issued).toEqual([]);
  });

  it("authenticated → inFlight/byStage JSON shape, exactly two SELECT statements", async () => {
    const sql = stubSql();
    const res = await call(routeCtx(sql), "GET", { "x-user-login": "alice" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.inFlight).toHaveLength(2);
    expect(data.inFlight[0].stage).toBe("shadow");
    expect(data.inFlight[1].stage).toBe("partial");
    expect(data.inFlightCount).toBe(2);
    expect(data.byStage).toEqual([
      { stage: "shadow", count: 1 },
      { stage: "partial", count: 1 },
      { stage: "completed", count: 3 },
    ]);
    expect(typeof data.timestamp).toBe("string");
    expect(sql.issued).toHaveLength(2);
    for (const q of sql.issued) {
      expect(q.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
    expect(sql.issued[0]).toContain("WHERE stage IN ('shadow', 'partial', 'full')");
    expect(sql.issued[0]).toContain("ORDER BY created_at ASC");
    expect(sql.issued[0]).not.toMatch(/LIMIT/i);
  });

  it("sessionId fallback: no header but a sessionId authenticates", async () => {
    const sql = stubSql();
    const res = await call(routeCtx(sql), "GET", {}, "s1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it("empty store → inFlightCount 0, empty byStage", async () => {
    const sql = stubSql({ inFlight: [], byStage: [] });
    const res = await call(routeCtx(sql), "GET", { "x-user-login": "alice" });
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.inFlight).toEqual([]);
    expect(data.inFlightCount).toBe(0);
    expect(data.byStage).toEqual([]);
  });

  it("query failure → 500 coded outcome from the catalog, no raw store error", async () => {
    const sql = stubSql({ throws: true });
    const res = await call(routeCtx(sql), "GET", { "x-user-login": "alice" });
    expect(res!.status).toBe(500);
    const data = (await res!.json()) as any;
    expect(data.code).toBe("FAILURE_PROMOTIONS_ACTIVE_CHECK_QUERY");
    // The message comes FROM the catalog, not from the handler (#2573).
    expect(data.error).toBe(codedMessage("FAILURE_PROMOTIONS_ACTIVE_CHECK_QUERY"));
    expect(JSON.stringify(data)).not.toContain("no such table");
  });

  it("POST to the path matches no route (GET-only, no widening)", async () => {
    const sql = stubSql();
    const res = await call(routeCtx(sql), "POST", { "x-user-login": "alice" });
    expect(res).toBeNull();
    expect(sql.issued).toEqual([]);
  });
});
