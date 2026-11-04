// @vitest-environment node
/**
 * #2360 (#1976 step 4d-2) — CHARACTERIZATION for the payments
 * route's mas_transactions bypass closure, written against the
 * UNMODIFIED implementation. Every pin here must pass before
 * the cutover and keep passing after it: the slice moves the
 * route's eight raw statements behind the step-3a
 * transaction-ledger port; it changes no behaviour.
 *
 * The pins drive the REAL route handlers
 * (handlePaymentsRoutes) over a node:sqlite-backed SqlStorage
 * double with real SQL semantics, in PAYMENTS_FLOW_MODE=
 * immediate (the only mode whose flows touch mas_transactions
 * from this module — the HITL flows delegate to MCP commands):
 *
 *  - POST /payments/create (immediate): the 16-column INSERT —
 *    field mapping, the pending_checkout/completed initial
 *    status rule, checkout-before-insert ordering (a gateway
 *    failure writes NO row), payment.created audit.
 *  - POST /payments/confirm (immediate): the draft SELECT and
 *    the two status UPDATEs — field sets verbatim (approve:
 *    status/gateway_ref/checkout_url/authorizer_did/note/
 *    updated_at; reject: status/authorizer_did/note/
 *    updated_at), the note defaults, checkout-only-if-missing,
 *    the refund branch, and the recovered silent-success on a
 *    missing draft (approve AND reject). No status guard
 *    exists on either UPDATE — pinned as found.
 *  - POST /payments/capture: the completion UPDATE's
 *    `WHERE id = ? OR gateway_ref = ?` semantics (one call can
 *    settle two rows), gated on capture success.
 *  - POST /payments/webhook: the existence probes and the
 *    settle UPDATE — local settle, unknown draft (404 loud),
 *    settlement-hop owner_row_missing (404) and misrouted
 *    (502, settles nothing), signature gate (401), provider
 *    default-deny (401). The settle UPDATE has no status
 *    guard — an already-completed row's updated_at still
 *    moves; pinned as found.
 *
 * The gateway is the fetch-free sandbox strategy throughout,
 * except where a pin stubs PaymentGatewayService methods to
 * reach a route branch the sandbox cannot produce (empty
 * checkoutUrl, gateway failure, capture success/failure).
 *
 * #CDO-mha7
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handlePaymentsRoutes,
  type PaymentsRouteContext,
} from "../src/agents/routes/payments";
import { AGENT_DIDS, getUserDid } from "../src/agents/did";
import { SETTLEMENT_OWNER_HEADER } from "../src/payments/draftOwners";
import { PaymentGatewayService } from "../src/services/payments";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import { SHARED_TABLE_DDL } from "../src/data/ormSchema";
import { InMemoryAuditPolicyAdapter } from "../src/data/inMemoryAuditPolicyAdapter";

const SESSION = "user-session-2360";
const SENTINEL = "2000-01-01T00:00:00.000Z";
/** Webhook secret assembled from fragments (no literal secret shape). */
const WH_SECRET = ["whsec", "step4d2", "characterization"].join("_");

/** SqlStorage-shaped executor over node:sqlite (real semantics,
 *  rowsWritten-faithful like the DO cursor). */
class SqliteRouteStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(SHARED_TABLE_DDL.mas_transactions);
    // #3156: money execution now writes a payment.execution_started
    // audit through the chained mas_events repository (chain columns
    // are added by ensureAuditChainColumns on first write), so the
    // characterization storage must carry the audit table too.
    this.sqlite.exec(SHARED_TABLE_DDL.mas_events);
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
  row(id: string): any {
    return this.sqlite
      .prepare("SELECT * FROM mas_transactions WHERE id = ?")
      .get(id) as any;
  }
  allRows(): any[] {
    return this.sqlite
      .prepare("SELECT * FROM mas_transactions ORDER BY id")
      .all() as any[];
  }
  seed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const row: Record<string, unknown> = {
      id: "pay_seed1",
      session_id: SESSION,
      action: "charge",
      amount: 42.5,
      currency: "USD",
      customer: "Seed Co",
      gateway: "sandbox",
      gateway_ref: "sandbox_seed1",
      status: "pending_checkout",
      checkout_url: "https://agent.internal/checkout/sandbox?id=pay_seed1",
      proposer_did: AGENT_DIDS.PAYMENTS,
      authorizer_did: "",
      proof_signature: "sig_seed",
      note: "seed note",
      created_at: SENTINEL,
      updated_at: SENTINEL,
      ...overrides,
    };
    this.sqlite
      .prepare(
        "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        row.id, row.session_id, row.action, row.amount, row.currency,
        row.customer, row.gateway, row.gateway_ref, row.status,
        row.checkout_url, row.proposer_did, row.authorizer_did,
        row.proof_signature, row.note, row.created_at, row.updated_at
      );
    return row;
  }
}

interface AuditRow {
  type: string;
  agent: string;
  payload: Record<string, unknown>;
}

function makeCtx(
  storage: SqliteRouteStorage,
  envOverrides: Record<string, unknown> = {}
): { ctx: PaymentsRouteContext; audits: AuditRow[] } {
  const audits: AuditRow[] = [];
  const ctx = {
    env: {
      APP_BASE_URL: "https://agent.internal",
      PAYMENTS_FLOW_MODE: "immediate",
      STRIPE_WEBHOOK_SECRET: WH_SECRET,
      ...envOverrides,
    },
    ensureTables: () => storage as any,
    // #3156: the money-path audit gate needs a reachable policy
    // store, or it fails closed (503). The in-memory adapter stands
    // in for the orchestrator's D1 port on this direct route ctx.
    getAuditPolicyPort: async () => new InMemoryAuditPolicyAdapter(),
    audit: (type: string, agent: string, payload: Record<string, unknown>) => {
      audits.push({ type, agent, payload });
    },
  } as unknown as PaymentsRouteContext;
  return { ctx, audits };
}

const call = (
  ctx: PaymentsRouteContext,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  handlePaymentsRoutes(
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    new URL(`https://agent.internal${path}`),
    path.split("?")[0],
    SESSION,
    ctx
  );

const auditsOf = (audits: AuditRow[], type: string) =>
  audits.filter((a) => a.type === type);

/** ISO-8601 timestamps order lexicographically: strictly after the sentinel. */
const expectLaterThanSentinel = (iso: unknown) =>
  expect(typeof iso === "string" && (iso as string) > SENTINEL).toBe(true);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("immediate create — the ledger INSERT (#2360 characterization)", () => {
  it("stores the full 16-column row with the sandbox checkout fields and audits payment.created", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await call(ctx, "POST", "/payments/create", {
      amount: 25,
      currency: "usd",
      customer: "Acme Corp",
      gateway: "sandbox",
      description: "test desc",
    });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as any;
    expect(json.success).toBe(true);
    const tx = json.transaction;
    expect(tx.status).toBe("pending_checkout");
    expect(tx.checkoutUrl).toContain("/checkout/sandbox");

    const rows = storage.allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(tx.id);
    expect(row.session_id).toBe(SESSION);
    expect(row.action).toBe("charge");
    expect(row.amount).toBe(25);
    expect(row.currency).toBe("USD");
    expect(row.customer).toBe("Acme Corp");
    expect(row.gateway).toBe("sandbox");
    expect(row.gateway_ref).toBe(`sandbox_${String(tx.id).replace("pay_", "")}`);
    expect(row.gateway_ref).toBe(tx.gatewayRef);
    expect(row.status).toBe("pending_checkout");
    expect(row.checkout_url).toBe(tx.checkoutUrl);
    expect(row.proposer_did).toBe(AGENT_DIDS.PAYMENTS);
    expect(row.authorizer_did).toBe(getUserDid(SESSION));
    expect(row.proof_signature).toBe(tx.proofSignature);
    expect(row.proof_signature).toBeTruthy();
    expect(row.note).toBe("test desc");
    expect(row.created_at).toBe(tx.createdAt);
    expect(row.updated_at).toBe(tx.updatedAt);

    const created = auditsOf(audits, "payment.created");
    expect(created).toHaveLength(1);
    expect(created[0].agent).toBe("payments");
    expect(created[0].payload).toMatchObject({
      draftId: tx.id,
      amount: 25,
      currency: "USD",
      customer: "Acme Corp",
      gateway: "sandbox",
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid: getUserDid(SESSION),
      proofSignature: tx.proofSignature,
    });
  });

  it("a checkout with no URL stores initial status completed (the status rule)", async () => {
    vi.spyOn(PaymentGatewayService.prototype, "createCheckout").mockResolvedValue({
      success: true,
      draftId: "pay_stubbed",
      gateway: "sandbox",
      checkoutUrl: "",
      gatewayRef: "gw_stub_1",
      status: "completed",
      didAttestation: { signature: "sig_stub" },
      message: "stubbed",
    } as any);
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    const res = await call(ctx, "POST", "/payments/create", {
      amount: 10,
      customer: "No Url Co",
      gateway: "sandbox",
    });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as any;
    expect(json.transaction.status).toBe("completed");
    const row = storage.row(json.transaction.id);
    expect(row.status).toBe("completed");
    expect(row.checkout_url).toBe("");
    expect(row.gateway_ref).toBe("gw_stub_1");
    expect(row.proof_signature).toBe("sig_stub");
  });

  it("a gateway failure at create writes NO row (checkout precedes the insert)", async () => {
    vi.spyOn(PaymentGatewayService.prototype, "createCheckout").mockResolvedValue({
      success: false,
      message: "gateway down",
    } as any);
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await call(ctx, "POST", "/payments/create", {
      amount: 10,
      customer: "Fail Co",
      gateway: "sandbox",
    });
    expect(res!.status).toBe(400);
    const json = (await res!.json()) as any;
    expect(json).toMatchObject({
      success: false,
      error: "gateway down",
      code: "PAYMENT_GATEWAY_ERROR",
    });
    expect(storage.allRows()).toHaveLength(0);
    expect(auditsOf(audits, "payment.created")).toHaveLength(0);
  });
});

describe("immediate confirm — the draft SELECT and the two status UPDATEs (#2360 characterization)", () => {
  async function createViaRoute(storage: SqliteRouteStorage, ctx: PaymentsRouteContext) {
    const res = await call(ctx, "POST", "/payments/create", {
      amount: 25,
      customer: "Acme Corp",
      gateway: "sandbox",
    });
    const json = (await res!.json()) as any;
    return json.transaction as any;
  }

  it("approve keeps an existing checkout and completes with the default note", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const tx = await createViaRoute(storage, ctx);
    // Model time passing so the confirm UPDATE's updated_at is visible.
    storage.sqlite
      .prepare("UPDATE mas_transactions SET updated_at = ? WHERE id = ?")
      .run(SENTINEL, tx.id);

    const res = await call(ctx, "POST", "/payments/confirm", {
      draftId: tx.id,
      decision: "approved",
    });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as any;
    expect(json).toEqual({
      success: true,
      status: "completed",
      draftId: tx.id,
      checkoutUrl: tx.checkoutUrl,
      gatewayRef: tx.gatewayRef,
      authorizerDid: getUserDid(SESSION),
    });

    const row = storage.row(tx.id);
    expect(row.status).toBe("completed");
    expect(row.gateway_ref).toBe(tx.gatewayRef);
    expect(row.checkout_url).toBe(tx.checkoutUrl);
    expect(row.authorizer_did).toBe(getUserDid(SESSION));
    expect(row.note).toBe("Confirmed by human authorizer");
    expect(row.updated_at).not.toBe(SENTINEL);
    expectLaterThanSentinel(row.updated_at);

    const confirmed = auditsOf(audits, "payment.confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].payload).toEqual({
      draftId: tx.id,
      authorizerDid: getUserDid(SESSION),
      executorDid: AGENT_DIDS.ORCHESTRATOR,
      gatewayRef: tx.gatewayRef,
      checkoutUrl: tx.checkoutUrl,
    });
  });

  it("approve stores the caller's note when one is supplied", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    const tx = await createViaRoute(storage, ctx);
    await call(ctx, "POST", "/payments/confirm", {
      draftId: tx.id,
      decision: "approved",
      note: "ship it",
    });
    expect(storage.row(tx.id).note).toBe("ship it");
  });

  it("approve creates a checkout only when the draft has none", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    storage.seed({ id: "pay_nocheckout", checkout_url: "", gateway_ref: "" });
    const res = await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_nocheckout",
      decision: "approved",
    });
    const json = (await res!.json()) as any;
    expect(json.status).toBe("completed");
    expect(json.checkoutUrl).toContain("/checkout/sandbox");
    expect(json.gatewayRef).toBe("sandbox_nocheckout");
    const row = storage.row("pay_nocheckout");
    expect(row.status).toBe("completed");
    expect(row.checkout_url).toBe(json.checkoutUrl);
    expect(row.gateway_ref).toBe("sandbox_nocheckout");
  });

  it("approve on a refund draft replaces gateway_ref with the refund id and keeps checkout empty", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    storage.seed({
      id: "pay_refund1",
      action: "refund",
      checkout_url: "",
      gateway_ref: "sandbox_refund1",
    });
    const res = await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_refund1",
      decision: "approved",
    });
    const json = (await res!.json()) as any;
    expect(json.status).toBe("completed");
    expect(json.gatewayRef).toMatch(/^ref_sandbox_/);
    expect(json.checkoutUrl).toBe("");
    const row = storage.row("pay_refund1");
    expect(row.status).toBe("completed");
    expect(row.gateway_ref).toBe(json.gatewayRef);
    expect(row.checkout_url).toBe("");
  });

  it("approve on a MISSING draft is the recovered silent success — envelope, audit, no row", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_ghost",
      decision: "approved",
    });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as any;
    expect(json).toEqual({
      success: true,
      status: "completed",
      draftId: "pay_ghost",
      checkoutUrl: "",
      gatewayRef: "",
      authorizerDid: getUserDid(SESSION),
    });
    expect(storage.allRows()).toHaveLength(0);
    expect(auditsOf(audits, "payment.confirmed")).toHaveLength(1);
  });

  it("reject stores the supplied note and the reviewer default otherwise", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    storage.seed({ id: "pay_rej1" });
    storage.seed({ id: "pay_rej2" });

    const res1 = await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_rej1",
      decision: "rejected",
      note: "no thanks",
    });
    expect((await res1!.json()) as any).toMatchObject({
      success: true,
      status: "rejected",
      draftId: "pay_rej1",
    });
    const row1 = storage.row("pay_rej1");
    expect(row1.status).toBe("rejected");
    expect(row1.note).toBe("no thanks");
    expect(row1.authorizer_did).toBe(getUserDid(SESSION));
    expectLaterThanSentinel(row1.updated_at);
    // The reject field set is narrower: gateway fields are untouched.
    expect(row1.gateway_ref).toBe("sandbox_seed1");
    expect(row1.checkout_url).toBe(
      "https://agent.internal/checkout/sandbox?id=pay_seed1"
    );

    await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_rej2",
      decision: "rejected",
    });
    expect(storage.row("pay_rej2").note).toBe("Rejected by reviewer");

    const rejected = auditsOf(audits, "payment.rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected[0].payload).toEqual({
      draftId: "pay_rej1",
      authorizerDid: getUserDid(SESSION),
    });
  });

  it("reject on a MISSING draft still returns success/rejected and writes nothing", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await call(ctx, "POST", "/payments/confirm", {
      draftId: "pay_ghost",
      decision: "rejected",
    });
    expect(res!.status).toBe(200);
    expect((await res!.json()) as any).toEqual({
      success: true,
      status: "rejected",
      draftId: "pay_ghost",
    });
    expect(storage.allRows()).toHaveLength(0);
    expect(auditsOf(audits, "payment.rejected")).toHaveLength(1);
  });
});

describe("capture — the id-OR-gateway_ref completion UPDATE (#2360 characterization)", () => {
  it("a successful capture settles the id-matched AND the ref-matched row in one call", async () => {
    vi.spyOn(PaymentGatewayService.prototype, "capturePayment").mockResolvedValue({
      success: true,
      captureId: "cap_123",
      message: "captured",
    });
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    storage.seed({ id: "cap_by_ref", gateway_ref: "SHARED_REF", status: "authorized" });
    storage.seed({ id: "SHARED_REF", gateway_ref: "other_ref", status: "authorized" });
    storage.seed({ id: "cap_bystander", gateway_ref: "zzz", status: "authorized" });

    const res = await call(ctx, "POST", "/payments/capture", {
      orderId: "SHARED_REF",
      gateway: "stripe",
    });
    expect(res!.status).toBe(200);
    expect((await res!.json()) as any).toEqual({
      success: true,
      captureId: "cap_123",
      message: "captured",
    });

    for (const id of ["cap_by_ref", "SHARED_REF"]) {
      const row = storage.row(id);
      expect(row.status).toBe("completed");
      expectLaterThanSentinel(row.updated_at);
      // The capture field set is status + updated_at only.
      expect(row.note).toBe("seed note");
    }
    const bystander = storage.row("cap_bystander");
    expect(bystander.status).toBe("authorized");
    expect(bystander.updated_at).toBe(SENTINEL);

    const captured = auditsOf(audits, "payment.captured");
    expect(captured).toHaveLength(1);
    expect(captured[0].payload).toEqual({
      orderId: "SHARED_REF",
      gateway: "stripe",
      captureId: "cap_123",
    });
  });

  it("a failed capture updates nothing and emits no payment.captured audit", async () => {
    vi.spyOn(PaymentGatewayService.prototype, "capturePayment").mockResolvedValue({
      success: false,
      message: "capture declined",
    });
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    storage.seed({ id: "cap_fail", gateway_ref: "cap_fail", status: "authorized" });
    const res = await call(ctx, "POST", "/payments/capture", {
      orderId: "cap_fail",
      gateway: "stripe",
    });
    expect((await res!.json()) as any).toEqual({
      success: false,
      message: "capture declined",
    });
    const row = storage.row("cap_fail");
    expect(row.status).toBe("authorized");
    expect(row.updated_at).toBe(SENTINEL);
    expect(auditsOf(audits, "payment.captured")).toHaveLength(0);
  });
});

describe("webhook settlement — the existence probes and the settle UPDATE (#2360 characterization)", () => {
  const stripeBody = (draftId: string) =>
    JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: draftId } },
    });

  const signedWebhook = async (
    ctx: PaymentsRouteContext,
    draftId: string,
    headers: Record<string, string> = {}
  ) => {
    const body = stripeBody(draftId);
    const ts = Math.floor(Date.now() / 1000);
    const v1 = await computeHmacSha256Hex(WH_SECRET, `${ts}.${body}`);
    return handlePaymentsRoutes(
      new Request("https://agent.internal/payments/webhook?provider=stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${ts},v1=${v1}`,
          ...headers,
        },
        body,
      }),
      new URL("https://agent.internal/payments/webhook?provider=stripe"),
      "/payments/webhook",
      SESSION,
      ctx
    );
  };

  it("settles a locally held draft: status completed, updated_at bumped, settled_webhook audit", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    storage.seed({ id: "pay_wh1" });
    const res = await signedWebhook(ctx, "pay_wh1");
    expect(res!.status).toBe(200);
    expect((await res!.json()) as any).toEqual({
      received: true,
      settled: true,
      draftId: "pay_wh1",
    });
    const row = storage.row("pay_wh1");
    expect(row.status).toBe("completed");
    expectLaterThanSentinel(row.updated_at);
    const settled = auditsOf(audits, "payment.settled_webhook");
    expect(settled).toHaveLength(1);
    expect(settled[0].payload).toEqual({
      draftId: "pay_wh1",
      provider: "stripe",
      raw: "checkout.session.completed",
    });
  });

  it("the settle UPDATE has no status guard: an already-completed row still gets its updated_at moved (as found)", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    storage.seed({ id: "pay_wh_done", status: "completed" });
    const res = await signedWebhook(ctx, "pay_wh_done");
    expect(res!.status).toBe(200);
    const row = storage.row("pay_wh_done");
    expect(row.status).toBe("completed");
    expectLaterThanSentinel(row.updated_at);
  });

  it("an unknown draft is LOUD: 404 unmatched with the unknown_draft reason and audit", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await signedWebhook(ctx, "pay_unknown");
    expect(res!.status).toBe(404);
    const json = (await res!.json()) as any;
    expect(json).toMatchObject({
      received: false,
      settled: false,
      unmatched: true,
      draftId: "pay_unknown",
    });
    expect(json.error).toContain("unknown_draft");
    const unmatched = auditsOf(audits, "payment.settled_webhook_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].payload).toMatchObject({
      draftId: "pay_unknown",
      provider: "stripe",
      reason: "unknown_draft",
    });
  });

  it("a settlement hop naming THIS session with no local row is 404 owner_row_missing", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const res = await signedWebhook(ctx, "pay_elsewhere", {
      [SETTLEMENT_OWNER_HEADER]: SESSION,
    });
    expect(res!.status).toBe(404);
    const json = (await res!.json()) as any;
    expect(json.error).toContain("owner_row_missing");
    expect(auditsOf(audits, "payment.settled_webhook_unmatched")[0].payload).toMatchObject({
      reason: "owner_row_missing",
    });
  });

  it("a settlement hop naming ANOTHER session is refused 502 misrouted and settles nothing", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    storage.seed({ id: "pay_wh_other" });
    const res = await signedWebhook(ctx, "pay_wh_other", {
      [SETTLEMENT_OWNER_HEADER]: "someone-else",
    });
    expect(res!.status).toBe(502);
    const json = (await res!.json()) as any;
    expect(json.error).toContain("misrouted");
    const row = storage.row("pay_wh_other");
    expect(row.status).toBe("pending_checkout");
    expect(row.updated_at).toBe(SENTINEL);
    expect(auditsOf(audits, "payment.settled_webhook")).toHaveLength(0);
  });

  it("an invalid signature is 401 before any state change", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    storage.seed({ id: "pay_wh_sig" });
    const body = stripeBody("pay_wh_sig");
    const res = await handlePaymentsRoutes(
      new Request("https://agent.internal/payments/webhook?provider=stripe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef",
        },
        body,
      }),
      new URL("https://agent.internal/payments/webhook?provider=stripe"),
      "/payments/webhook",
      SESSION,
      ctx
    );
    expect(res!.status).toBe(401);
    expect(storage.row("pay_wh_sig").status).toBe("pending_checkout");
  });

  it("an unsupported webhook provider is 401 before verification (#148 default-deny)", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx } = makeCtx(storage);
    const res = await call(
      ctx,
      "POST",
      "/payments/webhook?provider=bogus",
      undefined,
      {}
    );
    expect(res!.status).toBe(401);
    const json = (await res!.json()) as any;
    expect(json.error).toContain("Unsupported webhook provider");
  });
});

describe("audit-gate enforcement (#3156)", () => {
  it("a gate-blocked immediate confirm returns 503, moves no money, and audits the denial", async () => {
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    // No policy port on this ctx: the gate fails closed (owner
    // directive 2026-11-04 — store-unreachable blocks).
    const blockedCtx = { ...ctx, getAuditPolicyPort: undefined } as PaymentsRouteContext;
    storage.seed({ id: "pay_gate1", checkout_url: "" });
    const res = await call(blockedCtx, "POST", "/payments/confirm", {
      draftId: "pay_gate1",
      decision: "approved",
    });
    expect(res!.status).toBe(503);
    expect(storage.row("pay_gate1").status).toBe("pending_checkout");
    expect(auditsOf(audits, "payment.confirmed")).toHaveLength(0);
    const denied = auditsOf(audits, "payment.gate_blocked");
    expect(denied).toHaveLength(1);
    expect(denied[0].payload.action).toBe("payment.charge");
  });

  it("a gate-blocked capture returns 503 and never calls the gateway", async () => {
    const captureSpy = vi.spyOn(PaymentGatewayService.prototype, "capturePayment").mockResolvedValue({
      success: true,
      captureId: "cap_x",
      message: "captured",
    });
    const storage = new SqliteRouteStorage();
    const { ctx, audits } = makeCtx(storage);
    const blockedCtx = { ...ctx, getAuditPolicyPort: undefined } as PaymentsRouteContext;
    storage.seed({ id: "cap_gate", gateway_ref: "cap_gate", status: "authorized" });
    const res = await call(blockedCtx, "POST", "/payments/capture", {
      orderId: "cap_gate",
      gateway: "stripe",
    });
    expect(res!.status).toBe(503);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(storage.row("cap_gate").status).toBe("authorized");
    expect(auditsOf(audits, "payment.captured")).toHaveLength(0);
    expect(auditsOf(audits, "payment.gate_blocked")).toHaveLength(1);
  });
});
