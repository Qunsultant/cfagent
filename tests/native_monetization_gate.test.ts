// @vitest-environment node
/**
 * Issue #2193 (slice 1, #2146) — native gate semantics.
 *
 * Card confirm semantics (all four retrieve conditions, each
 * failure mode rejected, redirect-never-proof); crypto confirm
 * semantics (facilitator fail-closed, amount/payer/nonce mismatch
 * rejected, simulated proofs rejected); fail-closed on unconfigured
 * ports and missing recipient; coverage/scheduling preserved from
 * the cfpay gate; and the flow driving a native gate end to end
 * (the flow's step logic is unchanged — only its gate type and
 * verified-event join keys are new).
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { X402CheckoutAdapter } from "../src/services/x402CheckoutAdapter";
import { InMemoryCheckoutAdapter } from "../src/services/inMemoryCheckoutAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryFreeRunCounterAdapter } from "../src/data/inMemoryFreeRunCounterAdapter";
import type { PriceFamily } from "../src/data/priceCataloguePorts";
import type { CheckoutPorts } from "../src/services/checkoutPorts";
import {
  extractCheckoutId,
  runPaymentWorkflowFlow,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const OTHER_PAYER = "0x3333333333333333333333333333333333333333";

function account(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "PayPerUse", creditsUSD: 0, includedRunsRemaining: 0, ...overrides };
}

interface SessionEvidence {
  status: string;
  payment_status: string;
  amount_total: number;
  client_reference_id: string;
  payment_intent?: string;
}

function stripeClient(evidenceFor: (sessionId: string) => SessionEvidence) {
  const creates: Array<{ draftId: string; amount: number }> = [];
  const client: StripeCheckoutClient = {
    async createCheckout(params) {
      creates.push({ draftId: params.draftId, amount: params.amount });
      return { success: true, checkoutUrl: `https://checkout.example/session/${params.draftId}`, gatewayRef: `cs_test_${params.draftId}` };
    },
    async retrieveSession(sessionId) {
      const e = evidenceFor(sessionId);
      return { id: sessionId, status: e.status, payment_status: e.payment_status, amount_total: e.amount_total, client_reference_id: e.client_reference_id, payment_intent: e.payment_intent };
    },
  };
  return { client, creates };
}

function goalEvidence(overrides: Partial<SessionEvidence> = {}): SessionEvidence {
  return { status: "complete", payment_status: "paid", amount_total: 10, client_reference_id: "run-1", payment_intent: "pi_test_run-1", ...overrides };
}

function cardGate(evidenceFor: (sessionId: string) => SessionEvidence, monetizationEnabled = true) {
  const { client, creates } = stripeClient(evidenceFor);
  const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
  const gate = new NativeMonetizationGate({
    monetizationEnabled,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: ports,
  });
  return { gate, creates, ports };
}

function facilitatorStub(opts: { isValid: boolean }) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fn = (async (_url: string, init?: { body?: unknown }) => {
    calls.push({ body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    return { ok: true, json: async () => ({ isValid: opts.isValid }) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function x402CheckedGate(opts: { isValid: boolean }) {
  const { fn, calls } = facilitatorStub(opts);
  const ports: CheckoutPorts = {
    card: null,
    x402: new X402CheckoutAdapter({ recipientAddress: RECIPIENT, network: "base-sepolia", fetchFn: fn }),
  };
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: ports,
  });
  const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
  if (decision.allowed) throw new Error("expected a 402 checkout decision");
  const challenge = (decision.checkout as { challenge: { nonce: string } }).challenge;
  return { gate, challenge, calls };
}

function x402Proof(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ signature: "0xsig", payer: PAYER, ...fields })).toString("base64");
}

describe("native gate: card confirm semantics", () => {
  it("mints a per-checkout amount and confirms on all four retrieve conditions", async () => {
    const { gate, creates } = cardGate(() => goalEvidence());
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect(decision.allowed).toBe(false);
    // Per-checkout amount: the goal catalogue price, not a fixed amount.
    expect(creates).toEqual([{ draftId: "run-1", amount: 0.1 }]);
    const confirmed = await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" });
    expect(confirmed).toEqual({ allowed: true, status: "paid", runRequestId: "run-1", priceUSD: 0.1, paidVia: "stripe_checkout", productId: "prod-per-run-goal", versionId: "cat-goal-default-v1" });
    // Already-paid short-circuit.
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" })).status).toBe("already_paid");
  });

  it.each([
    ["incomplete session", goalEvidence({ status: "open" })],
    ["unpaid payment_status", goalEvidence({ payment_status: "unpaid" })],
    ["amount mismatch", goalEvidence({ amount_total: 11 })],
    ["reference mismatch", goalEvidence({ client_reference_id: "run-other" })],
  ])("rejects %s (payment_required, never paid)", async (_label, evidence) => {
    const { gate } = cardGate(() => evidence);
    await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    const confirmed = await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.status).toBe("payment_required");
  });

  it("rejects a payment-intent mismatch and a session mismatch against the minted checkout", async () => {
    const { gate } = cardGate(() => goalEvidence());
    await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" }, { paymentIntentId: "pi_other" })).allowed).toBe(false);
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" }, { sessionId: "cs_test_other" })).allowed).toBe(false);
  });

  it("a success-page redirect is never proof (throws)", async () => {
    const { gate } = cardGate(() => goalEvidence());
    await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    await expect(
      gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" }, { stripeReturnPage: true }),
    ).rejects.toThrow(/not proof of payment/);
  });

  it("rejects replay of a confirmed session for another run", async () => {
    const { gate } = cardGate(() => goalEvidence());
    await gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() });
    await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" });
    await gate.check({ id: "run-2", family: "goal", trigger: "manual", account: account() });
    await expect(
      gate.confirmPaid({ id: "run-2", userId: "u1", email: "u1@example.com" }, { sessionId: "cs_test_run-1" }),
    ).rejects.toThrow(/already redeemed/);
  });

  it("confirms statelessly from a proof session id + catalogue price (durable-resume path)", async () => {
    const { ports } = cardGate(() => goalEvidence());
    const fresh = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
      checkout: ports,
    });
    const confirmed = await fresh.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com", family: "goal" },
      { sessionId: "cs_test_run-1" },
    );
    expect(confirmed.allowed).toBe(true);
    expect(confirmed.paidVia).toBe("stripe_checkout");
  });
});

describe("native gate: crypto confirm semantics", () => {
  it("mints an explicit-recipient challenge and confirms on facilitator pass + payer + nonce match", async () => {
    const { gate, challenge, calls } = await x402CheckedGate({ isValid: true });
    expect(challenge.recipient).toBe(RECIPIENT);
    expect(challenge.amountUSD).toBe(0.1);
    const confirmed = await gate.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com" },
      { paymentProof: x402Proof({ nonce: challenge.nonce }), payer: PAYER },
    );
    expect(confirmed).toEqual({ allowed: true, status: "paid", runRequestId: "run-1", priceUSD: 0.1, paidVia: "x402", productId: "prod-per-run-goal", versionId: "cat-goal-default-v1" });
    // The verify request carried this run's amount + recipient as requirements.
    const req = calls[0].body.paymentRequirements as { amount: string; payTo: string };
    expect(req.amount).toBe("100000");
    expect(req.payTo).toBe(RECIPIENT);
  });

  it("facilitator rejection, payer mismatch, and nonce mismatch all refuse", async () => {
    const denied = await x402CheckedGate({ isValid: false });
    expect((await denied.gate.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com" },
      { paymentProof: x402Proof({ nonce: denied.challenge.nonce }) },
    )).allowed).toBe(false);

    const payerMismatch = await x402CheckedGate({ isValid: true });
    expect((await payerMismatch.gate.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com" },
      { paymentProof: x402Proof({ nonce: payerMismatch.challenge.nonce }), payer: OTHER_PAYER },
    )).allowed).toBe(false);

    const nonceMismatch = await x402CheckedGate({ isValid: true });
    expect((await nonceMismatch.gate.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com" },
      { paymentProof: x402Proof({ nonce: "n_someone_elses" }) },
    )).allowed).toBe(false);
  });

  it("missing proof and simulated proof refuse", async () => {
    const { gate, challenge } = await x402CheckedGate({ isValid: true });
    expect((await gate.confirmPaid({ id: "run-1", userId: "u1", email: "u1@example.com" })).allowed).toBe(false);
    expect((await gate.confirmPaid(
      { id: "run-1", userId: "u1", email: "u1@example.com" },
      { paymentProof: x402Proof({ nonce: challenge.nonce, simulated: true }) },
    )).allowed).toBe(false);
  });
});

describe("native gate: fail-closed and preserved rules", () => {
  it("throws when no checkout ports exist, and when the requested rail is unconfigured", async () => {
    const noPorts = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
      checkout: null,
    });
    await expect(noPorts.check({ id: "run-1", family: "goal", trigger: "manual", account: account() })).rejects.toThrow(/not configured/);

    const x402Only: CheckoutPorts = {
      card: null,
      x402: new X402CheckoutAdapter({ recipientAddress: RECIPIENT, fetchFn: facilitatorStub({ isValid: true }).fn }),
    };
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
      checkout: x402Only,
    });
    await expect(gate.check({ id: "run-1", family: "goal", trigger: "manual", account: account(), rail: "stripe" })).rejects.toThrow(/rail stripe/);
    // Default rail falls through to the configured x402 port.
    expect((await gate.check({ id: "run-2", family: "goal", trigger: "manual", account: account() })).allowed).toBe(false);
  });

  it("throws on missing catalogue price (never a hardcoded fallback)", async () => {
    const { gate } = cardGate(() => goalEvidence());
    const emptyGate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter({}),
      checkout: (gate as unknown as { config: { checkout: CheckoutPorts } }).config.checkout,
    });
    await expect(emptyGate.check({ id: "run-1", family: "goal", trigger: "manual", account: account() })).rejects.toThrow(/No valid stored price/);
  });

  it("coverage, scheduling, flag-OFF, and tenant rules are unchanged from the cfpay gate", async () => {
    const { gate, creates } = cardGate(() => goalEvidence());
    // Subscription coverage consumes no checkout.
    const sub = await gate.check({ id: "run-sub", family: "goal", trigger: "manual", account: account({ tier: "Subscribed", includedRunsRemaining: 2 }) });
    expect(sub).toMatchObject({ allowed: true, paidVia: "subscription_included" });
    // Credits coverage consumes no checkout.
    const cred = await gate.check({ id: "run-cred", family: "stock", trigger: "manual", account: account({ creditsUSD: 1 }) });
    expect(cred).toMatchObject({ allowed: true, paidVia: "credits" });
    // Recurring scheduled: coverage-only, no mint.
    const rec = await gate.check({ id: "run-rec", family: "goal", trigger: "scheduled", scheduleKind: "recurring", account: account() });
    expect(rec).toMatchObject({ allowed: false, status: "coverage_required" });
    // One-off authorized: may mint.
    const oneOff = await gate.check({ id: "run-one", family: "goal", trigger: "scheduled", scheduleKind: "one_off", authorizedAtSubmission: true, account: account() });
    expect(oneOff.allowed).toBe(false);
    expect(creates.map((c) => c.draftId)).toEqual(["run-one"]);
    // Flag OFF: free, no mint.
    const { gate: offGate, creates: offCreates } = cardGate(() => goalEvidence(), false);
    expect(await offGate.check({ id: "run-free", family: "goal", trigger: "manual", account: account() })).toMatchObject({ allowed: true, status: "free_flag_off" });
    expect(offCreates).toHaveLength(0);
    // Tenant mismatch throws before any mint.
    await expect(gate.check({ id: "run-ten", family: "goal", trigger: "manual", tenantId: "t-other", account: account() })).rejects.toThrow(/Tenant mismatch/);
  });
});

describe("flow + native gate + extractCheckoutId", () => {
  it("the flow drives a native card gate to started via the verified-event session id", async () => {
    const mem = new InMemoryCheckoutAdapter("stripe");
    mem.setCardSessionEvidence("mem_cs_run-1", {
      sessionId: "mem_cs_run-1",
      status: "complete",
      paymentStatus: "paid",
      amountTotalCents: 10,
      clientReferenceId: "run-1",
      paymentIntentId: "pi_mem_run-1",
    });
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
      checkout: { card: mem, x402: null },
    });
    const events: string[] = [];
    const params: PaymentWorkflowParams = {
      runRequestId: "run-1",
      family: "goal",
      trigger: "manual",
      tenantId: "t1",
      userId: "u1",
      email: "u1@example.com",
    };
    const step: PaymentWorkflowStep = {
      async waitForEvent(name) {
        if (name.includes("approval")) return { payload: { approved: true } };
        return { payload: { sessionId: "mem_cs_run-1", paymentIntentId: "pi_mem_run-1" } };
      },
      async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    };
    const outcome = await runPaymentWorkflowFlow(
      params,
      {
        gate: gate as never,
        account: account(),
        startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
        recordEvent: async (e) => {
          events.push(e.type);
        },
        issueFailureCredit: async () => {},
      },
      step,
    );
    expect(outcome).toEqual({ status: "started", runRequestId: "run-1", paidVia: "stripe_checkout", screenerWorkflowId: "wf-run-1", priceUSD: 0.1 });
    expect(events).toContain("payment.confirmed");
  });

  it("extractCheckoutId returns the native session id and never a checkout URL", () => {
    expect(extractCheckoutId({ rail: "stripe", checkoutId: "cs_test_run-1", checkoutUrl: "https://checkout.example/session/run-1" })).toBe("cs_test_run-1");
    expect(extractCheckoutId({ checkoutUrl: "https://checkout.example/session/run-1" })).toBeUndefined();
    expect(extractCheckoutId({ data: { id: "chk-9" } })).toBe("chk-9");
    expect(extractCheckoutId({ id: "https://checkout.example/only-url" })).toBeUndefined();
  });
});

describe("native gate: free-run counter (#3305)", () => {
  const NOV = Date.UTC(2026, 10, 15, 12, 0, 0);
  const DEC = Date.UTC(2026, 11, 1, 0, 0, 0);

  function freeGate(opts: { allowances?: Partial<Record<PriceFamily, number>>; approved?: boolean } = {}) {
    const { client, creates } = stripeClient(() => goalEvidence());
    const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
    // #3315: the in-memory adapter starts empty (no hardcoded
    // defaults), so the fixture passes the decided allowances
    // explicitly — 10 per family unless the test says otherwise.
    const counter = new InMemoryFreeRunCounterAdapter(
      opts.allowances ?? { stock: 10, goal: 10, options: 10, strategy: 10 },
    );
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(
        undefined,
        opts.approved === false ? undefined : { approvedBy: "test-operator" },
      ),
      checkout: ports,
      freeRunCounter: counter,
    });
    return { gate, creates, counter };
  }

  function freeAccount(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
    return account({ tier: "Free", ...overrides });
  }

  it("a Free manual run under the cap is allowed at price 0, mints no checkout, spends no credits", async () => {
    const { gate, creates, counter } = freeGate();
    const acct = freeAccount({ creditsUSD: 5 });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: acct });
    expect(decision).toEqual({ allowed: true, status: "paid", runRequestId: "run-1", priceUSD: 0, paidVia: "free_run_allowance" });
    expect(creates).toHaveLength(0);
    expect(acct.creditsUSD).toBe(5);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
  });

  it("10 free runs are allowed; the 11th manual run falls through to a 402 checkout", async () => {
    const { gate, creates, counter } = freeGate();
    for (let i = 1; i <= 10; i++) {
      const d = await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
      expect(d.allowed).toBe(true);
    }
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(10);
    const eleventh = await gate.check({ id: "run-11", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    expect(eleventh).toMatchObject({ allowed: false, status: "payment_required", httpStatus: 402, priceUSD: 0.1 });
    expect((eleventh as { checkout?: unknown }).checkout).toBeDefined();
    expect(creates).toEqual([{ draftId: "run-11", amount: 0.1 }]);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(10);
  });

  it("a Free scheduled run under the cap is allowed; at the cap it is coverage_required with no checkout", async () => {
    const { gate, creates, counter } = freeGate();
    for (let i = 1; i <= 10; i++) {
      const d = await gate.check({ id: `run-${i}`, family: "goal", trigger: "scheduled", nowMs: NOV, account: freeAccount() });
      expect(d.allowed).toBe(true);
    }
    const eleventh = await gate.check({ id: "run-11", family: "goal", trigger: "scheduled", nowMs: NOV, account: freeAccount() });
    expect(eleventh).toMatchObject({ allowed: false, status: "coverage_required", httpStatus: 402 });
    expect(creates).toHaveLength(0);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(10);
  });

  it("the counter is per product, and a re-check of the same run id does not double-count", async () => {
    const { gate, counter } = freeGate();
    await gate.check({ id: "run-g1", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    await gate.check({ id: "run-g2", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    await gate.check({ id: "run-g3", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    await gate.check({ id: "run-s1", family: "stock", trigger: "manual", nowMs: NOV, account: freeAccount() });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(3);
    expect(await counter.getUsed({ login: "u1", family: "stock", month: "2026-11" })).toBe(1);
    // Idempotent on run-request id: the second check returns
    // already_paid and consumes nothing.
    const again = await gate.check({ id: "run-g1", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    expect(again).toMatchObject({ allowed: true, status: "already_paid", paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(3);
    expect((await gate.confirmPaid({ id: "run-g1", userId: "u1", email: "u1@example.com" })).status).toBe("already_paid");
  });

  it("the counter resets monthly: December starts at 0 while November stays at the cap", async () => {
    const { gate, counter } = freeGate();
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `nov-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    }
    expect((await gate.check({ id: "nov-11", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() })).allowed).toBe(false);
    const dec = await gate.check({ id: "dec-1", family: "goal", trigger: "manual", nowMs: DEC, account: freeAccount() });
    expect(dec).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-12" })).toBe(1);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(10);
  });

  it("an unlimited-free grant no longer bypasses the counter when the quota is unavailable (#3263 supersedes #3245 ordering)", async () => {
    // Issue #3263 (CI fix): the grant is bounded by the quota when the
    // quota system can enforce the bound; when it cannot, the run falls
    // through to the Free allowance FIRST — the grant covers only if the
    // allowance cannot. So a grant run with no quota wired spends the
    // allowance (paidVia free_run_allowance, counter 1). The grant still
    // consumes nothing when IT is the covering path: quota-engaged grant
    // runs are counted against the quota, never the counter (see
    // tests/approved_free_quota_gate_3263.test.ts). The old expectation
    // (grant precedes the counter, counter untouched) was the #3245
    // grant-first order, which #3263 deliberately replaces.
    const { gate, counter } = freeGate();
    const granted = freeAccount({
      unlimitedFreeGrant: { grantedBy: "op1", reason: "Owner-approved pilot account", expiresAtMs: null },
    });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: granted });
    expect(decision).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
  });

  it("trial/Subscribed runs use included runs, not the counter", async () => {
    const { gate, counter } = freeGate();
    const sub = account({ tier: "Subscribed", includedRunsRemaining: 2 });
    for (let i = 1; i <= 2; i++) {
      const d = await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: sub });
      expect(d).toMatchObject({ allowed: true, paidVia: "subscription_included" });
    }
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(0);
    const third = await gate.check({ id: "run-3", family: "goal", trigger: "manual", nowMs: NOV, account: sub });
    expect(third).toMatchObject({ allowed: false, status: "payment_required" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(0);
  });

  it("with no counter wired, a Free account gets today's behavior (402, no free runs)", async () => {
    const { gate } = cardGate(() => goalEvidence());
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
    expect(decision).toMatchObject({ allowed: false, status: "payment_required", httpStatus: 402 });
  });

  it("free runs work with unapproved (PROPOSED) prices; the 11th fails closed instead of minting", async () => {
    const counter = new InMemoryFreeRunCounterAdapter({ goal: 10 });
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined),
      checkout: null,
      freeRunCounter: counter,
    });
    for (let i = 1; i <= 10; i++) {
      const d = await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() });
      expect(d.allowed).toBe(true);
    }
    await expect(
      gate.check({ id: "run-11", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() }),
    ).rejects.toThrow(/not approved/);
  });

  it("the allowance is operator-changeable: lowering it to 2 caps the month at 2", async () => {
    const { gate, counter } = freeGate();
    await counter.setAllowance({ family: "goal", runs: 2 });
    for (let i = 1; i <= 2; i++) {
      expect((await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() })).allowed).toBe(true);
    }
    expect((await gate.check({ id: "run-3", family: "goal", trigger: "manual", nowMs: NOV, account: freeAccount() })).allowed).toBe(false);
  });
});
