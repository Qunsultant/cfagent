/**
 * Issue #359-09: characterization for the E*TRADE broker route extraction.
 *
 * Pins (a) the route inventory and relative order of the two extracted
 * handlers in src/agents/routes/etradeBroker.ts — the matching order in
 * routeRequest is load-bearing, so the module must handle the
 * (path, method) pairs in the same sequence as the original inline blocks;
 * (b) the two delegation call sites in orchestrator.ts — one call site
 * each, at the exact original positions (the account-activity block was
 * non-contiguous with the main broker block, so the module exports two
 * handlers); (c) behavior with a mock context: owned paths return a
 * Response, non-owned paths return null (the orchestrator keeps routing) —
 * each handler ends with an explicit `return null`, never undefined
 * (slice #359-08 caught a missing-return-null bug on exactly this).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks — those move when their domain is extracted. The only remaining
 * neighbor anchors are the still-inline options banner and the still-inline
 * trading-blocks markers; when those domains are extracted (slices #359-10
 * and #359-11), their slices must swap the banner anchors for their
 * delegation calls.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleEtradeBrokerRoutes,
  handleEtradeBrokerActivityRoutes,
  type EtradeBrokerRouteContext,
} from "../src/agents/routes/etradeBroker";
import { handleEnvironmentSwitch } from "../src/agents/routes/brokerEnvironment";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<EtradeBrokerRouteContext> = {}): EtradeBrokerRouteContext =>
  ({
    env: {} as any,
    getOrm: () => {
      throw new Error("boom");
    },
    // Issue #2482: handlers resolve the broker environment from the
    // persisted selection; fixtures without a selection read PROD.
    readSettingRaw: () => null,
    audit: vi.fn(),
    getScreenerAgent: () => ({}) as any,
    persistScreenerReportCanonical: vi.fn(),
    evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as any,
    getAutopilotState: () => ({ running: false }),
    incrementAutopilotOrdersToday: vi.fn(),
    schedule: async () => ({ id: "sched-1" }) as any,
    cancelSchedule: async () => {},
    ...overrides,
  }) as EtradeBrokerRouteContext;

// Issue #1185: requests model the production session gate — src/server.ts
// sets x-user-login from the verified session on every authenticated
// /api/* request, and the handlers now fail closed without it.
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { "x-user-login": "alice", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("E*TRADE broker route inventory (extraction #372)", () => {
  it("the broker route conditions appear in the module in the original relative order", () => {
    const moduleSrc = src("agents/routes/etradeBroker.ts");
    const markers = [
      'path.endsWith("/environment/switch")',
      'path.endsWith("/broker/etrade/environment")',
      'path.endsWith("/etrade/status")',
      'path.endsWith("/etrade/diagnostics")',
      'path.endsWith("/etrade/accounts")',
      'path.endsWith("/etrade/screen")',
      'path.endsWith("/etrade/quote")',
      'path.endsWith("/etrade/order/preview")',
      'path.endsWith("/etrade/order/execute")',
      'path.endsWith("/etrade/positions")',
      'path.endsWith("/etrade/portfolio-risk")',
      'path.endsWith("/etrade/portfolio-risk/evaluate")',
      'path.endsWith("/etrade/portfolio-risk/correlation")',
      'path.endsWith("/etrade/portfolio-risk/size")',
      'path.endsWith("/etrade/think/evaluate")',
      'path.endsWith("/etrade/hedge/analyze")',
      'path.endsWith("/etrade/orders")',
      'path.endsWith("/etrade/orders/remote")',
      'path.endsWith("/etrade/orders/cancel")',
      // Account-activity block (second handler, original position preserved).
      'path.endsWith("/etrade/transactions")',
      'path.includes("/etrade/transactions/")',
      'path.endsWith("/etrade/alerts")',
      'path.includes("/etrade/alerts/")',
      'path.endsWith("/etrade/lookup")',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; two delegations stand at the original positions", () => {
    const orchSrc = src("agents/orchestrator.ts");
    expect(orchSrc).toContain("handleEtradeBrokerRoutes(request, url, path, sessionId,");
    expect(orchSrc).toContain("handleEtradeBrokerActivityRoutes(request, url, path, sessionId,");
    // No leftover inline conditions for these paths.
    for (const cond of [
      'path.endsWith("/etrade/status")',
      'path.endsWith("/etrade/accounts")',
      'path.endsWith("/etrade/order/preview")',
      'path.endsWith("/etrade/transactions")',
      'path.endsWith("/etrade/lookup")',
      "return handleEnvironmentSwitch(request);",
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // The extracted module is the sole owner of these blocks now.
    const moduleSrc = src("agents/routes/etradeBroker.ts");
    // Issue #2482 split (same #995 pattern as diagnostics): the
    // environment block lives in brokerEnvironment.ts, and
    // etradeBroker.ts delegates to it.
    const envModuleSrc = src("agents/routes/brokerEnvironment.ts");
    expect(envModuleSrc).toContain("export async function handleEnvironmentSwitch");
    expect(moduleSrc).toContain("return handleEnvironmentSwitch(request, ctx);");
    expect(moduleSrc).toContain("export async function handleEtradeBrokerRoutes");
    expect(moduleSrc).toContain("export async function handleEtradeBrokerActivityRoutes");
    // The options blocks were NOT moved (sibling slice #359-11).
    expect(moduleSrc).not.toContain('path.endsWith("/etrade/options/chains")');
    // Single call site per handler.
    for (const name of ["handleEtradeBrokerRoutes", "handleEtradeBrokerActivityRoutes"]) {
      const needle = `${name}(request, url, path, sessionId,`;
      const count = orchSrc.split(needle).length - 1;
      expect(count, `expected exactly one call site for ${name}`).toBe(1);
    }
  });

  it("the broker delegation sits between the premium delegation and the activity delegation; the activity delegation precedes the still-inline options block", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const brokerIdx = orchSrc.indexOf("handleEtradeBrokerRoutes(request, url, path, sessionId,");
    const activityIdx = orchSrc.indexOf("handleEtradeBrokerActivityRoutes(request, url, path, sessionId,");
    // Lower bound: the premium delegation call (slice #359-08), a
    // delegation-call anchor per the #405 rule.
    const premiumIdx = orchSrc.indexOf("handlePremiumRoutes(request, url, path, sessionId,");
    expect(premiumIdx).toBeGreaterThan(-1);
    expect(brokerIdx, "broker delegation must follow the premium delegation").toBeGreaterThan(premiumIdx);
    expect(activityIdx, "activity delegation must follow the broker delegation").toBeGreaterThan(brokerIdx);
    // Upper bound: the options delegation call (slice #359-11 swapped the
    // still-inline options banner for this delegation call when it extracted
    // the options block; delegation-call anchor per the #405 rule).
    const optionsIdx = orchSrc.indexOf("handleEtradeOptionsRoutes(request, url, path, sessionId,");
    expect(optionsIdx).toBeGreaterThan(-1);
    expect(activityIdx, "activity delegation must precede the options block").toBeLessThan(optionsIdx);
    // The requestedEnv binding stays inline for the still-inline options block.
    // Issue #2482: it now resolves from the persisted selection, never
    // from the request header.
    expect(orchSrc).toContain("resolveBrokerEnvironmentFromSettings((key) => this.readSettingRaw(key), this.env)");
  });
});

describe("handleEtradeBrokerRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(
      await handleEtradeBrokerRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleEtradeBrokerRoutes(req("POST", "/api/etrade/status"), urlOf("/api/etrade/status"), "/api/etrade/status", "s", ctx)
    ).toBeNull();
    // Options paths belong to the sibling slice, not this handler.
    expect(
      await handleEtradeBrokerRoutes(req("GET", "/api/etrade/options/chains"), urlOf("/api/etrade/options/chains"), "/api/etrade/options/chains", "s", ctx)
    ).toBeNull();
  });

  it("answers the environment switcher through the single-owner handler", async () => {
    const ctx = baseCtx();
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/broker/etrade/environment", { environment: "BOGUS" }),
      urlOf("/api/broker/etrade/environment"),
      "/api/broker/etrade/environment",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toMatch(/TEST or PROD/);
  });

  it("owned broker paths return a Response (not null) even when the backend fails", async () => {
    const ctx = baseCtx();
    // getOrm throws in this fixture, so the status route hits its catch and
    // answers 500 - proving the route matched and ran here.
    const res = await handleEtradeBrokerRoutes(
      req("GET", "/api/etrade/status"),
      urlOf("/api/etrade/status"),
      "/api/etrade/status",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });
});

describe("handleEtradeBrokerActivityRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    expect(
      await handleEtradeBrokerActivityRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", ctx)
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleEtradeBrokerActivityRoutes(req("POST", "/api/etrade/transactions"), urlOf("/api/etrade/transactions"), "/api/etrade/transactions", "s", ctx)
    ).toBeNull();
    // Main broker-block paths belong to the sibling handler, not this one.
    expect(
      await handleEtradeBrokerActivityRoutes(req("GET", "/api/etrade/status"), urlOf("/api/etrade/status"), "/api/etrade/status", "s", ctx)
    ).toBeNull();
  });

  it("owned activity paths return a Response (not null) even when the backend fails", async () => {
    const ctx = baseCtx();
    const res = await handleEtradeBrokerActivityRoutes(
      req("GET", "/api/etrade/transactions"),
      urlOf("/api/etrade/transactions"),
      "/api/etrade/transactions",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    // #2573: catch blocks in converted routes return the generic coded
    // failure (FAILURE_ETRADE_UPSTREAM, 502), never err.message.
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ETRADE_UPSTREAM");
    expect(body.message).toBe("Broker data is temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("handleEnvironmentSwitch is exported from the brokerEnvironment module for the #314 test pins", () => {
    expect(typeof handleEnvironmentSwitch).toBe("function");
  });
});
