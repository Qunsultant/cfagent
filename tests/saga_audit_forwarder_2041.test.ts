/**
 * Issue #2041 follow-up — saga audit forwarder payload mapping.
 *
 * The flow carries refusalReason on refused journey rows
 * (sagaWorkflowFlow.ts: parsed.reason / saga_id_mismatch /
 * non_owner_decider), but the adapter's recordSagaAudit payload
 * mapping omitted it, so forwarded saga.journey_decision_refused
 * rows lost the reason. This pin drives the real
 * CrossDomainSagaWorkflow.run() with stubbed bindings (the
 * ThinkWorkflow stub constructor takes ctx/env, so the class
 * instantiates under Node; run() only touches this.env) through
 * payment → completed screen → journey gate, queues one refused
 * answer of each kind, and asserts the FORWARDED payloads — the
 * JSON bodies the SEARCH_AGENT stub received — carry the reason.
 *
 * The distinct `reason` field keeps its own mapping: a refused
 * row must not gain a spurious `reason` from the refusalReason.
 */
import { describe, expect, it, vi } from "vitest";

// Same idiom as trading_trade_workflow.test.ts: trading-agent.ts
// is an Agents SDK actor, so mock the SDK with a plain base class.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { CrossDomainSagaWorkflow } from "../src/workflows/sagaWorkflow";
import type { SagaParams } from "../src/workflows/sagaWorkflowFlow";
import type { Env } from "../src/types";

type CapturedBody = {
  type: string;
  agent: string;
  payload: Record<string, unknown>;
};

function runRefusedGate(): Promise<{ outcomeStatus: string; bodies: CapturedBody[] }> {
  const bodies: CapturedBody[] = [];
  const auditStub = {
    fetch: async (req: Request): Promise<Response> => {
      bodies.push((await req.json()) as CapturedBody);
      return new Response("{}", { status: 200 });
    },
  };
  const paymentBinding = {
    create: async ({ id }: { id: string }) => ({ id }),
    get: async () => ({
      status: async () => ({
        status: "complete",
        output: {
          status: "started",
          screenerWorkflowId: "screen-1",
          paidVia: "stripe_checkout",
          priceUSD: 0.1,
        },
      }),
    }),
  };
  const screenerBinding = {
    create: async ({ id }: { id: string }) => ({ id }),
    get: async () => ({
      status: async () => ({
        status: "complete",
        output: { lifecycle: "Completed" },
      }),
    }),
  };
  const env = {
    SERVICE_USER_LOGIN: "svclogin",
    SEARCH_AGENT: {
      idFromName: () => "shared",
      get: () => auditStub,
    },
    PAYMENT_WORKFLOW: paymentBinding,
    SCREENER_WORKFLOW: screenerBinding,
  } as unknown as Env;

  const params: SagaParams = {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    family: "goal",
    trigger: "manual",
    account: {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "PayPerUse",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    },
    screenerCommand: {
      jobId: "job-1",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "u1login",
      shards: [],
      role: "parent",
    },
    rail: "stripe",
    pollIntervalMs: 1000,
    paymentPollDeadlineMs: 5000,
    screenPollDeadlineMs: 5000,
  };

  // One refused answer of each kind, then provider timeout:
  // the gate loop breaks and the saga expires (no trade leg).
  const queuedDecisions: unknown[] = [
    { sagaId: "saga-1", decision: "denied", deciderLogin: "someone-else", surface: "slack" },
    { sagaId: "saga-1", decision: "maybe", deciderLogin: "u1login", surface: "chat" },
    { sagaId: "saga-other", decision: "denied", deciderLogin: "u1login", surface: "slack" },
  ];
  const step = {
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sleep: async () => {},
    waitForEvent: async () => {
      const next = queuedDecisions.shift();
      if (next === undefined) throw new Error("provider timeout");
      return { payload: next };
    },
  };

  const workflow = new CrossDomainSagaWorkflow({}, env);
  return workflow
    .run({ payload: params } as never, step as never)
    .then((outcome) => ({ outcomeStatus: outcome.status, bodies }));
}

describe("saga audit forwarder refusalReason mapping (#2041 follow-up)", () => {
  it("forwards the refusal reason on every refused journey row", async () => {
    const { outcomeStatus, bodies } = await runRefusedGate();
    expect(outcomeStatus).toBe("journey_expired");
    const refused = bodies.filter((b) => b.type === "saga.journey_decision_refused");
    expect(refused).toHaveLength(3);
    expect(refused.map((b) => b.payload["refusalReason"])).toEqual([
      "non_owner_decider",
      "malformed_decision_value",
      "saga_id_mismatch",
    ]);
    for (const row of refused) {
      expect(row.agent).toBe("saga");
      expect(row.payload["sagaId"]).toBe("saga-1");
      // The distinct `reason` field keeps its own mapping: a
      // refused row carries refusalReason, never a copied reason.
      expect(row.payload["reason"]).toBeUndefined();
    }
  });
});
