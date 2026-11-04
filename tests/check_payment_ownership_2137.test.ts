// @vitest-environment node
/**
 * Issue #2137 (check-payment ownership hardening): the production
 * submission/check-payment route must verify that the verified
 * session login OWNS the submission being verified — the same
 * ownership the submit route records and submission-status already
 * enforces. Before this slice, check-payment accepted any verified
 * login's runRequestId (plus a caller-supplied sessionId, family,
 * paymentProof, or payer) and verified it without ever looking up
 * the submission owner, so one user could verify — and deliver
 * payment_verified for — another user's (or another tenant's) run.
 *
 * Gate (record-aware, stated plainly): when a paid-submission
 * record exists for the runRequestId (the submit route records
 * every paid submission under the verified login BEFORE the
 * workflow starts, fail-closed on record failure), a caller whose
 * login differs from the record's userId gets 403 before any
 * Stripe retrieve, audit scan, or facilitator call. Ownership is
 * per-login, which is strictly stronger than per-tenant: a
 * tenant is derived from the login via the platform identity,
 * never from a client-supplied tenantId, so a different-tenant
 * login is necessarily a different login and is refused too.
 * An unbound commercial store fails closed with 503.
 *
 * Residual, pinned by the existing suite rather than hidden:
 * when NO record exists (a pre-record legacy run, or the
 * redeemed path's best-effort record failure — redeemed runs
 * start no payment workflow), there is no owner to check
 * against, so the route follows the legacy verify path. A
 * strict unknown -> 404 flip needs the existing check-payment
 * fixtures (tests/commercial_checkout_ui_routes.test.ts, outside
 * this slice's file ownership) to seed a paid submission first.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1PriceCatalogueDb,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice 0). */
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

async function setup(record?: { workflowId: string; userId: string; runRequestId: string }) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensurePriceCatalogueSchema(createD1PriceCatalogueDb(mock as unknown as D1Database));
  if (record) {
    const store = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
    await store.recordPaidSubmission(record);
  }
  const sendEvent = vi.fn(async () => {});
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({ sendEvent })),
  };
  const ctx = {
    env: {
      AGENT_DB: mock,
      STRIPE_SECRET_KEY: "sk_test_x",
      X402_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
      PAYMENT_WORKFLOW: binding,
    },
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, sendEvent, binding };
}

function stubStripe(session: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    if (String(url).startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
      return { ok: true, json: async () => session };
    }
    return { ok: false, json: async () => ({}) };
  });
}

const stripeSession = (over: Record<string, unknown> = {}) => ({
  id: "cs_test_run-1",
  status: "complete",
  payment_status: "paid",
  amount_total: 2,
  client_reference_id: "run-1",
  payment_intent: "pi_test_run-1",
  url: "https://checkout.stripe.com/pay/cs_test_run-1",
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("check-payment ownership (#2137)", () => {
  it("lets the recorded owner verify a paid card checkout", async () => {
    const fetchMock = stubStripe(stripeSession());
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, sendEvent } = await setup({ workflowId: "run-1", userId: "owner1", runRequestId: "run-1" });
    const res = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "owner1",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { paid: boolean; delivered: boolean };
    expect(body.paid).toBe(true);
    expect(body.delivered).toBe(true);
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_verified" }),
    );
  });

  it("refuses a different verified user with 403 before any Stripe retrieve", async () => {
    const fetchMock = stubStripe(stripeSession());
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, sendEvent } = await setup({ workflowId: "run-1", userId: "owner1", runRequestId: "run-1" });
    const res = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "user2",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(res?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("refuses a login from another tenant with 403 — ownership is per-login, never per client tenantId", async () => {
    const fetchMock = stubStripe(stripeSession());
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, sendEvent } = await setup({
      workflowId: "run-1",
      userId: "tenant-a-user",
      runRequestId: "run-1",
    });
    const res = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "tenant-b-user",
      { runRequestId: "run-1", sessionId: "cs_test_run-1", family: "stock" },
    );
    expect(res?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("refuses a different user on the informational path too — the gate precedes the audit scan", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { ctx, sendEvent } = await setup({ workflowId: "run-1", userId: "owner1", runRequestId: "run-1" });
    const res = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "user2",
      { runRequestId: "run-1" },
    );
    expect(res?.status).toBe(403);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("refuses a different user's x402 proof with 403 before any facilitator call", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("/verify")) {
        return { ok: true, json: async () => ({ isValid: true }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const payer = "0x2222222222222222222222222222222222222222";
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer })).toString("base64");
    const { ctx, sendEvent } = await setup({ workflowId: "run-1", userId: "owner1", runRequestId: "run-1" });
    const res = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "user2",
      { runRequestId: "run-1", family: "stock", paymentProof: proof, payer },
    );
    expect(res?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("still requires a verified login (401) and fails closed with 503 on an unbound store", async () => {
    const { ctx } = await setup({ workflowId: "run-1", userId: "owner1", runRequestId: "run-1" });
    const anon = await call(
      ctx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      null,
      { runRequestId: "run-1" },
    );
    expect(anon?.status).toBe(401);
    const noDbCtx = {
      ...ctx,
      env: { ...((ctx.env as unknown) as Record<string, unknown>), AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const noStore = await call(
      noDbCtx,
      "POST",
      "/payments/agentic/commercial/submission/check-payment",
      "owner1",
      { runRequestId: "run-1" },
    );
    expect(noStore?.status).toBe(503);
  });
});
