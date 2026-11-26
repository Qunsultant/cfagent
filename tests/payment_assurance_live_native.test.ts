/**
 * Issue #2197 (slice 4 of the native-payments program #2146,
 * stacked on #2195): live assurance routes read NATIVE state.
 *
 * The route's checkout ports are injected through the handler
 * context (see PaymentAssuranceLiveContext.checkoutPorts), so
 * these tests exercise the route logic — flag source, native
 * configuration gate, session-retrieve fulfilled test — against
 * a fake card port, with no Stripe network and no cfpay call.
 * The pre-existing tests/payment_assurance_live.test.ts suite
 * (allowlist, live-test- prefix, 409 statuses) stays green
 * alongside this file; the 409 bodies are catalog-coded since
 * #5607 (FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE).
 */
import { describe, expect, it } from "vitest";
import { handlePaymentAssuranceLiveRoutes } from "../src/agents/routes/paymentAssuranceLive";
import { codedMessage } from "../src/outcomes/outcomeAspects";
import type {
  CardSessionEvidence,
  CheckoutPort,
  CheckoutPorts,
} from "../src/services/checkoutPorts";

type Binding = {
  events: Array<{ id: string; event: unknown }>;
  binding: {
    create: (options: { id: string; params: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<{ sendEvent: (event: unknown) => Promise<void>; status: () => Promise<string> }>;
  };
};

function makeBinding(): Binding {
  const events: Binding["events"] = [];
  return {
    events,
    binding: {
      create: async (options) => ({ id: options.id }),
      get: async (id: string) => ({
        sendEvent: async (event: unknown) => {
          events.push({ id, event });
        },
        status: async () => "running",
      }),
    },
  };
}

function fakeCardPort(evidenceByKey: Record<string, CardSessionEvidence>): CheckoutPort {
  return {
    rail: "stripe",
    createCheckout: async () => {
      throw new Error("not used by the assurance routes");
    },
    retrieveCardSession: async (input) => {
      const evidence = evidenceByKey[input.sessionId];
      if (!evidence) throw new Error(`No session for ${input.sessionId}`);
      return evidence;
    },
    verifyCryptoPayment: async () => {
      throw new Error("StripeCheckoutAdapter cannot verify x402 payments");
    },
  };
}

function cardPorts(evidenceByKey: Record<string, CardSessionEvidence>): CheckoutPorts {
  return { card: fakeCardPort(evidenceByKey), x402: null };
}

function paidEvidence(sessionId: string, reference: string): CardSessionEvidence {
  return {
    sessionId,
    status: "complete",
    paymentStatus: "paid",
    amountTotalCents: 1000,
    clientReferenceId: reference,
    paymentIntentId: "pi_test_123",
  };
}

function unpaidEvidence(sessionId: string, reference: string): CardSessionEvidence {
  return {
    sessionId,
    status: "open",
    paymentStatus: "unpaid",
    amountTotalCents: 1000,
    clientReferenceId: reference,
  };
}

/** A Flagship binding fake: the port, not the env var, decides. */
function flagshipEnv(overrides: Record<string, unknown>, binding: unknown, monetization: boolean) {
  return {
    FEATURE_PAYMENT_ASSURANCE: "1",
    PAYMENT_ASSURANCE_LIVE_LOGINS: "tester",
    PAYMENT_WORKFLOW: binding,
    FLAGS: {
      getBooleanValue: async (flag: string) => {
        if (flag === "payment_assurance") return true;
        if (flag === "monetization") return monetization;
        return false;
      },
    },
    ...overrides,
  };
}

function envWith(overrides: Record<string, unknown>, binding: unknown) {
  return {
    FEATURE_PAYMENT_ASSURANCE: "1",
    PAYMENT_ASSURANCE_LIVE_LOGINS: "tester",
    PAYMENT_WORKFLOW: binding,
    ...overrides,
  };
}

function request(path: string, method: string, body?: unknown, login = "tester"): Request {
  return new Request(`https://worker.local${path}`, {
    method,
    headers: { "content-type": "application/json", "x-user-login": login },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  req: Request,
  env: unknown,
  checkoutPorts?: CheckoutPorts | null,
) {
  const url = new URL(req.url);
  return handlePaymentAssuranceLiveRoutes(req, url, url.pathname, undefined, {
    env,
    ...(checkoutPorts !== undefined ? { checkoutPorts } : {}),
  });
}

describe("payment assurance live routes, native rework (issue #2197)", () => {
  it("checkout mode refuses with 409 when native Stripe is unconfigured, even when the flag is ON", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      envWith({ MONETIZATION_ENABLED: "true" }, b.binding),
      null,
    );
    expect(res?.status).toBe(409);
    const body = (await res?.json()) as { code: string; error: string };
    // #5607 (G-5/G-6): the 409 is now catalog-coded; the status
    // and the refusal are unchanged.
    expect(body.code).toBe("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE");
    expect(body.error).toBe(codedMessage("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE"));
  });

  it("checkout mode refuses with 409 when the flag is OFF even though a card port exists", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      // Phase 3 (#6550): monetization is ON via
      // environment.config.json, so a bare env no longer means the
      // monetization flag is off — checkout starts instead of
      // refusing. This test pins the flag-OFF refusal, so the flag
      // is off explicitly here.
      envWith({ MONETIZATION_ENABLED: "false" }, b.binding),
      cardPorts({}),
    );
    expect(res?.status).toBe(409);
    const flagBody = (await res?.json()) as { code: string; error: string };
    expect(flagBody.code).toBe("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE");
    expect(flagBody.error).toBe(codedMessage("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE"));
  });

  it("coverage mode still starts when native Stripe is unconfigured", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/start", "POST", { mode: "coverage", scheduleKind: "one_off", authorizedAtSubmission: false }),
      envWith({}, b.binding),
      null,
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    expect(data.nativeStripeConfigured).toBe(false);
  });

  it("the FeatureFlagPort wins over the MONETIZATION_ENABLED env var in both directions", async () => {
    const b = makeBinding();
    // Env var says ON, Flagship says OFF -> refused, naming the flag.
    const refused = await call(
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      flagshipEnv({ MONETIZATION_ENABLED: "true" }, b.binding, false),
      cardPorts({}),
    );
    expect(refused?.status).toBe(409);
    const refusedBody = (await refused?.json()) as { code: string; error: string };
    expect(refusedBody.code).toBe("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE");
    expect(refusedBody.error).toBe(codedMessage("FAILURE_PAYMENT_ASSURANCE_UNAVAILABLE"));

    // No env var at all, Flagship says ON, card port present -> starts.
    const started = await call(
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout", scheduleKind: "one_off", authorizedAtSubmission: false }),
      flagshipEnv({}, b.binding, true),
      cardPorts({}),
    );
    expect(started?.status).toBe(200);
    const data = (await started?.json()) as Record<string, unknown>;
    expect(data.monetizationEnabled).toBe(true);
    expect(data.nativeStripeConfigured).toBe(true);
  });

  it("status reports the native session evidence, and null without a card port", async () => {
    const b = makeBinding();
    const withCard = await call(
      request("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
      envWith({}, b.binding),
      cardPorts({ "live-test-9": paidEvidence("live-test-9", "live-test-9") }),
    );
    expect(withCard?.status).toBe(200);
    const data = (await withCard?.json()) as Record<string, unknown>;
    expect(data.instanceStatus).toBe("running");
    const checkout = data.checkout as Record<string, unknown>;
    expect(checkout.sessionId).toBe("live-test-9");
    expect(checkout.paymentStatus).toBe("paid");

    const withoutCard = await call(
      request("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
      envWith({}, b.binding),
      null,
    );
    expect(withoutCard?.status).toBe(200);
    expect(((await withoutCard?.json()) as Record<string, unknown>).checkout).toBeNull();
  });

  it("check-payment delivers payment_verified for a fulfilled native session", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-2" }),
      envWith({}, b.binding),
      cardPorts({ "live-test-2": paidEvidence("live-test-2", "live-test-2") }),
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    expect(data.delivered).toBe(true);
    expect(b.events).toHaveLength(1);
    const event = b.events[0].event as { type: string; payload: Record<string, unknown> };
    expect(event.type).toBe("payment_verified");
    expect(event.payload.paymentIntentId).toBe("pi_test_123");
  });

  it("check-payment delivers nothing for a non-fulfilled session, and refuses without a card port", async () => {
    const b = makeBinding();
    const unfulfilled = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-3" }),
      envWith({}, b.binding),
      cardPorts({ "live-test-3": unpaidEvidence("live-test-3", "live-test-3") }),
    );
    expect(unfulfilled?.status).toBe(200);
    expect(((await unfulfilled?.json()) as Record<string, unknown>).delivered).toBe(false);
    expect(b.events).toHaveLength(0);

    const misbound = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-4" }),
      envWith({}, b.binding),
      cardPorts({ "live-test-4": paidEvidence("live-test-4", "some-other-run") }),
    );
    expect(((await misbound?.json()) as Record<string, unknown>).delivered).toBe(false);
    expect(b.events).toHaveLength(0);

    const noCard = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-5" }),
      envWith({}, b.binding),
      null,
    );
    expect(noCard?.status).toBe(409);
    expect(b.events).toHaveLength(0);
  });

  it("check-payment accepts an explicit Stripe session id and still binds it to the run", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-6", sessionId: "cs_test_abc" }),
      envWith({}, b.binding),
      cardPorts({ cs_test_abc: paidEvidence("cs_test_abc", "live-test-6") }),
    );
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as Record<string, unknown>).delivered).toBe(true);
    expect(b.events).toHaveLength(1);
  });
});
