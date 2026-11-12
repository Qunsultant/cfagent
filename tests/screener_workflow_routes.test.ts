/**
 * Issue #1737 — route async paths: opt-in `async` starts a
 * workflow and returns 202 without awaiting the scan; the
 * default (no flag) and any start failure fall back to the
 * synchronous path byte-unchanged. Issue #4278: that sync
 * path runs through the one engine seam (runStockScreenViaEngine),
 * not the direct agent call — so the sync tests below inject
 * the seam fake on the ctx, and a SUCCESS sync result is no
 * longer re-persisted/delivered by the route (the workflow's
 * store/deliver steps own it). Premium's async branch sits
 * behind the payment gate (handleGatedEndpoint) and is not
 * route-testable here; it uses the same helper + 202 shape
 * these tests pin.
 */
import { describe, expect, it } from "vitest";
import { executeEtradeScreen } from "../src/agents/routes/etradeBrokerScreen";
import { handleMarketDataCompareScreenRoutes } from "../src/agents/routes/marketDataResearch";
import type { WorkflowInstanceStatus } from "../src/workflows/workflowPorts";

function fakeBinding() {
  const instances = new Map<string, { status: WorkflowInstanceStatus }>();
  return {
    create: async ({ id }: { id: string }) => {
      if (instances.has(id)) throw new Error("already exists");
      instances.set(id, { status: "queued" });
      return { id };
    },
    get: async (id: string) => {
      if (!instances.has(id)) throw new Error("not found");
      return { id, status: async () => ({ status: "queued" as const }) };
    },
  };
}

const throwingAgent = {
  runScreen: async () => {
    throw new Error("sync path must not run on the async branch");
  },
  runSharded: async () => {
    throw new Error("sync path must not run on the async branch");
  },
} as never;

/** Issue #4278: the sync path's engine seam, faked — the route trusts it to have stored/delivered the success result. */
const seamFake = async () => ({
  results: [cannedResult()],
  collation: null,
  jobId: "screener:manual:TECH:2026-10-26T12:00:00.000Z",
  workflowId: "wf-1",
});

function cannedResult() {
  return {
    success: true,
    timestamp: "2026-10-26T12:00:00.000Z",
    universe: "TECH",
    provider: "yahoo",
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    opportunities: [],
    allStocks: [],
    discoveryMessage: "test",
    filterSummary: "test",
  };
}

describe("etrade screen async path", () => {
  it("async=1 starts a workflow and returns 202 without running the screen", async () => {
    const audits: Array<{ type: string }> = [];
    const ctx = {
      env: { SCREENER_WORKFLOW: fakeBinding(), AGENT_DB: {} },
      readSettingRaw: () => null,
      audit: (type: string) => {
        audits.push({ type });
      },
      persistScreenerReportCanonical: async () => {},
    } as never;
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "TECH",
      validatedFilters: {},
      asyncRequested: true,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("queued");
    expect(typeof body.jobId).toBe("string");
    expect(typeof body.workflowId).toBe("string");
    expect(String(body.statusUrl)).toMatch(/^\/api\/jobs\/history\?chainId=/);
    expect(audits.map((a) => a.type)).toContain("etrade.screen_enqueued");
  });

  it("async flag without bindings runs the sync branch through the engine seam (never crashes)", async () => {
    const audits: Array<{ type: string }> = [];
    const persisted: unknown[] = [];
    const bridged: unknown[] = [];
    const ctx = {
      env: {},
      readSettingRaw: () => null,
      audit: (type: string) => {
        audits.push({ type });
      },
      persistScreenerReportCanonical: async (r: unknown) => {
        persisted.push(r);
      },
      scheduleScreenerFollowups: async (o: unknown) => {
        bridged.push(o);
      },
      // Issue #4278: the sync branch runs through the seam now.
      runStockScreenViaEngine: seamFake,
    } as never;
    // The agent is the seam's gates + read-back; the fake seam ignores it.
    const agent = {} as never;
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent,
      universe: "TECH",
      validatedFilters: {},
      asyncRequested: true,
    });
    expect(res.status).toBe(200);
    expect(audits.map((a) => a.type)).toContain("etrade.screened");
    // Issue #4278: the SUCCESS sync result is stored + delivered
    // by the workflow's own steps — the route persists/delivers
    // nothing for it, so both finalizers stay empty here.
    expect(persisted).toHaveLength(0);
    expect(bridged).toHaveLength(0);
  });

  it("no flag keeps the synchronous path", async () => {
    const audits: Array<{ type: string }> = [];
    const ctx = {
      env: { SCREENER_WORKFLOW: fakeBinding(), AGENT_DB: {} },
      readSettingRaw: () => null,
      audit: (type: string) => {
        audits.push({ type });
      },
      persistScreenerReportCanonical: async () => {},
      scheduleScreenerFollowups: async () => {},
      // Issue #4278: the sync path runs through the seam now.
      runStockScreenViaEngine: seamFake,
    } as never;
    // The agent is the seam's gates + read-back; the fake seam ignores it.
    const agent = {} as never;
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(200);
    expect(audits.map((a) => a.type)).toContain("etrade.screened");
  });
});

describe("market-data screen async path", () => {
  function marketDataCtx(env: unknown, agent: unknown) {
    const audits: Array<{ type: string }> = [];
    const persisted: unknown[] = [];
    return {
      audits,
      persisted,
      ctx: {
        env,
        audit: (type: string) => {
          audits.push({ type });
        },
        getScreenerAgent: () => agent,
        persistScreenerReportCanonical: async (r: unknown) => {
          persisted.push(r);
        },
        // Issue #4278: the sync path runs through the seam now.
        runStockScreenViaEngine: seamFake,
      } as never,
    };
  }

  it("async=1 returns 202 without running the screen", async () => {
    const { audits, ctx } = marketDataCtx(
      { SCREENER_WORKFLOW: fakeBinding(), AGENT_DB: {} },
      throwingAgent,
    );
    const url = new URL("https://x/market-data/screen?universe=TECH&async=1");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handleMarketDataCompareScreenRoutes(req, url, "/market-data/screen", "s1", ctx);
    expect(res?.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("queued");
    expect(audits.map((a) => a.type)).toContain("market_data.screener.enqueued");
  });

  it("no flag keeps the synchronous path", async () => {
    const { audits, persisted, ctx } = marketDataCtx(
      { SCREENER_WORKFLOW: fakeBinding(), AGENT_DB: {} },
      {},
    );
    const url = new URL("https://x/market-data/screen?universe=TECH");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handleMarketDataCompareScreenRoutes(req, url, "/market-data/screen", "s1", ctx);
    expect(res?.status).toBe(200);
    expect(audits.map((a) => a.type)).toContain("market_data.screener.executed");
    // Issue #4278: the SUCCESS sync result is stored by the
    // workflow's own store step — the route persists nothing.
    expect(persisted).toHaveLength(0);
  });
});
