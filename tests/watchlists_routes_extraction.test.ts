/**
 * Issue #359-12: characterization for the E*TRADE watchlists route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handler in
 * src/agents/routes/watchlists.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the (path, method) pairs in the
 * same sequence as the original inline blocks; (b) the single delegation
 * call site in orchestrator.ts, at the exact original position (after the
 * E*TRADE options delegation); (c) the requestedEnv binding stays inline and
 * is passed through the context; (d) behavior with a mocked ETradeService:
 * owned paths return a Response (200 / 400 / 404 / 500 exactly as before),
 * non-owned paths return null (the orchestrator keeps routing) — the handler
 * ends with an explicit `return null`, never undefined (slice #359-08 caught
 * a missing-return-null bug on exactly this).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The lower bound anchors to the slice-11 options delegation call.
 * The upper bound (the Alpaca block) is NOT asserted here: it is slice
 * #359-13's domain and still inline; slice #376 must anchor its alpaca
 * delegation's lower bound to the handleWatchlistsRoutes(...) delegation
 * call when it extracts that block (reciprocal of the swap performed here).
 *
 * This slice performed slice #359-11's requested swap: the watchlists-banner
 * position anchor in tests/etrade_options_routes_extraction.test.ts became
 * this module's delegation call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/services/etrade", () => {
  const fns = {
    getWatchlists: vi.fn(async () => [{ id: "w1", name: "Watch 1" }]),
    getWatchlistDetails: vi.fn(async (id: string) =>
      id === "missing" ? null : { id, name: "Watch" }
    ),
    createWatchlist: vi.fn(async (args: any) => ({ id: "created-1", ...args })),
    saveScanAsWatchlist: vi.fn(async (name: string, symbols: string[]) => ({
      id: "scan-1",
      name,
      count: symbols.length,
    })),
    deleteWatchlist: vi.fn(async (_id: string) => true),
    // Issue #243: the details/list routes now consult the service's
    // existing getLastError() (the #155 pattern) to tell an upstream
    // failure from a genuine empty/not-found. The real ETradeService
    // always implements it; undefined models "no recorded error" here,
    // so every behaviour pinned below is unchanged.
    getLastError: vi.fn(() => undefined),
  };
  const seen: any[] = [];
  class MockETradeService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  return { ETradeService: MockETradeService, __mockETrade: { fns, seen } };
});

import {
  handleWatchlistsRoutes,
  type WatchlistsRouteContext,
} from "../src/agents/routes/watchlists";
import * as etradeMod from "../src/services/etrade";

const mocks = (etradeMod as any).__mockETrade as {
  fns: Record<string, ReturnType<typeof vi.fn>>;
  seen: Array<{ ctor: any[]; svc: any }>;
};

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (
  overrides: Partial<WatchlistsRouteContext> = {}
): WatchlistsRouteContext =>
  ({
    env: { MARKER: "env" } as any,
    getOrm: () => ({ MARKER: "orm" } as any),
    requestedEnv: undefined,
    ...overrides,
  }) as WatchlistsRouteContext;

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
  mocks.seen.length = 0;
});

describe("watchlists route inventory (extraction #375)", () => {
  it("the watchlist route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/watchlists.ts");
    const markers = [
      'path.endsWith("/etrade/watchlists") && request.method === "GET"',
      'path.endsWith("/etrade/watchlist/details") && request.method === "GET"',
      'path.endsWith("/etrade/watchlist/create") && request.method === "POST"',
      'path.endsWith("/etrade/watchlist/save-screen") && request.method === "POST"',
      'path.endsWith("/etrade/watchlist/delete")',
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
    expect(orchSrc).toContain("handleWatchlistsRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'path.endsWith("/etrade/watchlists")',
      'path.endsWith("/etrade/watchlist/details")',
      'path.endsWith("/etrade/watchlist/create")',
      'path.endsWith("/etrade/watchlist/save-screen")',
      'path.endsWith("/etrade/watchlist/delete")',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    expect(src("agents/routes/watchlists.ts")).toContain(
      "export async function handleWatchlistsRoutes"
    );
    expect(src("agents/routes/watchlists.ts")).toContain(
      "export interface WatchlistsRouteContext"
    );
    // Single call site.
    const needle = "handleWatchlistsRoutes(request, url, path, sessionId,";
    expect(orchSrc.split(needle).length - 1, "expected exactly one call site").toBe(1);
    // The requestedEnv binding stays inline in routeRequest; the delegation
    // passes it through the context.
    // Issue #2482: it now resolves from the persisted selection, never
    // from the request header.
    expect(orchSrc).toContain("resolveBrokerEnvironmentFromSettings((key) => this.readSettingRaw(key), this.env)");
    expect(orchSrc).toContain("requestedEnv,");
  });

  it("the watchlists delegation sits after the E*TRADE options delegation", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const watchlistsIdx = orchSrc.indexOf("handleWatchlistsRoutes(request, url, path, sessionId,");
    // Lower bound: the slice-11 options delegation call (delegation-call
    // anchor per the #405 rule).
    const optionsIdx = orchSrc.indexOf("handleEtradeOptionsRoutes(request, url, path, sessionId,");
    expect(optionsIdx).toBeGreaterThan(-1);
    expect(watchlistsIdx, "watchlists delegation must follow the options delegation").toBeGreaterThan(
      optionsIdx
    );
    // NOTE for slice #359-13 (alpaca): anchor its delegation's lower bound to
    // the handleWatchlistsRoutes(...) delegation call above.
  });

  it("ETradeService is imported in the module, not orchestrator.ts", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const moduleSrc = src("agents/routes/watchlists.ts");
    expect(moduleSrc).toContain('import { ETradeService } from "../../services/etrade"');
    expect(orchSrc, "ETradeService import must have moved with the block").not.toContain(
      'import { ETradeService } from "../services/etrade"'
    );
  });
});

describe("handleWatchlistsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(
      await handleWatchlistsRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleWatchlistsRoutes(
        req("POST", "/api/etrade/watchlists"),
        urlOf("/api/etrade/watchlists"),
        "/api/etrade/watchlists",
        "s",
        ctx
      )
    ).toBeNull();
    // Sibling-domain paths are not owned (alpaca is slice #359-13's domain).
    expect(
      await handleWatchlistsRoutes(
        req("POST", "/api/trading/alpaca/order"),
        urlOf("/api/trading/alpaca/order"),
        "/api/trading/alpaca/order",
        "s",
        ctx
      )
    ).toBeNull();
  });

  it("returns an explicit null, never undefined, for non-owned paths", async () => {
    const res = await handleWatchlistsRoutes(
      req("GET", "/api/nothing-here"),
      urlOf("/api/nothing-here"),
      "/api/nothing-here",
      "s",
      baseCtx()
    );
    expect(res).not.toBeUndefined();
    expect(res).toBeNull();
  });

  it("lists watchlists with the count shape and wires orm/env/userLogin through the context", async () => {
    const ctx = baseCtx({ requestedEnv: "PROD" });
    const res = await handleWatchlistsRoutes(
      req("GET", "/api/etrade/watchlists", undefined, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlists"),
      "/api/etrade/watchlists",
      "sess-1",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 1, watchlists: [{ id: "w1", name: "Watch 1" }] });
    // Context wiring: (orm, env, userLogin, requestedEnv) as the inline code passed them.
    const last = mocks.seen.at(-1)!;
    expect(last.ctor[0]).toEqual({ MARKER: "orm" });
    expect(last.ctor[1]).toEqual({ MARKER: "env" });
    expect(last.ctor[2]).toBe("alice");
    expect(last.ctor[3]).toBe("PROD");
  });

  it("fails closed with 401 when no user header is present (#1185: no sessionId/default_trader fallback)", async () => {
    const ctx = baseCtx();
    const before = mocks.seen.length;
    const res = await handleWatchlistsRoutes(
      req("GET", "/api/etrade/watchlists"),
      urlOf("/api/etrade/watchlists"),
      "/api/etrade/watchlists",
      "sess-9",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    // No E*TRADE service may be constructed under a synthetic identity.
    expect(mocks.seen.length).toBe(before);
  });

  it("returns 404 for a missing watchlist id", async () => {
    const res = await handleWatchlistsRoutes(
      req("GET", "/api/etrade/watchlist/details?id=missing", undefined, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlist/details?id=missing"),
      "/api/etrade/watchlist/details",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(((await res!.json()) as any).error).toContain("missing");
  });

  it("returns 400 when the delete id is missing", async () => {
    const res = await handleWatchlistsRoutes(
      req("POST", "/api/etrade/watchlist/delete", {}, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlist/delete"),
      "/api/etrade/watchlist/delete",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toBe("Missing watchlist id");
  });

  it("normalizes create-watchlist args exactly as the inline code did", async () => {
    const ctx = baseCtx();
    const res = await handleWatchlistsRoutes(
      req("POST", "/api/etrade/watchlist/create", { name: "  My List  ", symbols: "not-an-array" }, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlist/create"),
      "/api/etrade/watchlist/create",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(mocks.fns.createWatchlist).toHaveBeenCalledWith({ name: "My List", symbols: [] });
    const body = (await res!.json()) as any;
    expect(body.id).toBe("created-1");
  });

  it("defaults the create name when none is supplied", async () => {
    const res = await handleWatchlistsRoutes(
      req("POST", "/api/etrade/watchlist/create", {}, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlist/create"),
      "/api/etrade/watchlist/create",
      "s",
      baseCtx()
    );
    expect(mocks.fns.createWatchlist).toHaveBeenCalledWith({ name: "Default Watchlist", symbols: [] });
    expect(res!.status).toBe(200);
  });

  it("save-screen defaults the name and forwards symbols/items", async () => {
    const res = await handleWatchlistsRoutes(
      req("POST", "/api/etrade/watchlist/save-screen", { symbols: ["AAPL"], items: [{ s: "AAPL" }] }, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlist/save-screen"),
      "/api/etrade/watchlist/save-screen",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(mocks.fns.saveScanAsWatchlist).toHaveBeenCalledWith("Screener Results", ["AAPL"], [{ s: "AAPL" }]);
  });

  it("returns 502 with the generic coded message when the service throws (#2573)", async () => {
    mocks.fns.getWatchlists.mockRejectedValueOnce(new Error("etrade down"));
    const res = await handleWatchlistsRoutes(
      req("GET", "/api/etrade/watchlists", undefined, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlists"),
      "/api/etrade/watchlists",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    // #2573: the old contract surfaced err.message (500); converted
    // routes now return the generic coded failure (502) and the
    // thrown message reaches logs only, never the response body.
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ETRADE_UPSTREAM");
    expect(body.message).toBe("Broker data is temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("etrade down");
    // Non-Error throws return the same generic coded failure.
    mocks.fns.getWatchlists.mockRejectedValueOnce("string-failure");
    const res2 = await handleWatchlistsRoutes(
      req("GET", "/api/etrade/watchlists", undefined, { "x-user-login": "alice" }),
      urlOf("/api/etrade/watchlists"),
      "/api/etrade/watchlists",
      "s",
      baseCtx()
    );
    expect(res2!.status).toBe(502);
    const body2 = (await res2!.json()) as any;
    expect(body2.code).toBe("FAILURE_ETRADE_UPSTREAM");
    expect(JSON.stringify(body2)).not.toContain("string-failure");
  });
});
