/**
 * Issue #2378 (Agent Mesh S10, #2225 G5) — a chat paid request
 * is a PaymentWorkflow run with a PaymentsAgent budget check
 * first.
 *
 * The chat stock-screen surface is the NLQ async job; its
 * executor binds `nlqStockScreenPort`. These tests drive THAT
 * port (the chat path's dispatch point) with the workflows
 * faked only at the binding seams:
 *   - the PAYMENT_WORKFLOW binding seam is a fake whose
 *     create() runs the REAL runPaymentWorkflowFlow with a
 *     REAL NativeMonetizationGate (in-memory price catalogue;
 *     a fake card CheckoutPort for the checkout cases), and
 *     whose startScreener dep forwards the caller-built
 *     screener command into the S8 harness's
 *     InMemoryWorkflowAdapter running the real screener flows;
 *   - the PaymentsAgent budget check is the port's ctx seam
 *     (production: the S5 door, checkPaymentBudgetViaDoor);
 *   - flag / price / account stores / checkout email are the
 *     port's ctx seams (production defaults derive from env
 *     exactly as the routes derive theirs).
 *
 * Programme acceptance (#2225): start the real workflow from
 * the chat path; unpaid → zero screener runs; paid/covered →
 * exactly one payment start via the seam, the screener started
 * by the payment flow, and the result read back from
 * mas_reports.
 */
import { describe, expect, it } from "vitest";
import {
  nlqStockScreenPort,
  type NlqPortsContext,
} from "../src/agents/orchestrator/nlqPorts";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { PaymentWorkflowEventParams } from "../src/workflows/paymentWorkflow";
import { NativeMonetizationGate } from "../src/services/nativeMonetization";
import type { CheckoutPort, CheckoutPorts } from "../src/services/checkoutPorts";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { PaidScreenStorePorts } from "../src/services/paidScreenSubmission";
import { workflowTenantId } from "../src/workflows/screenerWorkflowRoutes";
import type { Env } from "../src/types";
import { MockSqlStorage } from "./mock-sql";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

const LOGIN = "alice";
const EMAIL = "alice@example.com";
const STOCK_PRICE_USD = 0.02;
const TENANT = workflowTenantId({} as Env);

function fullResult(universe: string, overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: LOGIN,
    ...overrides,
  };
}

interface PaidHarnessOptions {
  monetizationOn?: boolean;
  budgetVerdict?: { allowed: boolean; reason?: string };
  priceUSD?: number | null;
  checkoutEmail?: string | null;
  /** null → unbound stores seam (fail-closed case). */
  stores?: PaidScreenStorePorts | null;
  /** How the fake payment binding's real gate is configured. */
  gateCheckout?: "none" | "stripe";
  /** Scripted waitForEvent behavior for the checkout path. */
  approval?: "approved" | "timeout";
  /** Whether the fake Stripe session reads back paid. */
  stripePaid?: boolean;
}

interface Harness {
  ctx: NlqPortsContext;
  sql: MockSqlStorage;
  screenerStarts: WorkflowJobCommand[];
  budgetCalls: Array<{ operation: string; amountCents: number }>;
  paymentCreates: Array<{ id: string; params: PaymentWorkflowEventParams }>;
  paymentEvents: PaymentWorkflowEvent[];
  coverageConsumed: Array<{ userId: string; paidVia: string; priceUSD: number }>;
  failureCredits: Array<{ runRequestId: string; priceUSD: number }>;
  checkouts: Array<{ runRequestId: string; priceUSD: number; email: string; userId: string }>;
  agentCalls: Array<Record<string, unknown>>;
}

function subscribedStores(): PaidScreenStorePorts {
  const commercial = {
    getAccount: async (userId: string) => ({
      id: userId,
      tenantId: TENANT,
      tier: "Subscribed" as const,
      tierSource: "operator" as const,
      creditsUSD: 0,
      includedRuns: 1,
      updatedAtMs: Date.now(),
    }),
  } as unknown as CommercialStore;
  const subscriptions = {
    listSubscriptions: async () => [],
  } as unknown as SubscriptionStore;
  return { commercial, subscriptions };
}

function makeHarness(opts: PaidHarnessOptions = {}): Harness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const screenerStarts: WorkflowJobCommand[] = [];
  const budgetCalls: Harness["budgetCalls"] = [];
  const paymentCreates: Harness["paymentCreates"] = [];
  const paymentEvents: PaymentWorkflowEvent[] = [];
  const coverageConsumed: Harness["coverageConsumed"] = [];
  const failureCredits: Harness["failureCredits"] = [];
  const checkouts: Harness["checkouts"] = [];
  const agentCalls: Array<Record<string, unknown>> = [];

  /* ---- the real screener workflow, behind its adapter (S8) ---- */
  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = fullResult(req.universe ?? "TECH");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
  };
  const screenerAdapter = new InMemoryWorkflowAdapter(deps);
  const recordingScreenerPort: WorkflowPort = {
    start: async (command) => {
      screenerStarts.push(command);
      return screenerAdapter.start(command);
    },
    status: (workflowId) => screenerAdapter.status(workflowId),
  };

  /* ---- the fake PAYMENT_WORKFLOW binding: create() runs the
   * REAL payment flow with a REAL native gate ---- */
  const cardPort: CheckoutPort = {
    rail: "stripe",
    createCheckout: async (input) => {
      checkouts.push({
        runRequestId: input.runRequestId,
        priceUSD: input.priceUSD,
        email: input.email,
        userId: input.userId,
      });
      return { rail: "stripe", checkoutId: "cs_test_123", checkoutUrl: "https://checkout.example/cs_test_123" };
    },
    retrieveCardSession: async ({ sessionId }) => ({
      sessionId,
      status: "complete",
      paymentStatus: (opts.stripePaid ?? true) ? "paid" : "unpaid",
      amountTotalCents: Math.round(STOCK_PRICE_USD * 100),
      clientReferenceId: checkouts[checkouts.length - 1]?.runRequestId ?? "",
      paymentIntentId: "pi_test_123",
    }),
    verifyCryptoPayment: async () => ({ verified: false, payer: null, nonce: null }),
  };
  const gateCheckoutPorts: CheckoutPorts | null =
    opts.gateCheckout === "stripe" ? { card: cardPort, x402: null } : null;

  const instances = new Map<string, { status: string; output?: PaymentWorkflowOutcome }>();
  const runRealPaymentFlow = async (
    params: PaymentWorkflowEventParams,
  ): Promise<PaymentWorkflowOutcome> => {
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: {
        getPrice: async (family: string) => (family === "stock" ? STOCK_PRICE_USD : null),
        // #2547: gates resolve through the approval-aware read;
        // this stub's stock price is an approved fixture.
        getApprovedPrice: async (family: string) => (family === "stock" ? STOCK_PRICE_USD : null),
        getEntry: async (family: string) =>
          family === "stock"
            ? { family: "stock" as const, priceUSD: STOCK_PRICE_USD, updatedAtMs: 0, approvalStatus: "approved" as const, approvedBy: "test-operator", approvedAtMs: 0 }
            : null,
      },
      checkout: gateCheckoutPorts,
    });
    const step: PaymentWorkflowStep = {
      do: async (_name, fn) => fn(),
      waitForEvent: async (name) => {
        if (name === "await-payment-approval") {
          if ((opts.approval ?? "approved") === "timeout") {
            throw new Error("waitForEvent timeout (scripted)");
          }
          return { payload: { approved: true, approverId: LOGIN } };
        }
        if (name === "await-payment-verified") {
          return { payload: { sessionId: "cs_test_123" } };
        }
        throw new Error(`unexpected waitForEvent: ${name}`);
      },
    };
    const flowDeps: PaymentWorkflowDeps = {
      gate,
      account: params.account,
      startScreener: async () => {
        const handle = await recordingScreenerPort.start(params.screenerCommand);
        return { workflowId: handle.workflowId };
      },
      recordEvent: async (e) => {
        paymentEvents.push(e);
      },
      issueFailureCredit: async (runRequestId, priceUSD) => {
        failureCredits.push({ runRequestId, priceUSD });
      },
      consumeCoverage: async (use) => {
        coverageConsumed.push(use);
      },
    };
    const { account: _account, screenerCommand: _cmd, ...flowParams } = params;
    return runPaymentWorkflowFlow(flowParams, flowDeps, step);
  };

  const paymentBinding = {
    create: async ({ id, params }: { id: string; params: PaymentWorkflowEventParams }) => {
      // Snapshot at submission time: the real gate decrements
      // the account's included runs in place during its check,
      // so the live object no longer shows the submitted state.
      paymentCreates.push({
        id,
        params: { ...params, account: { ...params.account } },
      });
      const inst: { status: string; output?: PaymentWorkflowOutcome } = { status: "running" };
      instances.set(id, inst);
      void runRealPaymentFlow(params).then(
        (outcome) => {
          inst.output = outcome;
          inst.status = "complete";
        },
        () => {
          inst.status = "errored";
        },
      );
      return { id };
    },
    get: async (_id: string) => ({ sendEvent: async () => {} }),
  };

  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      return {
        runScreen: async (req: Record<string, unknown>) => {
          agentCalls.push(req);
          throw new Error("direct ScreenerAgent fallback must not run on the paid path");
        },
      } as never;
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
    workflowPort: recordingScreenerPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    /* ---- S10 paid-path seams ---- */
    monetizationOn: async () => opts.monetizationOn ?? false,
    paidScreenPriceUSD: async () => (opts.priceUSD === undefined ? STOCK_PRICE_USD : opts.priceUSD),
    paidBudgetCheck: async (_actingLogin, input) => {
      budgetCalls.push(input);
      return opts.budgetVerdict ?? { allowed: true };
    },
    checkoutEmail: () => (opts.checkoutEmail === undefined ? EMAIL : opts.checkoutEmail),
    paidScreenStores: opts.stores === undefined ? subscribedStores() : opts.stores,
    paymentWorkflowBinding: paymentBinding as never,
    paymentWorkflowStatus: async (workflowId) => {
      const inst = instances.get(workflowId);
      if (!inst) return null;
      return {
        status: inst.status,
        ...(inst.output ? { output: inst.output } : {}),
      };
    },
  };
  return {
    ctx,
    sql,
    screenerStarts,
    budgetCalls,
    paymentCreates,
    paymentEvents,
    coverageConsumed,
    failureCredits,
    checkouts,
    agentCalls,
  };
}

const FILTERS = { universe: "NASDAQ100", minPrice: 10 } as never;

/* ------------------------------------------------------------------ */
/* The gate's dispositions                                             */
/* ------------------------------------------------------------------ */

describe("issue #2378 — chat paid request as a PaymentWorkflow run (G5)", () => {
  it("flag OFF: the free path runs exactly as today — zero budget checks, zero payment starts", async () => {
    const h = makeHarness({ monetizationOn: false });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });

    expect(result.success).toBe(true);
    expect(result.allStocks.map((s) => s.symbol)).toEqual(["NVDA", "AMD"]);
    expect(h.screenerStarts).toHaveLength(1);
    expect(h.budgetCalls).toHaveLength(0);
    expect(h.paymentCreates).toHaveLength(0);
  });

  it("identity missing: fail-closed before the budget check and before any start, flag ON or OFF", async () => {
    for (const monetizationOn of [true, false]) {
      const h = makeHarness({ monetizationOn });
      const port = nlqStockScreenPort(h.ctx);
      await expect(
        port.runScreen({ filters: FILTERS, userLogin: "" }),
      ).rejects.toThrow(/identity|login/i);
      await expect(
        port.runScreen({ filters: FILTERS, userLogin: "default" }),
      ).rejects.toThrow(/identity|login/i);
      expect(h.budgetCalls).toHaveLength(0);
      expect(h.paymentCreates).toHaveLength(0);
      expect(h.screenerStarts).toHaveLength(0);
      expect(h.agentCalls).toHaveLength(0);
    }
  });

  it("no stored price: fail-closed before the budget check and before any start", async () => {
    const h = makeHarness({ monetizationOn: true, priceUSD: null });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: FILTERS, userLogin: LOGIN }),
    ).rejects.toThrow(/price/i);
    expect(h.budgetCalls).toHaveLength(0);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.screenerStarts).toHaveLength(0);
  });

  it("budget refusal: honest coded refusal, zero workflow starts, no free fallback", async () => {
    const h = makeHarness({
      monetizationOn: true,
      budgetVerdict: { allowed: false, reason: "daily spend cap reached for this operation" },
    });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: FILTERS, userLogin: LOGIN }),
    ).rejects.toThrow(/budget/i);
    await expect(
      port.runScreen({ filters: FILTERS, userLogin: LOGIN }),
    ).rejects.toThrow(/daily spend cap reached/);
    expect(h.budgetCalls).toEqual([
      { operation: "nlq.execute", amountCents: Math.round(STOCK_PRICE_USD * 100) },
      { operation: "nlq.execute", amountCents: Math.round(STOCK_PRICE_USD * 100) },
    ]);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.screenerStarts).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
  });

  it("no checkout email resolvable: honest refusal, zero starts (the route's 400, in chat shape)", async () => {
    const h = makeHarness({ monetizationOn: true, checkoutEmail: null });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: FILTERS, userLogin: LOGIN }),
    ).rejects.toThrow(/checkout email/i);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.screenerStarts).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
  });

  it("account store unbound: fail-closed, zero starts", async () => {
    const h = makeHarness({ monetizationOn: true, stores: null });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: FILTERS, userLogin: LOGIN }),
    ).rejects.toThrow(/account store is unavailable|verified coverage/i);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.screenerStarts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance: the real PaymentWorkflow, started from the chat port    */
/* ------------------------------------------------------------------ */

describe("issue #2378 — acceptance", () => {
  it("covered account: exactly one payment start via the seam; the real flow starts the screener; result read back", async () => {
    const h = makeHarness({ monetizationOn: true, gateCheckout: "none" });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });

    // Budget consulted first, against the catalogue price, under
    // the NLQ operation the guard allowlists.
    expect(h.budgetCalls).toEqual([
      { operation: "nlq.execute", amountCents: Math.round(STOCK_PRICE_USD * 100) },
    ]);

    // Exactly one payment workflow start, through the seam: the
    // instance id IS the run-request id IS the screener job id.
    expect(h.paymentCreates).toHaveLength(1);
    const { id, params } = h.paymentCreates[0];
    expect(params.runRequestId).toBe(id);
    expect(params.screenerCommand.jobId).toBe(id);
    expect(id.startsWith("screener:chat:NASDAQ100:")).toBe(true);
    expect(params.family).toBe("stock");
    expect(params.trigger).toBe("manual");
    expect(params.userId).toBe(LOGIN);
    expect(params.email).toBe(EMAIL);
    expect(params.tenantId).toBe(TENANT);
    expect(params.account).toMatchObject({
      userId: LOGIN,
      email: EMAIL,
      tier: "Subscribed",
      includedRunsRemaining: 1,
    });
    expect(params.screenerCommand.userLogin).toBe(LOGIN);
    expect(params.screenerCommand.source).toBe("nlq-chat");
    expect(params.screenerCommand.filters).toMatchObject({ universe: "NASDAQ100", minPrice: 10 });

    // The payment flow consumed the coverage and started the
    // screener exactly once, with the caller-built command.
    expect(h.coverageConsumed).toEqual([
      { userId: LOGIN, paidVia: "subscription_included", priceUSD: STOCK_PRICE_USD },
    ]);
    expect(h.paymentEvents.map((e) => e.type)).toContain("payment.covered");
    expect(h.screenerStarts).toHaveLength(1);
    expect(h.screenerStarts[0].jobId).toBe(id);

    // The chat result is the screener run's own stored result.
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(result.totalScanned).toBe(100);
    expect(result.matchedCount).toBe(2);
    expect(result.allStocks.map((s) => s.symbol)).toEqual(["NVDA", "AMD"]);
    expect(h.agentCalls).toHaveLength(0);
    expect(h.failureCredits).toHaveLength(0);
  });

  it("checkout path: approval + provider-verified payment through the real gate starts the screener", async () => {
    const freeStores: PaidScreenStorePorts = {
      commercial: {
        getAccount: async () => null,
      } as unknown as CommercialStore,
      subscriptions: {
        listSubscriptions: async () => [],
      } as unknown as SubscriptionStore,
    };
    const h = makeHarness({
      monetizationOn: true,
      gateCheckout: "stripe",
      approval: "approved",
      stripePaid: true,
      stores: freeStores,
    });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });

    expect(h.paymentCreates).toHaveLength(1);
    expect(h.checkouts).toEqual([
      {
        runRequestId: h.paymentCreates[0].id,
        priceUSD: STOCK_PRICE_USD,
        email: EMAIL,
        userId: LOGIN,
      },
    ]);
    expect(h.paymentEvents.map((e) => e.type)).toContain("payment.checkout_created");
    expect(h.paymentEvents.map((e) => e.type)).toContain("payment.confirmed");
    expect(h.screenerStarts).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.matchedCount).toBe(2);
  });

  it("checkout path unpaid: approval never lands → zero screener runs, honest payment-state result", async () => {
    const freeStores: PaidScreenStorePorts = {
      commercial: {
        getAccount: async () => null,
      } as unknown as CommercialStore,
      subscriptions: {
        listSubscriptions: async () => [],
      } as unknown as SubscriptionStore,
    };
    const h = makeHarness({
      monetizationOn: true,
      gateCheckout: "stripe",
      approval: "timeout",
      stores: freeStores,
    });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });

    expect(h.paymentCreates).toHaveLength(1);
    expect(h.screenerStarts).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/payment/i);
    expect(result.error).toMatch(/expired/);
    expect(result.error).toContain(h.paymentCreates[0].id);
    expect(result.allStocks).toEqual([]);
  });
});
