// @vitest-environment node
/**
 * Issue #3182 — mas_transactions carries tenantId.
 *
 * The DO ledger of record gains a nullable tenant_id column (DO
 * migration, #2178 pattern), tenant stamped at write from resolved
 * identity on every charge/credit path, and a tenant-scoped read.
 * Backfill rule: legacy rows without a resolvable tenant stay
 * explicitly NULL — never invented — and tenant-filtered reads
 * exclude null-tenant rows. The audit-payload join (family
 * attribution by run id) keeps working unchanged.
 */
import { describe, expect, it } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureSharedTable,
  ensureTransactionTenantColumn,
  SHARED_TABLE_DDL,
} from "../src/data/ormSchema";
import { DoSqliteTransactionLedgerAdapter } from "../src/data/doSqliteOrmAdapters";
import { InMemoryTransactionLedgerAdapter } from "../src/data/inMemoryOrmAdapters";
import {
  aggregateCfpayRevenue,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
} from "../src/services/cfpayLedger";
import { buildLedgerTransaction } from "../src/payments/ledger";
import type { TransactionRecord } from "../src/types";

/** The pre-#3182 DDL: 16 columns, no tenant_id. */
const LEGACY_TRANSACTIONS_DDL = `
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

const LEGACY_INSERT =
  "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function legacyRow(id: string, sessionId: string): unknown[] {
  return [
    id, sessionId, "charge", 0.1, "USD", "u1", "stripe", "chk-1", "completed",
    "", "did:ex:proposer", "", "sig", "legacy row", "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ];
}

function chargeRow(id: string, tenantId: string | null): TransactionRecord {
  return {
    id,
    sessionId: `screener-payment:${id}`,
    action: "charge",
    amount: 0.1,
    currency: "USD",
    customer: "u1",
    gateway: "stripe",
    gatewayRef: `chk-${id}`,
    status: "completed",
    checkoutUrl: "",
    proposerDid: "did:ex:orchestrator",
    proofSignature: "none",
    note: "test",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    tenantId,
  };
}

function pragmaColumns(sql: MockSqlStorage): Array<{ name: string; type: string; pk: number }> {
  return Array.from(sql.exec(`PRAGMA table_info(mas_transactions)`)) as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
}

describe("mas_transactions tenant_id DDL + migration (#3182)", () => {
  it("fresh tables carry tenant_id, nullable, last", () => {
    expect(SHARED_TABLE_DDL.mas_transactions).toContain("tenant_id TEXT");
    const sql = new MockSqlStorage() as unknown as MockSqlStorage;
    ensureSharedTable(sql as never, "mas_transactions");
    const cols = pragmaColumns(sql);
    expect(cols.map((c) => c.name)).toContain("tenant_id");
    expect(cols[cols.length - 1].name).toBe("tenant_id");
    expect(cols.find((c) => c.name === "tenant_id")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "tenant_id")?.pk).toBe(0);
  });

  it("pre-existing tables gain the column, legacy rows stay null, re-run is a no-op", () => {
    const sql = new MockSqlStorage() as unknown as MockSqlStorage;
    // Simulate a table created before #3182: rewind the mock's catalog
    // to the legacy 16 columns (the mock preseeds the current DDL, and
    // its CREATE TABLE is a no-op, so the rewind is the only way to
    // stage a pre-migration table). The legacy DDL string is executed
    // too, for the record — it is the DDL a real pre-#3182 DO has.
    (sql as unknown as { schema: Map<string, Array<{ name: string; type: string; pk: number }>> }).schema.set(
      "mas_transactions",
      [
        "id", "session_id", "action", "amount", "currency", "customer",
        "gateway", "gateway_ref", "status", "checkout_url", "proposer_did",
        "authorizer_did", "proof_signature", "note", "created_at", "updated_at",
      ].map((name, i) => ({
        name,
        type: name === "amount" ? "REAL" : "TEXT",
        pk: i === 0 ? 1 : 0,
      })),
    );
    sql.exec(LEGACY_TRANSACTIONS_DDL);
    sql.exec(LEGACY_INSERT, ...legacyRow("legacy-1", "screener-payment:run-legacy"));
    expect(pragmaColumns(sql).map((c) => c.name)).not.toContain("tenant_id");

    ensureTransactionTenantColumn(sql as never);
    const cols = pragmaColumns(sql);
    expect(cols.map((c) => c.name)).toContain("tenant_id");
    expect(cols[cols.length - 1].name).toBe("tenant_id");

    // Legacy row: no tenant invented — explicitly null.
    const tx = new DoSqliteTransactionLedgerAdapter(sql as never);
    expect(tx.findById("legacy-1")?.tenantId ?? null).toBeNull();

    // Idempotent: a second run changes nothing and throws nothing.
    ensureTransactionTenantColumn(sql as never);
    expect(pragmaColumns(sql).map((c) => c.name).filter((n) => n === "tenant_id")).toHaveLength(1);
    expect(tx.findById("legacy-1")?.tenantId ?? null).toBeNull();
  });
});

describe("tenant stamping at write time (#3182)", () => {
  it("cfpay builders stamp the threaded tenant, null when none is threaded", () => {
    const charge = buildCfpayChargeTransaction({
      runRequestId: "run-1",
      userId: "u1",
      family: "goal",
      priceUSD: 0.1,
      tenantId: "tenant-a",
    });
    expect(charge.tenantId).toBe("tenant-a");
    expect(
      buildCfpayChargeTransaction({ runRequestId: "run-1", userId: "u1", family: "goal", priceUSD: 0.1 })
        .tenantId,
    ).toBeNull();
    expect(
      buildCfpayCreditTransaction({
        runRequestId: "run-1",
        userId: "u1",
        family: "goal",
        priceUSD: 0.1,
        tenantId: "tenant-a",
      }).tenantId,
    ).toBe("tenant-a");
    expect(
      buildCfpayCreditTransaction({ runRequestId: "run-1", userId: "u1", family: "goal", priceUSD: 0.1 })
        .tenantId,
    ).toBeNull();
  });

  it("PaymentsAgent x402 rows carry explicit null — no tenant is resolvable there", () => {
    const tx = buildLedgerTransaction(
      {
        agentId: "agent-1",
        operation: "quote",
        amountCents: 250,
        idempotencyKey: "key-1",
      },
      "did:ex:payments",
    );
    expect(tx.tenantId).toBeNull();
  });
});

describe("tenant-scoped reads (#3182)", () => {
  function seedDo(): DoSqliteTransactionLedgerAdapter {
    const sql = new MockSqlStorage() as unknown as MockSqlStorage;
    ensureSharedTable(sql as never, "mas_transactions");
    ensureTransactionTenantColumn(sql as never);
    const tx = new DoSqliteTransactionLedgerAdapter(sql as never);
    tx.replace(chargeRow("row-a1", "tenant-a"));
    tx.replace(chargeRow("row-a2", "tenant-a"));
    tx.replace(chargeRow("row-b1", "tenant-b"));
    // Legacy row: written before tenant stamping, no tenant_id value.
    (sql as unknown as { exec: (q: string, ...a: unknown[]) => unknown }).exec(
      LEGACY_INSERT,
      ...legacyRow("row-legacy", "screener-payment:run-legacy"),
    );
    return tx;
  }

  it("DO adapter: findByTenant returns only that tenant, never null-tenant rows", () => {
    const tx = seedDo();
    expect(tx.findMany()).toHaveLength(4);
    expect(tx.findByTenant("tenant-a").map((r) => r.id).sort()).toEqual(["row-a1", "row-a2"]);
    expect(tx.findByTenant("tenant-b").map((r) => r.id)).toEqual(["row-b1"]);
    expect(tx.findByTenant("tenant-none")).toEqual([]);
    // The legacy row is unattributed, not any tenant's.
    expect(tx.findById("row-legacy")?.tenantId ?? null).toBeNull();
  });

  it("DO adapter: a stamped row round-trips through replace()", () => {
    const tx = seedDo();
    expect(tx.findById("row-a1")?.tenantId).toBe("tenant-a");
    tx.replace({ ...chargeRow("row-a1", "tenant-a"), status: "completed" });
    expect(tx.findById("row-a1")?.tenantId).toBe("tenant-a");
  });

  it("in-memory adapter: same tenant scoping, same null exclusion", () => {
    const tx = new InMemoryTransactionLedgerAdapter();
    tx.replace(chargeRow("row-a1", "tenant-a"));
    tx.replace(chargeRow("row-b1", "tenant-b"));
    tx.replace({ ...chargeRow("row-legacy", null), sessionId: "screener-payment:run-legacy" });
    expect(tx.findByTenant("tenant-a").map((r) => r.id)).toEqual(["row-a1"]);
    expect(tx.findByTenant("tenant-b").map((r) => r.id)).toEqual(["row-b1"]);
    expect(tx.findByTenant("tenant-none")).toEqual([]);
    expect(tx.findMany()).toHaveLength(3);
  });
});

describe("audit-payload join keeps working (#3182)", () => {
  it("tenant-stamped rows still attribute family by run id, with unknown buckets", () => {
    const charge = buildCfpayChargeTransaction({
      runRequestId: "run-1",
      userId: "u1",
      family: "goal",
      priceUSD: 0.1,
      tenantId: "tenant-a",
    });
    const report = aggregateCfpayRevenue(
      [charge],
      [],
      [{ runRequestId: "run-1", family: "goal", tenantId: "tenant-a" }],
      [],
      [],
    );
    expect(report.charges.count).toBe(1);
    expect(report.byFamily["goal"].charges).toBe(1);
    expect(report.chargesWithoutFamily).toBe(0);
    expect(report.byFamily["unknown"]).toBeUndefined();
  });
});
