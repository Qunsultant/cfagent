/**
 * Issue #1206 (E5b of epic #1116) — the premium options-scan host
 * wired on-platform.
 *
 * E5 (#1202) delivered tier entitlements at the data layer but left
 * the premium host unwired: PremiumRouteContext carried no storage
 * handles, so the paid scan constructed UnifiedOptionsService with
 * no platform deps — no captures, no tier-checked resolution. This
 * suite pins the wiring:
 *
 *  (a) with storage handles on the context, a paid options-scan
 *      executes through the platform: its chain fetches are captured
 *      under ONE run id (the scan's platform run identity),
 *      retrievable through the capture store's read API on the same
 *      sql; the handler's response body and canonical persistence
 *      are unchanged.
 *  (b) with the optionsChains route tiered premium (the state a
 *      configure routeTiers call produces), the paid scan still
 *      serves end-to-end and captures — the handler presents
 *      callerTier "premium" (its x402 verification is the
 *      entitlement evidence). At the freemium default tier this
 *      same route refuses, as pinned by E5 (d); no duplicate here.
 *  (c) behaviour preservation: an UNPAID options-scan (the real
 *      payment gate, no mock) returns the same 402 challenge as
 *      before and writes no captures and no canonical report, even
 *      with storage handles present — fulfillment never runs.
 *  (d) makePremiumRouteContext binds exactly the host's handles
 *      (sql = host storage's sql, blobStorage = the storage itself,
 *      env identity) and delegates getOrm / getScreenerAgent /
 *      persistScreenerReportCanonical to the host.
 *
 * Harness: the premium suites' idiom — the payment gate is driven
 * straight to fulfillment by mocking handleGatedEndpoint (payment
 * gating itself is pinned by the agentic-payments suites), the
 * E*TRADE layer is stubbed at the fetch seam with stored session
 * tokens (the E5 (d) harness), and storage is MockSqlStorage plus a
 * Map-backed blob store (the platform suites' fakes). No live data,
 * no network. Fixture identifiers are plainly synthetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import * as premiumModule from "../src/agents/routes/premium";
import { ETradeAgenticPaymentService } from "../src/services/agenticPayments";
import {
  bootstrapDataProviders,
  getCapabilityRoute,
  upsertCapabilityRoute,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  listCapturesByProvider,
  listCapturesByRun,
} from "../src/trading/dataProviders/captureStore";
import { listScheduledReports } from "../src/services/scheduledReports";
import type { Env } from "../src/types";

const LOGIN = "e5b_premium_trader";
const PATH = "/api/premium/options-scan";

// ---------------------------------------------------------------------------
// Harness (E5 (d) options harness + the #982 premium gate idiom)
// ---------------------------------------------------------------------------

function optionsEnv() {
  const kvStorage: Record<string, string> = {};
  const mockKv = {
    get: async (k: string) => kvStorage[k] || null,
    put: async (k: string, v: string) => {
      kvStorage[k] = v;
    },
    delete: async (k: string) => {
      delete kvStorage[k];
    },
  } as any;
  const { namespace: sessionStoreNs } = makeFakeSessionStore();
  return {
    APP_NAME: "cfagent-test",
    APP_BASE_URL: "https://agent.openaimp.com",
    SESSION_SECRET: "e5b-session-secret",
    GITHUB_CLIENT_ID: "gh_id",
    GITHUB_CLIENT_SECRET: "e5b-github-secret",
    AI_SEARCH_ENDPOINT: "https://ai.example.com",
    SESSION_STORE: sessionStoreNs,
    ETRADE_KV: mockKv,
    ORCHESTRATOR_AGENT: {} as any,
    ASSETS: {} as any,
    AI: {} as any,
    APP_ENV: "TEST",
    ET_API_KEY: "e5b-et-key",
    ET_API_SECRET: "e5b-et-secret",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
  } as unknown as Env;
}

// Expiry ~35 days out — inside the default 0–90 DTE window (the E5
// harness pattern).
const expiry = new Date(Date.now() + 35 * 86_400_000);
const expiryParts = {
  year: expiry.getUTCFullYear(),
  month: expiry.getUTCMonth() + 1,
  day: expiry.getUTCDate(),
};

function chainWirePayload() {
  const nowSec = Math.floor(Date.now() / 1000);
  const strikes = [225, 237.5, 250, 262.5, 275];
  const pair = (strike: number) => {
    const callMid = Math.max(0.5, 250 - strike + 2.5);
    const putMid = Math.max(0.5, strike - 250 + 2.5);
    const contract = (type: "Call" | "Put", mid: number, delta: number) => ({
      symbol: `NVDA---${type === "Call" ? "C" : "P"}${strike}`,
      strikePrice: strike,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 500,
      openInterest: 1500,
      timeStamp: nowSec,
      OptionGreeks: { delta, gamma: 0.02, theta: -0.03, vega: 0.1, iv: 0.25 },
    });
    return {
      Call: contract("Call", callMid, 0.5),
      Put: contract("Put", putMid, -0.5),
    };
  };
  return {
    OptionChainResponse: {
      OptionPair: strikes.map(pair),
      nearPrice: 250,
      SelectedED: expiryParts,
      timeStamp: nowSec,
    },
  };
}

function stubOptionsFetch() {
  const chainPayload = chainWirePayload();
  const expirePayload = {
    OptionExpireDateResponse: { ExpirationDate: [expiryParts] },
  };
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("optionexpiredate")) {
        return new Response(JSON.stringify(expirePayload), { status: 200 });
      }
      if (url.includes("optionchains")) {
        return new Response(JSON.stringify(chainPayload), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

/** Drive the gated endpoint straight to fulfillment (the #982
 *  idiom — payment gating itself is pinned elsewhere). */
function mockPaidGate() {
  vi.spyOn(
    ETradeAgenticPaymentService.prototype,
    "handleGatedEndpoint"
  ).mockImplementation(
    async (
      _req: unknown,
      _resource: unknown,
      _price: unknown,
      _desc: unknown,
      fulfill: unknown
    ) => {
      const out = await (fulfill as (receipt: unknown) => Promise<unknown>)({
        payer: "0xSYNTHETIC_PAYER",
        receiptId: "synthetic-receipt",
      });
      return Response.json(out as Record<string, unknown>);
    }
  );
}

function makeCtx(
  sql: MockSqlStorage,
  orm: DatabaseORM,
  env: Env,
  blobStorage: ReturnType<typeof fakeBlobStorage>
): PremiumRouteContext {
  return {
    env,
    getOrm: () => orm,
    getScreenerAgent: (() => {
      throw new Error("options-scan does not use the screener agent");
    }) as never,
    persistScreenerReportCanonical: async () => {},
    sql: sql as any,
    blobStorage: blobStorage as any,
  } as PremiumRouteContext;
}

function paidScanRequest(login: string = LOGIN) {
  return new Request(`https://agent.internal${PATH}?symbol=NVDA`, {
    method: "GET",
    headers: { "x-user-login": login },
  });
}

async function runPaidScan(ctx: PremiumRouteContext, login: string = LOGIN) {
  const request = paidScanRequest(login);
  const response = await handlePremiumRoutes(
    request,
    new URL(request.url),
    PATH,
    "session-1",
    ctx
  );
  expect(response).not.toBeNull();
  return response!;
}

// ---------------------------------------------------------------------------
// (a) + (b): on-platform paid scans
// ---------------------------------------------------------------------------

describe("premium options-scan on-platform (issue #1206)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let env: Env;

  beforeEach(async () => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql as never);
    env = optionsEnv();
    await storeAccessTokens(env, LOGIN, "valid_token", "valid_secret");
    stubOptionsFetch();
    mockPaidGate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) captures the scan's chain fetches under one run id; body + canonical persistence unchanged", async () => {
    const ctx = makeCtx(sql, orm, env, fakeBlobStorage());
    const response = await runPaidScan(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;

    // Response contract unchanged: the screenResult IS the service's
    // screen data, and the scan matched contracts.
    expect(body.success).toBe(true);
    expect(body.service).toBeDefined();
    expect(body.screenResult.matchedCount).toBeGreaterThan(0);

    // The fetches were captured on-platform, under ONE run id.
    const captures = listCapturesByProvider(sql as any, "default", "etrade");
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.every((c) => c.capability === "optionsChains")).toBe(true);
    expect(captures.every((c) => c.status === "captured")).toBe(true);
    const runIds = new Set(captures.map((c) => c.runId));
    expect(runIds.size).toBe(1);
    const runId = [...runIds][0];
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
    // The capture store's run read returns exactly the scan's rows.
    expect(listCapturesByRun(sql as any, "default", runId)).toHaveLength(
      captures.length
    );

    // Canonical persistence still happens in the route, as before.
    const reports = listScheduledReports(sql as never, {
      sourceFilter: "options_scanner",
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toContain("NVDA");
  });

  it("(b) serves and captures with the optionsChains route tiered premium (callerTier premium through the real host)", async () => {
    // A distinct login from (a): the service's in-memory result
    // cache is segmented per caller, and this test must FETCH (a
    // cache hit would capture nothing — there is nothing to
    // capture when no provider call happens).
    const tierLogin = "e5b_premium_tier_trader";
    await storeAccessTokens(env, tierLogin, "valid_token", "valid_secret");
    // The state a configure routeTiers call produces.
    bootstrapDataProviders(sql as any);
    const route = getCapabilityRoute(sql as any, "optionsChains")!;
    upsertCapabilityRoute(sql as any, {
      capability: "optionsChains",
      primaryProviderId: route.primaryProviderId,
      gapFillProviderId: route.gapFillProviderId,
      minTier: "premium",
    });
    expect(getCapabilityRoute(sql as any, "optionsChains")!.minTier).toBe(
      "premium"
    );

    const ctx = makeCtx(sql, orm, env, fakeBlobStorage());
    const response = await runPaidScan(ctx, tierLogin);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    // No tier refusal: at the default freemium tier this route throws
    // DataProviderTierError (E5 (d)); the paid host presents
    // "premium", so the scan serves.
    expect(body.success).toBe(true);
    expect(body.screenResult.matchedCount).toBeGreaterThan(0);

    const captures = listCapturesByProvider(sql as any, "default", "etrade");
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.every((c) => c.capability === "optionsChains")).toBe(true);
    expect(new Set(captures.map((c) => c.runId)).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (c): unpaid preservation — the real payment gate
// ---------------------------------------------------------------------------

describe("premium options-scan unpaid preservation (issue #1206)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(c) an unpaid request gets the 402 challenge and writes no captures and no canonical report", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const env = optionsEnv();
    // Storage handles ARE present — the gate must still stop the
    // request before fulfillment, so nothing is captured or stored.
    const ctx = makeCtx(sql, orm, env, fakeBlobStorage());
    const request = new Request(`https://agent.internal${PATH}?symbol=NVDA`, {
      method: "GET",
    });
    const response = await handlePremiumRoutes(
      request,
      new URL(request.url),
      PATH,
      "session-1",
      ctx
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(402);
    expect(listCapturesByProvider(sql as any, "default", "etrade")).toHaveLength(
      0
    );
    expect(
      listScheduledReports(sql as never, { sourceFilter: "options_scanner" })
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d): the context factory
// ---------------------------------------------------------------------------

describe("makePremiumRouteContext (issue #1206)", () => {
  it("(d) binds exactly the host's handles and delegates the host methods", async () => {
    const make = (premiumModule as Record<string, unknown>)[
      "makePremiumRouteContext"
    ] as ((host: unknown) => PremiumRouteContext) | undefined;
    expect(typeof make).toBe("function");

    const env = optionsEnv();
    const hostSql = new MockSqlStorage();
    const storage = Object.assign(fakeBlobStorage(), { sql: hostSql as any });
    const ormSentinel = { marker: "orm-sentinel" };
    const agentSentinel = { marker: "agent-sentinel" };
    const getScreenerAgent = vi.fn((_userLogin?: string) => agentSentinel);
    const persist = vi.fn(async (_result: unknown) => {});
    const host = {
      env,
      ctx: { storage },
      getOrm: () => ormSentinel,
      getScreenerAgent,
      persistScreenerReportCanonical: persist,
    };

    const ctx = make!(host);
    expect(ctx.env).toBe(env);
    // The handles are exactly the host's: sql is the storage's sql,
    // blobStorage is the storage object itself.
    expect(ctx.sql).toBe(hostSql);
    expect(ctx.blobStorage).toBe(storage);
    expect(ctx.getOrm()).toBe(ormSentinel);
    expect(ctx.getScreenerAgent("login-1")).toBe(agentSentinel);
    expect(getScreenerAgent).toHaveBeenCalledWith("login-1");
    const payload = {
      timestamp: "2026-10-23T00:00:00.000Z",
      success: true,
      totalScanned: 0,
      matchedCount: 0,
      opportunities: [],
      allStocks: [],
    };
    await ctx.persistScreenerReportCanonical(payload as any);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe(payload);
  });
});
