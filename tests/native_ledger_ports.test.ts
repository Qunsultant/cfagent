/**
 * Issue #2192 ([Native payments] Slice 0, sub-issue of #2012,
 * umbrella #2146) — native ledger port tests.
 *
 * Builders (gateway truthfulness per rail, dedupe key,
 * charge-never-micropayment, proposerDid), port conformance
 * run unchanged against the Drizzle D1 adapter and the
 * in-memory adapter, pure reconciliation, pure native revenue
 * aggregation, structural pins, webhook recognition helpers,
 * and the composition root's null-when-unbound rule.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1NativeLedgerDb,
  D1NativeLedgerAdapter,
  ensureNativeLedgerSchema,
} from "../src/data/d1NativeLedgerAdapter";
import { InMemoryNativeLedgerAdapter } from "../src/data/inMemoryNativeLedgerAdapter";
import { createNativeLedgerAdapter } from "../src/data/createNativeLedgerPorts";
import { MIGRATION_0012_NATIVE_LEDGER } from "../src/data/migrationRunner";
import { agentNativeLedgerRows } from "../src/data/drizzleSchema";
import {
  aggregateNativeRevenue,
  buildNativeChargeTransaction,
  buildNativeCreditTransaction,
  findNativeRowBySessionAndAction,
  isNativeLedgerRow,
  nativeLedgerSessionId,
  reconcileNativeRun,
  type NativeLedgerPort,
  type NativeLedgerRowInput,
} from "../src/data/nativeLedgerPorts";
import {
  isNativeScreenerDraft,
  isNativeSubscriptionDraft,
  nativeWebhookRecordInput,
  NATIVE_WEBHOOK_METADATA_ORIGIN,
} from "../src/services/nativeWebhook";
import { AGENT_DIDS } from "../src/agents/did";

/** Minimal D1Database stand-in over node:sqlite (test-only; mirrors the journal test). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

async function makeD1Store(): Promise<NativeLedgerPort> {
  const mock = new MockD1Database();
  const db = createD1NativeLedgerDb(mock as any);
  await ensureNativeLedgerSchema(db);
  return new D1NativeLedgerAdapter(db);
}

const makers: Array<{ name: string; make: () => Promise<NativeLedgerPort> }> = [
  { name: "Drizzle D1 adapter", make: makeD1Store },
  { name: "in-memory adapter", make: async () => new InMemoryNativeLedgerAdapter() },
];

const chargeInput = (overrides: Partial<NativeLedgerRowInput> = {}): NativeLedgerRowInput => ({
  kind: "charge",
  runRequestId: "run-1",
  tenantId: "tenant-a",
  userId: "u1",
  family: "goal",
  priceUSD: 0.1,
  rail: "stripe",
  sessionId: "cs_test_1",
  paymentIntentId: "pi_1",
  ...overrides,
});

describe("native ledger builders (#2192)", () => {
  it("card charge row carries truthful stripe attribution, never a cfpay copy", () => {
    const row = buildNativeChargeTransaction(chargeInput(), 1780000000000);
    expect(row.sessionId).toBe("screener-payment-native:run-1");
    expect(row.action).toBe("charge");
    expect(row.gateway).toBe("stripe");
    expect(row.gatewayRef).toBe("cs_test_1");
    expect(row.amount).toBe(0.1);
    expect(row.currency).toBe("USD");
    expect(row.customer).toBe("u1");
    expect(row.status).toBe("completed");
    expect(row.proposerDid).toBe(AGENT_DIDS.ORCHESTRATOR);
    expect(row.proofSignature).toBe("pi_1");
    expect(row.note).toContain("goal run run-1");
    expect(row.note).toContain("native stripe checkout");
    expect(row.note).toContain("pi_1");
    expect(row.tenantId).toBe("tenant-a");
    expect(row.family).toBe("goal");
    expect(row.createdAtMs).toBe(1780000000000);
  });

  it("crypto charge row carries truthful x402 attribution, never hardcoded stripe", () => {
    const row = buildNativeChargeTransaction(
      chargeInput({ rail: "x402", sessionId: undefined, paymentIntentId: undefined, claimTxHash: "0xabc" }),
    );
    expect(row.gateway).toBe("x402");
    expect(row.gatewayRef).toBe("0xabc");
    expect(row.proofSignature).toBe("0xabc");
    expect(row.note).toContain("native x402 checkout");
  });

  it("card charge falls back to payment intent, then run id, for gatewayRef", () => {
    expect(buildNativeChargeTransaction(chargeInput({ sessionId: undefined })).gatewayRef).toBe("pi_1");
    expect(
      buildNativeChargeTransaction(chargeInput({ sessionId: undefined, paymentIntentId: undefined })).gatewayRef,
    ).toBe("run-1");
  });

  it("credit row is a replacement grant, not a cash refund, never micropayment (#2549 wording)", () => {
    const row = buildNativeCreditTransaction(chargeInput({ kind: "credit" }));
    expect(row.action).toBe("credit");
    expect(row.gatewayRef).toBe("credit:run-1");
    expect(row.proofSignature).toContain("no payment");
    expect(row.note).toContain("this credit is not a cash refund");
  });

  it("no builder ever produces a micropayment row", () => {
    for (const row of [
      buildNativeChargeTransaction(chargeInput()),
      buildNativeChargeTransaction(chargeInput({ rail: "x402", claimTxHash: "0xabc" })),
      buildNativeCreditTransaction(chargeInput({ kind: "credit" })),
    ]) {
      expect(row.action).not.toBe("micropayment");
      expect(row.action === "charge" || row.action === "credit").toBe(true);
    }
  });

  it("session helpers use the native prefix and reject cfpay-era rows", () => {
    expect(nativeLedgerSessionId("run-9")).toBe("screener-payment-native:run-9");
    expect(isNativeLedgerRow({ sessionId: "screener-payment-native:run-9" })).toBe(true);
    expect(isNativeLedgerRow({ sessionId: "screener-payment:run-9" })).toBe(false);
    const rows = [buildNativeChargeTransaction(chargeInput())];
    expect(findNativeRowBySessionAndAction(rows, "run-1", "charge")).toBe(rows[0]);
    expect(findNativeRowBySessionAndAction(rows, "run-1", "credit")).toBeUndefined();
  });

  it("validation rejects missing tenant, bad price, and unknown rail", () => {
    expect(() => buildNativeChargeTransaction(chargeInput({ tenantId: "  " }))).toThrow("tenantId");
    expect(() => buildNativeChargeTransaction(chargeInput({ priceUSD: 0 }))).toThrow("priceUSD");
    expect(() =>
      buildNativeChargeTransaction(chargeInput({ rail: "paypal" as any })),
    ).toThrow("rail");
    expect(() => buildNativeChargeTransaction(chargeInput({ kind: "credit" }))).toThrow(
      "requires kind charge",
    );
  });
});

describe.each(makers)("native ledger port conformance (#2192) — $name", ({ make }) => {
  it("records a charge and replays it as a duplicate, never a second row", async () => {
    const port = await make();
    const first = await port.recordRow(chargeInput());
    expect(first.duplicate).toBe(false);
    expect(first.row.sessionId).toBe("screener-payment-native:run-1");
    const replay = await port.recordRow(chargeInput({ priceUSD: 999 }));
    expect(replay.duplicate).toBe(true);
    expect(replay.row.id).toBe(first.row.id);
    expect(replay.row.amount).toBe(0.1);
    expect((await port.listRowsForRun("run-1")).filter((r) => r.action === "charge")).toHaveLength(1);
  });

  it("charge and credit coexist for one run under the same session", async () => {
    const port = await make();
    await port.recordRow(chargeInput());
    const credit = await port.recordRow(chargeInput({ kind: "credit" }));
    expect(credit.duplicate).toBe(false);
    expect(credit.row.action).toBe("credit");
    const rows = await port.listRowsForRun("run-1");
    expect(rows.map((r) => r.action).sort()).toEqual(["charge", "credit"]);
    // D1 re-reads a fresh object; identity holds only for the
    // in-memory adapter, so compare by id (the dedupe key).
    expect((await port.findRow("run-1", "credit"))?.id).toBe(credit.row.id);
  });

  it("isolates tenants: no unscoped read, no cross-tenant visibility", async () => {
    const port = await make();
    await port.recordRow(chargeInput());
    await port.recordRow(chargeInput({ runRequestId: "run-2", tenantId: "tenant-b" }));
    expect((await port.listRowsForTenant("tenant-a")).map((r) => r.runRequestId)).toEqual(["run-1"]);
    expect((await port.listRowsForTenant("tenant-b")).map((r) => r.runRequestId)).toEqual(["run-2"]);
    expect(await port.listRowsForTenant("tenant-c")).toEqual([]);
  });

  it("rejects invalid input before writing anything", async () => {
    const port = await make();
    await expect(port.recordRow(chargeInput({ priceUSD: -1 }))).rejects.toThrow("priceUSD");
    expect(await port.listRowsForRun("run-1")).toEqual([]);
  });
});

describe("native reconciliation (#2192)", () => {
  const rows = [buildNativeChargeTransaction(chargeInput())];
  it("matches paid + charge present, and unpaid + no charge", () => {
    expect(reconcileNativeRun(rows, "run-1", true).matched).toBe(true);
    expect(reconcileNativeRun([], "run-1", false).matched).toBe(true);
  });
  it("flags paid-without-charge and charge-without-paid", () => {
    expect(reconcileNativeRun([], "run-1", true).reasons).toContain(
      "native confirm reports paid but no charge row exists",
    );
    expect(reconcileNativeRun(rows, "run-1", false).reasons).toContain(
      "charge row exists but native confirm does not report paid",
    );
  });
  it("credit rows do not change the paid-match", () => {
    const withCredit = [...rows, buildNativeCreditTransaction(chargeInput({ kind: "credit" }))];
    expect(reconcileNativeRun(withCredit, "run-1", true)).toMatchObject({
      matched: true,
      chargePresent: true,
      creditPresent: true,
    });
  });
});

describe("native revenue aggregation (#2192)", () => {
  it("totals charges and credits, attributes families, applies the 1/5 cost assumption", () => {
    const rows = [
      buildNativeChargeTransaction(chargeInput({ runRequestId: "r1", priceUSD: 0.1 })),
      buildNativeChargeTransaction(chargeInput({ runRequestId: "r2", family: "stock", priceUSD: 0.02 })),
      buildNativeCreditTransaction(chargeInput({ kind: "credit", runRequestId: "r1", priceUSD: 0.1 })),
    ];
    const report = aggregateNativeRevenue(
      rows,
      [{ runRequestId: "r1", family: "goal" }],
      [{ paidVia: "already_paid" }],
      [{ runRequestId: "r1", family: "goal" }],
    );
    expect(report.charges).toEqual({ count: 2, totalUSD: 0.12 });
    expect(report.credits).toEqual({ count: 1, totalUSD: 0.1 });
    expect(report.netUSD).toBe(0.02);
    expect(report.assumedCostUSD).toBe(0.02);
    expect(report.byFamily["goal"].chargeTotalUSD).toBe(0.1);
    expect(report.byFamily["goal"].creditTotalUSD).toBe(0.1);
    expect(report.byFamily["stock"].chargeTotalUSD).toBe(0.02);
    expect(report.coveredByPaidVia).toEqual({ already_paid: 1 });
  });

  it("excludes non-native rows entirely, never counting cfpay history as native revenue", () => {
    const cfpayEra = {
      ...buildNativeChargeTransaction(chargeInput({ runRequestId: "old" })),
      sessionId: "screener-payment:old",
    };
    const report = aggregateNativeRevenue([cfpayEra], [], [], []);
    expect(report.charges.count).toBe(0);
    expect(report.charges.totalUSD).toBe(0);
  });
});

describe("native webhook recognition (#2192)", () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        client_reference_id: "run-1",
        payment_status: "paid",
        payment_intent: "pi_1",
        amount_total: 10,
        currency: "usd",
        metadata: {
          origin: NATIVE_WEBHOOK_METADATA_ORIGIN,
          userId: "u1",
          family: "goal",
          tenantId: "tenant-a",
        },
        ...overrides,
      },
    },
  });

  it("recognizes only verified native completed+paid sessions with the marker", () => {
    expect(isNativeScreenerDraft(session(), "run-1", "stripe")).toBe(true);
    expect(isNativeScreenerDraft(session({ payment_status: "unpaid" }), "run-1", "stripe")).toBe(false);
    expect(isNativeScreenerDraft({ ...session(), type: "payment_intent.succeeded" }, "run-1", "stripe")).toBe(false);
    expect(isNativeScreenerDraft(session(), "run-1", "paypal")).toBe(false);
    expect(isNativeScreenerDraft(session(), "run-2", "stripe")).toBe(false);
    const unmarked = session();
    (unmarked.data.object.metadata as Record<string, unknown>)["origin"] = "other";
    expect(isNativeScreenerDraft(unmarked, "run-1", "stripe")).toBe(false);
  });

  it("maps a native session to a stripe charge input in dollars", () => {
    const mapped = nativeWebhookRecordInput(session());
    expect("input" in mapped && mapped.input).toMatchObject({
      kind: "charge",
      runRequestId: "run-1",
      tenantId: "tenant-a",
      userId: "u1",
      family: "goal",
      priceUSD: 0.1,
      rail: "stripe",
      sessionId: "cs_test_1",
      paymentIntentId: "pi_1",
    });
  });

  it("refuses to invent attribution when metadata or amount is missing", () => {
    const noFamily = session();
    delete (noFamily.data.object.metadata as Record<string, unknown>)["family"];
    expect(nativeWebhookRecordInput(noFamily)).toMatchObject({ error: expect.stringContaining("family") });
    expect(nativeWebhookRecordInput(session({ amount_total: 0 }))).toMatchObject({
      error: expect.stringContaining("amount_total"),
    });
    expect(nativeWebhookRecordInput(session({ currency: "eur" }))).toMatchObject({
      error: expect.stringContaining("USD"),
    });
  });

  it("subscription drafts are recognized by the sub- prefix", () => {
    expect(isNativeSubscriptionDraft("sub-abc")).toBe(true);
    expect(isNativeSubscriptionDraft("run-1")).toBe(false);
  });
});

describe("native ledger composition root (#2192)", () => {
  it("returns null when AGENT_DB is unbound", () => {
    expect(createNativeLedgerAdapter({})).toBeNull();
    expect(createNativeLedgerAdapter({ AGENT_DB: undefined })).toBeNull();
  });

  it("builds an adapter when AGENT_DB is bound", async () => {
    const adapter = createNativeLedgerAdapter({ AGENT_DB: new MockD1Database() as any });
    expect(adapter).not.toBeNull();
  });
});

describe("native ledger structural pins (#2192)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  it("port and webhook modules import no store client and no gateway SDK", () => {
    for (const file of ["data/nativeLedgerPorts.ts", "services/nativeWebhook.ts"]) {
      const imports = importLines(file).join("\n");
      expect(imports).not.toContain("drizzle-orm");
      expect(imports).not.toContain("D1Database");
      expect(imports).not.toContain("Adapter");
      expect(imports).not.toContain("services/payments");
      expect(imports).not.toContain("services/agenticPayments");
      expect(imports).not.toContain("viem");
    }
  });

  it("the agentic-payments route builds the port via the composition root, never an adapter", () => {
    // Multi-line imports: scan the whole module, not just `import ` lines.
    const src = readFileSync(resolve(__dirname, "../src/agents/routes/agenticPayments.ts"), "utf8");
    expect(src).toContain("data/createNativeLedgerPorts");
    expect(src).not.toContain("d1NativeLedgerAdapter");
    expect(src).not.toContain("inMemoryNativeLedgerAdapter");
  });

  it("the webhook route builds the port via the composition root, never an adapter", () => {
    const src = readFileSync(resolve(__dirname, "../src/agents/routes/payments.ts"), "utf8");
    expect(src).toContain("data/createNativeLedgerPorts");
    expect(src).not.toContain("d1NativeLedgerAdapter");
    expect(src).not.toContain("inMemoryNativeLedgerAdapter");
  });

  it("migration DDL and Drizzle schema agree on columns for the native table", () => {
    const rawColumns = getTableConfig(agentNativeLedgerRows).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const block = MIGRATION_0012_NATIVE_LEDGER.sql.split(
      "CREATE TABLE IF NOT EXISTS agent_native_ledger_rows (",
    )[1].split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
  });
});
