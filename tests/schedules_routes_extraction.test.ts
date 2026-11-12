/**
 * Issue #359-16: characterization for the schedules route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler
 * in src/agents/routes/schedules.ts - the matching order in routeRequest
 * is load-bearing, so the module must match the (path, method) pairs in
 * the same sequence as the original inline block; (b) the single
 * delegation call site in orchestrator.ts, at the exact original position
 * (after the handleScreenerResearchRoutes delegation, before
 * routeRequest's Not-found fallthrough); (c) behavior with mocked
 * orchestrator helpers passed through the context: owned paths return a
 * Response (200 / 400 / 401 / 404 / 503 exactly as before), non-owned
 * paths return null (the orchestrator keeps routing) - the handler ends
 * with an explicit `return null`, never undefined (slice #359-08 caught a
 * missing-return-null bug on exactly this); (d) the SDK scheduling port
 * and the #111 callback allow-list arrive via the context - the
 * allow-list constants stay module-owned by orchestrator.ts
 * (CREATABLE_SCHEDULE_CALLBACKS is a public export there) and the moved
 * imports (resolveEnvironmentConfig, getStoredTokens, isTokenExpiredEt,
 * runStorageRetention, UNIVERSES) left orchestrator.ts with the block;
 * (e) schedule lifecycle audit events stay funneled through the
 * single-owner audit() via the context.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The delegation's lower bound (preceding position) anchors to
 * the handleScreenerResearchRoutes(...) delegation call - the reciprocal
 * note slice #359-15 left in
 * tests/screener_research_routes_extraction.test.ts. The upper bound is
 * routeRequest's own Not-found fallthrough, the terminus of the
 * sequential chain (this block was the last one before it).
 *
 * The deep create-route behavior (#111 honesty, #447/#461 account
 * stamping) stays pinned by tests/schedules_create_route.test.ts, which
 * drives the real OrchestratorAgent routeRequest; this file pins the
 * module boundary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/services/auditTamperAlert", () => ({
  verifyStoredAuditChainAndAlert: vi.fn(() => ({
    valid: true,
    brokenIndex: null,
    reason: null,
    alertRecorded: false,
  })),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { runStorageRetention } from "../src/security/storageRetention";
import { verifyStoredAuditChainAndAlert } from "../src/services/auditTamperAlert";
import { getStoredTokens } from "../src/security/etradeOAuth";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

/**
 * node:sqlite double for the SqlStorage seam (same shape as #2964 /
 * the #3123 pins). The routes read the unified store through
 * `ctx.agentCtx.storage.sql` — production DOs always carry a real
 * SqlStorage, so the fake carries a real one too; the old `{}` stub
 * made every store touch throw `sql.exec is not a function`.
 */
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

const baseCtx = (
  overrides: Partial<SchedulesRouteContext> = {}
): SchedulesRouteContext =>
  ({
    env: {},
    agentCtx: { storage: { sql: new SqliteTestStorage() } },
    audit: vi.fn(),
    listSchedules: vi.fn(async () => []),
    cancelSchedule: vi.fn(async () => true),
    getScheduleById: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ id: "sched-1" })),
    scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
    getScreenerExecutionContext: vi.fn(async () => undefined),
    getOrm: vi.fn(() => ({})),
    autonomousMarketScreen: vi.fn(async () => undefined),
    autoRenewETradeTokens: vi.fn(async () => undefined),
    creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen"],
    accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen"]),
    ...overrides,
  }) as unknown as SchedulesRouteContext;

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

describe("schedules route inventory (extraction #379)", () => {
  it("the route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/schedules.ts");
    const markers = [
      'path.endsWith("/schedules")',
      'path.endsWith("/api/schedules")',
      'path === "/schedules"',
      'path === "/api/schedules"',
      'path.endsWith("/schedules/cancel")',
      'path.includes("/schedules/cancel/")',
      'path.includes("/schedules/")', // cancel via DELETE branch
      'path.includes("/schedules/")', // get-by-id
      'path.endsWith("/schedules/create")',
      'path.endsWith("/schedules") && request.method === "POST"',
      'path.endsWith("/schedules/trigger-screen")',
      'path.endsWith("/schedules/trigger-renew")',
      'path.endsWith("/schedules/trigger-options-analysis")',
      'path.endsWith("/schedules/trigger-retention")',
      'path.endsWith("/schedules/trigger-iv-collection")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker, last + 1);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline block is gone from orchestrator.ts; one delegation stands at the original position", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleSchedulesRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'path.endsWith("/schedules/cancel")',
      'path.endsWith("/schedules/create")',
      'path.endsWith("/schedules/trigger-screen")',
      'path.endsWith("/schedules/trigger-renew")',
      'path.endsWith("/schedules/trigger-options-analysis")',
      'path.endsWith("/schedules/trigger-retention")',
      'path.endsWith("/schedules/trigger-iv-collection")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The block's imports moved with it.
    expect(orchSrc).not.toContain("resolveEnvironmentConfig");
    expect(orchSrc).not.toContain("getStoredTokens");
    expect(orchSrc).not.toContain("isTokenExpiredEt");
    expect(orchSrc).not.toContain("runStorageRetention");
    expect(orchSrc).not.toContain("UNIVERSES");
    // The #111 allow-list constants moved with the dispatcher by #2942:
    // their definition lives in src/agents/orchestrator/scheduleCallbacks.ts
    // (CREATABLE_SCHEDULE_CALLBACKS stays a public export of orchestrator.ts
    // via re-export) and they are wired into the delegation context.
    expect(src("agents/orchestrator/scheduleCallbacks.ts")).toContain("export const CREATABLE_SCHEDULE_CALLBACKS");
    expect(orchSrc).toContain("export { CREATABLE_SCHEDULE_CALLBACKS");
    expect(dispatchSrc).toContain("creatableScheduleCallbacks: CREATABLE_SCHEDULE_CALLBACKS");
    expect(dispatchSrc).toContain("accountScopedScheduleCallbacks: ACCOUNT_SCOPED_SCHEDULE_CALLBACKS");
    // The delegation is invoked after the screener + research delegation
    // (slice #359-15's reciprocal note: anchor to the delegation call) and
    // before routeRequest's Not-found fallthrough.
    const prevIdx = dispatchSrc.indexOf("handleScreenerResearchRoutes(request, url, path, sessionId,");
    const mineIdx = dispatchSrc.indexOf("handleSchedulesRoutes(request, url, path, sessionId,");
    const fallIdx = dispatchSrc.indexOf('return new Response("Not found", { status: 404 });');
    expect(prevIdx, "screener/research delegation must exist").toBeGreaterThan(-1);
    expect(mineIdx, "schedules delegation must exist").toBeGreaterThan(-1);
    expect(mineIdx, "delegation must come after the screener/research delegation").toBeGreaterThan(prevIdx);
    expect(fallIdx, "Not-found fallthrough must exist").toBeGreaterThan(-1);
    expect(mineIdx, "delegation must come before the Not-found fallthrough").toBeLessThan(fallIdx);
    // Context wiring is present: orchestrator-owned helpers arrive via the object.
    expect(dispatchSrc).toContain("listSchedules: (criteria) => deps.listSchedules(criteria)");
    expect(dispatchSrc).toContain("getOrm: () => deps.getOrm()");
    expect(dispatchSrc).toContain("if (schedulesResponse) return schedulesResponse;");
  });

  it("the module ends its handler with an explicit return null for non-owned paths", () => {
    const moduleSrc = src("agents/routes/schedules.ts");
    expect(moduleSrc).toContain("return null;");
  });
});

describe("schedules behavior (extraction #379)", () => {
  it("returns null for paths it does not own", async () => {
    const res = await handleSchedulesRoutes(req("GET", "/nope"), urlOf("/nope"), "/nope", "s1", baseCtx());
    expect(res).toBeNull();
    const res2 = await handleSchedulesRoutes(req("DELETE", "/schedules"), urlOf("/schedules"), "/schedules", "s1", baseCtx());
    expect(res2).toBeNull(); // DELETE without an id segment -> not owned
  });

  it("GET /schedules lists through the SDK port and passes the type filter", async () => {
    // Rows carry the timing type: the unified list (#3123) filters
    // the merged alarms + records AFTER the port call, so a typeless
    // row would not survive ?type=cron.
    const rows = [
      { id: "a", type: "cron", callback: "autonomousMarketScreen" },
      { id: "b", type: "cron", callback: "autonomousMarketScreen" },
    ];
    const listSchedules = vi.fn(async () => rows);
    const ctx = baseCtx({ listSchedules: listSchedules as any });
    const res = await handleSchedulesRoutes(req("GET", "/schedules?type=cron"), urlOf("/schedules?type=cron"), "/schedules", "s1", ctx);
    expect((res as Response).status).toBe(200);
    // The alarms port lists all; the type filter is applied by the
    // unified list (it must cover records too, which the SDK port
    // cannot see) — so the port is called with no arguments.
    expect(listSchedules).toHaveBeenCalledWith();
    const body = await (res as Response).json();
    expect(body.count).toBe(2);
    expect(body.schedules.map((s: any) => s.id)).toEqual(["a", "b"]);
    expect(body.schedules.every((s: any) => s.type === "cron")).toBe(true);
  });

  it("GET /schedules surfaces a listing failure as a 500, never an empty 200 (#108)", async () => {
    const ctx = baseCtx({ listSchedules: vi.fn(async () => { throw new Error("binding down"); }) as any });
    const res = await handleSchedulesRoutes(req("GET", "/schedules"), urlOf("/schedules"), "/schedules", "s1", ctx);
    expect((res as Response).status).toBe(500);
    const body = await (res as Response).json();
    expect(body.error).toBe("binding down");
    expect(body.schedules).toEqual([]);
  });

  it("POST /schedules/cancel cancels via the port and audits schedule.cancelled", async () => {
    const cancelSchedule = vi.fn(async () => true);
    const audit = vi.fn();
    const ctx = baseCtx({ cancelSchedule: cancelSchedule as any, audit: audit as any });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/cancel", { scheduleId: "sch-9" }), urlOf("/schedules/cancel"), "/schedules/cancel", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(cancelSchedule).toHaveBeenCalledWith("sch-9");
    expect(audit).toHaveBeenCalledWith("schedule.cancelled", "orchestrator", { scheduleId: "sch-9", success: true });
    expect(await (res as Response).json()).toEqual({ scheduleId: "sch-9", cancelled: true });
  });

  it("DELETE /schedules/:id takes the id from the path", async () => {
    const cancelSchedule = vi.fn(async () => false);
    const ctx = baseCtx({ cancelSchedule: cancelSchedule as any });
    const res = await handleSchedulesRoutes(req("DELETE", "/schedules/sch-7"), urlOf("/schedules/sch-7"), "/schedules/sch-7", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(cancelSchedule).toHaveBeenCalledWith("sch-7");
    // With no body id and no path id, the original derivation falls back to
    // path.split("/schedules/")[1] - the literal "cancel" - so the 400
    // branch is not reachable through this route's own spellings (quirk
    // of the original code, pinned as-is).
    cancelSchedule.mockClear();
    const noId = await handleSchedulesRoutes(req("POST", "/schedules/cancel", {}), urlOf("/schedules/cancel"), "/schedules/cancel", "s1", ctx);
    expect((noId as Response).status).toBe(200);
    expect(cancelSchedule).toHaveBeenCalledWith("cancel");
  });

  it("GET /schedules/:id returns the schedule or a 404", async () => {
    const found = baseCtx({ getScheduleById: vi.fn(async () => ({ id: "sch-3" })) as any });
    const res = await handleSchedulesRoutes(req("GET", "/schedules/sch-3"), urlOf("/schedules/sch-3"), "/schedules/sch-3", "s1", found);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ id: "sch-3" });
    const missing = await handleSchedulesRoutes(req("GET", "/schedules/nope"), urlOf("/schedules/nope"), "/schedules/nope", "s1", baseCtx());
    expect((missing as Response).status).toBe(404);
  });

  it("POST /schedules/create rejects callbacks outside the #111 allow-list", async () => {
    const scheduleEvery = vi.fn();
    const ctx = baseCtx({ scheduleEvery: scheduleEvery as any });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/create", { callback: "executeAsyncJob", scheduleType: "interval", intervalSeconds: 60 }),
      urlOf("/schedules/create"),
      "/schedules/create",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(400);
    expect(scheduleEvery).not.toHaveBeenCalled();
  });

  it("POST /schedules/create requires stored E*TRADE tokens for account-scoped callbacks (409)", async () => {
    (getStoredTokens as any).mockResolvedValue(null);
    const scheduleEvery = vi.fn();
    const ctx = baseCtx({
      scheduleEvery: scheduleEvery as any,
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader1", environment: "PROD" as const })),
    });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/create", { callback: "autonomousMarketScreen", scheduleType: "interval", intervalSeconds: 60, payload: { universe: "NASDAQ100" } }),
      urlOf("/schedules/create"),
      "/schedules/create",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(409);
    expect(scheduleEvery).not.toHaveBeenCalled();
  });

  it("POST /schedules/create surfaces an SDK throw as the honest 503, never a fabricated id (#111)", async () => {
    (getStoredTokens as any).mockResolvedValue({ storedAt: new Date().toISOString(), userLogin: "trader1" });
    const scheduleEvery = vi.fn(async () => { throw new Error("sdk down"); });
    const ctx = baseCtx({
      scheduleEvery: scheduleEvery as any,
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader1", environment: "PROD" as const })),
    });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/create", { callback: "autonomousMarketScreen", scheduleType: "interval", intervalSeconds: 60, payload: { universe: "NASDAQ100" } }),
      urlOf("/schedules/create"),
      "/schedules/create",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(503);
    const body = await (res as Response).json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("sdk down");
  });

  it("POST /schedules/create arms an interval schedule through the SDK port and audits schedule.created", async () => {
    (getStoredTokens as any).mockResolvedValue({ storedAt: new Date().toISOString(), userLogin: "trader1" });
    const scheduleEvery = vi.fn(async () => ({ id: "real-sdk-id" }));
    const audit = vi.fn();
    const ctx = baseCtx({
      scheduleEvery: scheduleEvery as any,
      audit: audit as any,
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader1", environment: "PROD" as const })),
    });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/create", { callback: "autonomousMarketScreen", scheduleType: "interval", intervalSeconds: 60, payload: { universe: "NASDAQ100" } }),
      urlOf("/schedules/create"),
      "/schedules/create",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(200);
    expect(scheduleEvery).toHaveBeenCalledWith(60, "autonomousMarketScreen", expect.objectContaining({ universe: "NASDAQ100", trigger: "scheduled", userLogin: "trader1" }));
    expect(audit).toHaveBeenCalledWith("schedule.created", "orchestrator", expect.objectContaining({ scheduleId: "real-sdk-id", callback: "autonomousMarketScreen" }));
    expect(await (res as Response).json()).toEqual({ success: true, schedule: { id: "real-sdk-id" } });
  });

  it("POST /schedules/trigger-screen runs the manual screen with the manual trigger stamp", async () => {
    const autonomousMarketScreen = vi.fn(async () => undefined);
    const ctx = baseCtx({ autonomousMarketScreen: autonomousMarketScreen as any });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/trigger-screen", { universe: "SP500" }, { "x-user-login": "trader1", "x-environment": "TEST" }),
      urlOf("/schedules/trigger-screen"),
      "/schedules/trigger-screen",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(200);
    expect(autonomousMarketScreen).toHaveBeenCalledWith({ universe: "SP500", userLogin: "trader1", environment: "TEST", trigger: "manual" });
  });

  it("POST /schedules/trigger-renew requires an authenticated account (401) and otherwise renews", async () => {
    const denied = await handleSchedulesRoutes(req("POST", "/schedules/trigger-renew"), urlOf("/schedules/trigger-renew"), "/schedules/trigger-renew", "s1", baseCtx());
    expect((denied as Response).status).toBe(401);
    const autoRenewETradeTokens = vi.fn(async () => undefined);
    const ctx = baseCtx({ autoRenewETradeTokens: autoRenewETradeTokens as any });
    const res = await handleSchedulesRoutes(
      req("POST", "/schedules/trigger-renew", undefined, { "x-user-login": "trader1" }),
      urlOf("/schedules/trigger-renew"),
      "/schedules/trigger-renew",
      "s1",
      ctx
    );
    expect((res as Response).status).toBe(200);
    expect(autoRenewETradeTokens).toHaveBeenCalledWith({ userLogin: "trader1", env: undefined });
  });

  it("POST /schedules/trigger-options-analysis delegates to ScheduledTasksService", async () => {
    const autonomousOptionsAnalysis = vi.fn(async () => ({ success: true, runs: 1 }));
    (ScheduledTasksService as any).mockImplementation(function () { return { autonomousOptionsAnalysis }; });
    const ctx = baseCtx({ getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader1", environment: "TEST" as const })) });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/trigger-options-analysis", { maxItems: 5 }), urlOf("/schedules/trigger-options-analysis"), "/schedules/trigger-options-analysis", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ success: true, runs: 1 });
    expect(autonomousOptionsAnalysis).toHaveBeenCalledWith({ maxItems: 5, userLogin: "trader1", environment: "TEST", trigger: "manual" });
  });

  it("POST /schedules/trigger-retention runs the retention pass over the ORM", async () => {
    (runStorageRetention as any).mockReturnValue({ deleted: 4, retentionDays: 90 });
    const getOrm = vi.fn(() => ({ tag: "orm" }));
    const ctx = baseCtx({ getOrm: getOrm as any });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/trigger-retention"), urlOf("/schedules/trigger-retention"), "/schedules/trigger-retention", "s1", ctx);
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as Record<string, unknown>;
    // #2294: the pass also reports the outcome-feed prune (0 on an empty table).
    expect(body).toMatchObject({ success: true, deleted: 4, retentionDays: 90 });
    expect(typeof body.jobOutcomesPruned).toBe("number");
    expect(runStorageRetention).toHaveBeenCalledWith({ tag: "orm" }, { retentionDays: undefined });
  });

  it("POST /schedules/trigger-retention reports a valid chain verification and prunes (#3156)", async () => {
    (runStorageRetention as any).mockReturnValue({ deleted: 4, retentionDays: 90 });
    const getOrm = vi.fn(() => ({ tag: "orm" }));
    const ctx = baseCtx({ getOrm: getOrm as any });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/trigger-retention"), urlOf("/schedules/trigger-retention"), "/schedules/trigger-retention", "s1", ctx);
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as Record<string, unknown>;
    expect(body.auditChainPruneSkipped).toBe(false);
    expect(body.auditChainVerification).toMatchObject({ valid: true, alertRecorded: false });
    expect(runStorageRetention).toHaveBeenCalled();
  });

  it("POST /schedules/trigger-retention SKIPS pruning on a failed chain verification (#3156)", async () => {
    (verifyStoredAuditChainAndAlert as any).mockReturnValueOnce({
      valid: false,
      brokenIndex: 2,
      reason: "eventHash recomputation mismatch (row payload modified)",
      alertRecorded: true,
      alertId: "tamper_ab12cd34",
    });
    const getOrm = vi.fn(() => ({ tag: "orm" }));
    const ctx = baseCtx({ getOrm: getOrm as any });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/trigger-retention"), urlOf("/schedules/trigger-retention"), "/schedules/trigger-retention", "s1", ctx);
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as Record<string, unknown>;
    // The run completes (sweep/snapshot still report), but the
    // mas_events prune is skipped to preserve tamper evidence.
    expect(body.auditChainPruneSkipped).toBe(true);
    expect(body.auditChainVerification).toMatchObject({
      valid: false,
      brokenIndex: 2,
      alertRecorded: true,
      alertId: "tamper_ab12cd34",
    });
    expect(runStorageRetention).not.toHaveBeenCalled();
  });

  it("POST /schedules/trigger-iv-collection requires auth (401) and otherwise collects via the service", async () => {
    const denied = await handleSchedulesRoutes(req("POST", "/schedules/trigger-iv-collection", {}), urlOf("/schedules/trigger-iv-collection"), "/schedules/trigger-iv-collection", "s1", baseCtx());
    expect((denied as Response).status).toBe(401);
    const collectDailyIvHistory = vi.fn(async () => ({ success: true, symbols: 3 }));
    (ScheduledTasksService as any).mockImplementation(function () { return { collectDailyIvHistory }; });
    const ctx = baseCtx({ getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "trader1", environment: "PROD" as const })) });
    const res = await handleSchedulesRoutes(req("POST", "/schedules/trigger-iv-collection", { symbols: ["SPY"] }), urlOf("/schedules/trigger-iv-collection"), "/schedules/trigger-iv-collection", "s1", ctx);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ success: true, symbols: 3 });
    expect(collectDailyIvHistory).toHaveBeenCalledWith({ symbols: ["SPY"], userLogin: "trader1", environment: "PROD" });
  });
});
