// @vitest-environment node
/**
 * Issue #2204 (sub-issue of #2012) — refund port conformance +
 * service lifecycle + operator routes + structural pins, TDD.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter. A
 * behavior that passes on one adapter and fails on the other is
 * a layer defect, not an application bug.
 *
 * Pinned contracts:
 * - Seeded policy defaults (PROPOSED, pending owner approval):
 *   30-day window, operator-HITL approver, full-only refunds,
 *   full subscription refund revokes immediately, partial keeps
 *   access, pay-per-run and credit effects none — written by
 *   ensure (D1) or construction (in-memory), never read from
 *   code by the service.
 * - An operator policy change is honored with no code deploy and
 *   survives a re-ensure (INSERT OR IGNORE seeding).
 * - Refund lifecycle: requested -> approved|denied; execution only
 *   from approved (or retry from execution_failed), only with the
 *   flag ON, only with a resolvable payment-intent id, never for
 *   crypto. Unapproved execution, flag-OFF execution, amount and
 *   window violations, and unresolvable legacy rows are all
 *   refused before any gateway call.
 * - Approved card execution calls the gateway with the stored
 *   payment-intent id, marks executed, posts the balanced journal
 *   effect (Dr 5000 / Cr 1000), and applies the policy's
 *   entitlement consequences (subscription revoked, included runs
 *   removed).
 * - Migration 0018 owns the refund DDL; the Drizzle schema maps
 *   it (column parity pinned here).
 * - Port modules never import a store client; the service never
 *   imports a store client or a gateway SDK (structural grep pins,
 *   ADR 0002 R1).
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1RefundDb,
  D1RefundAdapter,
  D1RefundPolicyAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import {
  InMemoryRefundAdapter,
  InMemoryRefundPolicyAdapter,
} from "../src/data/inMemoryRefundAdapter";
import {
  MIGRATION_0018_REFUNDS,
  MIGRATION_0036_REFUND_POLICY_APPROVAL,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { agentRefundPolicy, agentRefunds } from "../src/data/drizzleSchema";
import {
  CRYPTO_NON_REFUNDABLE_MESSAGE,
  PROPOSED_SEED_POLICY,
  type RefundPaymentSourceResolver,
  type RefundPolicyStore,
  type RefundStore,
} from "../src/data/refundPorts";
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
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { resolveEffectiveTier } from "../src/data/subscriptionPorts";
import {
  createD1JournalDb,
  D1JournalAdapter,
} from "../src/data/d1JournalAdapter";
import {
  createSubscriptionPaymentResolver,
  decideRefund,
  executeRefund,
  RefundTenantUnresolvableError,
  requestRefund,
} from "../src/services/refundService";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
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
}

async function seededAdapters(): Promise<
  Array<{ name: string; store: RefundStore; policy: RefundPolicyStore }>
> {
  const mock = new MockD1Database();
  const db = createD1RefundDb(mock as unknown as D1Database);
  await ensureRefundSchema(db);
  return [
    {
      name: "in-memory",
      store: new InMemoryRefundAdapter(),
      policy: new InMemoryRefundPolicyAdapter(),
    },
    { name: "drizzle", store: new D1RefundAdapter(db), policy: new D1RefundPolicyAdapter(db) },
  ];
}

async function emptyPolicyAdapters(): Promise<
  Array<{ name: string; policy: RefundPolicyStore }>
> {
  const mock = new MockD1Database();
  const db = createD1RefundDb(mock as unknown as D1Database);
  await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0018_REFUNDS, MIGRATION_0036_REFUND_POLICY_APPROVAL]);
  return [
    { name: "in-memory", policy: new InMemoryRefundPolicyAdapter(null) },
    { name: "drizzle", policy: new D1RefundPolicyAdapter(db) },
  ];
}

function refundInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "refund-1",
    kind: "pay_per_run",
    rail: "card",
    tenantId: "t1",
    userId: "u1",
    originalPaymentRef: "run-1",
    subscriptionId: null,
    paymentIntentId: "pi_test_1",
    family: "goal",
    originalAmountUSD: 0.1,
    amountUSD: 0.1,
    originalPaidAtMs: Date.now() - 1000,
    reason: "run never started",
    status: "requested",
    approverLogin: null,
    decisionNote: null,
    gatewayRefundId: null,
    executedAtMs: null,
    entitlementConsequence: null,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    ...overrides,
  } as Parameters<RefundStore["createRefund"]>[0];
}

describe("refund port contract (#2204)", () => {
  it("seeds the proposed policy defaults on both adapters", async () => {
    for (const { policy } of await seededAdapters()) {
      const got = await policy.getPolicy();
      expect(got).toMatchObject({ ...PROPOSED_SEED_POLICY });
      expect(got?.windowDays).toBe(30);
      expect(got?.approver).toBe("operator_hitl");
      expect(got?.allowPartial).toBe(false);
      expect(got?.subscriptionFullEffect).toBe("revoke_immediately");
      expect(got?.subscriptionPartialEffect).toBe("keep_access");
      expect(got?.payPerRunEffect).toBe("none");
      expect(got?.creditEffect).toBe("none");
    }
  });

  it("reads an unseeded policy as null, never a guessed policy", async () => {
    for (const { policy } of await emptyPolicyAdapters()) {
      expect(await policy.getPolicy()).toBeNull();
      await expect(policy.setPolicy({ windowDays: 14 })).rejects.toThrow(/not configured/);
    }
  });

  it("an operator policy edit survives re-ensure on D1 and validates on both adapters", async () => {
    const mock = new MockD1Database();
    const db = createD1RefundDb(mock as unknown as D1Database);
    await ensureRefundSchema(db);
    const policy = new D1RefundPolicyAdapter(db);
    await policy.setPolicy({ windowDays: 14, allowPartial: true });
    await ensureRefundSchema(db);
    expect((await policy.getPolicy())?.windowDays).toBe(14);
    expect((await policy.getPolicy())?.allowPartial).toBe(true);
    for (const { policy: p } of await seededAdapters()) {
      await expect(p.setPolicy({ windowDays: 0 })).rejects.toThrow(/windowDays/);
      await expect(p.setPolicy({ windowDays: 366 })).rejects.toThrow(/windowDays/);
      await expect(p.setPolicy({ approver: "automatic" })).rejects.toThrow(/operator_hitl/);
      await expect(p.setPolicy({ bogusField: 1 })).rejects.toThrow(/Unknown refund policy field/);
      await expect(p.setPolicy({ subscriptionFullEffect: "keep_everything" })).rejects.toThrow(
        /subscriptionFullEffect/,
      );
      const updated = await p.setPolicy({ subscriptionFullEffect: "cancel_at_period_end" });
      expect(updated.subscriptionFullEffect).toBe("cancel_at_period_end");
    }
  });

  it("refund records round-trip on both adapters, scoped per user", async () => {
    for (const { store } of await seededAdapters()) {
      const created = await store.createRefund(refundInput());
      expect(created.status).toBe("requested");
      expect(await store.getRefund("refund-1")).toMatchObject({ id: "refund-1", userId: "u1" });
      expect(await store.getRefund("missing")).toBeNull();
      await store.createRefund(refundInput({ id: "refund-2", userId: "u2" }));
      expect((await store.listRefunds("u1")).map((r) => r.id)).toEqual(["refund-1"]);
      expect((await store.listRefunds("u2")).map((r) => r.id)).toEqual(["refund-2"]);
      const updated = await store.updateRefund("refund-1", { status: "approved", approverLogin: "op1", updatedAtMs: Date.now() });
      expect(updated.status).toBe("approved");
      expect(updated.approverLogin).toBe("op1");
      await expect(store.updateRefund("missing", { status: "approved", updatedAtMs: Date.now() })).rejects.toThrow(
        /No refund/,
      );
      await expect(store.createRefund(refundInput())).rejects.toThrow();
      await expect(store.createRefund(refundInput({ id: "refund-3", amountUSD: 0.2 }))).rejects.toThrow(
        /exceeds the original amount/,
      );
    }
  });

  it("migration DDL and Drizzle schema agree on columns", async () => {
    const columnsOf = (table: any): string[] => {
      const raw = getTableConfig(table).columns as any;
      const names = Array.isArray(raw)
        ? raw.map((c: any) => c.name as string)
        : Object.keys(raw).map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
      return [...names].sort();
    };
    const ddlColumns = (table: string): string[] => {
      const block = MIGRATION_0018_REFUNDS.sql.split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1].split(");")[0];
      const base = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
      // Issue #2662: migration 0036 adds approval columns by ALTER.
      const alters = [...MIGRATION_0036_REFUND_POLICY_APPROVAL.sql.matchAll(/ADD COLUMN (\w+) /g)].map((m) => m[1]);
      return [...base, ...(table === "agent_refund_policy" ? alters : [])].sort();
    };
    expect(ddlColumns("agent_refund_policy")).toEqual(columnsOf(agentRefundPolicy));
    expect(ddlColumns("agent_refunds")).toEqual(columnsOf(agentRefunds));
  });
});

describe("refund service lifecycle (#2204)", () => {
  function gatewayStub() {
    const calls: any[] = [];
    let result = { success: true, refundId: "re_test_1", amountRefunded: 20, message: "ok" };
    return {
      calls,
      setResult(next: typeof result) {
        result = next;
      },
      gateway: {
        executeRefund: async (params: any) => {
          calls.push(params);
          return { ...result };
        },
      },
    };
  }

  async function serviceSetup() {
    const policy = new InMemoryRefundPolicyAdapter();
    // Issue #2662: the #2204 lifecycle tests predate per-kind approval;
    // approve both kinds here so the lifecycle assertions keep testing
    // lifecycle behavior, while the approval gate itself is covered by
    // tests/cancel_refund_policy_2662.test.ts.
    await policy.setKindApproval("subscription", true, "op1");
    await policy.setKindApproval("pay_per_run", true, "op1");
    const store = new InMemoryRefundAdapter();
    const subs = new InMemorySubscriptionAdapter();
    const commercial = new InMemoryCommercialAdapter();
    const plan = await subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const now = Date.now();
    const sub = await subs.createSubscription({
      id: "sub-row-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "sub-draft-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      periodStartMs: now,
      periodEndMs: now + 30 * 86_400_000,
    });
    await commercial.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      tierSource: "subscription",
      creditsUSD: 0,
      includedRuns: 10,
    });
    const gateway = gatewayStub();
    const journal: any[] = [];
    const base = {
      policyStore: policy,
      refundStore: store,
      sourceResolver: createSubscriptionPaymentResolver(subs),
      subscriptionStore: subs,
      commercialStore: commercial,
      gateway: gateway.gateway,
      postJournal: async (entries: any[]) => {
        journal.push(...entries);
      },
      monetizationEnabled: true,
    };
    return { policy, store, subs, commercial, plan, sub, gateway, journal, base, now };
  }

  // Issue #3180: a stub resolved payment source for pay-per-run
  // service tests — the tenant comes from the source, never from
  // request input. Amounts/dates stay null so the request input
  // values are exercised exactly as before.
  function stubPayPerRunSource(tenantId: string | null): RefundPaymentSourceResolver {
    return {
      resolve: async () => ({
        paymentIntentId: null,
        rail: "card",
        originalAmountUSD: null,
        originalPaidAtMs: null,
        userId: "u1",
        tenantId,
        subscriptionId: null,
      }),
    };
  }

  it("requests a subscription refund from the subscription row", async () => {
    const { base } = await serviceSetup();
    const record = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "changed mind",
      requesterLogin: "u1",
      isOperator: false,
    });
    expect(record.status).toBe("requested");
    expect(record.paymentIntentId).toBe("pi_test_1");
    expect(record.originalAmountUSD).toBe(20);
    expect(record.tenantId).toBe("t1");
    expect(record.subscriptionId).toBe("sub-row-1");
    await expect(
      requestRefund(base, {
        kind: "subscription",
        originalPaymentRef: "sub-draft-1",
        amountUSD: 20,
        reason: "x",
        requesterLogin: "u2",
        isOperator: false,
      }),
    ).rejects.toThrow(/Only the subscription owner/);
    const byOperator = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-draft-1",
      amountUSD: 20,
      reason: "operator request",
      requesterLogin: "op1",
      isOperator: true,
    });
    expect(byOperator.userId).toBe("u1");
  });

  it("refuses crypto, partial-when-disallowed, over-amount, and stale-window requests", async () => {
    const { base } = await serviceSetup();
    await expect(
      requestRefund({ ...base, sourceResolver: stubPayPerRunSource("t1") }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        rail: "crypto",
        reason: "crypto back",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(CRYPTO_NON_REFUNDABLE_MESSAGE);
    await expect(
      requestRefund({ ...base, sourceResolver: stubPayPerRunSource("t1") }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.05,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        rail: "card",
        reason: "partial",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(/Partial refunds are not allowed/);
    await expect(
      requestRefund({ ...base, sourceResolver: stubPayPerRunSource("t1") }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.2,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        rail: "card",
        reason: "too much",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(/exceeds the original amount/);
    await expect(
      requestRefund({ ...base, sourceResolver: stubPayPerRunSource("t1") }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 31 * 86_400_000,
        rail: "card",
        reason: "too late",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(/window expired/);
  });

  it("refuses a pay-per-run request whose resolved source carries no tenant, and records nothing (#3180)", async () => {
    const { base, store } = await serviceSetup();
    await expect(
      requestRefund({ ...base, sourceResolver: stubPayPerRunSource(null) }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        rail: "card",
        reason: "run failed",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(RefundTenantUnresolvableError);
    expect(await store.listRefunds("u1")).toEqual([]);
  });

  it("refuses a pay-per-run request with no source resolver at all, and records nothing (#3180)", async () => {
    const { base, store } = await serviceSetup();
    await expect(
      requestRefund({ policyStore: base.policyStore, refundStore: base.refundStore }, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        rail: "card",
        reason: "run failed",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(RefundTenantUnresolvableError);
    expect(await store.listRefunds("u1")).toEqual([]);
  });

  it("refuses a subscription request whose source row carries no tenant, and records nothing (#3180)", async () => {
    const { base, store } = await serviceSetup();
    const tenantlessSubscriptionSource: RefundPaymentSourceResolver = {
      resolve: async () => ({
        paymentIntentId: "pi_test_1",
        rail: "card",
        originalAmountUSD: 20,
        originalPaidAtMs: Date.now() - 1000,
        userId: "u1",
        tenantId: null,
        subscriptionId: "sub-row-1",
      }),
    };
    await expect(
      requestRefund({ ...base, sourceResolver: tenantlessSubscriptionSource }, {
        kind: "subscription",
        originalPaymentRef: "sub-row-1",
        amountUSD: 20,
        reason: "changed mind",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(RefundTenantUnresolvableError);
    expect(await store.listRefunds("u1")).toEqual([]);
  });

  it("refuses a legacy subscription row with no stored payment-intent id", async () => {
    const { base, subs, now } = await serviceSetup();
    await subs.createSubscription({
      id: "sub-legacy",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "cfpay",
      providerPaymentRef: "sub-legacy-draft",
      stripeSessionId: null,
      stripePaymentIntentId: null,
      periodStartMs: now,
      periodEndMs: now + 30 * 86_400_000,
    });
    await expect(
      requestRefund(base, {
        kind: "subscription",
        originalPaymentRef: "sub-legacy",
        amountUSD: 20,
        reason: "legacy",
        requesterLogin: "u1",
        isOperator: false,
      }),
    ).rejects.toThrow(/no stored Stripe payment-intent id/);
  });

  it("refuses unapproved execution and flag-OFF execution before any gateway call", async () => {
    const { base, gateway } = await serviceSetup();
    const record = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "x",
      requesterLogin: "u1",
      isOperator: false,
    });
    await expect(executeRefund(base, { refundId: record.id })).rejects.toThrow(/Only an approved refund/);
    expect(gateway.calls).toEqual([]);
    await decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
    await expect(
      executeRefund({ ...base, monetizationEnabled: false }, { refundId: record.id }),
    ).rejects.toThrow(/flag is OFF/);
    expect(gateway.calls).toEqual([]);
    await expect(
      decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "deny", approverLogin: "op1" }),
    ).rejects.toThrow(/cannot be decided/);
  });

  it("executes an approved card refund via the payment-intent id with journal + revocation", async () => {
    const { base, gateway, journal, subs, commercial, sub } = await serviceSetup();
    const record = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "changed mind",
      requesterLogin: "u1",
      isOperator: false,
    });
    await decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "approve", approverLogin: "op1", note: "verified in Stripe" });
    const nowMs = Date.now();
    const executed = await executeRefund({ ...base, nowMs }, { refundId: record.id });
    expect(executed.status).toBe("executed");
    expect(executed.gatewayRefundId).toBe("re_test_1");
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      gateway: "stripe",
      gatewayRef: "pi_test_1",
      amount: 20,
      transactionId: record.id,
    });
    expect(executed.entitlementConsequence).toContain("subscription_revoked");
    expect(executed.entitlementConsequence).toContain("included_runs_removed:10");
    const revoked = await subs.getSubscription(sub.id);
    expect(revoked?.status).toBe("canceled");
    expect(revoked?.periodEndMs).toBe(nowMs);
    const account = await commercial.getAccount("u1");
    expect(account?.includedRuns).toBe(0);
    expect(resolveEffectiveTier(account, revoked ? [revoked] : [], nowMs)).toBe("Free");
    expect(journal).toHaveLength(2);
    expect(journal.map((e: any) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["5000", 20, 0],
      ["1000", 0, 20],
    ]);
    expect(new Set(journal.map((e: any) => e.transactionRef)).size).toBe(1);
    await expect(executeRefund(base, { refundId: record.id })).rejects.toThrow(/Only an approved refund/);
  });

  it("gateway failure marks execution_failed and a retry succeeds", async () => {
    const { base, gateway } = await serviceSetup();
    const record = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "x",
      requesterLogin: "u1",
      isOperator: false,
    });
    await decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
    gateway.setResult({ success: false, refundId: "", amountRefunded: 0, message: "card declined at gateway" });
    await expect(executeRefund(base, { refundId: record.id })).rejects.toThrow(/Gateway refund failed/);
    expect((await base.refundStore.getRefund(record.id))?.status).toBe("execution_failed");
    gateway.setResult({ success: true, refundId: "re_retry", amountRefunded: 20, message: "ok" });
    const retried = await executeRefund(base, { refundId: record.id });
    expect(retried.status).toBe("executed");
    expect(retried.gatewayRefundId).toBe("re_retry");
  });

  it("an approved pay-per-run refund with no resolvable payment-intent id fails closed, gateway untouched", async () => {
    const { base, gateway } = await serviceSetup();
    const record = await requestRefund({ ...base, sourceResolver: stubPayPerRunSource("t1") }, {
      kind: "pay_per_run",
      originalPaymentRef: "run-9",
      amountUSD: 0.1,
      originalAmountUSD: 0.1,
      originalPaidAtMs: Date.now() - 1000,
      rail: "card",
      reason: "run failed",
      requesterLogin: "u1",
      isOperator: false,
    });
    await decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
    await expect(executeRefund(base, { refundId: record.id })).rejects.toThrow(/not resolvable/);
    expect(gateway.calls).toEqual([]);
    expect((await base.refundStore.getRefund(record.id))?.status).toBe("approved");
  });

  it("execution re-validates against the current policy", async () => {
    const { base, policy } = await serviceSetup();
    const record = await requestRefund(base, {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "x",
      requesterLogin: "u1",
      isOperator: false,
    });
    await decideRefund({ refundStore: base.refundStore }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
    await policy.setPolicy({ windowDays: 1 });
    // Issue #2662: the edit reset approval; re-approve so the test
    // isolates window re-validation (not the approval gate).
    await policy.setKindApproval("subscription", true, "op1");
    await expect(
      executeRefund({ ...base, nowMs: Date.now() + 2 * 86_400_000 }, { refundId: record.id }),
    ).rejects.toThrow(/window expired/);
  });

  it("revokeSubscription ends one period immediately on both subscription adapters", async () => {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const db = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(db);
    for (const subs of [new InMemorySubscriptionAdapter(), new D1SubscriptionAdapter(db)]) {
      await subs.createPlan({ id: "p1", name: "P", priceUSD: 5, periodDays: 30, includedRuns: 0 });
      const now = Date.now();
      await subs.createSubscription({
        id: "s1",
        userId: "u1",
        tenantId: "t1",
        planId: "p1",
        provider: "stripe",
        providerPaymentRef: "sub-d1",
        periodStartMs: now,
        periodEndMs: now + 30 * 86_400_000,
      });
      const nowMs = now + 1000;
      const revoked = await subs.revokeSubscription("s1", nowMs);
      expect(revoked?.status).toBe("canceled");
      expect(revoked?.periodEndMs).toBe(nowMs);
      expect(resolveEffectiveTier(null, revoked ? [revoked] : [], nowMs)).toBe("Free");
      expect(await subs.revokeSubscription("missing", nowMs)).toBeNull();
    }
  });
});

describe("refund routes (#2204)", () => {
  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (
    ctx: AgenticPaymentsRouteContext,
    method: string,
    path: string,
    login: string | null,
    body?: unknown,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
  };

  const bodyOf = async (res: Response | null) => (await res?.json()) as any;

  async function setup(opts: { monetization?: boolean } = {}) {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const refundDb = createD1RefundDb(mock as unknown as D1Database);
    await ensureRefundSchema(refundDb);
    // Issue #2662: approve both kinds so the #2204 route tests keep
    // testing route behavior; the gate itself is covered by the 2.7 tests.
    const refundPolicy = new D1RefundPolicyAdapter(refundDb);
    await refundPolicy.setKindApproval("subscription", true, "op1");
    await refundPolicy.setKindApproval("pay_per_run", true, "op1");
    const subs = new D1SubscriptionAdapter(subsDb);
    const plan = await subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const now = Date.now();
    const sub = await subs.createSubscription({
      id: "sub-row-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "sub-draft-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      periodStartMs: now,
      periodEndMs: now + 30 * 86_400_000,
    });
    const commercial = new D1CommercialAdapter(commercialDb);
    await commercial.upsertAccount({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      tierSource: "subscription",
      creditsUSD: 0,
      includedRuns: 10,
    });
    const env: Record<string, unknown> = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
      STRIPE_SECRET_KEY: "sk_test_stub",
    };
    if (opts.monetization) env.MONETIZATION_ENABLED = "true";
    const ctx = {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx, env, mock, subs, commercial, sub };
  }

  function stubRefundGateway() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const href = String(url);
        if (href === "https://api.stripe.com/v1/refunds" && init?.method === "POST") {
          const params = new URLSearchParams(String(init.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "re_route_1", amount: Number(params.get("amount") ?? 0) }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("request -> approve -> execute happy path with revocation and journal", async () => {
    const { ctx, mock, subs, commercial } = await setup({ monetization: true });
    stubRefundGateway();
    const requested = await call(ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "changed mind",
    });
    expect(requested?.status).toBe(200);
    const refund = (await bodyOf(requested)).refund;
    expect(refund.status).toBe("requested");
    expect(refund.paymentIntentId).toBe("pi_test_1");
    expect(
      (await call(ctx, "POST", "/payments/agentic/commercial/refunds/approve", "u1", {
        refundId: refund.id,
        decision: "approve",
      }))?.status,
    ).toBe(403);
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/refunds/approve", "op1", {
      refundId: refund.id,
      decision: "approve",
      note: "verified in Stripe",
    });
    expect(approved?.status).toBe(200);
    expect((await bodyOf(approved)).refund.status).toBe("approved");
    const executed = await call(ctx, "POST", "/payments/agentic/commercial/refunds/execute", "op1", {
      refundId: refund.id,
    });
    expect(executed?.status).toBe(200);
    const done = (await bodyOf(executed)).refund;
    expect(done.status).toBe("executed");
    expect(done.gatewayRefundId).toBe("re_route_1");
    expect(done.entitlementConsequence).toContain("subscription_revoked");
    const revoked = await subs.getSubscription("sub-row-1");
    expect(revoked?.status).toBe("canceled");
    expect((await commercial.getAccount("u1"))?.includedRuns).toBe(0);
    const journalDb = createD1JournalDb(mock as unknown as D1Database);
    const entries = await new D1JournalAdapter(journalDb).listEntries("t1");
    expect(entries.filter((e: any) => e.transactionRef === `${refund.id}:refund`).map((e: any) => [e.accountCode, e.debitUSD, e.creditUSD]).sort()).toEqual([
      ["1000", 0, 20],
      ["5000", 20, 0],
    ]);
    const read = await call(ctx, "GET", `/payments/agentic/commercial/refunds?refundId=${refund.id}`, "u1");
    expect(read?.status).toBe(200);
    expect((await bodyOf(read)).refund.status).toBe("executed");
    expect((await call(ctx, "GET", `/payments/agentic/commercial/refunds?refundId=${refund.id}`, "u2"))?.status).toBe(403);
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/refunds", "u1"));
    expect(listed.refunds.map((r: any) => r.id)).toEqual([refund.id]);
  });

  it("a client-supplied tenantId in the refund body is never trusted: a sourceless pay-per-run request is refused and nothing is recorded (#3180)", async () => {
    const { ctx } = await setup({ monetization: true });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "pay_per_run",
      originalPaymentRef: "run-1",
      amountUSD: 0.1,
      originalAmountUSD: 0.1,
      originalPaidAtMs: Date.now() - 1000,
      tenantId: "t-evil",
      rail: "card",
      reason: "run failed",
    });
    expect(res?.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/tenantId is required/);
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/refunds", "u1"));
    expect(listed.refunds).toEqual([]);
  });

  it("flag OFF refuses execution; crypto request fails closed; policy routes are operator-gated", async () => {
    const { ctx, env, subs } = await setup({ monetization: true });
    stubRefundGateway();
    const requested = await call(ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: "sub-row-1",
      amountUSD: 20,
      reason: "x",
    });
    const refund = (await bodyOf(requested)).refund;
    await call(ctx, "POST", "/payments/agentic/commercial/refunds/approve", "op1", {
      refundId: refund.id,
      decision: "approve",
    });
    const flagOffCtx = {
      env: { ...env, MONETIZATION_ENABLED: undefined },
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    delete (flagOffCtx.env as Record<string, unknown>).MONETIZATION_ENABLED;
    expect(
      (await call(flagOffCtx, "POST", "/payments/agentic/commercial/refunds/execute", "op1", {
        refundId: refund.id,
      }))?.status,
    ).toBe(403);
    // Issue #3180: the crypto refusal is exercised through a
    // subscription request now — a route pay-per-run request has
    // no resolved source and refuses at tenant derivation before
    // rail validation, so it can no longer reach the crypto check.
    await subs.createSubscription({
      id: "sub-x402",
      userId: "u1",
      tenantId: "t1",
      planId: "plan-pro",
      provider: "x402",
      providerPaymentRef: "sub-x402-draft",
      stripeSessionId: "cs_test_x",
      stripePaymentIntentId: "pi_test_x",
      periodStartMs: Date.now(),
      periodEndMs: Date.now() + 30 * 86_400_000,
    });
    const crypto = await call(ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: "sub-x402",
      amountUSD: 20,
      reason: "crypto back",
    });
    expect(crypto?.status).toBe(400);
    expect((await bodyOf(crypto)).error).toContain("non-refundable");
    const policy = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/refund-policy", "u1"));
    expect(policy.policy.windowDays).toBe(30);
    expect(policy.disclosure).toContain("non-refundable");
    // Issue #2662: GET reports real approval state, never a hardcoded flag.
    expect([...policy.policy.approvedKinds].sort()).toEqual(["pay_per_run", "subscription"]);
    expect(
      (await call(ctx, "POST", "/payments/agentic/commercial/refund-policy", "u1", { windowDays: 14 }))?.status,
    ).toBe(403);
    const updated = await call(ctx, "POST", "/payments/agentic/commercial/refund-policy", "op1", { windowDays: 14 });
    expect(updated?.status).toBe(200);
    expect((await bodyOf(updated)).policy.windowDays).toBe(14);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/refund-policy", "op1", { windowDays: 0 }))?.status).toBe(400);
  });

  it("unbound store is 503; anonymous is 401", async () => {
    const unbound = {
      env: { COMMERCIAL_STORE_OPERATORS: "op1", MONETIZATION_ENABLED: "true" },
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    expect(
      (await call(unbound, "POST", "/payments/agentic/commercial/refunds", "u1", {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        reason: "x",
      }))?.status,
    ).toBe(503);
    const { ctx } = await setup({ monetization: true });
    expect(
      (await call(ctx, "POST", "/payments/agentic/commercial/refunds", null, {
        kind: "pay_per_run",
        originalPaymentRef: "run-1",
        amountUSD: 0.1,
        reason: "x",
      }))?.status,
    ).toBe(401);
  });
});

describe("refund structural pins (#2204, ADR 0002 R1)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  function fullText(file: string): string {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8");
  }

  it("port module imports no store client and writes no SQL", () => {
    const imports = importLines("data/refundPorts.ts").join("\n");
    expect(imports).toBe("");
    const text = fullText("data/refundPorts.ts");
    expect(text).not.toContain("AGENT_DB");
    expect(text).not.toContain("drizzle-orm");
    expect(text).not.toContain("CREATE TABLE");
    expect(text).not.toContain("SELECT ");
  });

  it("service imports no store client, no gateway SDK, no env binding", () => {
    const imports = importLines("services/refundService.ts").join("\n");
    expect(imports).not.toContain("drizzle-orm");
    expect(imports).not.toContain("D1Database");
    expect(imports).not.toContain("d1RefundAdapter");
    expect(imports).not.toContain("inMemoryRefundAdapter");
    expect(imports).not.toContain("services/payments");
    expect(imports).not.toContain("createCheckoutPorts");
    const text = fullText("services/refundService.ts");
    expect(text).not.toContain("AGENT_DB");
    expect(text).not.toContain("CREATE TABLE");
  });
});
