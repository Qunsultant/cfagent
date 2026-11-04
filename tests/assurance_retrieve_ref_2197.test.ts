/**
 * Assurance retrieve-by-reference follow-up (related to issue #2197).
 *
 * Slice 4 gave the assurance routes native session retrieve, but
 * only half of the reference surface was wired end to end:
 * check-payment passes its whole body through sessionLookupKey,
 * so a caller-supplied sessionId OR checkoutId wins there, while
 * status built its lookup record from the sessionId query param
 * alone — a stored checkoutId reference (the card checkout join
 * key, i.e. the Stripe session id) was silently ignored on status
 * and the lookup fell back to the workflow id. These tests pin
 * the parity fix: status accepts checkoutId as an explicit lookup
 * key with the same precedence as check-payment (sessionId wins,
 * then checkoutId, then the workflow id), and caller-supplied
 * references still bind back to the run on check-payment
 * (a misbound stored reference delivers nothing).
 */
import { describe, expect, it } from "vitest";
import { handlePaymentAssuranceLiveRoutes } from "../src/agents/routes/paymentAssuranceLive";
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

describe("assurance retrieve-by-reference (issue #2197 follow-up)", () => {
  it("status retrieves by a stored checkoutId query param and the evidence binds back to the run", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/status?workflowId=live-test-7&checkoutId=cs_test_stored", "GET"),
      envWith({}, b.binding),
      cardPorts({ cs_test_stored: paidEvidence("cs_test_stored", "live-test-7") }),
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    const checkout = data.checkout as Record<string, unknown>;
    expect(checkout.sessionId).toBe("cs_test_stored");
    expect(checkout.paymentStatus).toBe("paid");
    expect(checkout.clientReferenceId).toBe("live-test-7");
  });

  it("status still prefers an explicit sessionId over checkoutId", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/status?workflowId=live-test-7&sessionId=cs_test_session&checkoutId=cs_test_other", "GET"),
      envWith({}, b.binding),
      cardPorts({ cs_test_session: paidEvidence("cs_test_session", "live-test-7") }),
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    const checkout = data.checkout as Record<string, unknown>;
    expect(checkout.sessionId).toBe("cs_test_session");
  });

  it("check-payment retrieves by a stored checkoutId and still binds it to the run", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-8", checkoutId: "cs_test_stored2" }),
      envWith({}, b.binding),
      cardPorts({ cs_test_stored2: paidEvidence("cs_test_stored2", "live-test-8") }),
    );
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as Record<string, unknown>).delivered).toBe(true);
    expect(b.events).toHaveLength(1);
    const event = b.events[0].event as { type: string; payload: Record<string, unknown> };
    expect(event.type).toBe("payment_verified");
    expect(event.payload.paymentIntentId).toBe("pi_test_123");
  });

  it("check-payment delivers nothing for a misbound stored checkoutId", async () => {
    const b = makeBinding();
    const res = await call(
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-9", checkoutId: "cs_test_misbound" }),
      envWith({}, b.binding),
      cardPorts({ cs_test_misbound: paidEvidence("cs_test_misbound", "some-other-run") }),
    );
    expect(res?.status).toBe(200);
    expect(((await res?.json()) as Record<string, unknown>).delivered).toBe(false);
    expect(b.events).toHaveLength(0);
  });
});
