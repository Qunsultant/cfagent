/**
 * #2373 Slice B (verification, NOT re-routing): premium stock-signals is
 * ALREADY paid on both branches in ALL monetization-flag states.
 *
 * The stock-signals handler (src/agents/routes/premium.ts) returns
 * ETradeAgenticPaymentService.handleGatedEndpoint directly, and BOTH the
 * async branch (tryStartScreenerWorkflow) and the sync branch
 * (the engine seam) run INSIDE its fulfill callback — behind verified
 * payment, with no path that serves without a verified receipt. The gate
 * (src/services/agenticPayments.ts) reads no monetization flag, so flag
 * ON and flag OFF behave identically here; the flag variations below
 * prove that behaviorally, they are not inputs the gate consults.
 *
 * Identity follows #183 in both branches: session traffic (x-user-login
 * set by the worker from the verified session) is metered under the login;
 * anonymous traffic (no header) is metered under the VERIFIED payer scope
 * (payerScopeId), never pooled under the gateway identity. Tier is
 * attribution only, never entitlement: entitlement is the verified
 * payment itself, so a Subscribed caller still pays x402 per call.
 *
 * Seam-unification onto paidScreenSubmission is an OPEN OWNER DECISION,
 * not done here: the seam requires a verified login + email + account
 * row, which anonymous payer-bound traffic does not have. Forcing the
 * re-route would discard #2408 metering and #2522 tier audit and break
 * anonymous traffic.
 *
 * Harness notes (mirrors tests/metered_payment_gate_2408.test.ts and
 * tests/agentic_payments.test.ts): on-chain verification is stubbed —
 * the real verifier is unit-covered by tests/x402_verifier.test.ts —
 * and the MPP path uses the same mppx mocks as #2408. The workflow
 * starter is the only other stub: tryStartScreenerWorkflow is faked so
 * the async branch's handle shape is observable without a bound
 * workflow DO (unbound, it returns null and the handler falls through
 * to the sync branch — that fall-through is production behavior, not
 * a test artifact).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../src/services/agenticPayments";
import { PROPOSED_SEED_PRICES } from "../src/data/priceCataloguePorts";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import type { UsageEventPort, InsertUsageEventRow } from "../src/data/canonicalReportStorePorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env, X402PaymentProof } from "../src/types";
import type { X402ClaimVerifier } from "../src/services/x402Verifier";

// On-chain verification is covered in x402_verifier.test.ts; here the
// verifier accepts any claim except from a known-bad payer.
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) =>
    proof.payer === "0xBadPayer"
      ? { ok: false, reason: "No matching USDC transfer" }
      : { ok: true, payer: proof.payer, txHash: proof.txHash },
  ),
}));

// MPP fakes (mirrors tests/metered_payment_gate_2408.test.ts: no
// deterministic local fixture can produce a real tempo verification).
const mppFake = vi.hoisted(() => ({
  mode: "verified" as "verified" | "challenge",
  source: undefined as string | undefined,
}));

vi.mock("mppx/server", () => ({
  Mppx: {
    create: (_config: unknown) => ({
      charge: (_options: unknown) => async (_req: Request) => {
        if (mppFake.mode === "challenge") {
          return {
            status: 402,
            challenge: new Response("Payment required", {
              status: 402,
              headers: { "WWW-Authenticate": 'Payment id="fake-challenge", realm="test"' },
            }),
          };
        }
        return { status: 200, withReceipt: (res: Response) => res };
      },
    }),
  },
  tempo: { charge: (_config: unknown) => ({}) },
}));

vi.mock("mppx", () => ({
  Credential: {
    fromRequest: (_req: Request) => ({
      challenge: {},
      payload: {},
      ...(mppFake.source ? { source: mppFake.source } : {}),
    }),
  },
}));

// Workflow starter fake: null = unbound (production fall-through to the
// sync branch); a handle = the async branch's observable shape.
const workflowFake = vi.hoisted(() => ({
  handle: null as null | { jobId: string; workflowId: string; statusUrl: string },
  lastCommand: null as unknown,
}));

vi.mock("../src/workflows/screenerWorkflowRoutes", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/workflows/screenerWorkflowRoutes")>();
  return {
    ...orig,
    tryStartScreenerWorkflow: async (...args: unknown[]) => {
      workflowFake.lastCommand = args[1] ?? null;
      return workflowFake.handle;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PAYER = "0x1111111111111111111111111111111111111111";
const MPP_PAYER = "0x700C0FFEE700C0FFEE700C0FFEE700C0FFEE7001";
const RECIPIENT = "0x71C8363837918a211797E3c76A8B3C4258759550";
const STOCK = TRADING_PAID_SERVICES.STOCK_SIGNALS;

let txCounter = 0;
const nextTxHash = () => `0x${(++txCounter).toString(16).padStart(64, "0")}`;

const verifyingClaim: X402ClaimVerifier = async ({ proof }) => ({
  ok: true,
  payer: proof.payer,
  txHash: proof.txHash || "",
});

class CapturingMeter implements UsageEventPort {
  rows: InsertUsageEventRow[] = [];
  ensureSchema(): void {}
  insertEvent(row: InsertUsageEventRow): void {
    this.rows.push({ ...row });
  }
  listByUser(userLogin: string, limit: number) {
    return this.rows
      .filter((r) => r.userLogin === userLogin)
      .slice(-limit)
      .map(({ id, userLogin: u, runId, category, createdAt }) => ({ id, userLogin: u, runId, category, createdAt }));
  }
}

const syncScreenResult = () => ({
  success: true,
  timestamp: "2026-11-03T00:00:00.000Z",
  totalScanned: 1,
  matchedCount: 1,
  opportunities: [],
  allStocks: [
    {
      symbol: "NVDA",
      lastPrice: 100,
      changePercent: 1.5,
      rsi14: 40,
      signal: "buy",
      indicators: { screenScore: 80 },
    },
  ],
});

interface Harness {
  ctx: PremiumRouteContext;
  runStockScreenViaEngine: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  meterSql: MockSqlStorage;
  meterRows: (userLogin: string) => Array<{ id: string; userLogin: string; runId: string; category: string; createdAt: string }>;
}

function makeHarness(flagOn: boolean, opts: { tenantDataProviderId?: string } = {}): Harness {
  const meterSql = new MockSqlStorage();
  const ormSql = new MockSqlStorage();
  const orm = new DatabaseORM(ormSql);
  orm.initializeSchema("trader_session_1");
  // Issue #4278: the sync branch runs through the one engine seam — the
  // fake returns the engine run's outcome (the canned result as its one shard).
  const runStockScreenViaEngine = vi.fn().mockResolvedValue({
    results: [syncScreenResult()],
    collation: null,
    jobId: "screener:manual:symbols:2026-11-03T00:00:00.000Z",
    workflowId: "wf-symbols",
  });
  const persist = vi.fn().mockResolvedValue(undefined);
  const env = {
    X402_NETWORK: "base-sepolia",
    X402_RECIPIENT_ADDRESS: RECIPIENT,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    MPP_SECRET_KEY: "test-secret",
    // The gate reads NONE of these; varying them proves flag-independence.
    FEATURE_MONETIZATION: flagOn ? "1" : "0",
    MONETIZATION_ENABLED: flagOn ? "true" : "false",
    // Issue #2373 (S1b, F9): the tenant data-provider selection,
    // read by the fulfilment through the env override (the store
    // path is pinned by the paid-seam route tests instead).
    ...(opts.tenantDataProviderId !== undefined
      ? { TENANT_DATA_PROVIDER_ID: opts.tenantDataProviderId }
      : {}),
  } as unknown as Env;
  const ctx = {
    env,
    sql: meterSql,
    getOrm: () => orm,
    // The agent is the seam's gates + read-back; the fake seam ignores it.
    getScreenerAgent: () => ({}) as any,
    persistScreenerReportCanonical: persist,
    runStockScreenViaEngine,
  } as unknown as PremiumRouteContext;
  return {
    ctx,
    runStockScreenViaEngine,
    persist,
    meterSql,
    meterRows: (userLogin: string) =>
      createCanonicalReportStorePorts(meterSql as never).usage.listByUser(userLogin, 10),
  };
}

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function stockSignalsRequest(opts: {
  method: "GET" | "POST";
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Request {
  const path = `/premium/stock-signals${opts.query ?? ""}`;
  return new Request(`https://agent.internal${path}`, {
    method: opts.method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function paidHeaders(payer: string, txHash: string): Record<string, string> {
  const proof: X402PaymentProof = {
    payer,
    signature: `0x${"b".repeat(64)}`,
    txHash,
    nonce: `n_test_${txHash.slice(-8)}`,
    timestamp: Date.now(),
  };
  return { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64") };
}

async function callStockSignals(
  h: Harness,
  req: Request,
  sessionId: string,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  return handlePremiumRoutes(req, urlOf(path + new URL(req.url).search), path, sessionId, h.ctx);
}

beforeEach(() => {
  mppFake.mode = "verified";
  mppFake.source = undefined;
  workflowFake.handle = null;
  workflowFake.lastCommand = null;
});

// ---------------------------------------------------------------------------
// Source pins: the paid shape itself
// ---------------------------------------------------------------------------
describe("stock-signals paid shape on current main (#2373 Slice B)", () => {
  const premiumSrc = readFileSync("src/agents/routes/premium.ts", "utf8");
  const gateSrc = readFileSync("src/services/agenticPayments.ts", "utf8");

  it("the gate reads no monetization flag — it is flag-independent", () => {
    for (const src of [premiumSrc, gateSrc]) {
      expect(src).not.toMatch(/monetization/i);
      expect(src).not.toMatch(/FeatureFlag|featureFlag/);
    }
  });

  it("the stock-signals branch serves ONLY through handleGatedEndpoint, with both branches inside fulfill", () => {
    const start = premiumSrc.indexOf('path.includes("/premium/stock-signals")');
    expect(start).toBeGreaterThan(-1);
    const block = premiumSrc.slice(start, premiumSrc.indexOf("return null;", start));
    expect(block).toContain("handleGatedEndpoint");
    expect(block).toContain("TRADING_PAID_SERVICES.STOCK_SIGNALS");
    // Both branches live inside the fulfill callback: the async workflow
    // start AND the sync seam run, before the metered-gate options that
    // close the handleGatedEndpoint call.
    expect(block.indexOf("tryStartScreenerWorkflow")).toBeGreaterThan(-1);
    expect(block.indexOf("runStockScreenViaEngine")).toBeGreaterThan(-1);
    expect(block.indexOf("tryStartScreenerWorkflow")).toBeLessThan(block.indexOf("premiumMeteredGateOptions"));
    expect(block.indexOf("runStockScreenViaEngine")).toBeLessThan(block.indexOf("premiumMeteredGateOptions"));
  });

  it("the sibling premium families are separate entries, untouched by this slice", () => {
    expect(premiumSrc).toContain("TRADING_PAID_SERVICES.OPTIONS_SCREENER");
    expect(premiumSrc).toContain("TRADING_PAID_SERVICES.MARKET_RESEARCH");
  });

  it("the only route entry is the orchestrator delegation; the worker forwards /api/premium/* with session identity stripped for anonymous traffic", () => {
    // #2942: the delegation moved with routeRequest into orchestrator/routeRequest.ts.
    const orchSrc = readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8");
    expect(orchSrc.match(/handlePremiumRoutes\(request, url, path, sessionId,/g)).toHaveLength(1);
    // Slice 7 of Qunsultant/cfagent#2902 (2026-11-05): the /api/premium/*
    // forward moved from src/server.ts to src/server/routes/platform.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files (assertions unchanged).
    const serverSrc = readFileSync("src/server.ts", "utf8") + readFileSync("src/server/routes/platform.ts", "utf8");
    expect(serverSrc).toContain('path.startsWith("/api/premium/")');
    expect(serverSrc).toContain('forwardReq.headers.delete("x-user-login")');
  });

  it("gate price agrees with the operator-catalogue stock price ($0.02) — numerically, not by linkage", () => {
    // The gate charges its own constant; the catalogue seed (a PROPOSED,
    // not owner-approved, value) is never read by the gate — so a future
    // catalogue change would diverge the two unless the gate is updated.
    expect(STOCK.priceUSD).toBe(0.02);
    expect(PROPOSED_SEED_PRICES.stock).toBe(0.02);
    expect(STOCK.priceUSD).toBe(PROPOSED_SEED_PRICES.stock);
  });
});

// ---------------------------------------------------------------------------
// Handler-level: the real stock-signals route, flag ON and flag OFF
// ---------------------------------------------------------------------------
for (const flagOn of [true, false]) {
  describe(`real stock-signals handler, monetization flag ${flagOn ? "ON" : "OFF"} (#2373 Slice B)`, () => {
    it("unpaid async request -> 402, nothing served, no meter row", async () => {
      const h = makeHarness(flagOn);
      const res = await callStockSignals(
        h,
        stockSignalsRequest({ method: "POST", body: { symbols: ["NVDA"], async: true } }),
        "trader_session_1",
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(402);
      const body = (await res!.json()) as any;
      expect(body.error).toBe("Payment Required");
      expect(h.runStockScreenViaEngine).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
    });

    it("unpaid sync request -> 402, nothing served", async () => {
      const h = makeHarness(flagOn);
      const res = await callStockSignals(
        h,
        stockSignalsRequest({ method: "GET", query: "?symbols=NVDA" }),
        "trader_session_1",
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(402);
      expect(h.runStockScreenViaEngine).not.toHaveBeenCalled();
    });

    it("verified x402 session traffic, sync branch -> served + metered under the login", async () => {
      const h = makeHarness(flagOn);
      const req = stockSignalsRequest({
        method: "GET",
        query: "?symbols=NVDA",
        headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
      });
      const res = await callStockSignals(h, req, "trader_session_1");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
      const body = (await res!.json()) as any;
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
      expect(body.signals[0].symbol).toBe("NVDA");
      expect(h.runStockScreenViaEngine).toHaveBeenCalledTimes(1);
      // Issue #4278: the SUCCESS sync result is stored by the
      // workflow's own store step — the route persists nothing.
      expect(h.persist).toHaveBeenCalledTimes(0);
      const rows = h.meterRows("owner-login");
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe("stock_signals");
    });

    it("verified x402 session traffic, async branch -> workflow handle served, sync engine not run", async () => {
      workflowFake.handle = { jobId: "job_symbols_test", workflowId: "wf_test", statusUrl: "/api/jobs/job_symbols_test" };
      const h = makeHarness(flagOn);
      const req = stockSignalsRequest({
        method: "POST",
        body: { symbols: ["NVDA"], async: true },
        headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
      });
      const res = await callStockSignals(h, req, "trader_session_1");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.async).toBe(true);
      expect(body.jobId).toBe("job_symbols_test");
      expect(body.workflowId).toBe("wf_test");
      expect(body.statusUrl).toBe("/api/jobs/job_symbols_test");
      expect(h.runStockScreenViaEngine).not.toHaveBeenCalled();
      expect(h.meterRows("owner-login")).toHaveLength(1);
    });

    it("verified x402 anonymous traffic (no login), sync branch -> served via the payer scope, not the gateway identity", async () => {
      const h = makeHarness(flagOn);
      const req = stockSignalsRequest({
        method: "GET",
        query: "?symbols=NVDA",
        headers: paidHeaders(PAYER, nextTxHash()),
      });
      const res = await callStockSignals(h, req, "premium-gateway");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.success).toBe(true);
      const rows = h.meterRows(payerScopeId(PAYER));
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe("stock_signals");
      expect(h.meterRows("premium-gateway")).toHaveLength(0);
    });

    it("verified x402 anonymous traffic (no login), async branch -> workflow handle served via the payer scope", async () => {
      workflowFake.handle = { jobId: "job_symbols_test", workflowId: "wf_test", statusUrl: "/api/jobs/job_symbols_test" };
      const h = makeHarness(flagOn);
      const req = stockSignalsRequest({
        method: "POST",
        body: { symbols: ["NVDA"], async: true },
        headers: paidHeaders(PAYER, nextTxHash()),
      });
      const res = await callStockSignals(h, req, "premium-gateway");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.async).toBe(true);
      expect(body.jobId).toBe("job_symbols_test");
      expect(h.meterRows(payerScopeId(PAYER))).toHaveLength(1);
    });

    it("verified MPP anonymous traffic (no login), sync branch -> served via the verified MPP payer scope", async () => {
      mppFake.source = `did:pkh:eip155:1:${MPP_PAYER}`;
      const h = makeHarness(flagOn);
      const req = stockSignalsRequest({
        method: "GET",
        query: "?symbols=NVDA",
        headers: { Authorization: "Payment credential-test" },
      });
      const res = await callStockSignals(h, req, "premium-gateway");
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.success).toBe(true);
      expect(h.meterRows(payerScopeId(MPP_PAYER))).toHaveLength(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Gate-level: tier is attribution only — a Subscribed caller still pays
// ---------------------------------------------------------------------------
describe("stock-signals gate: tier never waives payment (#2373 Slice B)", () => {
  function gateService(flagOn: boolean) {
    const orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema("trader_session_1");
    const env = {
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: RECIPIENT,
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      FEATURE_MONETIZATION: flagOn ? "1" : "0",
      MONETIZATION_ENABLED: flagOn ? "true" : "false",
    } as unknown as Env;
    return new ETradeAgenticPaymentService(orm, env, "trader_session_1", verifyingClaim);
  }

  function gatePaidRequest(service: ETradeAgenticPaymentService, txHash: string, login?: string): Request {
    const challenge = service.createX402Challenge(STOCK.resource, STOCK.priceUSD);
    const proof: X402PaymentProof = {
      payer: PAYER,
      signature: `0x${"b".repeat(64)}`,
      txHash,
      nonce: challenge.nonce,
      timestamp: Date.now(),
    };
    return new Request(`https://agent.internal${STOCK.resource}`, {
      method: "GET",
      headers: {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64"),
        ...(login ? { "x-user-login": login } : {}),
      },
    });
  }

  for (const flagOn of [true, false]) {
    it(`Subscribed resolver + NO payment -> 402, fulfill never runs (flag ${flagOn ? "ON" : "OFF"})`, async () => {
      const service = gateService(flagOn);
      const meter = new CapturingMeter();
      const fulfill = vi.fn().mockResolvedValue({ served: true });
      const req = new Request(`https://agent.internal${STOCK.resource}`, {
        method: "GET",
        headers: { "x-user-login": "owner-login" },
      });
      const res = await service.handleGatedEndpoint(
        req,
        STOCK.resource,
        STOCK.priceUSD,
        STOCK.description,
        fulfill,
        { meter, category: STOCK.id, resolveTier: async () => "Subscribed" },
      );
      expect(res.status).toBe(402);
      expect(fulfill).not.toHaveBeenCalled();
      expect(meter.rows).toHaveLength(0);
    });

    it(`Subscribed resolver + verified payment -> served, meter row records Subscribed at $0.02 (flag ${flagOn ? "ON" : "OFF"})`, async () => {
      const service = gateService(flagOn);
      const meter = new CapturingMeter();
      const fulfill = vi.fn().mockResolvedValue({ async: false, signals: [{ symbol: "NVDA" }] });
      const res = await service.handleGatedEndpoint(
        gatePaidRequest(service, nextTxHash(), "owner-login"),
        STOCK.resource,
        STOCK.priceUSD,
        STOCK.description,
        fulfill,
        { meter, category: STOCK.id, resolveTier: async () => "Subscribed" },
      );
      expect(res.status).toBe(200);
      expect(fulfill).toHaveBeenCalledTimes(1);
      expect(meter.rows).toHaveLength(1);
      expect(meter.rows[0].category).toBe("stock_signals");
      expect(meter.rows[0].userLogin).toBe("owner-login");
      const detail = JSON.parse(meter.rows[0].detailJson ?? "{}") as any;
      expect(detail.tier).toBe("Subscribed");
      expect(detail.priceUSD).toBe(0.02);
      expect(detail.protocol).toBe("x402");
    });
  }

  it("anonymous traffic + verified payment -> served, meter row records Free under the payer scope (entitlement is the payment itself)", async () => {
    const service = gateService(true);
    const meter = new CapturingMeter();
    const fulfill = vi.fn().mockResolvedValue({ served: true });
    const res = await service.handleGatedEndpoint(
      gatePaidRequest(service, nextTxHash()),
      STOCK.resource,
      STOCK.priceUSD,
      STOCK.description,
      fulfill,
      { meter, category: STOCK.id },
    );
    expect(res.status).toBe(200);
    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0].userLogin).toBe(payerScopeId(PAYER));
    const detail = JSON.parse(meter.rows[0].detailJson ?? "{}") as any;
    expect(detail.tier).toBe("Free");
  });
});

// ---------------------------------------------------------------------------
// #2373 (S1b, F9): premium fulfilment resolves the tenant's stored
// data provider instead of hardcoding "yahoo"
// ---------------------------------------------------------------------------
describe("stock-signals fulfilment provider resolution (#2373 S1b, F9)", () => {
  function syncedSpec(h: Harness) {
    const call = h.runStockScreenViaEngine.mock.calls[0]?.[0] as
      | { spec?: { provider?: string } }
      | undefined;
    return call?.spec;
  }

  it("stored provider yahoo + sync → served with provider yahoo", async () => {
    const h = makeHarness(true, { tenantDataProviderId: "yahoo" });
    const req = stockSignalsRequest({
      method: "GET",
      query: "?symbols=NVDA",
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).success).toBe(true);
    expect(syncedSpec(h)?.provider).toBe("yahoo");
  });

  it("stored provider yahoo + async → workflow command carries provider yahoo", async () => {
    workflowFake.handle = { jobId: "job_symbols_test", workflowId: "wf_test", statusUrl: "/api/jobs/job_symbols_test" };
    const h = makeHarness(true, { tenantDataProviderId: "yahoo" });
    const req = stockSignalsRequest({
      method: "POST",
      body: { symbols: ["NVDA"], async: true },
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).async).toBe(true);
    expect((workflowFake.lastCommand as { provider?: string } | null)?.provider).toBe("yahoo");
  });

  it("stored provider etrade + sync → served with the provider OMITTED (engine default)", async () => {
    const h = makeHarness(true, { tenantDataProviderId: "etrade" });
    const req = stockSignalsRequest({
      method: "GET",
      query: "?symbols=NVDA",
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).success).toBe(true);
    expect(syncedSpec(h)?.provider).toBeUndefined();
  });

  it("stored provider etrade + async → workflow command omits the provider", async () => {
    workflowFake.handle = { jobId: "job_symbols_test", workflowId: "wf_test", statusUrl: "/api/jobs/job_symbols_test" };
    const h = makeHarness(true, { tenantDataProviderId: "etrade" });
    const req = stockSignalsRequest({
      method: "POST",
      body: { symbols: ["NVDA"], async: true },
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    expect("provider" in ((workflowFake.lastCommand ?? {}) as Record<string, unknown>)).toBe(false);
  });

  it("no provider stored + sync → served with the provider OMITTED (engine default, not hardcoded yahoo)", async () => {
    const h = makeHarness(true);
    const req = stockSignalsRequest({
      method: "GET",
      query: "?symbols=NVDA",
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).success).toBe(true);
    expect(syncedSpec(h)?.provider).toBeUndefined();
  });

  it("stored provider public + sync → plain refusal, no screen run, no fallback", async () => {
    const h = makeHarness(true, { tenantDataProviderId: "public" });
    const req = stockSignalsRequest({
      method: "GET",
      query: "?symbols=NVDA",
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error).toBe("The selected data provider does not serve premium stock signals.");
    expect(h.runStockScreenViaEngine).not.toHaveBeenCalled();
  });

  it("stored provider public + async → plain refusal, no workflow started", async () => {
    workflowFake.handle = { jobId: "job_symbols_test", workflowId: "wf_test", statusUrl: "/api/jobs/job_symbols_test" };
    const h = makeHarness(true, { tenantDataProviderId: "public" });
    const req = stockSignalsRequest({
      method: "POST",
      body: { symbols: ["NVDA"], async: true },
      headers: { "x-user-login": "owner-login", ...paidHeaders(PAYER, nextTxHash()) },
    });
    const res = await callStockSignals(h, req, "trader_session_1");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error).toBe("The selected data provider does not serve premium stock signals.");
    expect(workflowFake.lastCommand).toBeNull();
    expect(h.runStockScreenViaEngine).not.toHaveBeenCalled();
  });
});
