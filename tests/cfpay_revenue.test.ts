/**
 * Issue #2022 (Goal 4) — cfpay revenue report.
 *
 * The aggregator is pure: ledger rows are authoritative for money,
 * audit payloads joined on run id attribute family and coverage,
 * with explicit "unknown" buckets where an audit row is missing.
 * The endpoint test calls handleAgenticPaymentsRoutes with a fake
 * ORM, mirroring the ads route tests' fake pattern.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aggregateCfpayRevenue,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
} from "../src/services/cfpayLedger";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

const charge = (run: string, price: number) =>
  buildCfpayChargeTransaction({ runRequestId: run, userId: "u1", family: "goal", priceUSD: price });
const credit = (run: string, price: number) =>
  buildCfpayCreditTransaction({ runRequestId: run, userId: "u1", family: "goal", priceUSD: price });

describe("aggregateCfpayRevenue (#2022)", () => {
  it("totals come from the ledger; family comes from the audit join", () => {
    const report = aggregateCfpayRevenue(
      [charge("run-1", 0.1), charge("run-2", 0.05)],
      [credit("run-1", 0.1)],
      [
        { runRequestId: "run-1", family: "goal" },
        { runRequestId: "run-2", family: "options" },
      ],
      [{ runRequestId: "run-3", paidVia: "subscription_included" }],
      [{ runRequestId: "run-1", family: "goal" }],
    );
    expect(report.charges).toEqual({ count: 2, totalUSD: 0.15 });
    expect(report.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.netUSD).toBe(0.05);
    // Owner-directed cost assumption: 1/5 of revenue, not measured.
    expect(report.assumedCostUSD).toBe(0.03);
    expect(report.grossProfitUSD).toBe(0.12);
    expect(report.netProfitUSD).toBe(0.02);
    expect(report.costAssumption).toBe("cost assumed at 1/5 of revenue (owner-directed, not measured)");
    expect(report.byFamily["goal"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.1,
      credits: 1,
      creditTotalUSD: 0.1,
      assumedCostUSD: 0.02,
      profitUSD: -0.02,
    });
    expect(report.byFamily["options"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.05,
      credits: 0,
      creditTotalUSD: 0,
      assumedCostUSD: 0.01,
      profitUSD: 0.04,
    });
    expect(report.coveredByPaidVia).toEqual({ subscription_included: 1 });
    expect(report.chargesWithoutFamily).toBe(0);
    expect(report.coveredWithoutPaidVia).toBe(0);
  });

  it("missing audit rows land in unknown buckets without moving totals", () => {
    const report = aggregateCfpayRevenue(
      [charge("run-9", 0.1)],
      [credit("run-8", 0.1)],
      [],
      [{ runRequestId: "run-7" }],
      [],
    );
    expect(report.charges).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.netUSD).toBe(0);
    // The unknown bucket carries assumed cost too: cost applies to
    // revenue regardless of attribution.
    expect(report.assumedCostUSD).toBe(0.02);
    expect(report.grossProfitUSD).toBe(0.08);
    expect(report.netProfitUSD).toBe(-0.02);
    expect(report.byFamily["unknown"]).toEqual({
      charges: 1,
      chargeTotalUSD: 0.1,
      credits: 1,
      creditTotalUSD: 0.1,
      assumedCostUSD: 0.02,
      profitUSD: -0.02,
    });
    expect(report.chargesWithoutFamily).toBe(1);
    expect(report.creditsWithoutFamily).toBe(1);
    expect(report.coveredByPaidVia).toEqual({ unknown: 1 });
    expect(report.coveredWithoutPaidVia).toBe(1);
  });

  it("empty ledgers report zeros, not nulls", () => {
    const report = aggregateCfpayRevenue([], [], [], [], []);
    expect(report.charges).toEqual({ count: 0, totalUSD: 0 });
    expect(report.netUSD).toBe(0);
    expect(report.assumedCostUSD).toBe(0);
    expect(report.grossProfitUSD).toBe(0);
    expect(report.netProfitUSD).toBe(0);
    expect(report.costAssumption).toBe("cost assumed at 1/5 of revenue (owner-directed, not measured)");
    expect(report.byFamily).toEqual({});
    expect(report.coveredByPaidVia).toEqual({});
  });
});

describe("cfpay revenue endpoint (#2022)", () => {
  it("aggregates ledger rows with audit-joined attribution", async () => {
    const txRows = [
      charge("run-1", 0.1),
      charge("run-2", 0.05),
      credit("run-1", 0.1),
      // A non-cfpay row must never leak into the report.
      { ...charge("run-3", 1), sessionId: "payments-agent:x" },
    ];
    const eventRows = [
      { type: "payment.confirmed", payload: JSON.stringify({ runRequestId: "run-1", family: "goal" }) },
      { type: "payment.confirmed", payload: JSON.stringify({ runRequestId: "run-2", family: "options" }) },
      { type: "payment.covered", payload: { runRequestId: "run-4", paidVia: "credits" } },
      { type: "payment.failure_credit_issued", payload: JSON.stringify({ runRequestId: "run-1", family: "goal" }) },
    ];
    // #6102: the endpoint reads the attribution payloads from D1
    // now, not orm.events — seed the same four rows there (the
    // payment.covered row's object payload round-trips through the
    // D1 JSON-text storage exactly as the string ones do).
    const mockD1 = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(mockD1 as never));
    const now = new Date().toISOString();
    for (const [i, e] of eventRows.entries()) {
      await d1Store.create({
        id: `cfpay-seed-${i}`,
        sessionId: "sess-1",
        type: e.type,
        agent: "payments",
        payload: (typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload) as Record<
          string,
          unknown
        >,
        createdAt: now,
      });
    }
    const ctx = {
      env: { AGENT_DB: mockD1 } as any,
      getOrm: () => ({
        transactions: { findMany: vi.fn(() => txRows) },
      }),
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const res = await handleAgenticPaymentsRoutes(
      new Request("https://agent.internal/payments/agentic/ledger/cfpay-revenue", { method: "GET" }),
      new URL("https://agent.internal/payments/agentic/ledger/cfpay-revenue"),
      "/payments/agentic/ledger/cfpay-revenue",
      "sess-1",
      ctx,
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as ReturnType<typeof aggregateCfpayRevenue>;
    expect(body.charges).toEqual({ count: 2, totalUSD: 0.15 });
    expect(body.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(body.assumedCostUSD).toBe(0.03);
    expect(body.grossProfitUSD).toBe(0.12);
    expect(body.netProfitUSD).toBe(0.02);
    expect(body.costAssumption).toBe("cost assumed at 1/5 of revenue (owner-directed, not measured)");
    expect(body.byFamily["goal"]?.charges).toBe(1);
    expect(body.byFamily["goal"]?.assumedCostUSD).toBe(0.02);
    expect(body.byFamily["goal"]?.profitUSD).toBe(-0.02);
    expect(body.byFamily["options"]?.charges).toBe(1);
    expect(body.byFamily["options"]?.assumedCostUSD).toBe(0.01);
    expect(body.byFamily["options"]?.profitUSD).toBe(0.04);
    expect(body.coveredByPaidVia).toEqual({ credits: 1 });
    expect(body.chargesWithoutFamily).toBe(0);
  });
});
