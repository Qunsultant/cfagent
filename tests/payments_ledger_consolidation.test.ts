/**
 * Issue #896 (from the #785 audit): consolidate the dual payment ledgers.
 *
 * Pins:
 * - processPaidRequest records into mas_transactions (the ledger of
 *   record, owned by the OrchestratorAgent) — visible via the real
 *   GET /payments/transactions route — and writes NOTHING to the
 *   PaymentsAgent ctx.storage `payments` / `budgetGuard` blob keys.
 * - Concurrent-pair safety (the #785 throwaway race demonstration,
 *   merged): two concurrent verified payments persist as TWO ledger
 *   rows; a concurrent replay of one idempotency key cannot slip a
 *   second record past the facilitator await.
 * - Budget truth reconciles with mas_transactions: spend already in
 *   the ledger (agentic micropayments + PaymentsAgent-origin rows)
 *   moves ScheduledAgent's budgetCheck; an idempotency key already in
 *   the ledger replays as a duplicate.
 * - budgetCheck stays fail-closed when the ledger is unreachable.
 * - Legacy blob records migrate losslessly + idempotently via
 *   migrateLegacyLedger(); guard-only keys are reported, not dropped.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("agents", () => {
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { PaymentsAgent } from "../src/agents/payments-agent";
import { AGENTIC_SPEND_AGENT_ID } from "../src/payments/ledger";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handleAgenticPaymentsRoutes } from "../src/agents/routes/agenticPayments";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    _store: store,
  };
}

/** The ledger owner: a real DatabaseORM over MockSqlStorage, served through
 *  the REAL agentic-payments route handler (the OrchestratorAgent surface). */
function makeLedger() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("default_trader");
  const routeCtx = {
    env: {} as any,
    getOrm: () => orm,
    audit: () => {},
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const res = await handleAgenticPaymentsRoutes(
          req,
          url,
          url.pathname,
          "default_trader",
          routeCtx as any
        );
        return res ?? Response.json({ error: "no such route" }, { status: 404 });
      },
    }),
  };
  return { sql, orm, namespace };
}

function makeEnv(ledger?: ReturnType<typeof makeLedger>) {
  // Issue #1185: the fixture's configured service identity — the
  // ledger owner login the fake namespace serves.
  const env: any = {
    CF_WALLET_FACILITATOR: "https://facilitator.test",
    SERVICE_USER_LOGIN: "default_trader",
  };
  if (ledger) env.ORCHESTRATOR_AGENT = ledger.namespace;
  return env;
}

const proof = () => btoa(JSON.stringify({ signature: "0xsig", payer: "0xpayer" }));
const okFacilitator = () => vi.stubGlobal("fetch", async () => Response.json({ isValid: true }));

function paymentsAgentRows(orm: DatabaseORM) {
  return orm.transactions
    .findMany()
    .filter((t) => String(t.sessionId).startsWith("payments-agent:"));
}

describe("PaymentsAgent records into mas_transactions (#896)", () => {
  it("processPaidRequest writes a ledger row visible in GET /payments/transactions, and no blob keys", async () => {
    okFacilitator();
    const ledger = makeLedger();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));

    const record = await agent.processPaidRequest({
      agentId: "a1",
      operation: "search.query",
      amountCents: 250,
      idempotencyKey: "key-visible",
      paymentProof: proof(),
    });
    expect(record.status).toBe("verified");
    expect(record.idempotencyKey).toBe("key-visible");

    const rows = paymentsAgentRows(ledger.orm);
    expect(rows).toHaveLength(1);
    expect(rows[0].gatewayRef).toBe("key-visible");
    expect(Number(rows[0].amount)).toBeCloseTo(2.5);

    // The UX ledger route reads the same mas_transactions store.
    const res = await handlePaymentsRoutes(
      new Request("https://agent.internal/payments/transactions"),
      new URL("https://agent.internal/payments/transactions"),
      "/payments/transactions",
      "default_trader",
      { env: {} as any, ensureTables: () => ledger.sql as any, audit: () => {} } as any
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.transactions.some((t: any) => t.gatewayRef === "key-visible")).toBe(true);

    // The blob ledger is gone as a system of record.
    expect(ctx._store.has("payments")).toBe(false);
    expect(ctx._store.has("budgetGuard")).toBe(false);
  });

  it("concurrent pair: two concurrent verified payments persist as two ledger rows", async () => {
    vi.stubGlobal("fetch", async () => {
      await new Promise((r) => setTimeout(r, 25));
      return Response.json({ isValid: true });
    });
    const ledger = makeLedger();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));

    const base = { agentId: "a1", operation: "search.query", amountCents: 100, paymentProof: proof() };
    const [r1, r2] = await Promise.all([
      agent.processPaidRequest({ ...base, idempotencyKey: "conc-a" }),
      agent.processPaidRequest({ ...base, idempotencyKey: "conc-b" }),
    ]);
    expect(r1.idempotencyKey).toBe("conc-a");
    expect(r2.idempotencyKey).toBe("conc-b");

    const rows = paymentsAgentRows(ledger.orm);
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.gatewayRef).sort()).toEqual(["conc-a", "conc-b"]);

    // Both keys are seen: a replay of either is rejected.
    await expect(
      agent.processPaidRequest({ ...base, idempotencyKey: "conc-a" })
    ).rejects.toThrow(/duplicate idempotency key/);
    expect(await agent.todaySpent()).toBe(200);
  });

  it("concurrent replay of the SAME key: exactly one record persists", async () => {
    vi.stubGlobal("fetch", async () => {
      await new Promise((r) => setTimeout(r, 25));
      return Response.json({ isValid: true });
    });
    const ledger = makeLedger();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));
    const req = {
      agentId: "a1",
      operation: "search.query",
      amountCents: 100,
      idempotencyKey: "conc-same",
      paymentProof: proof(),
    };
    const results = await Promise.allSettled([
      agent.processPaidRequest(req),
      agent.processPaidRequest(req),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as any).reason)).toMatch(/duplicate idempotency key/);
    expect(paymentsAgentRows(ledger.orm)).toHaveLength(1);
  });

  it("listPayments reads the ledger, newest first", async () => {
    okFacilitator();
    const ledger = makeLedger();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));
    await agent.processPaidRequest({
      agentId: "a1", operation: "search.query", amountCents: 10,
      idempotencyKey: "lp-1", paymentProof: proof(),
    });
    await agent.processPaidRequest({
      agentId: "a1", operation: "payments.draft", amountCents: 20,
      idempotencyKey: "lp-2", paymentProof: proof(),
    });
    const list = await agent.listPayments();
    expect(list.map((p: any) => p.idempotencyKey)).toEqual(["lp-2", "lp-1"]);
    expect(list[0].amountCents).toBe(20);
    expect(ctx._store.has("payments")).toBe(false);
  });

  it("listPayments stays newest-first when two payments share a millisecond timestamp", async () => {
    // Regression: createdAt is millisecond-resolution, so two payments
    // recorded in the same millisecond tie on timestamp. A plain
    // timestamp sort is stable, so it returned them in insertion
    // (oldest-first) order and broke the newest-first contract.
    const ledger = makeLedger();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));
    const ts = "2026-10-22T05:36:43.000Z";
    const seed = (id: string, key: string, amount: number) =>
      ledger.orm.transactions.create({
        id,
        sessionId: "payments-agent:a1",
        action: "micropayment",
        amount,
        currency: "USD",
        customer: "a1",
        gateway: "x402",
        gatewayRef: key,
        status: "completed",
        note: "search.query",
        createdAt: ts,
        updatedAt: ts,
      } as any);
    seed("tx_tie_1", "tie-1", 0.1);
    seed("tx_tie_2", "tie-2", 0.2);
    const list = await agent.listPayments();
    expect(list.map((p: any) => p.idempotencyKey)).toEqual(["tie-2", "tie-1"]);
  });
});

describe("Budget truth reconciles with mas_transactions (#896)", () => {
  it("agentic micropayment spend already in the ledger moves budgetCheck (split-brain pin)", async () => {
    const ledger = makeLedger();
    const now = new Date().toISOString();
    // $45 of outbound agentic spend recorded by the agentic-payments flow.
    ledger.orm.transactions.create({
      id: "tx_agentic_seed",
      sessionId: "default_trader",
      action: "micropayment",
      amount: 45,
      currency: "USD",
      customer: "0xrecipient",
      gateway: "x402",
      gatewayRef: "0xtxhash",
      status: "completed",
      checkoutUrl: "",
      proposerDid: "did:key:trading",
      authorizerDid: "did:key:0xpayer",
      proofSignature: "sig",
      note: "seeded agentic spend",
      createdAt: now,
      updatedAt: now,
    } as any);
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));
    // Default caps are 5000c/day and 1000c/call: $45 (4500c) already
    // spent, so a further 1000c check must be denied on the DAILY cap —
    // the pre-#896 guard blob saw none of this spend. Issue #2327: the
    // check names the orchestrator-attributed bucket explicitly (the
    // identity the retired callee-side default used to supply).
    const verdict = await agent.budgetCheck({ operation: "search.query", amountCents: 1000, agentId: AGENTIC_SPEND_AGENT_ID });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/daily cap exceeded/);
    // And a small check that fits the remaining headroom is still allowed.
    const small = await agent.budgetCheck({ operation: "search.query", amountCents: 400, agentId: AGENTIC_SPEND_AGENT_ID });
    expect(small.allowed).toBe(true);
  });

  it("an idempotency key already in the ledger replays as a duplicate", async () => {
    okFacilitator();
    const ledger = makeLedger();
    const now = new Date().toISOString();
    ledger.orm.transactions.create({
      id: "pay_seeded",
      sessionId: "payments-agent:a1",
      action: "micropayment",
      amount: 0.1,
      currency: "USD",
      customer: "a1",
      gateway: "x402",
      gatewayRef: "seeded-key",
      status: "completed",
      checkoutUrl: "",
      proposerDid: "did:key:payments",
      proofSignature: "sig",
      note: "search.query",
      createdAt: now,
      updatedAt: now,
    } as any);
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));
    await expect(
      agent.processPaidRequest({
        agentId: "a1", operation: "search.query", amountCents: 10,
        idempotencyKey: "seeded-key", paymentProof: proof(),
      })
    ).rejects.toThrow(/duplicate idempotency key/);
  });

  it("budgetCheck fails closed when the ledger owner is not bound", async () => {
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(undefined));
    // Explicit agentId (issue #2327) so this pin keeps exercising the
    // unreachable-ledger path, not the identity guard.
    const verdict = await agent.budgetCheck({ operation: "search.query", amountCents: 100, agentId: AGENTIC_SPEND_AGENT_ID });
    expect(verdict.allowed).toBe(false);
  });

  it("processPaidRequest fails loud (never records into the void) when the ledger is unreachable", async () => {
    okFacilitator();
    const ctx = makeCtx();
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(undefined));
    await expect(
      agent.processPaidRequest({
        agentId: "a1", operation: "search.query", amountCents: 10,
        idempotencyKey: "void-1", paymentProof: proof(),
      })
    ).rejects.toThrow(/ledger/);
    expect(ctx._store.has("payments")).toBe(false);
  });
});

describe("Legacy blob migration (#896)", () => {
  it("migrates pre-existing blob records losslessly + idempotently, reports guard-only keys, then retires the blob", async () => {
    const ledger = makeLedger();
    const ctx = makeCtx();
    const ts = new Date().toISOString();
    ctx._store.set("payments", [
      { id: "pay_old1", agentId: "a1", operation: "search.query", amountCents: 300, timestamp: ts, idempotencyKey: "old-1", status: "verified" },
      { id: "pay_old2", agentId: "a1", operation: "payments.draft", amountCents: 700, timestamp: ts, idempotencyKey: "old-2", status: "verified" },
    ]);
    ctx._store.set("budgetGuard", {
      dailySpend: [["a1", ts.slice(0, 10), 1000]],
      seenKeys: ["old-1", "old-2", "orphan-key"],
    });
    const agent = new (PaymentsAgent as any)(ctx, makeEnv(ledger));

    const result = await agent.migrateLegacyLedger();
    expect(result.found).toBe(2);
    expect(result.migrated).toBe(2);
    expect(result.orphanedGuardKeys).toEqual(["orphan-key"]);

    const rows = paymentsAgentRows(ledger.orm);
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.gatewayRef).sort()).toEqual(["old-1", "old-2"]);
    // Lossless: original timestamps survive the move.
    expect(rows.every((t) => t.createdAt === ts)).toBe(true);
    // The blob is retired only after the records landed.
    expect(ctx._store.has("payments")).toBe(false);
    expect(ctx._store.has("budgetGuard")).toBe(false);

    // Idempotent: re-seeding the same blob and re-running adds no rows.
    ctx._store.set("payments", [
      { id: "pay_old1", agentId: "a1", operation: "search.query", amountCents: 300, timestamp: ts, idempotencyKey: "old-1", status: "verified" },
    ]);
    const again = await agent.migrateLegacyLedger();
    expect(again.migrated).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(paymentsAgentRows(ledger.orm)).toHaveLength(2);

    // And the migrated spend is live budget truth now.
    const spent = await agent.todaySpent();
    expect(spent).toBe(1000);
  });
});
