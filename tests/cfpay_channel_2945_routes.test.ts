// @vitest-environment node
/**
 * Issue #2945 route tests (Monetization Phase 2.17, program #2405):
 * cfpay channel routes — mint, confirm (HITL), purchases list,
 * reconcile — plus the cfpay-channel refund rail on the 2.7 machinery.
 * Harness mirrors tests/cancel_refund_policy_2662_routes.test.ts
 * (MockD1Database over node:sqlite, real Drizzle adapters, fetch
 * stubbed as the cfpay A2A agent returning artifact data parts).
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
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
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import {
  createD1ChannelDb,
  D1ChannelDraftAdapter,
  ensureChannelSchema,
} from "../src/data/d1CfpayChannelAdapter";
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import type { DatabaseORM } from "../src/orm";

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

interface CfpayStubOptions {
  status?: string;
  paymentIntentId?: string | null;
  fulfilOk?: boolean;
  totalsData?: unknown;
}

interface CfpayStub {
  calls: Array<{ operation: string; args: Record<string, unknown> }>;
  created: Map<string, string>;
}

/** cfpay A2A stub: routes by the data part's operation, echoes created checkouts. */
function stubCfpay(opts: CfpayStubOptions = {}): CfpayStub {
  const calls: CfpayStub["calls"] = [];
  const created = new Map<string, string>();
  const status = opts.status ?? "paid";
  const paymentIntentId = opts.paymentIntentId === undefined ? "pi_test_1" : opts.paymentIntentId;
  const fulfilOk = opts.fulfilOk ?? true;
  const totalsData = opts.totalsData === undefined ? { total: 0.02 } : opts.totalsData;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const data = body?.params?.message?.parts?.[0]?.data as Record<string, unknown>;
      const operation = String(data?.operation ?? "");
      const args = { ...(data as Record<string, unknown>) };
      delete args.operation;
      calls.push({ operation, args });
      let payload: Record<string, unknown>;
      if (operation === "checkout.create") {
        created.set(String(args.requestId), String(args.email));
        payload = {};
      } else if (operation === "checkout.status") {
        payload = {
          status,
          requestId: String(args.requestId),
          email: created.get(String(args.requestId)) ?? "buyer@example.com",
          ...(paymentIntentId !== null ? { paymentIntentId } : {}),
        };
      } else if (operation === "checkout.fulfil") {
        payload = fulfilOk ? {} : { ok: false, error: "fulfil boom" };
      } else if (operation === "payments.totals") {
        payload = totalsData as Record<string, unknown>;
      } else if (operation === "payments.list") {
        payload = { items: [] };
      } else {
        throw new Error(`unexpected cfpay operation ${operation}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: { artifacts: [{ parts: [{ kind: "data", data: payload }] }] },
        }),
      } as any;
    }),
  );
  return { calls, created };
}

async function setup(opts: {
  monetization?: boolean;
  cfpayToken?: boolean;
  approveStock?: boolean;
  attested?: number | null;
} = {}) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  const catalogueDb = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensurePriceCatalogueSchema(catalogueDb);
  await ensureChannelSchema(createD1ChannelDb(mock as unknown as D1Database));
  const refundDb = createD1RefundDb(mock as unknown as D1Database);
  await ensureRefundSchema(refundDb);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  if (opts.monetization !== false) env.MONETIZATION_ENABLED = "true";
  if (opts.cfpayToken !== false) env.CFPAY_OUTBOUND_TOKEN = "stub-token";
  const txRows: Array<Record<string, unknown>> = [];
  const ctx = {
    env,
    getOrm: () =>
      ({
        transactions: {
          create: async (row: Record<string, unknown>) => {
            txRows.push(row);
            return row;
          },
        },
      }) as unknown as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const policy = new D1BillingPolicyAdapter(policyDb);
  const catalogue = new D1PriceCatalogueAdapter(catalogueDb);
  const commercial = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
  const drafts = new D1ChannelDraftAdapter(createD1ChannelDb(mock as unknown as D1Database));
  const refunds = new D1RefundAdapter(refundDb);
  if (opts.approveStock) await catalogue.approvePrice({ family: "stock", approverId: "op1" });
  if (opts.attested !== undefined && opts.attested !== null) {
    await policy.updatePolicy({ cfpayChannelFixedPriceUSD: opts.attested });
  }
  return { ctx, env, policy, catalogue, commercial, drafts, refunds, txRows, mock };
}

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

const MINT_PATH = "/api/payments/agentic/commercial/channel/checkout";
const CONFIRM_PATH = "/api/payments/agentic/commercial/channel/purchase";
const LIST_PATH = "/api/payments/agentic/commercial/channel/purchases";
const RECONCILE_PATH = "/api/payments/agentic/commercial/channel/reconcile";

async function mintOk(ctx: AgenticPaymentsRouteContext, cfpay: CfpayStub) {
  const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
  expect(res?.status).toBe(201);
  const body = await bodyOf(res);
  expect(body.draft.id.startsWith("cfpay-")).toBe(true);
  expect(body.draft.status).toBe("minted");
  expect(body.draft.expectedPriceUSD).toBe(0.02);
  expect(cfpay.calls.some((c) => c.operation === "checkout.create")).toBe(true);
  return body.draft.id as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel mint (#2945)", () => {
  it("mints a draft at the approved price when the attestation matches", async () => {
    const cfpay = stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    expect(typeof draftId).toBe("string");
  });

  it("refuses 401 without a login", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const res = await call(ctx, "POST", MINT_PATH, null, { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(401);
  });

  it("refuses 403 when the monetization flag is off", async () => {
    stubCfpay();
    const { ctx } = await setup({ monetization: false, approveStock: true, attested: 0.02 });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(403);
  });

  it("refuses 503 when cfpay is not configured", async () => {
    stubCfpay();
    const { ctx } = await setup({ cfpayToken: false, approveStock: true, attested: 0.02 });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(503);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_NOT_CONFIGURED");
  });

  it("refuses 503 when the operator attestation is unset", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(503);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_NOT_CONFIGURED");
  });

  it("refuses 503 when no price is approved for the family", async () => {
    stubCfpay();
    const { ctx } = await setup({ attested: 0.02 });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(503);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_NOT_CONFIGURED");
  });

  it("refuses 409 when the approved price differs from the attestation", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.05 });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "stock", email: "buyer@example.com" });
    expect(res?.status).toBe(409);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_PRICE_MISMATCH");
  });

  it("refuses 400 for an invalid family", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const res = await call(ctx, "POST", MINT_PATH, "user1", { family: "bogus", email: "buyer@example.com" });
    expect(res?.status).toBe(400);
  });
});

describe("channel confirm (#2945)", () => {
  it("fulfils on verified paid status: fulfil called, credit topped up, ledger row written", async () => {
    const cfpay = stubCfpay();
    const { ctx, commercial, txRows } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const res = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.draft.status).toBe("fulfilled");
    expect(body.draft.paymentIntentId).toBe("pi_test_1");
    expect(body.draft.fulfilSkippedReason).toBeNull();
    expect(cfpay.calls.some((c) => c.operation === "checkout.fulfil")).toBe(true);
    const account = await commercial.getAccount("user1");
    expect(account?.creditsUSD).toBe(0.02);
    expect(txRows).toHaveLength(1);
    expect(txRows[0].gateway).toBe("cfpay-channel");
    expect(txRows[0].customer).toBe("user1");
    expect(txRows[0].status).toBe("completed");
    expect(txRows[0].amount).toBe(0.02);
  });

  it("skips fulfil with a stated reason when no payment intent is carried", async () => {
    const cfpay = stubCfpay({ paymentIntentId: null });
    const { ctx, commercial } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const res = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).draft.fulfilSkippedReason).toBe("no_payment_intent");
    expect(cfpay.calls.some((c) => c.operation === "checkout.fulfil")).toBe(false);
    expect((await commercial.getAccount("user1"))?.creditsUSD).toBe(0.02);
  });

  it("refuses 402 when the retrieved status is not paid, granting nothing", async () => {
    const cfpay = stubCfpay({ status: "pending" });
    const { ctx, commercial } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const res = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId });
    expect(res?.status).toBe(402);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_NOT_PAID");
    // The confirm route provisions the Free account before verifying;
    // the refusal grants no credit, so the balance stays zero.
    expect((await commercial.getAccount("user1"))?.creditsUSD).toBe(0);
  });

  it("refuses 502 when fulfil fails, leaving the draft minted", async () => {
    const cfpay = stubCfpay({ fulfilOk: false });
    const { ctx, commercial, drafts } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const res = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId });
    expect(res?.status).toBe(502);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_FULFIL_FAILED");
    expect((await drafts.getDraft(draftId))?.status).toBe("minted");
    expect((await commercial.getAccount("user1"))?.creditsUSD).toBe(0);
  });

  it("refuses 409 on replay of a fulfilled draft", async () => {
    const cfpay = stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    expect((await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId }))?.status).toBe(200);
    const replay = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId });
    expect(replay?.status).toBe(409);
    expect((await bodyOf(replay)).code).toBe("FAILURE_CHANNEL_REPLAY");
  });

  it("refuses 403 when another user confirms", async () => {
    const cfpay = stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const res = await call(ctx, "POST", CONFIRM_PATH, "user2", { channelRequestId: draftId });
    expect(res?.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_FORBIDDEN");
  });

  it("refuses 404 for an unknown draft", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const res = await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: "cfpay-nope" });
    expect(res?.status).toBe(404);
    expect((await bodyOf(res)).code).toBe("FAILURE_CHANNEL_UNKNOWN_PURCHASE");
  });
});

describe("channel reads + reconcile (#2945)", () => {
  it("lists the owner's purchases; operator reads another user's; stranger is refused", async () => {
    const cfpay = stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    const own = await call(ctx, "GET", LIST_PATH, "user1");
    expect(own?.status).toBe(200);
    expect((await bodyOf(own)).purchases.map((p: any) => p.id)).toContain(draftId);
    const asOperator = await call(ctx, "GET", `${LIST_PATH}?userId=user1`, "op1");
    expect(asOperator?.status).toBe(200);
    expect((await bodyOf(asOperator)).purchases).toHaveLength(1);
    const asStranger = await call(ctx, "GET", `${LIST_PATH}?userId=user1`, "user2");
    expect(asStranger?.status).toBe(403);
  });

  it("reconcile is operator-only and reports match against cfpay totals", async () => {
    const cfpay = stubCfpay({ totalsData: { total: 0.02 } });
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    expect((await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId }))?.status).toBe(200);
    const stranger = await call(ctx, "POST", RECONCILE_PATH, "user1");
    expect(stranger?.status).toBe(403);
    const res = await call(ctx, "POST", RECONCILE_PATH, "op1");
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.verdict).toBe("match");
    expect(body.local.count).toBe(1);
    expect(body.local.totalUSD).toBe(0.02);
  });

  it("reconcile reports unverifiable when cfpay totals carry no comparable number", async () => {
    const cfpay = stubCfpay({ totalsData: {} });
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const draftId = await mintOk(ctx, cfpay);
    expect((await call(ctx, "POST", CONFIRM_PATH, "user1", { channelRequestId: draftId }))?.status).toBe(200);
    const res = await call(ctx, "POST", RECONCILE_PATH, "op1");
    expect((await bodyOf(res)).verdict).toBe("unverifiable");
  });
});

describe("channel refund rail (#2945 on 2.7 machinery)", () => {
  it("refuses a pay-per-run cfpay-channel refund request without a resolved source (#3180)", async () => {
    stubCfpay();
    const { ctx } = await setup({ approveStock: true, attested: 0.02 });
    const approve = await call(ctx, "POST", "/api/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "pay_per_run",
      approved: true,
    });
    expect(approve?.status).toBe(200);
    // Issue #3180: the refund tenant comes from the resolved
    // payment source only. A channel run has no resolved source
    // at request time, so the request is refused even though the
    // kind is approved and the body carries a tenantId — the
    // client-supplied tenant is never trusted.
    const res = await call(ctx, "POST", "/api/payments/agentic/commercial/refunds", "user1", {
      kind: "pay_per_run",
      originalPaymentRef: "cfpay-x",
      amountUSD: 0.02,
      reason: "test",
      tenantId: "t1",
      originalAmountUSD: 0.02,
      originalPaidAtMs: Date.now(),
      rail: "cfpay-channel",
    });
    expect(res?.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/tenantId is required/);
  });
});
