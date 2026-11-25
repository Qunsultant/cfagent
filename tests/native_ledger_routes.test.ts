/**
 * Issue #2192 ([Native payments] Slice 0, sub-issue of #2012,
 * umbrella #2146) — route tests.
 *
 * (a) POST /payments/agentic/ledger/record-native NO LONGER
 * EXISTS (#5572, ledger gate): the route was removed on a
 * re-verified zero-production-caller grep — the workflow calls
 * the native port directly. The handler returns null for the
 * path, touches no store, and audits nothing. The port-level
 * behavior (D1 rows, dedupe, truthful gateway) is pinned by
 * the adapter tests and the webhook part below, untouched.
 * (b) POST /payments/webhook through a real OrchestratorAgent:
 * a verified native session records a D1 row + audits
 * payment.settled_webhook with native:true, never touches
 * mas_transactions, never delivers a workflow wake-up, and
 * unmarked events keep the existing loud-unmatched behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/services/agenticPayments", () => ({
  ETradeAgenticPaymentService: class {
    constructor(..._args: unknown[]) {}
  },
}));

import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1NativeLedgerDb,
  D1NativeLedgerAdapter,
  ensureNativeLedgerSchema,
} from "../src/data/d1NativeLedgerAdapter";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

const baseCtx = (overrides: Partial<AgenticPaymentsRouteContext> = {}): AgenticPaymentsRouteContext =>
  ({
    env: {},
    getOrm: vi.fn(() => {
      throw new Error("DO store must not be touched by the native endpoint");
    }),
    audit: vi.fn(),
    ...overrides,
  }) as unknown as AgenticPaymentsRouteContext;

const postRecordNative = (
  ctx: AgenticPaymentsRouteContext,
  body: unknown,
  login?: string,
) =>
  handleAgenticPaymentsRoutes(
    new Request("https://agent.internal/payments/agentic/ledger/record-native", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(login === undefined ? {} : { "x-user-login": login }),
      },
      body: JSON.stringify(body),
    }),
    new URL("https://agent.internal/payments/agentic/ledger/record-native"),
    "/payments/agentic/ledger/record-native",
    "sess-test",
    ctx,
  );

const chargeBody = (overrides: Record<string, unknown> = {}) => ({
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

describe("POST /payments/agentic/ledger/record-native — removed (#5572)", () => {
  it("returns null for every presenter and touches no store", async () => {
    const mock = new MockD1Database();
    const audit = vi.fn();
    const ctx = baseCtx({ env: { AGENT_DB: mock } as any, audit: audit as any });
    // Service identity, user identity, and no identity: the route
    // does not exist, so the handler falls through for all of them.
    // baseCtx's getOrm throws if touched, so a null result also
    // proves the DO store was never read.
    expect(await postRecordNative(ctx, chargeBody(), "svc-test")).toBeNull();
    expect(await postRecordNative(ctx, chargeBody(), "some-user")).toBeNull();
    expect(await postRecordNative(ctx, chargeBody())).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns null with AGENT_DB unbound too (no 503: there is no route to fail closed)", async () => {
    const audit = vi.fn();
    const ctx = baseCtx({ env: {} as any, audit: audit as any });
    expect(await postRecordNative(ctx, chargeBody(), "svc-test")).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Webhook end-to-end (real OrchestratorAgent over MockSqlStorage)
// ---------------------------------------------------------------------------

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
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
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const STRIPE_WH_SECRET = "whsec_native_test";
const RECEIVER = "sess-webhook-receiver";

class FakeSessionStore {
  entries = new Map<string, { value: string; expiresAt: number | null }>();
  idFromName(name: string) {
    return name;
  }
  get(_id: unknown) {
    const entries = this.entries;
    return {
      fetch: async (req: Request) => {
        const body = (await req.json()) as any;
        const k = `${body.ns}:${body.key}`;
        const now = Date.now();
        const live = () => {
          const e = entries.get(k);
          if (!e) return undefined;
          if (e.expiresAt !== null && e.expiresAt <= now) {
            entries.delete(k);
            return undefined;
          }
          return e;
        };
        switch (body.op) {
          case "get": {
            const e = live();
            return Response.json({ value: e ? e.value : null });
          }
          case "put": {
            entries.set(k, {
              value: body.value,
              expiresAt: typeof body.ttl === "number" ? now + body.ttl * 1000 : null,
            });
            return Response.json({ ok: true });
          }
          case "delete": {
            entries.delete(k);
            return Response.json({ ok: true });
          }
          case "consume": {
            if (live()) return Response.json({ consumed: false });
            entries.set(k, {
              value: body.value ?? "",
              expiresAt: typeof body.ttl === "number" ? now + body.ttl * 1000 : null,
            });
            return Response.json({ consumed: true });
          }
        }
        return Response.json({ error: "bad op" }, { status: 400 });
      },
    };
  }
}

class FakeAgentNamespace {
  agents = new Map<string, OrchestratorAgent>();
  idFromName(name: string) {
    return name;
  }
  idFromString(id: string) {
    return id;
  }
  get(key: unknown) {
    const agents = this.agents;
    return {
      fetch: async (req: Request) => {
        const agent = agents.get(String(key));
        if (!agent) return Response.json({ error: "unknown instance" }, { status: 404 });
        return agent.onRequest(req);
      },
    };
  }
}

async function stripeSignature(body: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const v1 = await computeHmacSha256Hex(secret, `${ts}.${body}`);
  return `t=${ts},v1=${v1}`;
}

// #6102: audit rows land in D1 now (the DO mas_events table is
// frozen history). The orchestrator's audit() is sync
// fire-and-forget, so poll briefly until the row lands.
const auditsOf = (d1Store: D1AuditEventStore, type: string) =>
  d1Store.findMany({ where: { type } });
async function pollAuditEvents(d1Store: D1AuditEventStore, type: string) {
  let rows = await auditsOf(d1Store, type);
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
    rows = await auditsOf(d1Store, type);
  }
  return rows;
}

describe("POST /payments/webhook native branch (#2192)", () => {
  let agent: OrchestratorAgent;
  let sql: MockSqlStorage;
  let mockD1: MockD1Database;
  let d1Store: D1AuditEventStore;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const store = new FakeSessionStore();
    const ns = new FakeAgentNamespace();
    mockD1 = new MockD1Database();
    // #6102: read audit rows from the same mock bound as AGENT_DB.
    d1Store = new D1AuditEventStore(createD1AuditEventDb(mockD1 as never));
    const env = {
      AI: {} as any,
      ORCHESTRATOR_AGENT: ns as any,
      SESSION_STORE: store as any,
      AGENT_SESSIONS: {} as any,
      AGENT_DB: mockD1 as any,
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_WEBHOOK_SECRET: STRIPE_WH_SECRET,
    } as Env;
    sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => RECEIVER, name: RECEIVER },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    agent = new OrchestratorAgent(ctx as any, env);
    ns.agents.set(RECEIVER, agent);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
  });

  const postWebhook = async (body: unknown) => {
    const raw = JSON.stringify(body);
    return agent.onRequest(
      new Request("https://agent.internal/payments/webhook?provider=stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": await stripeSignature(raw, STRIPE_WH_SECRET),
        },
        body: raw,
      }),
    );
  };

  const nativeSession = (overrides: Record<string, unknown> = {}) => ({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_native_1",
        client_reference_id: "run-1",
        payment_status: "paid",
        payment_intent: "pi_native_1",
        amount_total: 10,
        currency: "usd",
        metadata: {
          origin: "screener-native",
          userId: "u1",
          family: "goal",
          tenantId: "tenant-a",
        },
        ...overrides,
      },
    },
  });

  const nativeRows = async () => {
    const db = createD1NativeLedgerDb(mockD1 as any);
    // Ensure first: branches that return before recording (unmarked
    // events, subscription drafts) never create the table, and a
    // read against a missing table must not throw the test.
    await ensureNativeLedgerSchema(db);
    return new D1NativeLedgerAdapter(db).listRowsForTenant("tenant-a");
  };

  it("records a native run charge in D1 and audits settled with native:true", async () => {
    const res = await postWebhook(nativeSession());
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({
      received: true,
      settled: true,
      native: true,
      draftId: "run-1",
      recorded: true,
      duplicate: false,
    });

    const rows = await nativeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "screener-payment-native:run-1",
      action: "charge",
      gateway: "stripe",
      gatewayRef: "cs_test_native_1",
      amount: 0.1,
    });
    // mas_transactions untouched: the native row lives in D1 only.
    expect(Array.from(sql.exec("SELECT * FROM mas_transactions"))).toHaveLength(0);
    const settled = await pollAuditEvents(d1Store, "payment.settled_webhook");
    expect(settled).toHaveLength(1);
    expect(JSON.parse(settled[0].payload as unknown as string)).toMatchObject({ draftId: "run-1", native: true });
  });

  it("replays a native webhook as a duplicate, never a second row", async () => {
    await postWebhook(nativeSession());
    const res = await postWebhook(nativeSession());
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ received: true, settled: true, native: true, recorded: true, duplicate: true });
    expect(await nativeRows()).toHaveLength(1);
  });

  it("a native subscription draft audits settled but records no run row", async () => {
    const res = await postWebhook(
      nativeSession({ client_reference_id: "sub-abc", amount_total: 500 }),
    );
    const json = (await res.json()) as any;
    expect(json).toMatchObject({
      received: true,
      settled: true,
      native: true,
      draftId: "sub-abc",
      recorded: false,
    });
    expect(await nativeRows()).toHaveLength(0);
    const settled = await pollAuditEvents(d1Store, "payment.settled_webhook");
    expect(settled).toHaveLength(1);
    expect(JSON.parse(settled[0].payload as unknown as string)).toMatchObject({ kind: "subscription", native: true });
  });

  it("an unmarked event keeps the existing loud-unmatched behavior", async () => {
    const body = nativeSession();
    delete (body.data.object.metadata as Record<string, unknown>)["origin"];
    const res = await postWebhook(body);
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ received: false, unmatched: true });
    expect(await nativeRows()).toHaveLength(0);
  });

  it("a native event with incomplete metadata audits unrecorded, never invents attribution", async () => {
    const body = nativeSession();
    delete (body.data.object.metadata as Record<string, unknown>)["family"];
    const res = await postWebhook(body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ received: true, native: true, recorded: false });
    expect(await nativeRows()).toHaveLength(0);
    const unrecorded = await pollAuditEvents(d1Store, "payment.settled_webhook_native_unrecorded");
    expect(unrecorded).toHaveLength(1);
    expect(JSON.parse(unrecorded[0].payload as unknown as string).reason).toContain("family");
  });
});
