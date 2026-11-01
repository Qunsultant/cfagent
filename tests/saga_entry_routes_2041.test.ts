/**
 * Issue #2041 S4 — saga entry route (gaps G-ENTRY-ROUTE, Q7).
 *
 * TDD: written before the route module. POST /api/saga/start
 * starts a SAGA_WORKFLOW instance (Leg 0 remains the flow's
 * payment child via the leg port — a route that started
 * PaymentWorkflow directly would be a paid screen, not a saga).
 * The route is a REVIEWED wiring step: it stays behind the
 * monetization flag, fail-closed, flag OFF by default. The
 * instance id MUST be sagaWorkflowInstanceId(sagaId) (the S2
 * delivery contract) — pinned exactly. The response carries the
 * pre-payment disclosure (S3 leftover) and the statusUrl the
 * existing pollers consume. The route never consults refund
 * deps: Q10 execution stays operator-only.
 */
import { describe, expect, it } from "vitest";
import {
  buildSagaEntryParams,
  handleSagaEntryRoutes,
  startSagaViaBinding,
  validateSagaEntryBody,
  type SagaEntryBinding,
} from "../src/agents/routes/sagaEntry";
import { sagaWorkflowInstanceId } from "../src/workflows/sagaJourneyGate";

function validBody(over: Record<string, unknown> = {}) {
  return {
    sagaId: "saga-1",
    screenerCommand: {
      jobId: "goal-screen:manual:u1login:income:2026-10-31T00:00:00.000Z",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "u1login",
      role: "parent",
      shards: [{ shardId: "goal" }],
    },
    tradeIntent: {
      kind: "stock",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
      orderType: "market",
    },
    email: "u1@example.com",
    ...over,
  };
}

function fakeBinding() {
  const creates: Array<{ id: string; params: unknown }> = [];
  const gets: string[] = [];
  let status: { status: string; output?: unknown } = { status: "running" };
  const binding: SagaEntryBinding = {
    async create(opts: { id: string; params: unknown }) {
      creates.push(opts);
      if ((binding as { createThrows?: Error }).createThrows) {
        throw (binding as { createThrows?: Error }).createThrows;
      }
      return { id: opts.id };
    },
    async get(id: string) {
      gets.push(id);
      return {
        status: async () => status,
      };
    },
    __setStatus(s: { status: string; output?: unknown }) {
      status = s;
    },
  } as SagaEntryBinding & {
    createThrows?: Error;
    __setStatus: (s: { status: string; output?: unknown }) => void;
  };
  return { binding, creates, gets };
}

function fakePorts() {
  return {
    commercial: {
      getAccount: async () => null,
    },
    subscriptions: {
      listSubscriptions: async () => [],
    },
  };
}

function envWithFlag(on: boolean) {
  return {
    FEATURE_FLAGS: JSON.stringify({ monetization: on }),
  };
}

describe("validateSagaEntryBody (S4, #2041)", () => {
  it("accepts a valid manual entry body", () => {
    const input = validateSagaEntryBody(validBody(), "u1login");
    expect(input.sagaId).toBe("saga-1");
    expect(input.tradeIntent.symbol).toBe("AAPL");
    expect(input.email).toBe("u1@example.com");
  });

  it("generates a sagaId when the caller omits one (runRequestId mirrors it)", () => {
    const { sagaId, ...rest } = validBody();
    void sagaId;
    const input = validateSagaEntryBody(rest, "u1login");
    expect(input.sagaId).toBeTruthy();
    expect(input.runRequestId).toBe(input.sagaId);
  });

  it("rejects a screenerCommand whose userLogin is not the session login", () => {
    expect(() =>
      validateSagaEntryBody(
        validBody({
          screenerCommand: {
            ...(validBody().screenerCommand as Record<string, unknown>),
            userLogin: "someone-else",
          },
        }),
        "u1login",
      ),
    ).toThrow(/userLogin/);
  });

  it("rejects a missing tradeIntent (the saga never invents a trade)", () => {
    const { tradeIntent, ...rest } = validBody();
    void tradeIntent;
    expect(() => validateSagaEntryBody(rest, "u1login")).toThrow(/tradeIntent/);
  });

  it("rejects an options intent without legs", () => {
    expect(() =>
      validateSagaEntryBody(
        validBody({
          tradeIntent: {
            kind: "options",
            symbol: "AAPL",
            action: "buy",
            quantity: 1,
          },
        }),
        "u1login",
      ),
    ).toThrow(/optionLegs/);
  });

  it("rejects a non-goal family (Q5 goal-only default)", () => {
    expect(() =>
      validateSagaEntryBody(validBody({ family: "stock" }), "u1login"),
    ).toThrow(/goal/);
  });

  it("rejects a missing email", () => {
    const { email, ...rest } = validBody();
    void email;
    expect(() => validateSagaEntryBody(rest, "u1login")).toThrow(/email/);
  });
});

describe("buildSagaEntryParams (S4, #2041)", () => {
  it("builds goal-only saga params carrying the trade intent", () => {
    const input = validateSagaEntryBody(validBody(), "u1login");
    const params = buildSagaEntryParams(input, {
      userId: "u1login",
      email: "u1@example.com",
      tenantId: "tenant-1",
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    });
    expect(params.family).toBe("goal");
    expect(params.sagaId).toBe("saga-1");
    expect(params.runRequestId).toBe("saga-1");
    expect(params.tradeIntent).toMatchObject({
      kind: "stock",
      symbol: "AAPL",
      quantity: 10,
    });
    expect(params.account.userId).toBe("u1login");
  });
});

describe("startSagaViaBinding (S4, #2041)", () => {
  it("creates the instance under sagaWorkflowInstanceId(sagaId) — the S2 contract", async () => {
    const { binding, creates } = fakeBinding();
    const params = buildSagaEntryParams(
      validateSagaEntryBody(validBody(), "u1login"),
      {
        userId: "u1login",
        email: "u1@example.com",
        tenantId: "tenant-1",
        tier: "Free",
        creditsUSD: 0,
        includedRunsRemaining: 0,
      },
    );
    const started = await startSagaViaBinding(binding, params);
    expect(creates).toHaveLength(1);
    expect(creates[0].id).toBe(sagaWorkflowInstanceId("saga-1"));
    expect(started.workflowId).toBe(sagaWorkflowInstanceId("saga-1"));
    expect(started.existing).toBe(false);
  });

  it("adopts an existing instance on create failure (G-REPLAY)", async () => {
    const { binding, creates } = fakeBinding();
    (binding as { createThrows?: Error }).createThrows = new Error(
      "instance already exists",
    );
    const params = buildSagaEntryParams(
      validateSagaEntryBody(validBody(), "u1login"),
      {
        userId: "u1login",
        email: "u1@example.com",
        tenantId: "tenant-1",
        tier: "Free",
        creditsUSD: 0,
        includedRunsRemaining: 0,
      },
    );
    const started = await startSagaViaBinding(binding, params);
    expect(creates).toHaveLength(1);
    expect(started.existing).toBe(true);
    expect(started.workflowId).toBe(sagaWorkflowInstanceId("saga-1"));
  });
});

describe("handleSagaEntryRoutes (S4, #2041)", () => {
  const url = new URL("https://agent.internal/api/saga/start");

  it("returns null for non-matching paths", async () => {
    const res = await handleSagaEntryRoutes(
      new Request("https://agent.internal/api/saga/other", { method: "GET" }),
      new URL("https://agent.internal/api/saga/other"),
      "/api/saga/other",
      envWithFlag(true),
      "u1login",
    );
    expect(res).toBeNull();
  });

  it("401 without a session login", async () => {
    const res = await handleSagaEntryRoutes(
      new Request(url, { method: "POST", body: JSON.stringify(validBody()) }),
      url,
      "/api/saga/start",
      envWithFlag(true),
      null,
    );
    expect(res?.status).toBe(401);
  });

  it("403 when the monetization flag is OFF (fail-closed, reviewed wiring)", async () => {
    const res = await handleSagaEntryRoutes(
      new Request(url, { method: "POST", body: JSON.stringify(validBody()) }),
      url,
      "/api/saga/start",
      envWithFlag(false),
      "u1login",
    );
    expect(res?.status).toBe(403);
  });

  it("400 for a missing tradeIntent, after the flag gate", async () => {
    const { tradeIntent, ...rest } = validBody();
    void tradeIntent;
    const res = await handleSagaEntryRoutes(
      new Request(url, { method: "POST", body: JSON.stringify(rest) }),
      url,
      "/api/saga/start",
      envWithFlag(true),
      "u1login",
    );
    expect(res?.status).toBe(400);
  });

  it("503 when commercial adapters are unbound", async () => {
    const res = await handleSagaEntryRoutes(
      new Request(url, { method: "POST", body: JSON.stringify(validBody()) }),
      url,
      "/api/saga/start",
      envWithFlag(true),
      "u1login",
    );
    expect(res?.status).toBe(503);
  });

  it("202 with the instance id, statusUrl, and pre-payment disclosure (S3 wiring)", async () => {
    const { binding, creates } = fakeBinding();
    const res = await handleSagaEntryRoutes(
      new Request(url, { method: "POST", body: JSON.stringify(validBody()) }),
      url,
      "/api/saga/start",
      envWithFlag(true),
      "u1login",
      {
        sagaBinding: binding,
        commercial: fakePorts().commercial,
        subscriptions: fakePorts().subscriptions,
      },
    );
    expect(res?.status).toBe(202);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.sagaId).toBe("saga-1");
    expect(body.runRequestId).toBe("saga-1");
    expect(body.workflowId).toBe(sagaWorkflowInstanceId("saga-1"));
    expect(body.statusUrl).toBe("/api/saga/saga-1/status");
    expect(typeof body.disclosure).toBe("string");
    expect((body.disclosure as string).length).toBeGreaterThan(0);
    expect(creates).toHaveLength(1);
    expect(creates[0].id).toBe(sagaWorkflowInstanceId("saga-1"));
    // The saga params handed to the instance carry the trade
    // intent (the leg never invents one) and the goal family.
    const params = creates[0].params as Record<string, unknown>;
    expect(params.family).toBe("goal");
    expect(params.tradeIntent).toMatchObject({ symbol: "AAPL" });
  });
});
