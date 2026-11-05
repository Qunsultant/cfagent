/**
 * Issue #359-15: characterization for the screener + research route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/screenerResearch.ts - the matching order in routeRequest
 * is load-bearing, so the module must match the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the single delegation
 * call site in orchestrator.ts, at the exact original position (after the
 * market-data compare/screen delegation, before the task schedules block); (c)
 * behavior with mocked orchestrator helpers passed through the context:
 * owned paths return a Response (200 / 400 / 404 / 503 exactly as before),
 * non-owned paths return null (the orchestrator keeps routing) - the
 * handler ends with an explicit `return null`, never undefined (slice
 * #359-08 caught a missing-return-null bug on exactly this); (d) the #308
 * canonical seam stays orchestrator-owned: runResearchAndPublish arrives
 * via the context and is invoked with identical arguments (trigger source +
 * userLogin); the scheduled-tick guard keeps its write-after-success
 * mas_settings semantics; (e) the research trigger imports
 * (triggerManualResearch/triggerScheduledResearch, shouldFireResearchTick,
 * RESEARCH_SCHEDULED_LAST_RUN_KEY) moved WITH the blocks out of
 * orchestrator.ts.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The delegation's lower bound (preceding position) anchors to the
 * handleMarketDataCompareScreenRoutes(...) delegation call - the reciprocal note
 * slice #359-14 left in tests/market_data_research_routes_extraction.test.ts. The
 * upper bound (the task schedules block) is NOT asserted here: it is slice
 * #359-16's domain and still inline; slice #379 must anchor its schedules
 * delegation's lower bound to the handleScreenerResearchRoutes(...)
 * delegation call when it extracts that block (reciprocal of this note).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/services/researchScheduleGuard", () => ({
  shouldFireResearchTick: vi.fn(),
  RESEARCH_SCHEDULED_LAST_RUN_KEY: "research:scheduled-last-run",
}));

import { shouldFireResearchTick } from "../src/services/researchScheduleGuard";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (
  overrides: Partial<ScreenerResearchRouteContext> = {}
): ScreenerResearchRouteContext =>
  ({
    getScreenerAgent: vi.fn(),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "test_user" })),
    getResearchAgent: vi.fn(),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    readSettingRaw: vi.fn(() => null),
    writeSetting: vi.fn(),
    ...overrides,
  }) as unknown as ScreenerResearchRouteContext;

const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("screener + research route inventory (extraction #378)", () => {
  it("the route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/screenerResearch.ts");
    const markers = [
      'path.endsWith("/screener/latest") && request.method === "GET"',
      'path.endsWith("/screener/report.pdf") && request.method === "GET"',
      'path.endsWith("/options/report.pdf") && request.method === "GET"',
      'path.endsWith("/research/run") && request.method === "POST"',
      'path.endsWith("/research/scheduled-tick") && request.method === "POST"',
      'path.endsWith("/research/latest") && request.method === "GET"',
      'path.endsWith("/research/history") && request.method === "GET"',
      'path.endsWith("/research/settings") && request.method === "GET"',
      'path.endsWith("/research/settings") && request.method === "POST"',
      'path.endsWith("/research/evaluate") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker, last + 1);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; one delegation stands at the original position", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleScreenerResearchRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'path.endsWith("/screener/latest")',
      'path.endsWith("/screener/report.pdf")',
      'path.endsWith("/options/report.pdf")',
      'path.endsWith("/research/run")',
      'path.endsWith("/research/scheduled-tick")',
      'path.endsWith("/research/latest")',
      'path.endsWith("/research/history")',
      'path.endsWith("/research/settings")',
      'path.endsWith("/research/evaluate")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The research trigger imports moved with the blocks.
    expect(orchSrc).not.toContain("triggerManualResearch");
    expect(orchSrc).not.toContain("triggerScheduledResearch");
    expect(orchSrc).not.toContain("RESEARCH_SCHEDULED_LAST_RUN_KEY");
    expect(orchSrc).not.toContain("shouldFireResearchTick");
    // The delegation is invoked after the market-data compare/screen delegation
    // (slice #359-14's reciprocal note: anchor to the delegation call).
    const compareScreenIdx = dispatchSrc.indexOf("handleMarketDataCompareScreenRoutes(request, url, path, sessionId,");
    const mineIdx = dispatchSrc.indexOf("handleScreenerResearchRoutes(request, url, path, sessionId,");
    expect(compareScreenIdx, "market-data screening delegation must exist").toBeGreaterThan(-1);
    expect(mineIdx, "screener/research delegation must exist").toBeGreaterThan(-1);
    expect(mineIdx, "delegation must come after the market-data screening delegation").toBeGreaterThan(compareScreenIdx);
    // Context wiring is present: orchestrator-owned helpers arrive via the object.
    expect(dispatchSrc).toContain("getScreenerAgent: (userLogin?: string) => deps.getScreenerAgent(userLogin)");
    expect(dispatchSrc).toContain("runResearchAndPublish: (trigger, userLogin) => deps.runResearchAndPublish(trigger, userLogin)");
    expect(dispatchSrc).toContain("if (screenerResearchResponse) return screenerResearchResponse;");
  });

  it("the module ends its handler with an explicit return null for non-owned paths", () => {
    const moduleSrc = src("agents/routes/screenerResearch.ts");
    expect(moduleSrc).toContain("return null;");
  });
});

describe("screener + research behavior (extraction #378)", () => {
  it("returns null for paths it does not own", async () => {
    const res = await handleScreenerResearchRoutes(req("GET", "/nope"), urlOf("/nope"), "/nope", "s1", baseCtx());
    expect(res).toBeNull();
    const res2 = await handleScreenerResearchRoutes(req("POST", "/screener/latest"), urlOf("/screener/latest"), "/screener/latest", "s1", baseCtx());
    expect(res2).toBeNull(); // wrong method -> not owned
  });

  it("GET /screener/latest returns history through the ScreenerAgent", async () => {
    const agent = {
      getLatest: vi.fn(async () => ({ runId: "r1" })),
      getHistory: vi.fn(async () => [{ runId: "r1" }]),
    };
    const ctx = baseCtx({ getScreenerAgent: vi.fn(() => agent as any) });
    const res = await handleScreenerResearchRoutes(req("GET", "/screener/latest"), urlOf("/screener/latest"), "/screener/latest", "s1", ctx);
    expect(res).not.toBeNull();
    const body = await (res as Response).json();
    expect(body.count).toBe(1);
    expect(body.latest).toEqual({ runId: "r1" });
    expect(agent.getLatest).toHaveBeenCalled();
    expect(agent.getHistory).toHaveBeenCalled();
  });

  it("GET /screener/report.pdf returns 404 when no report exists, 200 PDF bytes when it does", async () => {
    const missing = baseCtx({ getScreenerAgent: vi.fn(() => ({ getLatestPdf: async () => null }) as any) });
    const res404 = await handleScreenerResearchRoutes(req("GET", "/screener/report.pdf"), urlOf("/screener/report.pdf"), "/screener/report.pdf", "s1", missing);
    expect((res404 as Response).status).toBe(404);
    const pdf = { bytes: new Uint8Array([37, 80, 68, 70]), fileName: "screener.pdf" };
    const found = baseCtx({ getScreenerAgent: vi.fn(() => ({ getLatestPdf: async () => pdf }) as any) });
    const res200 = await handleScreenerResearchRoutes(req("GET", "/screener/report.pdf"), urlOf("/screener/report.pdf"), "/screener/report.pdf", "s1", found);
    expect((res200 as Response).status).toBe(200);
    expect((res200 as Response).headers.get("content-type")).toBe("application/pdf");
    expect((res200 as Response).headers.get("content-disposition")).toContain("screener.pdf");
  });

  it("GET /options/report.pdf looks up the keyed options PDF through the ScreenerAgent", async () => {
    const getOptionsPdfByKey = vi.fn(async (k: string) => ({ bytes: new Uint8Array([1]), fileName: `${k}.pdf` }));
    const ctx = baseCtx({ getScreenerAgent: vi.fn(() => ({ getOptionsPdfByKey } as any)) });
    const path = "/options/report.pdf?key=abc123";
    const res = await handleScreenerResearchRoutes(req("GET", path), urlOf(path), "/options/report.pdf", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(getOptionsPdfByKey).toHaveBeenCalledWith("abc123");
  });

  it("POST /research/run triggers the orchestrator-owned pipeline with the manual trigger", async () => {
    const runResearchAndPublish = vi.fn(async () => ({ success: true, reportId: "rep-1" }));
    const ctx = baseCtx({ runResearchAndPublish: runResearchAndPublish as any });
    const res = await handleScreenerResearchRoutes(req("POST", "/research/run"), urlOf("/research/run"), "/research/run", "sess-9", ctx);
    expect((res as Response).status).toBe(200);
    expect(runResearchAndPublish).toHaveBeenCalledWith("manual", "sess-9");
    expect(await (res as Response).json()).toEqual({ success: true, reportId: "rep-1" });
  });

  it("POST /research/run uses x-user-login when present", async () => {
    const runResearchAndPublish = vi.fn(async () => ({ success: true }));
    const ctx = baseCtx({ runResearchAndPublish: runResearchAndPublish as any });
    const res = await handleScreenerResearchRoutes(
      req("POST", "/research/run", undefined, { "x-user-login": "trader42" }),
      urlOf("/research/run"),
      "/research/run",
      "sess-9",
      ctx
    );
    expect((res as Response).status).toBe(200);
    expect(runResearchAndPublish).toHaveBeenCalledWith("manual", "trader42");
  });

  it("POST /research/scheduled-tick skips without running when the guard says no", async () => {
    (shouldFireResearchTick as any).mockReturnValue({ fire: false, reason: "already-ran", dateKey: "2026-10-19" });
    const runResearchAndPublish = vi.fn();
    const writeSetting = vi.fn();
    const ctx = baseCtx({ runResearchAndPublish: runResearchAndPublish as any, writeSetting });
    // Issue #2327: the tick request carries the identity header
    // server.ts asserts (the service identity); a header-less tick
    // is refused 401 before the guard is ever consulted.
    const res = await handleScreenerResearchRoutes(req("POST", "/research/scheduled-tick", undefined, { "x-user-login": "cronbot" }), urlOf("/research/scheduled-tick"), "/research/scheduled-tick", "s1", ctx);
    const body = await (res as Response).json();
    expect(body.skipped).toBe(true);
    expect(runResearchAndPublish).not.toHaveBeenCalled();
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("POST /research/scheduled-tick runs and writes the guard only after a successful run", async () => {
    (shouldFireResearchTick as any).mockReturnValue({ fire: true, dateKey: "2026-10-19" });
    const runResearchAndPublish = vi.fn(async () => ({ success: true }));
    const writeSetting = vi.fn();
    const ctx = baseCtx({ runResearchAndPublish: runResearchAndPublish as any, writeSetting });
    const res = await handleScreenerResearchRoutes(
      req("POST", "/research/scheduled-tick", undefined, { "x-user-login": "cronbot" }),
      urlOf("/research/scheduled-tick"),
      "/research/scheduled-tick",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(200);
    expect(runResearchAndPublish).toHaveBeenCalledWith("scheduled", "cronbot");
    expect(writeSetting).toHaveBeenCalledWith("research:scheduled-last-run", "2026-10-19");
  });

  it("GET /research/latest returns a null latest when no agent is configured", async () => {
    const ctx = baseCtx({ getResearchAgent: vi.fn(() => null) });
    const res = await handleScreenerResearchRoutes(req("GET", "/research/latest"), urlOf("/research/latest"), "/research/latest", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ latest: null });
  });

  it("GET /research/settings returns 503 when the ResearchAgent binding is missing", async () => {
    const ctx = baseCtx({ getResearchAgent: vi.fn(() => null) });
    const res = await handleScreenerResearchRoutes(req("GET", "/research/settings"), urlOf("/research/settings"), "/research/settings", "s1", ctx);
    expect((res as Response).status).toBe(503);
  });

  it("POST /research/settings saves through the agent", async () => {
    const saveConfig = vi.fn(async (p: any) => ({ ok: true, saved: p }));
    const ctx = baseCtx({ getResearchAgent: vi.fn(() => ({ saveConfig }) as any) });
    const res = await handleScreenerResearchRoutes(req("POST", "/research/settings", { pmccEnabled: false }), urlOf("/research/settings"), "/research/settings", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith({ pmccEnabled: false });
  });

  it("POST /research/evaluate requires runId and otherwise returns the evaluation", async () => {
    const evaluateRun = vi.fn(async () => ({ score: 0.9 }));
    const ctx = baseCtx({ getResearchAgent: vi.fn(() => ({ evaluateRun }) as any) });
    const bad = await handleScreenerResearchRoutes(req("POST", "/research/evaluate", {}), urlOf("/research/evaluate"), "/research/evaluate", "s1", ctx);
    expect((bad as Response).status).toBe(400);
    const good = await handleScreenerResearchRoutes(req("POST", "/research/evaluate", { runId: "r1" }), urlOf("/research/evaluate"), "/research/evaluate", "s1", ctx);
    expect((good as Response).status).toBe(200);
    expect(await (good as Response).json()).toEqual({ evaluation: { score: 0.9 } });
    expect(evaluateRun).toHaveBeenCalledWith("r1", "s1");
  });
});
