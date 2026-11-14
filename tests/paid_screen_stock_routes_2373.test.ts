/**
 * Issue #2373 (Slice A, program #2012) — the manual E*TRADE and
 * market-data stock routes follow the same payment path as the goal
 * route: under monetization ON they route through the existing
 * paidScreenSubmission seam (payment workflow) instead of running a
 * free screen, and under flag OFF today's behavior is unchanged.
 *
 * TDD: written before the handler wiring. The handlers under test are
 * handleEtradeBrokerRoutes (/etrade/screen) and
 * handleMarketDataCompareScreenRoutes (/market-data/screen and
 * siblings); the broker builder under test is
 * buildStockScreenWorkflowCommand in screenExecutionBroker.ts.
 *
 * Harness notes:
 * - Flag control is the env adapter (MONETIZATION_ENABLED), the same
 *   mechanism the billing route suites use; no FLAGS binding here.
 * - The commercial/subscription adapters are fakes at the composition
 *   root (createCommercialPorts / createSubscriptionPorts): the seam
 *   reads them through resolvePaidScreenAccount exactly as production
 *   does, but no D1 is involved.
 * - The PAYMENT_WORKFLOW binding is a fake whose create() records
 *   params and returns the id; the workflow's own gate refusal is
 *   covered by the payment-workflow suites, not re-tested here.
 * - The screener agent throws on every call in seam tests: a seam
 *   response proves no screener started and no scan ran.
 * - The E*TRADE service is stubbed to a bare class (the extraction
 *   suite's idiom): only the listings-branch placement pin needs it,
 *   and that pin must not touch the network.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleEtradeBrokerRoutes } from "../src/agents/routes/etradeBroker";
import { handleMarketDataCompareScreenRoutes } from "../src/agents/routes/marketDataResearch";
import {
  buildStockScreenWorkflowCommand,
  startStockScreenWorkflowOrNull,
} from "../src/workflows/screenExecutionBroker";
import { workflowTenantId } from "../src/workflows/screenerWorkflowRoutes";
import type { StockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

const storeState = vi.hoisted(() => ({
  /** Stored commercial row, or null for "no account yet" (implicit Free). */
  account: null as Record<string, unknown> | null,
  subscriptions: [] as Array<{ periodEndMs: number }>,
  commercialBound: true,
  subscriptionsBound: true,
  /** Stored tenant data-provider/broker selections (null = none stored). */
  dataProviderId: null as string | null,
  brokerId: null as string | null,
}));

const freeRunState = vi.hoisted(() => ({
  /** Free-run allowance for the family (null = counter unbound). */
  allowance: null as number | null,
  used: 0,
}));

vi.mock("../src/data/createCommercialPorts", () => ({
  createCommercialAdapter: () =>
    storeState.commercialBound
      ? {
          db: {},
          getAccount: async () => storeState.account,
          getTenantDataProviderSelection: async () => storeState.dataProviderId,
          getTenantBrokerSelection: async () => storeState.brokerId,
        }
      : null,
  ensureCommercialSchema: async () => {},
}));

// Issue #2373 (S1b): the seam's coverage probe reads the free-run
// counter through the real factory (unbound without AGENT_DB), so
// the allowance branch is pinned here with a fake counter.
vi.mock("../src/data/createFreeRunCounterPorts", () => ({
  createFreeRunCounterAdapter: () =>
    freeRunState.allowance === null
      ? null
      : {
          db: {},
          getAllowance: async () => freeRunState.allowance,
          getUsed: async () => freeRunState.used,
        },
  ensureFreeRunCounterSchema: async () => {},
}));

vi.mock("../src/data/createSubscriptionPorts", () => ({
  createSubscriptionAdapter: () =>
    storeState.subscriptionsBound
      ? { db: {}, listSubscriptions: async () => storeState.subscriptions }
      : null,
  ensureSubscriptionSchema: async () => {},
}));

vi.mock("../src/services/etrade", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ETradeService: class MockETradeService {
      constructor(..._args: unknown[]) {}
    },
  };
});

const LOGIN = "alice";
const TENANT = "tenant-1";
const EMAIL = "alice@example.com";

function paymentBinding(opts: { failCreate?: boolean } = {}) {
  const creates: Array<{ id: string; params: Record<string, any> }> = [];
  return {
    creates,
    binding: {
      create: async ({ id, params }: { id: string; params: unknown }) => {
        if (opts.failCreate) throw new Error("workflow provider down");
        creates.push({ id, params: params as Record<string, any> });
        return { id };
      },
      get: async () => {
        throw new Error("not found");
      },
    },
  };
}

function throwingAgent() {
  return {
    runScreen: async () => {
      throw new Error("sync path must not run on the paid seam path");
    },
    runSharded: async () => {
      throw new Error("sync path must not run on the paid seam path");
    },
  } as never;
}

function cannedAgent() {
  return {
    runScreen: async () => ({
      success: true,
      timestamp: "2026-11-03T12:00:00.000Z",
      universe: "NASDAQ100",
      totalScanned: 10,
      matchedCount: 2,
      opportunities: [],
      allStocks: [],
      discoveryMessage: "test",
      filterSummary: "test",
    }),
    runSharded: async () => [],
  } as never;
}

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (provider/sector ride the spec on the routes, the
// overrides on the scheduled path) and returns the stub's result
// as the engine run's one shard. The seam itself is pinned in
// tests/stock_entry_routing_4278.test.ts.
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    maxSymbols: input.commandOverrides?.maxSymbols,
    filters: input.spec.filters,
    userLogin: input.userLogin,
    environment: input.environment,
    portfolioContext: input.portfolioContext,
    provider: input.commandOverrides?.provider ?? input.spec.provider,
    broker: input.commandOverrides?.broker,
    ...(input.commandOverrides?.mode
      ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
      : {}),
  };
  const result = await runScreen(flat);
  return {
    results: [result],
    collation: null,
    jobId: input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  };
};

function etradeCtx(env: Record<string, unknown>, agent: unknown) {
  const audits: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];
  return {
    audits,
    ctx: {
      env: env as never,
      getOrm: () => {
        throw new Error("seam path must not touch the ORM");
      },
      readSettingRaw: () => null,
      audit: (type: string, agentName: string, payload: Record<string, unknown>) => {
        audits.push({ type, agent: agentName, payload });
      },
      getScreenerAgent: () => agent as never,
      persistScreenerReportCanonical: async () => {},
      scheduleScreenerFollowups: async () => {},
      evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as never,
      getAutopilotState: () => ({ running: false }),
      incrementAutopilotOrdersToday: () => {},
      schedule: async () => ({ id: "sched-1" }) as never,
      cancelSchedule: async () => true,
    } as never,
  };
}

function marketCtx(env: Record<string, unknown>, agent: unknown) {
  const audits: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];
  return {
    audits,
    ctx: {
      env: env as never,
      audit: (type: string, agentName: string, payload: Record<string, unknown>) => {
        audits.push({ type, agent: agentName, payload });
      },
      getScreenerAgent: () => agent as never,
      persistScreenerReportCanonical: async () => {},
    } as never,
  };
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      "x-user-login": LOGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function envFor(payment: ReturnType<typeof paymentBinding>, monetizationOn: boolean) {
  return {
    ...(monetizationOn ? { MONETIZATION_ENABLED: "true" } : {}),
    IAAA_TENANT_ID: TENANT,
    PAYMENT_WORKFLOW: payment.binding,
  } as Record<string, unknown>;
}

function resetStore() {
  storeState.account = null;
  storeState.subscriptions = [];
  storeState.commercialBound = true;
  storeState.subscriptionsBound = true;
  storeState.dataProviderId = null;
  storeState.brokerId = null;
  freeRunState.allowance = null;
  freeRunState.used = 0;
}

/** A stored Subscribed row with included runs, tenant-matched. */
function coveredAccount() {
  storeState.account = {
    id: LOGIN,
    tenantId: TENANT,
    tier: "Subscribed",
    creditsUSD: 0,
    includedRuns: 3,
    updatedAtMs: 0,
  };
  storeState.subscriptions = [{ periodEndMs: Date.now() + 30 * 24 * 3600 * 1000 }];
}

/** A stored Free row with a live unlimited-free grant, tenant-matched. */
function grantAccount() {
  storeState.account = {
    id: LOGIN,
    tenantId: TENANT,
    tier: "Free",
    creditsUSD: 0,
    includedRuns: 0,
    unlimitedFreeGrant: { grantedBy: "operator", reason: "test grant", expiresAtMs: null },
    updatedAtMs: 0,
  };
}

beforeEach(() => {
  resetStore();
});

/* ------------------------------------------------------------------ */
/* E*TRADE route                                                       */
/* ------------------------------------------------------------------ */

describe("POST /etrade/screen under #2373 Slice A", () => {
  it("flag ON + async + uncovered → payment workflow submitted, no screener, no scan", async () => {
    const payment = paymentBinding();
    const { audits, ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(typeof body.runRequestId).toBe("string");
    expect(typeof body.workflowId).toBe("string");
    expect(payment.creates).toHaveLength(1);
    const params = payment.creates[0].params;
    expect(params.family).toBe("stock");
    expect(params.trigger).toBe("manual");
    expect(params.runRequestId).toBe(body.runRequestId);
    expect(params.userId).toBe(LOGIN);
    expect(params.email).toBe(EMAIL);
    expect(params.tenantId).toBe(TENANT);
    expect(params.account.tenantId).toBe(TENANT);
    // Issue #2373 (S1b, F9): the tenant-resolved provider is
    // stamped explicitly (etrade is the route's implied provider),
    // and no broker rides when none is stored.
    expect(params.screenerCommand.provider).toBe("etrade");
    expect("broker" in params.screenerCommand).toBe(false);
    // The payment workflow instance id IS the run request id, and the
    // screener command it carries is the broker's command.
    expect(payment.creates[0].id).toBe(body.runRequestId);
    expect(params.screenerCommand.jobId).toBe(body.runRequestId);
    expect(params.screenerCommand.type).toBe("run-screen");
    expect(params.screenerCommand.role).toBe("parent");
    expect(params.screenerCommand.source).toBe("manual");
    expect(params.screenerCommand.userLogin).toBe(LOGIN);
    expect(params.screenerCommand.tenantId).toBe(TENANT);
    expect(String(params.screenerCommand.jobId)).toMatch(/^screener:manual:NASDAQ100:/);
    expect(audits.map((a) => a.type)).toContain("etrade.screen_payment_started");
  });

  it("flag ON + async + covered → payment_started with the verified command handed to the workflow", async () => {
    coveredAccount();
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.account.tier).toBe("Subscribed");
    expect(payment.creates[0].params.screenerCommand.jobId).toBe(body.runRequestId);
  });

  // Issue #2373 (S1b, gate-before-email): the 400 carries the
  // coded checkout_email_required — the client maps by code — and
  // only when payment is actually needed. The uncovered no-email
  // run below proves the "payment needed" half; the covered
  // no-email tests prove the other half.
  it("flag ON + async + no email + uncovered → 400 checkout_email_required, no payment workflow started", async () => {
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("checkout_email_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + no email + grant-covered → 202 with an empty checkout email, no email demanded", async () => {
    grantAccount();
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.email).toBe("");
  });

  it("flag ON + async + no email + free-run allowance → 202 with an empty checkout email", async () => {
    freeRunState.allowance = 10;
    freeRunState.used = 3;
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.email).toBe("");
  });

  it("flag ON + async + no email + allowance exhausted → 400 checkout_email_required, no workflow started", async () => {
    freeRunState.allowance = 10;
    freeRunState.used = 10;
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("checkout_email_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + no email + unbound commercial store → 400 (coverage unprovable), not 503", async () => {
    storeState.commercialBound = false;
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("checkout_email_required");
    expect(payment.creates).toHaveLength(0);
  });

  // Issue #2373 (S1b, F9): the route's implied provider must match
  // the tenant's stored data-provider selection, or the run is
  // refused with a coded 409 and no fallback is used.
  it("flag ON + async + stored data provider yahoo vs etrade route → 409 FAILURE_PROVIDER_MISMATCH, no workflow started", async () => {
    storeState.dataProviderId = "yahoo";
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("FAILURE_PROVIDER_MISMATCH");
    expect(body.selectedProvider).toBe("yahoo");
    expect(body.requestedProvider).toBe("etrade");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + stored data provider etrade + stored broker alpaca → 202, provider etrade + broker carried as provenance", async () => {
    storeState.dataProviderId = "etrade";
    storeState.brokerId = "alpaca";
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.screenerCommand.provider).toBe("etrade");
    expect(payment.creates[0].params.screenerCommand.broker).toBe("alpaca");
  });

  it("flag ON + sync (no async) → the goal route's 402, no free run", async () => {
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(402);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.error).toBe("monetization_enabled_workflow_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + unbound commercial store → 503, no payment workflow started", async () => {
    storeState.commercialBound = false;
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(503);
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + payment-workflow start failure → 503, no run started", async () => {
    const payment = paymentBinding({ failCreate: true });
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true, email: EMAIL }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(503);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/Payment workflow could not start/);
  });

  it("flag ON + listings branch → never reaches the payment stage", async () => {
    const payment = paymentBinding();
    const { ctx } = etradeCtx(envFor(payment, true), throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("GET", "/api/etrade/screen?mode=listings"),
      urlOf("/api/etrade/screen?mode=listings"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    // The stubbed service has no listings engine, so the branch fails
    // visibly (via the handler catch) — the pin is what it is NOT:
    // no payment submission, no payment_started, and NOT the seam's
    // 402 (a listings request that reached the seam would 402, since
    // it carries no async flag under monetization ON).
    expect(res).not.toBeNull();
    expect(res!.status).not.toBe(402);
    expect(payment.creates).toHaveLength(0);
    if (res!.status === 202) {
      expect(((await res!.json()) as Record<string, unknown>).status).not.toBe("payment_started");
    }
  });

  it("flag OFF + async with no workflow binding → #4278: no direct fallback — the sync branch answers a coded failure", async () => {
    const payment = paymentBinding();
    const env = envFor(payment, false);
    delete env.PAYMENT_WORKFLOW;
    const agent = cannedAgent();
    (agent as any).runScreen = vi.fn((agent as any).runScreen);
    const { ctx } = etradeCtx(env, agent);
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", { async: true }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    // Issue #4278 removed the broker-null sync fallthrough: the
    // sync branch runs through the one engine seam, and the seam
    // cannot start without a workflow binding — so the run answers
    // the caller's coded failure instead of silently running the
    // agent directly. No payment workflow, no direct run.
    expect(res!.status).toBe(500);
    expect(payment.creates).toHaveLength(0);
    expect((agent as any).runScreen).not.toHaveBeenCalled();
  });

  it("flag OFF + sync → today's synchronous run, unchanged", async () => {
    const payment = paymentBinding();
    const agent = cannedAgent();
    const { ctx } = etradeCtx(envFor(payment, false), agent);
    (ctx as any).runStockScreenViaEngine = delegateSeamFake((agent as any).runScreen);
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", {}),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(payment.creates).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Market-data route                                                   */
/* ------------------------------------------------------------------ */

describe("POST /market-data/screen under #2373 Slice A", () => {
  it("flag ON + async + uncovered → payment workflow submitted, no screener, no scan", async () => {
    const payment = paymentBinding();
    const { audits, ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true, email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(payment.creates).toHaveLength(1);
    const params = payment.creates[0].params;
    expect(params.family).toBe("stock");
    expect(params.trigger).toBe("manual");
    expect(params.runRequestId).toBe(body.runRequestId);
    expect(params.userId).toBe(LOGIN);
    expect(params.email).toBe(EMAIL);
    expect(params.tenantId).toBe(TENANT);
    expect(params.screenerCommand.jobId).toBe(body.runRequestId);
    expect(params.screenerCommand.type).toBe("run-screen");
    expect(params.screenerCommand.role).toBe("parent");
    expect(params.screenerCommand.provider).toBe("yahoo");
    expect(params.screenerCommand.deliver).toBe(false);
    expect(audits.map((a) => a.type)).toContain("market_data.screener.payment_started");
  });

  it("flag ON + async + covered → payment_started with the verified command", async () => {
    coveredAccount();
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true, email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.account.tier).toBe("Subscribed");
    expect(payment.creates[0].params.screenerCommand.jobId).toBe(body.runRequestId);
  });

  it("flag ON + GET async=1 with email in the query → payment_started (email from query)", async () => {
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("GET", `/api/market-data/screen?async=1&email=${encodeURIComponent(EMAIL)}`),
      urlOf(`/api/market-data/screen?async=1&email=${encodeURIComponent(EMAIL)}`),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.email).toBe(EMAIL);
  });

  // Issue #2373 (S1b, gate-before-email): see the etrade block —
  // the 400 carries checkout_email_required only when the gate
  // says payment is actually needed; a covered no-email run
  // starts instead.
  it("flag ON + async + no email + uncovered → 400 checkout_email_required, no payment workflow started", async () => {
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("checkout_email_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + no email + free-run allowance → 202 with an empty checkout email", async () => {
    freeRunState.allowance = 10;
    freeRunState.used = 0;
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.email).toBe("");
    expect(payment.creates[0].params.screenerCommand.provider).toBe("yahoo");
  });

  // Issue #2373 (S1b, F9): the market-data route implies yahoo;
  // a stored etrade selection refuses it with a coded 409.
  it("flag ON + async + stored data provider etrade vs market-data route → 409 FAILURE_PROVIDER_MISMATCH, no workflow started", async () => {
    storeState.dataProviderId = "etrade";
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true, email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("FAILURE_PROVIDER_MISMATCH");
    expect(body.selectedProvider).toBe("etrade");
    expect(body.requestedProvider).toBe("yahoo");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + stored data provider yahoo → 202, provider yahoo carried", async () => {
    storeState.dataProviderId = "yahoo";
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true, email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.screenerCommand.provider).toBe("yahoo");
  });

  it("flag ON + GET async=1 with no email + uncovered → 400 checkout_email_required", async () => {
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("GET", "/api/market-data/screen?async=1"),
      urlOf("/api/market-data/screen?async=1"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe("checkout_email_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + sync (no async) → the goal route's 402, no free run", async () => {
    const payment = paymentBinding();
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(402);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.error).toBe("monetization_enabled_workflow_required");
    expect(payment.creates).toHaveLength(0);
  });

  it("flag ON + async + payment-workflow start failure → 503, no run started", async () => {
    const payment = paymentBinding({ failCreate: true });
    const { ctx } = marketCtx(envFor(payment, true), throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", { async: true, email: EMAIL }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(503);
    expect(payment.creates).toHaveLength(0);
  });

  it("flag OFF + sync → today's synchronous run, unchanged", async () => {
    const payment = paymentBinding();
    const agent = cannedAgent();
    const { ctx } = marketCtx(envFor(payment, false), agent);
    (ctx as any).runStockScreenViaEngine = delegateSeamFake((agent as any).runScreen);
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", {}),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(payment.creates).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* ND mode + the extracted command builder                             */
/* ------------------------------------------------------------------ */

describe("ND screenMode under #2373 Slice A", () => {
  it("etrade ND + flag ON → command carries screenMode, no sync fallback", async () => {
    const payment = paymentBinding();
    const env = envFor(payment, true);
    env.SCREENER_ND_MODE = "on";
    const { ctx } = etradeCtx(env, throwingAgent());
    const res = await handleEtradeBrokerRoutes(
      req("POST", "/api/etrade/screen", {
        async: true,
        email: EMAIL,
        screenMode: "non-deterministic",
        screenIntent: "find oversold bounces",
      }),
      urlOf("/api/etrade/screen"),
      "/api/etrade/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.status).toBe("payment_started");
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.screenerCommand.screenMode).toBe("non-deterministic");
    expect(payment.creates[0].params.screenerCommand.screenIntent).toBe("find oversold bounces");
  });

  it("market-data ND + flag ON → command carries screenMode, no sync fallback", async () => {
    const payment = paymentBinding();
    const env = envFor(payment, true);
    env.SCREENER_ND_MODE = "on";
    const { ctx } = marketCtx(env, throwingAgent());
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/screen", {
        async: true,
        email: EMAIL,
        screenMode: "non-deterministic",
        screenIntent: "find oversold bounces",
      }),
      urlOf("/api/market-data/screen"),
      "/api/market-data/screen",
      "s",
      ctx,
    );
    expect(res!.status).toBe(202);
    expect(payment.creates).toHaveLength(1);
    expect(payment.creates[0].params.screenerCommand.screenMode).toBe("non-deterministic");
    expect(payment.creates[0].params.screenerCommand.screenIntent).toBe("find oversold bounces");
  });
});

describe("buildStockScreenWorkflowCommand (#2373 Slice A extraction)", () => {
  const baseSpec = (overrides: Partial<StockScreenRunSpec> = {}): StockScreenRunSpec => ({
    source: "etrade",
    trigger: "manual",
    userLogin: LOGIN,
    deliver: true,
    filters: {},
    universe: "NASDAQ100",
    asyncRequested: true,
    delivery: {},
    ...overrides,
  });

  it("maps a validated spec to the broker's parent command, job id derived from the spec", () => {
    const command = buildStockScreenWorkflowCommand(baseSpec(), { userLogin: LOGIN, tenantId: TENANT });
    expect(command.jobId).toMatch(/^screener:manual:NASDAQ100:/);
    expect(command.type).toBe("run-screen");
    expect(command.source).toBe("manual");
    expect(command.trigger).toBe("manual");
    expect(command.specTrigger).toBe("manual");
    expect(command.userLogin).toBe(LOGIN);
    expect(command.role).toBe("parent");
    expect(command.tenantId).toBe(TENANT);
    expect(command.deliver).toBe(true);
    expect(command.shards).toEqual([{ shardId: "NASDAQ100", universe: "NASDAQ100" }]);
  });

  it("a spec jobId wins over derivation, and ALL fans out to every shardable universe", () => {
    const command = buildStockScreenWorkflowCommand(
      baseSpec({ jobId: "spec-job-1", universe: "ALL" }),
      { userLogin: LOGIN, tenantId: TENANT },
    );
    expect(command.jobId).toBe("spec-job-1");
    expect(command.shards.length).toBeGreaterThan(1);
    expect(command.shards.every((s) => s.shardId === s.universe)).toBe(true);
  });

  it("carries screenMode/screenIntent only when the spec carries them, plus provider and environment", () => {
    const nd = buildStockScreenWorkflowCommand(
      baseSpec({ screenMode: "non-deterministic", screenIntent: "bounce hunt" }),
      { userLogin: LOGIN, tenantId: TENANT, environment: "TEST", portfolioContext: true },
    );
    expect(nd.screenMode).toBe("non-deterministic");
    expect(nd.screenIntent).toBe("bounce hunt");
    expect(nd.environment).toBe("TEST");
    expect(nd.portfolioContext).toBe(true);
    const plain = buildStockScreenWorkflowCommand(baseSpec(), { userLogin: LOGIN, tenantId: TENANT });
    expect("screenMode" in plain).toBe(false);
    expect("environment" in plain).toBe(false);
    const md = buildStockScreenWorkflowCommand(
      baseSpec({ source: "market-data", provider: "yahoo", deliver: false }),
      { userLogin: LOGIN, tenantId: TENANT },
    );
    expect(md.provider).toBe("yahoo");
    expect(md.deliver).toBe(false);
  });

  // Issue #2373 (S1b, F9): the paid seam passes the
  // tenant-resolved provider, which wins over the spec's
  // route-implied provider, and the stored broker rides as
  // provenance only — never a defaulted broker.
  it("deps.provider wins over the spec provider, and deps.brokerId rides as provenance only", () => {
    const command = buildStockScreenWorkflowCommand(baseSpec({ provider: "yahoo" }), {
      userLogin: LOGIN,
      tenantId: TENANT,
      provider: "etrade",
      brokerId: "alpaca",
    });
    expect(command.provider).toBe("etrade");
    expect(command.broker).toBe("alpaca");
    const plain = buildStockScreenWorkflowCommand(baseSpec({ provider: "yahoo" }), {
      userLogin: LOGIN,
      tenantId: TENANT,
    });
    expect(plain.provider).toBe("yahoo");
    expect("broker" in plain).toBe(false);
  });

  it("the broker's contract is preserved: async false → null, and the broker builds the same command", async () => {
    // Issue #3084: both builds below must carry the SAME spec jobId.
    // Without it, each build stamps jobId from new Date().toISOString()
    // and the toEqual below passes only when both builds land in the
    // same millisecond — a real race that failed CI shard 2/4 once
    // (and the #3049 full suite before it). Derivation itself stays
    // covered by the "job id derived from the spec" test above.
    const specJobId = "broker-contract-job";
    const sync = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: baseSpec({ asyncRequested: false }),
      userLogin: LOGIN,
      starter: async () => {
        throw new Error("broker must not start for a sync spec");
      },
    });
    expect(sync).toBeNull();
    const seen: unknown[] = [];
    const started = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: baseSpec({ jobId: specJobId }),
      userLogin: LOGIN,
      starter: async (_env, command) => {
        seen.push(command);
        return { workflowId: "wf-1", jobId: command.jobId } as never;
      },
    });
    expect(started).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect((seen[0] as { jobId: string }).jobId).toBe(started!.jobId);
    expect(seen[0]).toEqual(
      buildStockScreenWorkflowCommand(baseSpec({ jobId: specJobId }), {
        userLogin: LOGIN,
        tenantId: workflowTenantId({} as never),
      }),
    );
  });
});
