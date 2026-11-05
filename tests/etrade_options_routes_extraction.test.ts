/**
 * Issue #359-11: characterization for the E*TRADE options route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/etradeOptions.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the single delegation
 * call site in orchestrator.ts, at the exact original position (after the
 * E*TRADE broker account-activity delegation, before the watchlists block);
 * (c) the #314 single-owner handleOptionsStrategyRecommend moved here with
 * its block (it is called only by the two strategy routes this module owns);
 * (d) behavior with a mock context: owned paths return a Response, non-owned
 * paths return null (the orchestrator keeps routing) — the handler ends with
 * an explicit `return null`, never undefined (slice #359-08 caught a
 * missing-return-null bug on exactly this).
 *
 * The requestedEnv binding stays inline in routeRequest (shared with the
 * still-inline watchlists block) and is passed through the context.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The upper bound anchors to the slice-12 watchlists delegation call
 * (this slice already performed slice #359-09's requested swap: the options
 * banner anchor became this module's delegation call).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleEtradeOptionsRoutes,
  handleOptionsStrategyRecommend,
  type EtradeOptionsRouteContext,
} from "../src/agents/routes/etradeOptions";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<EtradeOptionsRouteContext> = {}): EtradeOptionsRouteContext =>
  ({
    env: {} as any,
    getOrm: () => {
      throw new Error("boom");
    },
    agentCtx: {} as any,
    ensureTables: () => ({} as any),
    requestedEnv: undefined,
    ...overrides,
  }) as EtradeOptionsRouteContext;

// Issue #1185: requests model the production session gate (x-user-login
// is set by src/server.ts from the verified session; handlers fail closed
// without it).
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { "x-user-login": "alice", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("E*TRADE options route inventory (extraction #374)", () => {
  it("the options route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/etradeOptions.ts");
    // Sequential search: duplicate conditions (profiles GET/POST)
    // must appear in their original relative order too.
    const markers = [
      'path.endsWith("/etrade/options/chains")',
      'path.endsWith("/etrade/options/strategy")',
      'path.endsWith("/etrade/options/expire-dates")',
      'path.endsWith("/etrade/options/scans") && request.method === "GET")',
      'path.endsWith("/etrade/options/scans/diff")',
      'path.endsWith("/etrade/options/iv-history")',
      'path.endsWith("/etrade/options/profiles") && request.method === "GET")',
      'path.endsWith("/etrade/options/profiles") && request.method === "POST")',
      'path.endsWith("/trading/options/llm-ideas")',
      'path.endsWith("/trading/options/compare")',
      'path.endsWith("/trading/options/recommend")',
      'path.endsWith("/trading/options/catalog")',
      'path.endsWith("/trading/options/strategies")',
      'path.endsWith("/trading/options/screen")',
      'path.endsWith("/trading/options/unified")',
      'path.endsWith("/trading/options/config")',
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
    expect(dispatchSrc).toContain("handleEtradeOptionsRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'path.endsWith("/etrade/options/chains")',
      'path.endsWith("/etrade/options/strategy")',
      'path.endsWith("/etrade/options/expire-dates")',
      'path.endsWith("/etrade/options/scans")',
      'path.endsWith("/etrade/options/iv-history")',
      'path.endsWith("/etrade/options/profiles")',
      'path.endsWith("/trading/options/llm-ideas")',
      'path.endsWith("/trading/options/compare")',
      'path.endsWith("/trading/options/recommend")',
      'path.endsWith("/trading/options/catalog")',
      'path.endsWith("/trading/options/strategies")',
      'path.endsWith("/trading/options/screen")',
      'path.endsWith("/trading/options/unified")',
      'path.endsWith("/trading/options/config")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The #314 single-owner handler moved with the block (not duplicated).
    expect(orchSrc).not.toContain("export async function handleOptionsStrategyRecommend");
    const moduleSrc = src("agents/routes/etradeOptions.ts");
    expect(moduleSrc).toContain("export async function handleOptionsStrategyRecommend");
    expect(moduleSrc).toContain("export async function handleEtradeOptionsRoutes");
    expect(moduleSrc).toContain("export interface EtradeOptionsRouteContext");
    // Single call site.
    const needle = "handleEtradeOptionsRoutes(request, url, path, sessionId,";
    expect(dispatchSrc.split(needle).length - 1, "expected exactly one call site").toBe(1);
    // The requestedEnv binding stays inline in routeRequest; the delegation
    // passes it through the context.
    // Issue #2482: it now resolves from the persisted selection, never
    // from the request header.
    expect(dispatchSrc).toContain("resolveBrokerEnvironmentFromSettings((key) => deps.readSettingRaw(key), deps.env)");
    expect(dispatchSrc).toContain("requestedEnv,");
  });

  it("the options delegation sits between the broker-activity delegation and the watchlists block", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const optionsIdx = dispatchSrc.indexOf("handleEtradeOptionsRoutes(request, url, path, sessionId,");
    // Lower bound: the broker-activity delegation call (slice #359-09), a
    // delegation-call anchor per the #405 rule.
    const activityIdx = dispatchSrc.indexOf("handleEtradeBrokerActivityRoutes(request, url, path, sessionId,");
    expect(activityIdx).toBeGreaterThan(-1);
    expect(optionsIdx, "options delegation must follow the broker-activity delegation").toBeGreaterThan(activityIdx);
    // Upper bound: the watchlists delegation call (slice #359-12 performed
    // this swap; delegation-call anchor per the #405 rule).
    const watchlistsIdx = dispatchSrc.indexOf("handleWatchlistsRoutes(request, url, path, sessionId,");
    expect(watchlistsIdx).toBeGreaterThan(-1);
    expect(optionsIdx, "options delegation must precede the watchlists delegation").toBeLessThan(watchlistsIdx);
  });

  it("the strategy routes delegate to the single-owner handler (both spellings)", () => {
    const moduleSrc = src("agents/routes/etradeOptions.ts");
    // The advertised /etrade/options/strategy spelling delegates to the same
    // handler as /trading/options/recommend — one logic owner.
    const strategyCall = "return handleOptionsStrategyRecommend(request,";
    const first = moduleSrc.indexOf(strategyCall);
    const second = moduleSrc.indexOf(strategyCall, first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second, "both strategy spellings must delegate to the single owner").toBeGreaterThan(first);
    expect(moduleSrc.indexOf(strategyCall, second + 1)).toBe(-1);
  });
});

describe("handleEtradeOptionsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(
      await handleEtradeOptionsRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleEtradeOptionsRoutes(req("POST", "/api/etrade/options/chains"), urlOf("/api/etrade/options/chains"), "/api/etrade/options/chains", "s", ctx)
    ).toBeNull();
    // Watchlist paths belong to the sibling slice, not this handler.
    expect(
      await handleEtradeOptionsRoutes(req("GET", "/api/etrade/watchlists"), urlOf("/api/etrade/watchlists"), "/api/etrade/watchlists", "s", ctx)
    ).toBeNull();
  });

  it("rejects an invalid llm-ideas symbol with 400 before touching backends", async () => {
    const ctx = baseCtx();
    const res = await handleEtradeOptionsRoutes(
      req("POST", "/api/trading/options/llm-ideas", { symbol: "!!!", question: "x" }),
      urlOf("/api/trading/options/llm-ideas"),
      "/api/trading/options/llm-ideas",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toMatch(/valid stock ticker/i);
  });

  it("rejects an invalid strategy request with 400 through the single-owner handler", async () => {
    // getOrm must not throw: the route builds the handler deps (incl. the
    // ORM) before the single-owner handler runs its pure validation.
    const ctx = baseCtx({ getOrm: () => ({} as any) });
    const res = await handleEtradeOptionsRoutes(
      req("POST", "/api/etrade/options/strategy", {}),
      urlOf("/api/etrade/options/strategy"),
      "/api/etrade/options/strategy",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toMatch(/strategy request/i);
  });

  it("the moved single-owner handler is importable and validates directly", async () => {
    const res = await handleOptionsStrategyRecommend(
      req("POST", "/api/trading/options/recommend", { symbol: 42 }),
      { orm: {} as any, env: {} as any, sessionKey: "s", requestedEnv: undefined }
    );
    expect(res.status).toBe(400);
  });
});
