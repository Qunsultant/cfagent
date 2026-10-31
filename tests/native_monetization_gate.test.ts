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
    priceCatalogue: new InMemoryPriceCatalogueAdapter(),
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
    priceCatalogue: new InMemoryPriceCatalogueAdapter(),
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
    expect(confirmed).toEqual({ allowed: true, status: "paid", runRequestId: "run-1", priceUSD: 0.1, paidVia: "stripe_checkout" });
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
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
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
    expect(confirmed).toEqual({ allowed: true, status: "paid", runRequestId: "run-1", priceUSD: 0.1, paidVia: "x402" });
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
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
      checkout: null,
    });
    await expect(noPorts.check({ id: "run-1", family: "goal", trigger: "manual", account: account() })).rejects.toThrow(/not configured/);

    const x402Only: CheckoutPorts = {
      card: null,
      x402: new X402CheckoutAdapter({ recipientAddress: RECIPIENT, fetchFn: facilitatorStub({ isValid: true }).fn }),
    };
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
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
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
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
