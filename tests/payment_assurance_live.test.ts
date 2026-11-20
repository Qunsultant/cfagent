/**
 * Issue #2059: live PaymentWorkflow assurance routes — unit tests.
 *
 * The route module is tested behind fake bindings and envs, the
 * same way the flow tests use fake seams: the route logic (flag
 * gate, allowlist, preconditions, live-test id guard, fulfilled
 * detection) is exercised, while the Cloudflare binding and the
 * cfpay service stay fake here. The live run itself happens only
 * against the deployed Worker.
 */
import { describe, expect, it } from "vitest";
import { handlePaymentAssuranceLiveRoutes } from "../src/agents/routes/paymentAssuranceLive";
import { codedMessage } from "../src/outcomes/outcomeAspects";

type Binding = {
  created: Array<{ id: string; params: unknown }>;
  events: Array<{ id: string; event: unknown }>;
  binding: {
    create: (options: { id: string; params: unknown }) => Promise<{ id: string }>;
    get: (id: string) => Promise<{ sendEvent: (event: unknown) => Promise<void>; status: () => Promise<string> }>;
  };
};

function makeBinding(): Binding {
  const created: Binding["created"] = [];
  const events: Binding["events"] = [];
  return {
    created,
    events,
    binding: {
      create: async (options) => {
        created.push(options);
        return { id: options.id };
      },
      get: async (id: string) => ({
        sendEvent: async (event: unknown) => {
          events.push({ id, event });
        },
        status: async () => "running",
      }),
    },
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

async function call(handler: typeof handlePaymentAssuranceLiveRoutes, req: Request, env: unknown) {
  const url = new URL(req.url);
  return handler(req, url, url.pathname, undefined, { env });
}

describe("payment assurance live routes (issue #2059)", () => {
  it("starts a real-params coverage run through the binding", async () => {
    const b = makeBinding();
    const env = envWith({}, b.binding);
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "coverage", scheduleKind: "one_off", authorizedAtSubmission: false }),
      env,
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    expect(String(data.runRequestId)).toMatch(/^live-test-/);
    expect(data.workflowId).toBe(data.runRequestId);
    expect(String(data.screenerJobId)).toContain(String(data.runRequestId));
    expect(b.created).toHaveLength(1);
    const params = b.created[0].params as Record<string, unknown>;
    expect(params.trigger).toBe("scheduled");
    expect(params.family).toBe("goal");
    expect((params.account as Record<string, unknown>).tier).toBe("Subscribed");
    expect((params.screenerCommand as Record<string, unknown>).environment).toBe("TEST");
  });

  it("refuses to start when the flag is OFF", async () => {
    const b = makeBinding();
    const env = envWith({ FEATURE_PAYMENT_ASSURANCE: "0" }, b.binding);
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "coverage" }),
      env,
    );
    expect(res?.status).toBe(403);
    expect(b.created).toHaveLength(0);
  });

  it("refuses logins outside the live allowlist, and missing identity", async () => {
    const b = makeBinding();
    const env = envWith({}, b.binding);
    const outsider = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "coverage" }, "mallory"),
      env,
    );
    expect(outsider?.status).toBe(403);
    const noLogin = new Request("https://worker.local/api/assurance/payment-workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "coverage" }),
    });
    const res = await handlePaymentAssuranceLiveRoutes(noLogin, new URL(noLogin.url), "/api/assurance/payment-workflow/start", undefined, { env });
    expect(res?.status).toBe(401);
    expect(b.created).toHaveLength(0);
  });

  it("refuses checkout mode when monetization or Stripe is missing", async () => {
    const b = makeBinding();
    const noMoney = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      envWith({}, b.binding),
    );
    expect(noMoney?.status).toBe(409);
    const noCfpay = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "checkout" }),
      envWith({ MONETIZATION_ENABLED: "true" }, b.binding),
    );
    expect(noCfpay?.status).toBe(409);
    expect(b.created).toHaveLength(0);
  });

  it("delivers approval only to live-test ids", async () => {
    const b = makeBinding();
    const env = envWith({}, b.binding);
    const ok = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/event", "POST", { workflowId: "live-test-1", type: "approval", approved: true }),
      env,
    );
    expect(ok?.status).toBe(200);
    expect(b.events).toHaveLength(1);
    expect((b.events[0].event as { type: string }).type).toBe("approval");
    const prod = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/event", "POST", { workflowId: "run-123", type: "approval", approved: true }),
      env,
    );
    expect(prod?.status).toBe(403);
    expect(b.events).toHaveLength(1);
  });

  it("status reports the instance status and returns null checkout without cfpay", async () => {
    const b = makeBinding();
    const env = envWith({}, b.binding);
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/status?workflowId=live-test-9", "GET"),
      env,
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as Record<string, unknown>;
    expect(data.instanceStatus).toBe("running");
    expect(data.checkout).toBeNull();
  });

  it("check-payment without cfpay refuses instead of faking fulfillment", async () => {
    const b = makeBinding();
    const env = envWith({}, b.binding);
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/check-payment", "POST", { workflowId: "live-test-2" }),
      env,
    );
    expect(res?.status).toBe(409);
    expect(b.events).toHaveLength(0);
  });

  it("returns null for unmatched paths", async () => {
    const b = makeBinding();
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/other", "GET"),
      envWith({}, b.binding),
    );
    expect(res).toBeNull();
  });

  it("never leaks exception details to the caller (CodeQL information exposure)", async () => {
    const throwing = {
      create: async () => {
        throw new Error("SECRET-INTERNAL-DETAIL");
      },
      get: async () => ({
        sendEvent: async () => {},
        // Provider semantics (the cfWorkflowAdapter existence
        // proof): status() on an instance that was never
        // created errors — so the submission seam's
        // create-or-adopt (#2409) cannot mistake this genuine
        // create failure for a landed duplicate, and the
        // original error reaches the route's generic 500.
        status: async () => {
          throw new Error("instance not found");
        },
      }),
    };
    const res = await call(
      handlePaymentAssuranceLiveRoutes,
      request("/api/assurance/payment-workflow/start", "POST", { mode: "coverage", scheduleKind: "one_off", authorizedAtSubmission: false }),
      envWith({}, throwing),
    );
    expect(res?.status).toBe(500);
    const text = await res?.text();
    expect(text).not.toContain("SECRET-INTERNAL-DETAIL");
    // #5607 (G-5/G-6): the generic 500 is now the catalog-coded
    // FAILURE_UNEXPECTED_ERROR — still generic, still no leak.
    expect(text).toContain(codedMessage("FAILURE_UNEXPECTED_ERROR"));
  });
});
