// @vitest-environment node
/**
 * Issue #5605 (G-2) — D1 batch atomicity pins for the four
 * multi-write routes.
 *
 * The slice's contract, pinned here against real D1 adapters
 * over a MockD1Database (node:sqlite, the slice-0 shape):
 * - each route's D1 statements run through exactly ONE batch()
 *   call — they are buffered, never executed one by one;
 * - a statement failing inside the batch leaves NO partial
 *   state (the mock's batch is BEGIN/RUN/COMMIT with ROLLBACK
 *   on error — D1's documented all-or-nothing contract);
 * - success-path rows and returned records are identical with
 *   and without the batch runner (byte-identical outcomes);
 * - bulk moves batch PER CUSTOMER: one customer's batch
 *   failure is recorded and counted, never fatal to the job.
 *
 * Mutation evidence (the #2288 proof-test idiom): the
 * "control" test runs the same sabotage against the old
 * sequential shape — one statement at a time — and asserts the
 * first row SURVIVES. A sabotage that cannot produce partial
 * state would make the rollback pins vacuous; the control
 * proves it can.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createD1BatchRunner } from "../src/data/d1BatchRunner";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1ProductDb,
  D1ProductAdapter,
  ensureProductSchema,
} from "../src/data/d1ProductAdapter";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import { InMemoryTenantDirectoryAdapter } from "../src/data/inMemoryTenantDirectoryAdapter";
import { mapChargeToJournalEntries } from "../src/data/journalPorts";
import { activateSubscription, grantSubscription } from "../src/services/subscriptionActivation";
import { moveSubscriptionToVersion, runBulkMove } from "../src/services/versionMoves";
import { handlePlatformTenantRoutes } from "../src/agents/routes/platformTenants";
import {
  bufferInAmbientUnit,
  doSqlTransactionBackend,
  d1BatchTransactionBackend,
  withTransaction,
} from "../src/aspects/transactionAspect";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice-0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  runCount = 0;
  /** 1-based index of the run() call that throws (statement failure inside a batch). */
  throwOnRunAt: number | null = null;
  /** 1-based index of the batch() call that throws (batch-level failure). */
  throwOnBatchAt: number | null = null;
  prepare(sql: string) {
    const db = this.sqlite;
    const self = this;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            self.runCount += 1;
            if (self.throwOnRunAt !== null && self.runCount === self.throwOnRunAt) {
              throw new Error("sabotaged statement run");
            }
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
    this.batchCalls += 1;
    if (this.throwOnBatchAt !== null && this.batchCalls === this.throwOnBatchAt) {
      throw new Error("sabotaged batch");
    }
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

const NOW = 1_791_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface BatchStores {
  mock: MockD1Database;
  commercial: D1CommercialAdapter;
  subs: D1SubscriptionAdapter;
  products: D1ProductAdapter;
  journal: D1JournalAdapter;
}

async function makeStores(): Promise<BatchStores> {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  const productDb = createD1ProductDb(mock as unknown as D1Database);
  const journalDb = createD1JournalDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  await ensureSubscriptionSchema(subsDb);
  await ensureProductSchema(productDb);
  await ensureJournalSchema(journalDb);
  return {
    mock,
    commercial: new D1CommercialAdapter(commercialDb),
    subs: new D1SubscriptionAdapter(subsDb),
    products: new D1ProductAdapter(productDb),
    journal: new D1JournalAdapter(journalDb),
  };
}

function resetCounters(s: BatchStores) {
  s.mock.batchCalls = 0;
  s.mock.runCount = 0;
}

function rows(mock: MockD1Database, table: string): Record<string, unknown>[] {
  const toCamel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return (mock.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map(
    (row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [toCamel(k), v])) as Record<
        string,
        unknown
      >,
  );
}

async function seedApprovedPlan(
  s: BatchStores,
  input: { id?: string; priceUSD?: number; periodDays?: number; includedRuns?: number },
) {
  const plan = await s.subs.createPlan({
    id: input.id ?? "plan-pro",
    name: "Pro",
    priceUSD: input.priceUSD ?? 20,
    periodDays: input.periodDays ?? 30,
    includedRuns: input.includedRuns ?? 10,
  });
  await s.subs.approvePlan(plan.id, "test-operator");
  const approved = await s.subs.getPlan(plan.id);
  if (!approved) throw new Error("seeded plan not found");
  return approved;
}

/* ------------------------------------------------------------------ */
/* Aspect helper                                                       */
/* ------------------------------------------------------------------ */

describe("bufferInAmbientUnit (#5605)", () => {
  it("returns false outside a unit; true inside a D1 batch unit", async () => {
    expect(bufferInAmbientUnit("SELECT 1")).toBe(false);
    const mock = new MockD1Database();
    const seen: boolean[] = [];
    await withTransaction(
      d1BatchTransactionBackend(mock as any),
      { operationName: "pin.ambient" },
      () => {
        seen.push(bufferInAmbientUnit("SELECT 1"));
        return undefined;
      },
    );
    expect(seen).toEqual([true]);
    expect(bufferInAmbientUnit("SELECT 1")).toBe(false);
  });

  it("returns false inside a DO-leg unit — D1 SQL never joins a DO transaction", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const storage = {
      sqlite,
      sql: {
        exec: (query: string, ...params: unknown[]) => sqlite.prepare(query).run(...(params as any[])),
      },
      transactionSync<T>(closure: () => T): T {
        sqlite.exec("BEGIN");
        try {
          const out = closure();
          sqlite.exec("COMMIT");
          return out;
        } catch (err) {
          sqlite.exec("ROLLBACK");
          throw err;
        }
      },
    };
    const seen: boolean[] = [];
    await withTransaction(
      doSqlTransactionBackend(storage as any),
      { operationName: "pin.do-ambient" },
      () => {
        seen.push(bufferInAmbientUnit("SELECT 1"));
        return undefined;
      },
    );
    expect(seen).toEqual([false]);
  });
});

/* ------------------------------------------------------------------ */
/* Journal post                                                        */
/* ------------------------------------------------------------------ */

describe("journal post batches as one unit (#5605)", () => {
  const entries = () =>
    mapChargeToJournalEntries({
      transactionRef: "run-1",
      tenantId: "tenant-a",
      runRequestId: "run-1",
      family: "goal",
      productId: "prod-per-run-goal",
      versionId: "cat-goal-default-v1",
      amountUSD: 0.1,
    });

  it("posts both entries through exactly ONE batch() call", async () => {
    const s = await makeStores();
    resetCounters(s);
    const posted = await s.journal.postEntries(entries());
    expect(posted).toHaveLength(2);
    expect(s.mock.batchCalls).toBe(1);
    expect(rows(s.mock, "agent_journal_entries")).toHaveLength(2);
  });

  it("a statement failing inside the batch leaves NO partial set", async () => {
    const s = await makeStores();
    resetCounters(s);
    s.mock.throwOnRunAt = 2;
    await expect(s.journal.postEntries(entries())).rejects.toThrow("sabotaged statement run");
    expect(rows(s.mock, "agent_journal_entries")).toHaveLength(0);
  });

  it("control: the same sabotage against sequential execution leaves the first row", async () => {
    const s = await makeStores();
    resetCounters(s);
    // The pre-#5605 shape: one insert at a time, no unit.
    const input = entries();
    s.mock.throwOnRunAt = 2;
    const first = input[0];
    const second = input[1];
    const insert = (e: (typeof input)[number]) =>
      s.mock
        .prepare(
          "INSERT INTO agent_journal_entries (id, transaction_ref, account_code, debit_usd, credit_usd, currency, tenant_id, run_request_id, family, product_id, version_id, price_usd, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `${e.transactionRef}:${e.accountCode}`,
          e.transactionRef,
          e.accountCode,
          e.debitUSD,
          e.creditUSD,
          e.currency,
          e.tenantId,
          e.runRequestId,
          e.family,
          e.productId,
          e.versionId,
          e.priceUSD,
          NOW,
        )
        .run();
    await insert(first);
    await expect(insert(second)).rejects.toThrow("sabotaged statement run");
    expect(rows(s.mock, "agent_journal_entries")).toHaveLength(1);
  });

  it("a replay returns the existing rows without opening a unit", async () => {
    const s = await makeStores();
    await s.journal.postEntries(entries());
    resetCounters(s);
    const replayed = await s.journal.postEntries(entries());
    expect(replayed).toHaveLength(2);
    expect(s.mock.batchCalls).toBe(0);
    expect(rows(s.mock, "agent_journal_entries")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Activation / grant pair                                             */
/* ------------------------------------------------------------------ */

describe("activation pair batches as one unit (#5605)", () => {
  it("activation applies both rows through exactly ONE batch() call", async () => {
    const s = await makeStores();
    const plan = await seedApprovedPlan(s, {});
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    const result = await activateSubscription({
      subs: s.subs,
      store: s.commercial,
      userId: "buyer-1",
      tenantId: "tenant-a",
      plan,
      provider: "stripe",
      providerPaymentRef: "chk-1",
      stripeSessionId: "sess-1",
      stripePaymentIntentId: "pi-1",
      nowMs: NOW,
      batch,
    });
    expect(s.mock.batchCalls).toBe(1);
    expect(result.subscription.userId).toBe("buyer-1");
    expect(result.subscription.planId).toBe(plan.id);
    expect(result.account.includedRuns).toBe(10);
    expect(rows(s.mock, "agent_subscriptions")).toHaveLength(1);
    expect(rows(s.mock, "agent_commercial_accounts")).toHaveLength(1);
  });

  it("a statement failing inside the batch leaves NEITHER row", async () => {
    const s = await makeStores();
    const plan = await seedApprovedPlan(s, {});
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    s.mock.throwOnRunAt = 2;
    await expect(
      activateSubscription({
        subs: s.subs,
        store: s.commercial,
        userId: "buyer-1",
        tenantId: "tenant-a",
        plan,
        provider: "stripe",
        providerPaymentRef: "chk-1",
        stripeSessionId: "sess-1",
        stripePaymentIntentId: "pi-1",
        nowMs: NOW,
        batch,
      }),
    ).rejects.toThrow("sabotaged statement run");
    expect(rows(s.mock, "agent_subscriptions")).toHaveLength(0);
    expect(rows(s.mock, "agent_commercial_accounts")).toHaveLength(0);
  });

  it("success rows are identical with and without the runner", async () => {
    const planInput = { id: "plan-pro", priceUSD: 20, periodDays: 30, includedRuns: 10 };
    const batched = await makeStores();
    const planB = await seedApprovedPlan(batched, planInput);
    const batch = createD1BatchRunner(batched.mock as any);
    const resultB = await activateSubscription({
      subs: batched.subs,
      store: batched.commercial,
      userId: "buyer-1",
      tenantId: "tenant-a",
      plan: planB,
      provider: "stripe",
      providerPaymentRef: "chk-1",
      stripeSessionId: "sess-1",
      stripePaymentIntentId: "pi-1",
      nowMs: NOW,
      batch,
    });
    const sequential = await makeStores();
    const planS = await seedApprovedPlan(sequential, planInput);
    const resultS = await activateSubscription({
      subs: sequential.subs,
      store: sequential.commercial,
      userId: "buyer-1",
      tenantId: "tenant-a",
      plan: planS,
      provider: "stripe",
      providerPaymentRef: "chk-1",
      stripeSessionId: "sess-1",
      stripePaymentIntentId: "pi-1",
      nowMs: NOW,
    });
    const strip = (r: Record<string, unknown>) => {
      const { id: _id, createdAtMs: _c, updatedAtMs: _u, ...rest } = r;
      return rest;
    };
    expect(strip(rows(batched.mock, "agent_subscriptions")[0] as Record<string, unknown>)).toEqual(
      strip(rows(sequential.mock, "agent_subscriptions")[0] as Record<string, unknown>),
    );
    expect(strip(rows(batched.mock, "agent_commercial_accounts")[0] as Record<string, unknown>)).toEqual(
      strip(rows(sequential.mock, "agent_commercial_accounts")[0] as Record<string, unknown>),
    );
    expect(resultB.subscription.providerPaymentRef).toBe(resultS.subscription.providerPaymentRef);
    expect(resultB.account.includedRuns).toBe(resultS.account.includedRuns);
  });

  it("grant pair batches as one unit and rolls back the same way", async () => {
    const s = await makeStores();
    const plan = await seedApprovedPlan(s, {});
    await s.commercial.upsertAccount({ userId: "grantee-1", tenantId: "tenant-a", tier: "Free" });
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    const result = await grantSubscription({
      subs: s.subs,
      store: s.commercial,
      userId: "grantee-1",
      plan,
      grantedBy: "op",
      nowMs: NOW,
      batch,
    });
    expect(s.mock.batchCalls).toBe(1);
    expect(result.account.includedRuns).toBe(10);

    const s2 = await makeStores();
    const plan2 = await seedApprovedPlan(s2, {});
    await s2.commercial.upsertAccount({ userId: "grantee-1", tenantId: "tenant-a", tier: "Free" });
    const batch2 = createD1BatchRunner(s2.mock as any);
    resetCounters(s2);
    s2.mock.throwOnRunAt = 2;
    await expect(
      grantSubscription({
        subs: s2.subs,
        store: s2.commercial,
        userId: "grantee-1",
        plan: plan2,
        grantedBy: "op",
        nowMs: NOW,
        batch: batch2,
      }),
    ).rejects.toThrow("sabotaged statement run");
    expect(rows(s2.mock, "agent_subscriptions")).toHaveLength(0);
    expect(rows(s2.mock, "agent_commercial_accounts")[0].includedRuns).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Version-move pair + bulk move                                       */
/* ------------------------------------------------------------------ */

async function seedMoveFixture(s: BatchStores) {
  const product = await s.products.getOrCreateProduct({ name: "Basic", kind: "subscription" });
  const v1 = await s.subs.createPlan({
    name: "Basic",
    priceUSD: 49.99,
    periodDays: 30,
    includedRuns: 20,
    effectiveFromMs: NOW - 1000,
    productId: product.id,
  });
  await s.subs.approvePlan(v1.id, "test-operator");
  const v2 = await s.subs.createPlan({
    name: "Basic",
    priceUSD: 59.99,
    periodDays: 30,
    includedRuns: 20,
    effectiveFromMs: NOW,
    productId: product.id,
  });
  await s.subs.approvePlan(v2.id, "test-operator");
  return { product, v1, v2 };
}

async function seedHolder(s: BatchStores, userId: string, planId: string, subscriptionId: string) {
  await s.commercial.upsertAccount({ userId, tenantId: "tenant-a", tier: "Free" });
  return s.subs.createSubscription({
    id: subscriptionId,
    userId,
    tenantId: "tenant-a",
    planId,
    provider: "manual",
    providerPaymentRef: `ref-${subscriptionId}`,
    periodStartMs: NOW,
    periodEndMs: NOW + DAY,
  });
}

describe("version-move pair batches as one unit (#5605)", () => {
  it("a per-customer move applies the update + audit row through exactly ONE batch() call", async () => {
    const s = await makeStores();
    const { v1, v2 } = await seedMoveFixture(s);
    const sub = await seedHolder(s, "user-1", v1.id, "sub-1");
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    const result = await moveSubscriptionToVersion({
      subs: s.subs,
      store: s.commercial,
      products: s.products,
      subscriptionId: sub.id,
      toVersionId: v2.id,
      movedBy: "op",
      nowMs: NOW,
      batch,
    });
    expect(s.mock.batchCalls).toBe(1);
    expect(result.moved).toBe(true);
    expect(result.subscription.planId).toBe(v2.id);
    expect(rows(s.mock, "agent_subscriptions")[0].planId).toBe(v2.id);
    expect(rows(s.mock, "agent_version_moves")).toHaveLength(1);
    expect(rows(s.mock, "agent_version_moves")[0].toVersionId).toBe(v2.id);
  });

  it("a statement failing inside the batch leaves the subscription unmoved and no audit row", async () => {
    const s = await makeStores();
    const { v1, v2 } = await seedMoveFixture(s);
    const sub = await seedHolder(s, "user-1", v1.id, "sub-1");
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    s.mock.throwOnRunAt = 2;
    await expect(
      moveSubscriptionToVersion({
        subs: s.subs,
        store: s.commercial,
        products: s.products,
        subscriptionId: sub.id,
        toVersionId: v2.id,
        movedBy: "op",
        nowMs: NOW,
        batch,
      }),
    ).rejects.toThrow("sabotaged statement run");
    expect(rows(s.mock, "agent_subscriptions")[0].planId).toBe(v1.id);
    expect(rows(s.mock, "agent_version_moves")).toHaveLength(0);
  });
});

describe("bulk move batches per customer (#5605)", () => {
  it("two holders move through TWO batch() calls — one per customer", async () => {
    const s = await makeStores();
    const { product, v1 } = await seedMoveFixture(s);
    await seedHolder(s, "user-1", v1.id, "sub-1");
    await seedHolder(s, "user-2", v1.id, "sub-2");
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    const result = await runBulkMove({
      subs: s.subs,
      store: s.commercial,
      products: s.products,
      productId: product.id,
      movedBy: "op",
      nowMs: NOW,
      batch,
    });
    expect(result.movedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(s.mock.batchCalls).toBe(2);
    expect(result.bulkMove?.status).toBe("complete");
    expect(rows(s.mock, "agent_version_moves")).toHaveLength(2);
  });

  it("a batch failing for one customer is recorded, never fatal — the other customer still moves", async () => {
    const s = await makeStores();
    const { product, v1, v2 } = await seedMoveFixture(s);
    await seedHolder(s, "user-1", v1.id, "sub-1");
    await seedHolder(s, "user-2", v1.id, "sub-2");
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    s.mock.throwOnBatchAt = 2;
    const result = await runBulkMove({
      subs: s.subs,
      store: s.commercial,
      products: s.products,
      productId: product.id,
      movedBy: "op",
      nowMs: NOW,
      batch,
    });
    expect(result.movedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].userId).toBe("user-2");
    expect(result.bulkMove?.status).toBe("complete_with_failures");
    const subs = rows(s.mock, "agent_subscriptions").sort((a, b) =>
      String(a.userId) < String(b.userId) ? -1 : 1,
    );
    expect(subs.find((r) => r.userId === "user-1")?.planId).toBe(v2.id);
    expect(subs.find((r) => r.userId === "user-2")?.planId).toBe(v1.id);
    expect(rows(s.mock, "agent_version_moves")).toHaveLength(1);
    expect(rows(s.mock, "agent_version_moves")[0].userId).toBe("user-1");
  });

  it("a dry run writes nothing and opens no batch", async () => {
    const s = await makeStores();
    const { product, v1 } = await seedMoveFixture(s);
    await seedHolder(s, "user-1", v1.id, "sub-1");
    const batch = createD1BatchRunner(s.mock as any);
    resetCounters(s);
    const result = await runBulkMove({
      subs: s.subs,
      store: s.commercial,
      products: s.products,
      productId: product.id,
      movedBy: "op",
      nowMs: NOW,
      dryRun: true,
      batch,
    });
    expect(result.movedCount).toBe(0);
    expect(s.mock.batchCalls).toBe(0);
    expect(rows(s.mock, "agent_version_moves")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Settings PATCH (route)                                              */
/* ------------------------------------------------------------------ */

async function patchSettings(
  s: BatchStores,
  body: Record<string, unknown>,
  opts: { withRunner: boolean },
) {
  const directory = new InMemoryTenantDirectoryAdapter();
  directory.seedTenant("tenant-a", []);
  const env: Record<string, unknown> = { COMMERCIAL_STORE_OPERATORS: "" };
  if (opts.withRunner) env.AGENT_DB = s.mock as unknown as D1Database;
  const req = new Request("https://worker.test/platform-tenants/tenant-a/settings", {
    method: "PATCH",
    headers: { "x-user-login": "op", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handlePlatformTenantRoutes(
    req,
    new URL("https://worker.test/platform-tenants/tenant-a/settings"),
    "/platform-tenants/tenant-a/settings",
    "session-1",
    {
      env: env as never,
      commercial: s.commercial as never,
      directory: directory as never,
      operators: { listOperators: async () => [{ login: "op", addedBy: "seed", addedAtMs: 1 }] } as never,
      auditPolicy: null,
    },
  );
}

const PATCH_ALL = {
  adsEnabled: true,
  autoRefresh: { enabled: true, intervalS: 60 },
  providers: { dataProviderId: "alpaca", brokerId: "alpaca" },
};

describe("settings PATCH batches as one unit (#5605)", () => {
  async function seedSettings(s: BatchStores) {
    await s.commercial.setTenantAdsEnabled("tenant-a", false);
  }

  it("a three-field PATCH applies through exactly ONE batch() call", async () => {
    const s = await makeStores();
    await seedSettings(s);
    resetCounters(s);
    const res = await patchSettings(s, PATCH_ALL, { withRunner: true });
    expect(res?.status).toBe(200);
    expect(s.mock.batchCalls).toBe(1);
    const settings = await s.commercial.getTenantAdsEnabled("tenant-a");
    expect(settings).toBe(true);
    expect(await s.commercial.getTenantAutoRefresh("tenant-a")).toEqual({ enabled: true, intervalS: 60 });
    expect(await s.commercial.getTenantProviders("tenant-a")).toEqual({
      dataProviderId: "alpaca",
      brokerId: "alpaca",
    });
  });

  it("a statement failing inside the batch leaves the settings row unchanged", async () => {
    const s = await makeStores();
    await seedSettings(s);
    resetCounters(s);
    s.mock.throwOnRunAt = 2;
    const res = await patchSettings(s, PATCH_ALL, { withRunner: true });
    expect(res?.status).toBe(500);
    expect(await s.commercial.getTenantAdsEnabled("tenant-a")).toBe(false);
    expect(await s.commercial.getTenantAutoRefresh("tenant-a")).toEqual({ enabled: false, intervalS: 15 });
    expect(await s.commercial.getTenantProviders("tenant-a")).toEqual({
      dataProviderId: "alpaca",
      brokerId: "alpaca",
    });
  });

  it("success settings are identical with and without the runner", async () => {
    const batched = await makeStores();
    await seedSettings(batched);
    expect((await patchSettings(batched, PATCH_ALL, { withRunner: true }))?.status).toBe(200);
    const sequential = await makeStores();
    await seedSettings(sequential);
    expect((await patchSettings(sequential, PATCH_ALL, { withRunner: false }))?.status).toBe(200);
    expect(await batched.commercial.getTenantAdsEnabled("tenant-a")).toBe(
      await sequential.commercial.getTenantAdsEnabled("tenant-a"),
    );
    expect(await batched.commercial.getTenantAutoRefresh("tenant-a")).toEqual(
      await sequential.commercial.getTenantAutoRefresh("tenant-a"),
    );
    expect(await batched.commercial.getTenantProviders("tenant-a")).toEqual(
      await sequential.commercial.getTenantProviders("tenant-a"),
    );
  });
});
