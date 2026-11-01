/**
 * #2041 G-METERING: saga paid runs meter one usage_event; non-saga
 * runs meter none. TDD pins for the wiring slice:
 *
 * - Flow: recordUsage fires AFTER confirm-paid succeeds (never
 *   earlier, never on covered runs), with the provider receipt id
 *   (Stripe session id / x402 payment proof), category "saga",
 *   and the gate-check price. It throws fail-closed on meter
 *   failure, and never fires without a saga meterContext.
 * - Route: POST /api/meter/event writes the row via the DO usage
 *   port (id use_<receiptId>, runId = receiptId, category saga,
 *   tier store-resolved with a Free fallback), fails closed on
 *   store failure, and dedupes a retried insert to one row.
 */

import { describe, it, expect } from "vitest";

import {
  runPaymentWorkflowFlow,
  type PaymentGate,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import { handleMeterRoutes } from "../src/agents/routes/meter";
import type { CanonicalReportStoreSqlExecutor } from "../src/data/canonicalReportStorePorts";

/* ------------------------------------------------------------------ */
/* Payment-flow harness: fake gate + fake step + capturing deps.       */
/* ------------------------------------------------------------------ */

const BASE_ACCOUNT = {
  userId: "u1",
  email: "u1@example.com",
  tenantId: "t1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
} as const;

function paidParams(over: Partial<PaymentWorkflowParams> = {}): PaymentWorkflowParams {
  return {
    runRequestId: "run-1",
    family: "goal",
    trigger: "manual",
    tenantId: "t1",
    userId: "u1",
    email: "u1@example.com",
    meterContext: { category: "saga", userLogin: "u1login" },
    ...over,
  };
}

/** Fake gate: check returns the configured decision; confirmPaid likewise. */
function fakeGate(checkDecision: unknown, confirmDecision: unknown): PaymentGate {
  return {
    check: async () => checkDecision as never,
    confirmPaid: async () => confirmDecision as never,
  };
}

/** Fake step: do runs immediately; waitForEvent replays a queue. */
function fakeStep(events: Array<Record<string, unknown>>): PaymentWorkflowStep {
  const queue = [...events];
  return {
    waitForEvent: async () => ({ payload: queue.shift()! as never }),
    do: async (_name: string, fn: () => Promise<never>) => fn(),
  };
}

interface FlowCapture {
  recordUsageCalls: Array<Record<string, unknown>>;
  startScreenerCalls: number;
  events: Array<Record<string, unknown>>;
}

function flowDeps(
  gate: PaymentGate,
  capture: FlowCapture,
  opts: { recordUsageThrows?: Error; withRecordUsage?: boolean } = {},
): PaymentWorkflowDeps {
  const deps: PaymentWorkflowDeps = {
    gate,
    account: BASE_ACCOUNT as never,
    startScreener: async () => {
      capture.startScreenerCalls += 1;
      return { workflowId: "scr-1" };
    },
    recordEvent: async (event) => {
      capture.events.push(event as unknown as Record<string, unknown>);
    },
    issueFailureCredit: async () => {},
  };
  if (opts.withRecordUsage !== false) {
    deps.recordUsage = async (usage) => {
      if (opts.recordUsageThrows) throw opts.recordUsageThrows;
      capture.recordUsageCalls.push(usage as unknown as Record<string, unknown>);
    };
  }
  return deps;
}

const CHECK_UNPAID = {
  allowed: false,
  status: "payment_required",
  httpStatus: 402,
  runRequestId: "run-1",
  priceUSD: 0.1,
  family: "goal",
  checkout: { checkoutId: "chk-1" },
};

const CONFIRM_PAID_STRIPE = {
  allowed: true,
  status: "paid",
  runRequestId: "run-1",
  priceUSD: 0.1,
  paidVia: "stripe_checkout",
};

const CONFIRM_PAID_X402 = {
  allowed: true,
  status: "paid",
  runRequestId: "run-1",
  priceUSD: 0.1,
  paidVia: "x402",
};

describe("payment flow meterUsage (issue #2041 G-METERING)", () => {
  it("stripe paid saga run records one usage row after confirm-paid", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    const outcome = await runPaymentWorkflowFlow(
      paidParams(),
      flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_STRIPE), capture),
      fakeStep([{ approved: true }, { sessionId: "cs_test_1" }]),
    );
    expect(outcome.status).toBe("started");
    expect(capture.startScreenerCalls).toBe(1);
    expect(capture.recordUsageCalls).toEqual([
      { receiptId: "cs_test_1", protocol: "stripe", userLogin: "u1login", priceUSD: 0.1 },
    ]);
  });

  it("x402 paid saga run records the payment proof as the receipt id", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    const outcome = await runPaymentWorkflowFlow(
      paidParams(),
      flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_X402), capture),
      fakeStep([{ approved: true }, { paymentProof: "proof-abc", payer: "0xabc" }]),
    );
    expect(outcome.status).toBe("started");
    expect(capture.recordUsageCalls).toEqual([
      { receiptId: "proof-abc", protocol: "x402", userLogin: "u1login", priceUSD: 0.1 },
    ]);
  });

  it("meter failure blocks the run: the step throws and the screen never starts", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    await expect(
      runPaymentWorkflowFlow(
        paidParams(),
        flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_STRIPE), capture, {
          recordUsageThrows: new Error("meter down"),
        }),
        fakeStep([{ approved: true }, { sessionId: "cs_test_1" }]),
      ),
    ).rejects.toThrow("meter down");
    expect(capture.startScreenerCalls).toBe(0);
  });

  it("no meterContext: no meter row, behavior exactly as today", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    const { meterContext: _dropped, ...params } = paidParams();
    const outcome = await runPaymentWorkflowFlow(
      params,
      flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_STRIPE), capture),
      fakeStep([{ approved: true }, { sessionId: "cs_test_1" }]),
    );
    expect(outcome.status).toBe("started");
    expect(capture.recordUsageCalls).toHaveLength(0);
  });

  it("covered run with meterContext: no meter row (no confirm-paid, no payment)", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    const outcome = await runPaymentWorkflowFlow(
      paidParams(),
      flowDeps(
        fakeGate(
          { allowed: true, status: "covered", runRequestId: "run-1", priceUSD: 0.1, paidVia: "subscription_included" },
          CONFIRM_PAID_STRIPE,
        ),
        capture,
      ),
      fakeStep([]),
    );
    expect(outcome.status).toBe("started");
    expect(capture.recordUsageCalls).toHaveLength(0);
  });

  it("meterContext present but recordUsage dep absent: fail loud, never start unmetered", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    await expect(
      runPaymentWorkflowFlow(
        paidParams(),
        flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_STRIPE), capture, { withRecordUsage: false }),
        fakeStep([{ approved: true }, { sessionId: "cs_test_1" }]),
      ),
    ).rejects.toThrow(/miswired/);
    expect(capture.startScreenerCalls).toBe(0);
  });

  it("confirmed payment with no provider receipt id: fail closed, never start unmetered", async () => {
    const capture: FlowCapture = { recordUsageCalls: [], startScreenerCalls: 0, events: [] };
    await expect(
      runPaymentWorkflowFlow(
        paidParams(),
        flowDeps(fakeGate(CHECK_UNPAID, CONFIRM_PAID_STRIPE), capture),
        fakeStep([{ approved: true }, {}]),
      ),
    ).rejects.toThrow(/no provider receipt id/);
    expect(capture.startScreenerCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Meter route harness: Map-backed fake sql executor.                  */
/* ------------------------------------------------------------------ */

class FakeSql {
  rows = new Map<string, Record<string, unknown>>();
  throwOnInsert: Error | null = null;

  exec(query: string, ...params: unknown[]): unknown[] {
    if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) return [];
    if (query.startsWith("INSERT INTO")) {
      if (this.throwOnInsert) throw this.throwOnInsert;
      const id = params[0] as string;
      if (this.rows.has(id)) throw new Error("UNIQUE constraint failed: usage_events.id");
      this.rows.set(id, {
        id: params[0],
        userLogin: params[1],
        runId: params[2],
        category: params[3],
        createdAt: params[4],
        detailJson: params[5],
      });
      return [];
    }
    throw new Error(`unexpected sql: ${query}`);
  }
}

function meterRequest(body: Record<string, unknown>): Request {
  return new Request("https://agent.internal/api/meter/event", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const METER_URL = new URL("https://agent.internal/api/meter/event");

async function postMeter(
  sql: FakeSql,
  body: Record<string, unknown>,
  opts: { resolveTier?: (userLogin: string) => Promise<string | null> } = {},
) {
  return handleMeterRoutes(meterRequest(body), METER_URL, "/api/meter/event", "test-session", {
    sql: sql as unknown as CanonicalReportStoreSqlExecutor,
    env: {},
    ...(opts.resolveTier ? { resolveTier: opts.resolveTier } : {}),
  });
}

describe("meter route (issue #2041 G-METERING)", () => {
  it("stripe happy path writes one saga row, tier Free when no tier store", async () => {
    const sql = new FakeSql();
    const res = await postMeter(sql, {
      receiptId: "cs_test_1",
      protocol: "stripe",
      userLogin: "u1login",
      priceUSD: 0.1,
      category: "saga",
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    expect(await res!.json()).toEqual({ id: "use_cs_test_1", duplicate: false });
    expect(sql.rows.size).toBe(1);
    const row = sql.rows.get("use_cs_test_1")!;
    expect(row.userLogin).toBe("u1login");
    expect(row.runId).toBe("cs_test_1");
    expect(row.category).toBe("saga");
    expect(JSON.parse(row.detailJson as string)).toEqual({
      receiptId: "cs_test_1",
      priceUSD: 0.1,
      tier: "Free",
      protocol: "stripe",
    });
  });

  it("x402 happy path records protocol x402 with the proof as receipt", async () => {
    const sql = new FakeSql();
    const res = await postMeter(sql, {
      receiptId: "proof-abc",
      protocol: "x402",
      userLogin: "u1login",
      priceUSD: 0.1,
      category: "saga",
    });
    expect(res!.status).toBe(201);
    const row = sql.rows.get("use_proof-abc")!;
    expect(JSON.parse(row.detailJson as string)).toEqual({
      receiptId: "proof-abc",
      priceUSD: 0.1,
      tier: "Free",
      protocol: "x402",
    });
  });

  it("retried insert dedupes: second identical post reports duplicate, still one row", async () => {
    const sql = new FakeSql();
    const body = {
      receiptId: "cs_test_1",
      protocol: "stripe",
      userLogin: "u1login",
      priceUSD: 0.1,
      category: "saga",
    };
    const first = await postMeter(sql, body);
    expect(first!.status).toBe(201);
    const second = await postMeter(sql, body);
    expect(second!.status).toBe(201);
    expect(await second!.json()).toEqual({ id: "use_cs_test_1", duplicate: true });
    expect(sql.rows.size).toBe(1);
  });

  it("validation failures are 400: bad category, missing receipt, bad price, bad protocol", async () => {
    const sql = new FakeSql();
    const base = {
      receiptId: "cs_test_1",
      protocol: "stripe",
      userLogin: "u1login",
      priceUSD: 0.1,
      category: "saga",
    };
    for (const over of [
      { category: "goal" },
      { receiptId: "" },
      { priceUSD: 0 },
      { protocol: "mpp" },
      { userLogin: "" },
    ]) {
      const res = await postMeter(sql, { ...base, ...over });
      expect(res!.status).toBe(400);
    }
    expect(sql.rows.size).toBe(0);
  });

  it("store failure fails closed with 500, never a silent swallow", async () => {
    const sql = new FakeSql();
    sql.throwOnInsert = new Error("database is locked");
    const res = await postMeter(sql, {
      receiptId: "cs_test_1",
      protocol: "stripe",
      userLogin: "u1login",
      priceUSD: 0.1,
      category: "saga",
    });
    expect(res!.status).toBe(500);
    expect(sql.rows.size).toBe(0);
  });

  it("tier resolves from the store when the resolver returns one", async () => {
    const sql = new FakeSql();
    const res = await postMeter(
      sql,
      {
        receiptId: "cs_test_1",
        protocol: "stripe",
        userLogin: "u1login",
        priceUSD: 0.1,
        category: "saga",
      },
      { resolveTier: async () => "PayPerUse" },
    );
    expect(res!.status).toBe(201);
    const row = sql.rows.get("use_cs_test_1")!;
    expect(JSON.parse(row.detailJson as string).tier).toBe("PayPerUse");
  });

  it("non-matching path or method returns null", async () => {
    const sql = new FakeSql();
    const res = await handleMeterRoutes(
      new Request("https://agent.internal/api/meter/other", { method: "POST", body: "{}" }),
      new URL("https://agent.internal/api/meter/other"),
      "/api/meter/other",
      "test-session",
      { sql: sql as unknown as CanonicalReportStoreSqlExecutor, env: {} },
    );
    expect(res).toBeNull();
    expect(sql.rows.size).toBe(0);
  });
});
