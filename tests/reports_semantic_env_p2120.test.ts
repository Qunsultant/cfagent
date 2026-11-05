import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleReportsRoutes,
  type ReportsRouteContext,
} from "../src/agents/routes/reports";

/**
 * #2120 slice 0: Reports semantic-search env wiring.
 * Root cause: the reports-route mount in OrchestratorAgent.routeRequest
 * never passed `env`, so the GET /api/reports/semantic-search handler
 * read `(ctx as any).env || {}` and semanticSearchReports always saw
 * bindings-absent -> [] -> `semantic: false` (lexical-only).
 *
 * Pin roles, stated honestly (parent-corrected 2026-10-28: all three
 * pins fail on the pristine tree, for two different reasons):
 * - The mount pin fails on pristine because the mount block has no
 *   `env` — it is the env-wiring Red pin.
 * - The two route pins fail on pristine because the detail branch
 *   shadows the semantic branch (404 "Report not found" for id
 *   "semantic-search") before env ever matters — they are the
 *   shadowing Red pins, and post-fix they guard the wired behavior,
 *   the lexical half, and the `{}` fallback guard.
 */

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const LEX_ROW = {
  id: "r-lex",
  run_id: "run-1",
  title: "Bullish tech outlook",
  source: "screener",
  summary: "bullish tech summary",
  body: "bullish tech body",
  created_at: "2026-10-28T00:00:00Z",
  body_r2_key: null,
};

const makeSql = () => ({
  exec: (query: string, ...params: unknown[]) => {
    // Production-faithful: no report has id "semantic-search", so the
    // detail lookup misses; every other mas_reports query returns the row.
    if (params.includes("semantic-search")) return [];
    if (query.includes("mas_reports")) return [LEX_ROW];
    return [];
  },
});

const makeCtx = (env: unknown): ReportsRouteContext =>
  ({
    ensureTables: () => makeSql(),
    env,
  }) as unknown as ReportsRouteContext;

const semanticEnv = {
  AI: { run: async () => ({ data: [[0.1]] }) },
  VECTOR_MEMORY: {
    query: async () => ({
      matches: [{ metadata: { reportId: "r-sem" }, score: 0.9 }],
    }),
  },
};

const callRoute = (ctx: ReportsRouteContext) =>
  handleReportsRoutes(
    new Request("https://agent.internal/api/reports/semantic-search?q=bullish+tech", {
      method: "GET",
    }),
    new URL("https://agent.internal/api/reports/semantic-search?q=bullish+tech"),
    "/api/reports/semantic-search",
    "sess",
    ctx
  );

describe("#2120 slice 0 reports semantic env", () => {
  it("mount passes env through to the reports routes (Red pin)", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const start = dispatchSrc.indexOf("handleReportsRoutes(request, url, path, sessionId,");
    expect(start).toBeGreaterThan(-1);
    const end = dispatchSrc.indexOf("if (reportsResponse) return reportsResponse;", start);
    expect(end).toBeGreaterThan(start);
    const mountBlock = dispatchSrc.slice(start, end);
    expect(mountBlock).toContain("env: deps.env");
  });

  it("semantic route returns semantic:true with stubbed bindings through ctx.env", async () => {
    const res = await callRoute(makeCtx(semanticEnv));
    expect(res).not.toBeNull();
    const body = await (res as Response).json();
    expect(body.semantic).toBe(true);
    const ids = (body.hits as Array<{ reportId: string }>).map((h) => h.reportId);
    expect(ids).toContain("r-sem");
    expect(ids).toContain("r-lex");
  });

  it("lexical half is unchanged when bindings are absent ({} fallback guard)", async () => {
    const res = await callRoute(makeCtx({}));
    expect(res).not.toBeNull();
    const body = await (res as Response).json();
    expect(body.semantic).toBe(false);
    const ids = (body.hits as Array<{ reportId: string }>).map((h) => h.reportId);
    expect(ids).toEqual(["r-lex"]);
  });
});
