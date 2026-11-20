// @vitest-environment node
/**
 * Slice 2.30 (#5235) — subscription + pay-per-run revenue in the
 * revenue summary (Goal 4, #2022 cuts: per-family / per-run /
 * per-coverage / cost-per-run).
 *
 * The summary aggregates the existing ledger of record
 * (mas_transactions) plus the metering store of record
 * (usage_events). No second ledger, no invented costs.
 *
 * - Pay-per-run revenue: settled run payments only — cfpay charge
 *   rows (sessionId `cfpay:<runId>`, family from the code-owned
 *   note) + x402/mpp inbound receipt rows (gateway x402|mpp,
 *   family from the checkoutUrl resource). Simulated, draft,
 *   outbound, agent-to-agent, bundle, channel, and generic
 *   charge rows are excluded.
 * - Subscription revenue: settled subscription receipt rows
 *   written best-effort by billing-purchase (id `tx_bill-…`,
 *   note `Subscription purchase plan …`). Pre-slice purchases
 *   have no row and are invisible to this line, by design.
 * - Coverage cuts: usage_events meter rows — paid (protocol in
 *   detailJson) vs subscription_included (paidVia). Credits-covered
 *   runs have no per-run row (conversion is account-level), so
 *   the credits bucket aggregates generically from paidVia and
 *   is 0 until such rows exist.
 * - Cost-per-run: NOT recorded anywhere (rolloutBudget only
 *   holds caller-supplied budget/actual) → null, never invented.
 * - grossRevenue / netRevenue formulas are UNCHANGED; the new
 *   lines are additive.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DatabaseORM } from "../src/orm";
import {
  buildCoveredCallEvent,
  buildMeteredCallEvent,
} from "../src/services/meteredPaymentGate";
import { buildCfpayChargeTransaction } from "../src/services/cfpayLedger";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
  transactionSync<T>(closure: (txn: { sql: SqliteTestStorage }) => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure({ sql: this });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

function freshOrm(): { orm: DatabaseORM; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const orm = new DatabaseORM(storage as never);
  orm.initializeSchema("sess-5235");
  orm.usageEvents.ensureSchema();
  return { orm, storage };
}

const NOW = "2026-11-17T12:00:00.000Z";

function txBase(id: string): Record<string, unknown> {
  return {
    id,
    sessionId: "s1",
    action: "charge",
    amount: 1,
    currency: "USD",
    customer: "cust-1",
    gateway: "stripe",
    gatewayRef: "gw",
    checkoutUrl: "",
    proposerDid: "did:ex:proposer",
    authorizerDid: "did:ex:authorizer",
    proofSignature: "sig",
    note: "",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("2.30 revenue summary cuts (#5235)", () => {
  it("new lines default to zero/empty/null and the old lines are unchanged", () => {
    const { orm } = freshOrm();
    const s = orm.getRevenueSummary();
    expect(s.subscriptionRevenue).toBe(0);
    expect(s.subscriptionCount).toBe(0);
    expect(s.payPerRunRevenue).toBe(0);
    expect(s.payPerRunByFamily).toEqual([
      { family: "stock", revenue: 0, runs: 0 },
      { family: "options", revenue: 0, runs: 0 },
      { family: "goal", revenue: 0, runs: 0 },
      { family: "strategy", revenue: 0, runs: 0 },
    ]);
    expect(s.runRevenueByCoverage).toEqual([
      { coverage: "paid", runs: 0, revenue: 0, listValue: 0 },
      { coverage: "subscription_included", runs: 0, revenue: 0, listValue: 0 },
      { coverage: "credits", runs: 0, revenue: 0, listValue: 0 },
    ]);
    expect(s.costPerRun).toBeNull();
    // Seeded base lines are untouched (characterization seeds).
    expect(s.adNetworkRevenue).toBeCloseTo(62.81);
    expect(s.marketplaceRevenue).toBeCloseTo(66);
  });

  it("pay-per-run revenue by family from settled cfpay + x402 rows", () => {
    const { orm } = freshOrm();
    // cfpay charges: options $0.05 x2, stock $0.02, goal $0.10.
    orm.transactions.create(
      buildCfpayChargeTransaction({ runRequestId: "r1", userId: "u1", family: "options", priceUSD: 0.05 }) as never,
    );
    orm.transactions.create(
      buildCfpayChargeTransaction({ runRequestId: "r2", userId: "u1", family: "options", priceUSD: 0.05 }) as never,
    );
    orm.transactions.create(
      buildCfpayChargeTransaction({ runRequestId: "r3", userId: "u1", family: "stock", priceUSD: 0.02 }) as never,
    );
    orm.transactions.create(
      buildCfpayChargeTransaction({ runRequestId: "r4", userId: "u1", family: "goal", priceUSD: 0.1 }) as never,
    );
    // x402 inbound receipt: options $0.05 via the options-scan resource.
    orm.transactions.create({
      ...txBase("tx_x402_1"),
      sessionId: "payer-1",
      action: "agentic_payment",
      amount: 0.05,
      gateway: "x402",
      gatewayRef: "0xabc",
      status: "completed",
      checkoutUrl: "/api/premium/options-scan",
      note: "Cloudflare Agentic Payment (X402) on base-sepolia",
    } as never);
    const s = orm.getRevenueSummary();
    expect(s.payPerRunRevenue).toBeCloseTo(0.27);
    expect(s.payPerRunByFamily).toEqual([
      { family: "stock", revenue: 0.02, runs: 1 },
      { family: "options", revenue: 0.15, runs: 3 },
      { family: "goal", revenue: 0.1, runs: 1 },
      { family: "strategy", revenue: 0, runs: 0 },
    ]);
  });

  it("excludes simulated, draft, outbound, A2A, bundle, channel, and generic rows from pay-per-run revenue", () => {
    const { orm } = freshOrm();
    const rows: Array<Record<string, unknown>> = [
      // Simulated x402 receipt: local-ledger simulation, no real payment.
      { ...txBase("tx_sim"), sessionId: "payer-1", action: "agentic_payment", amount: 5, gateway: "x402", status: "simulated", checkoutUrl: "/api/premium/options-scan" },
      // Draft charge: moves no money.
      { ...txBase("tx_draft"), sessionId: "cfpay:r9", action: "charge", amount: 5, gateway: "stripe", status: "awaiting_confirmation", note: "goal run r9 via cfpay checkout" },
      // Outbound micropayment: money leaving, not revenue.
      { ...txBase("tx_out"), sessionId: "payer-1", action: "micropayment", amount: 5, gateway: "x402", status: "completed", checkoutUrl: "/api/premium/options-scan" },
      // Agent-to-agent row: sessionId payagent: prefix.
      { ...txBase("tx_a2a"), sessionId: "payagent:agent-1", action: "micropayment", amount: 5, gateway: "x402", status: "completed", note: "some operation" },
      // Bundle purchase receipt: not a run payment.
      { ...txBase("tx_bbnd-1"), sessionId: "u1", action: "agentic_payment", amount: 25, gateway: "stripe", gatewayRef: "cs_bundle", status: "completed", note: "" },
      // cfpay channel purchase receipt: not a run payment.
      { ...txBase("tx_ch-1"), sessionId: "u1", action: "agentic_payment", amount: 9, gateway: "cfpay-channel", status: "completed", note: "" },
      // Generic completed charge: counts toward fees, never toward run revenue.
      { ...txBase("tx_generic"), sessionId: "s", action: "charge", amount: 200, gateway: "stripe", status: "completed", note: "" },
    ];
    for (const r of rows) orm.transactions.create(r as never);
    const s = orm.getRevenueSummary();
    expect(s.payPerRunRevenue).toBe(0);
    expect(s.payPerRunByFamily.every((f) => f.runs === 0)).toBe(true);
    // The generic charge still feeds the existing fee line.
    expect(s.paymentPlatformFees).toBeCloseTo(5);
  });

  it("unknown families are counted, never dropped", () => {
    const { orm } = freshOrm();
    orm.transactions.create(
      buildCfpayChargeTransaction({ runRequestId: "rX", userId: "u1", family: "weird", priceUSD: 0.07 }) as never,
    );
    orm.transactions.create({
      ...txBase("tx_x402_x"),
      sessionId: "payer-1",
      action: "agentic_payment",
      amount: 0.03,
      gateway: "mpp",
      status: "completed",
      checkoutUrl: "/api/premium/unknown-thing",
    } as never);
    const s = orm.getRevenueSummary();
    expect(s.payPerRunRevenue).toBeCloseTo(0.1);
    const unknown = s.payPerRunByFamily.find((f) => f.family === "unknown");
    expect(unknown).toEqual({ family: "unknown", revenue: 0.1, runs: 2 });
  });

  it("subscription revenue from settled subscription receipt rows; gross/net unchanged", () => {
    const { orm } = freshOrm();
    orm.transactions.create({
      ...txBase("tx_bill-aaa"),
      sessionId: "u1",
      action: "agentic_payment",
      amount: 49.99,
      gateway: "stripe",
      gatewayRef: "cs_sub_1",
      status: "completed",
      note: "Subscription purchase plan basic via Billing checkout",
    } as never);
    orm.transactions.create({
      ...txBase("tx_bill-bbb"),
      sessionId: "u2",
      action: "agentic_payment",
      amount: 59.99,
      gateway: "stripe",
      gatewayRef: "cs_sub_2",
      status: "completed",
      note: "Subscription purchase plan premium via Billing checkout",
    } as never);
    // A bundle receipt next to them must not count as subscription revenue.
    orm.transactions.create({
      ...txBase("tx_bbnd-9"),
      sessionId: "u1",
      action: "agentic_payment",
      amount: 25,
      gateway: "stripe",
      gatewayRef: "cs_bundle",
      status: "completed",
      note: "",
    } as never);
    const s = orm.getRevenueSummary();
    expect(s.subscriptionRevenue).toBeCloseTo(109.98);
    expect(s.subscriptionCount).toBe(2);
    // The new lines are additive: gross/net keep the old formula.
    expect(s.grossRevenue).toBeCloseTo(62.81 + 66 + 0);
    expect(s.netRevenue).toBeCloseTo(62.81 + 66 + 0 - 0);
  });

  it("coverage cuts from meter rows: paid vs subscription_included; credits empty; costPerRun null", () => {
    const { orm } = freshOrm();
    orm.usageEvents.insertEvent(
      buildMeteredCallEvent({
        receipt: {
          receiptId: "rc1",
          protocol: "x402",
          payer: "0xpayer",
          amount: 0.05,
          currency: "USDC",
          network: "base-sepolia",
        } as never,
        userLogin: "u1",
        category: "options_screener",
        priceUSD: 0.05,
        tier: "Free",
        tenantId: "tenant-a",
      }),
    );
    orm.usageEvents.insertEvent(
      buildMeteredCallEvent({
        receipt: {
          receiptId: "rc2",
          protocol: "mpp",
          payer: "0xpayer",
          amount: 0.1,
          currency: "USDC",
          network: "base-sepolia",
        } as never,
        userLogin: "u1",
        category: "market_research",
        priceUSD: 0.1,
        tier: "Free",
        tenantId: "tenant-a",
      }),
    );
    orm.usageEvents.insertEvent(
      buildCoveredCallEvent({
        coverageId: "cov-1",
        userLogin: "u2",
        category: "stock_signals",
        priceUSD: 0.02,
        tier: "Subscribed",
        tenantId: "tenant-b",
      }),
    );
    const s = orm.getRevenueSummary();
    expect(s.runRevenueByCoverage).toEqual([
      { coverage: "paid", runs: 2, revenue: 0.15, listValue: 0.15 },
      { coverage: "subscription_included", runs: 1, revenue: 0, listValue: 0.02 },
      { coverage: "credits", runs: 0, revenue: 0, listValue: 0 },
    ]);
    expect(s.costPerRun).toBeNull();
    // Issue #3185: the stamp does not change the platform
    // aggregate — the same rows read back per tenant. (Sorted:
    // both rows share a millisecond createdAt, so newest-first
    // order between them is not pinned.)
    expect(orm.usageEvents.listByTenant("tenant-a", 10).map((r) => r.id).sort()).toEqual([
      "use_rc1",
      "use_rc2",
    ]);
    expect(orm.usageEvents.listByTenant("tenant-b", 10).map((r) => r.id)).toEqual(["use_cov-1"]);
    expect(orm.usageEvents.listByTenant("tenant-none", 10)).toEqual([]);
  });

  it("tenant-scoped summary scopes ONLY the meter coverage cut (#3185 bridge)", () => {
    const { orm } = freshOrm();
    orm.usageEvents.insertEvent(
      buildMeteredCallEvent({
        receipt: {
          receiptId: "rc1",
          protocol: "x402",
          payer: "0xpayer",
          amount: 0.05,
          currency: "USDC",
          network: "base-sepolia",
        } as never,
        userLogin: "u1",
        category: "options_screener",
        priceUSD: 0.05,
        tier: "Free",
        tenantId: "tenant-a",
      }),
    );
    orm.usageEvents.insertEvent(
      buildCoveredCallEvent({
        coverageId: "cov-1",
        userLogin: "u2",
        category: "stock_signals",
        priceUSD: 0.02,
        tier: "Subscribed",
        tenantId: "tenant-b",
      }),
    );
    const a = orm.getRevenueSummary("tenant-a");
    expect(a.runRevenueByCoverage).toEqual([
      { coverage: "paid", runs: 1, revenue: 0.05, listValue: 0.05 },
      { coverage: "subscription_included", runs: 0, revenue: 0, listValue: 0 },
      { coverage: "credits", runs: 0, revenue: 0, listValue: 0 },
    ]);
    const b = orm.getRevenueSummary("tenant-b");
    expect(b.runRevenueByCoverage).toEqual([
      { coverage: "paid", runs: 0, revenue: 0, listValue: 0 },
      { coverage: "subscription_included", runs: 1, revenue: 0, listValue: 0.02 },
      { coverage: "credits", runs: 0, revenue: 0, listValue: 0 },
    ]);
    // The other cuts stay platform-wide BY DESIGN: subscription /
    // pay-per-run cuts read mas_transactions, whose tenant
    // stamping is partial per #3182 (x402/drafts NULL), so
    // scoping them would silently drop paid revenue. The ad cut
    // proves it — identical under both tenant scopes.
    expect(a.adNetworkRevenue).toBeCloseTo(62.81);
    expect(b.adNetworkRevenue).toBeCloseTo(62.81);
  });

  it("malformed meter detail never breaks the summary", () => {
    const { orm } = freshOrm();
    orm.usageEvents.insertEvent({
      id: "use_bad",
      userLogin: "u1",
      runId: "bad-1",
      category: "options_screener",
      createdAt: NOW,
      detailJson: "not-json{{{",
      tenantId: null,
    });
    orm.usageEvents.insertEvent({
      id: "use_nodetail",
      userLogin: "u1",
      runId: "nodetail-1",
      category: "stock_signals",
      createdAt: NOW,
      detailJson: null,
      tenantId: null,
    });
    const s = orm.getRevenueSummary();
    const unknown = s.runRevenueByCoverage.find((c) => c.coverage === "unknown");
    expect(unknown).toEqual({ coverage: "unknown", runs: 2, revenue: 0, listValue: 0 });
  });
});
