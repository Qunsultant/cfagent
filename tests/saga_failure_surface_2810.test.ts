/**
 * Issue #2810 — saga failures must surface: an errored instance
 * produces a visible record with step + reason, never an absence.
 *
 * Observed failure (live, 2026-11-02): saga-mvyz5pjk-ee0f27
 * errored with zero audit rows — the status payload showed only
 * the #2777 projection fallback row + instanceStatus "errored",
 * no Slack notice, no Workflow Runs entry, and the panel kept
 * polling a run that looked alive.
 *
 * Pins here:
 * - (c) Flow: an uncaught leg error ends in a terminal
 *   saga.failed audit row (leg + real reason text) + outcome
 *   notice + saga.ended with FAILURE_SAGA_FAILED — the
 *   instance completes with the failure recorded instead of
 *   erroring silently. A leg child's error text (e.g. the
 *   fail-closed price message) propagates as the reason, not
 *   just a code; without an error message the old code
 *   fallbacks still hold.
 * - (c-residual) When the audit dep itself is down, the
 *   catch-all cannot record: the throw still propagates
 *   (never a fake success) and the status route's errored
 *   surfacing below is the backstop.
 * - (a) Status route: an errored instance includes
 *   instanceError — the binding's error text when present,
 *   else the terminal audit row's reason, else the last known
 *   step + "instance errored". Best-effort: a binding failure
 *   never turns the read into a 503, and a non-errored
 *   instance carries no instanceError field.
 * - (a-map) mapSagaAuditToJobs maps saga.failed rows to a
 *   "failed" stage row whose detail names the leg + reason,
 *   so the failure also appears in Workflow Runs stages.
 */
import { describe, expect, it } from "vitest";
import {
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaDeps,
  type SagaParams,
  type SagaWorkflowStep,
} from "../src/workflows/sagaWorkflowFlow";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneyWithdrawResult,
} from "../src/workflows/sagaJourneyGate";
import type {
  SagaLeg,
  SagaLegInstanceStatus,
  SagaLegPort,
} from "../src/workflows/sagaLegPort";
import type { NativeCommercialAccount } from "../src/services/nativeMonetization";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import {
  handleSagaStatusRoutes,
  mapSagaAuditToJobs,
} from "../src/agents/routes/sagaStatus";
import type { ShardJobRow } from "../src/data/shardJobPorts";

const baseAccount: NativeCommercialAccount = {
  userId: "u1",
  email: "u1@example.com",
  tenantId: "t1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

const baseCommand: WorkflowJobCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "manual",
  trigger: "manual",
  userLogin: "u1login",
  shards: [],
  role: "parent",
};

function baseParams(over: Partial<SagaParams> = {}): SagaParams {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    family: "goal",
    trigger: "manual",
    account: baseAccount,
    screenerCommand: baseCommand,
    rail: "stripe",
    pollIntervalMs: 1000,
    paymentPollDeadlineMs: 5000,
    screenPollDeadlineMs: 5000,
    ...over,
  };
}

function fakeStep(clock: { ms: number }): SagaWorkflowStep {
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    async waitForEvent(): Promise<{ payload: unknown }> {
      throw new Error("no journey event queued");
    },
  };
}

type WaitScriptEntry = { payload: unknown } | { throws: Error };

function gateStep(
  clock: { ms: number },
  script: WaitScriptEntry[],
): SagaWorkflowStep {
  const queue = [...script];
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    async waitForEvent(): Promise<{ payload: unknown }> {
      const next = queue.shift();
      if (!next) throw new Error("waitForEvent script exhausted");
      if ("throws" in next) throw next.throws;
      return { payload: next.payload };
    },
  };
}

class FakeLegPort implements SagaLegPort {
  starts: Array<{ leg: SagaLeg; params: unknown }> = [];
  startThrows?: Error;
  statuses: Record<string, Array<SagaLegInstanceStatus | null>> = {};

  async startLeg(
    leg: SagaLeg,
    params: unknown,
  ): Promise<{ workflowId: string; existing: boolean }> {
    this.starts.push({ leg, params });
    if (this.startThrows) throw this.startThrows;
    return { workflowId: "pay-wf-1", existing: false };
  }

  async getLegStatus(
    leg: SagaLeg,
    workflowId: string,
  ): Promise<SagaLegInstanceStatus | null> {
    const queue = this.statuses[`${leg}:${workflowId}`];
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }
}

function depsFor(
  legPort: SagaLegPort,
  opts: {
    auditThrowsOnCall?: number;
    proposeTrade?: SagaDeps["proposeTrade"];
  } = {},
): { deps: SagaDeps; auditEvents: SagaAuditEvent[]; clock: { ms: number }; noticeCalls: unknown[] } {
  const auditEvents: SagaAuditEvent[] = [];
  const noticeCalls: unknown[] = [];
  const clock = { ms: 0 };
  let call = 0;
  const deps: SagaDeps = {
    legPort,
    recordAudit: async (event: SagaAuditEvent) => {
      call += 1;
      if (opts.auditThrowsOnCall === call) {
        throw new Error("audit endpoint unavailable");
      }
      auditEvents.push(event);
    },
    deliverPrompts: async (): Promise<JourneyPromptReceipts> => ({
      slackSkipped: "test: no Slack",
    }),
    withdrawPrompts: async (): Promise<JourneyWithdrawResult> => ({
      slack: "skipped",
      panel: "state-driven",
      chat: "state-driven",
    }),
    issueCredit: async () => {},
    getRefundPorts: async () => null,
    monetizationEnabled: async () => true,
    proposeTrade: async (intent: unknown) => {
      if (opts.proposeTrade) return opts.proposeTrade(intent);
      return { ok: false, reason: "proposal_failed" };
    },
    deliverNotice: async (notice: unknown) => {
      noticeCalls.push(notice);
      return { slack: "skipped" };
    },
    nowMs: () => clock.ms,
  };
  return { deps, auditEvents, clock, noticeCalls };
}

function paymentStarted(screenerWorkflowId = "scr-wf-1"): SagaLegInstanceStatus {
  return {
    status: "complete",
    output: {
      status: "started",
      runRequestId: "run-1",
      paidVia: "stripe_checkout",
      screenerWorkflowId,
      priceUSD: 0.1,
    },
  };
}

function collation(lifecycle: string): SagaLegInstanceStatus {
  return { status: "complete", output: { lifecycle } };
}

const TRADE_INTENT = {
  kind: "stock",
  symbol: "AAPL",
  action: "buy",
  quantity: 10,
  orderType: "market",
} as const;

function auditTypes(events: SagaAuditEvent[]): string[] {
  return events.map((e) => e.type);
}

const PRICE_FAIL_CLOSED =
  "Stored price for family goal is not approved (status: proposed): refusing to charge (fail-closed).";

describe("saga failure surfacing — flow catch-all (#2810)", () => {
  it("payment leg errored WITH a child error carries the real error text as the reason, not the code", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [
      { status: "errored", error: { message: PRICE_FAIL_CLOSED } },
    ];
    const { deps, auditEvents, clock } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("payment_not_completed");
    if (outcome.status === "payment_not_completed") {
      expect(outcome.reason).toBe(PRICE_FAIL_CLOSED);
    }
    const terminal = auditEvents.find((e) => e.type === "saga.payment_not_completed");
    expect(terminal?.reason).toBe(PRICE_FAIL_CLOSED);
  });

  it("payment leg errored WITHOUT an error keeps the old code fallback", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [{ status: "errored" }];
    const { deps, clock } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("payment_not_completed");
    if (outcome.status === "payment_not_completed") {
      expect(outcome.reason).toBe("payment_leg_errored");
    }
  });

  it("screen leg errored WITH a child error compensates with the real error text as the reason", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [
      { status: "errored", error: { message: "screener child blew up" } },
    ];
    const { deps, auditEvents, clock } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(
      baseParams({ rail: "x402" }),
      deps,
      fakeStep(clock),
    );
    expect(outcome.status).toBe("screen_failed_credit_issued");
    if (outcome.status === "screen_failed_credit_issued") {
      expect(outcome.reason).toBe("screener child blew up");
    }
    const failed = auditEvents.find((e) => e.type === "saga.screen_failed");
    expect(failed?.reason).toBe("screener child blew up");
  });

  it("a Leg 0 start throw ends in saga.failed + notice + saga.ended with FAILURE_SAGA_FAILED, never a silent error", async () => {
    const legPort = new FakeLegPort();
    legPort.startThrows = new Error("payment binding unavailable");
    const { deps, auditEvents, clock, noticeCalls } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("FAILURE_SAGA_FAILED");
    if (outcome.status === "failed") {
      expect(outcome.reason).toBe("payment binding unavailable");
    }
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.failed",
      "saga.outcome_notice",
      "saga.ended",
    ]);
    const failed = auditEvents.find((e) => e.type === "saga.failed");
    expect(failed?.leg).toBe("payment");
    expect(failed?.reason).toBe("payment binding unavailable");
    expect(failed?.outcomeCode).toBe("FAILURE_SAGA_FAILED");
    const ended = auditEvents.find((e) => e.type === "saga.ended");
    expect(ended?.outcomeCode).toBe("FAILURE_SAGA_FAILED");
    expect(ended?.reason).toBe("payment binding unavailable");
    expect(noticeCalls).toHaveLength(1);
    expect((noticeCalls[0] as { code: string }).code).toBe("FAILURE_SAGA_FAILED");
  });

  it("a journey-gate throw ends in saga.failed with leg screener (journey rows ride the screener leg)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, auditEvents, clock } = depsFor(legPort);
    // deliverPrompts throws inside the gate: the gate has no
    // local catch for prompt delivery, so it reaches the catch-all.
    deps.deliverPrompts = async () => {
      throw new Error("prompt delivery down");
    };
    const outcome = await runSagaWorkflowFlow(
      baseParams(),
      deps,
      gateStep(clock, []),
    );
    expect(outcome.code).toBe("FAILURE_SAGA_FAILED");
    const failed = auditEvents.find((e) => e.type === "saga.failed");
    expect(failed?.leg).toBe("screener");
    expect(failed?.reason).toBe("prompt delivery down");
  });

  it("a trade-leg throw ends in saga.failed with leg trade", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, auditEvents, clock } = depsFor(legPort, {
      proposeTrade: async () => {
        throw new Error("proposal service down");
      },
    });
    const outcome = await runSagaWorkflowFlow(
      baseParams({ tradeIntent: TRADE_INTENT }),
      deps,
      gateStep(clock, [
        {
          payload: {
            sagaId: "saga-1",
            decision: "approved",
            deciderLogin: "u1login",
            surface: "panel",
          },
        },
      ]),
    );
    expect(outcome.code).toBe("FAILURE_SAGA_FAILED");
    const failed = auditEvents.find((e) => e.type === "saga.failed");
    expect(failed?.leg).toBe("trade");
    expect(failed?.reason).toBe("proposal service down");
  });

  it("when the audit dep itself is down, the catch-all still propagates — never a fake success", async () => {
    const legPort = new FakeLegPort();
    legPort.startThrows = new Error("payment binding unavailable");
    // Call 1 = saga.started (ok); call 2 = saga.failed (throws).
    const { deps, auditEvents, clock } = depsFor(legPort, { auditThrowsOnCall: 2 });
    await expect(
      runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock)),
    ).rejects.toThrow("audit endpoint unavailable");
    expect(auditTypes(auditEvents)).toEqual(["saga.started"]);
  });
});

// ---- status route ----

function auditRow(
  type: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    agent: "saga",
    payload: {
      sagaId: "saga-1",
      runRequestId: "run-1",
      userLogin: "u1login",
      ...over,
    },
    created_at: "2026-10-31T00:00:00.000Z",
  };
}

function fakeAuditStub(rows: Record<string, unknown>[]) {
  return {
    async fetch(): Promise<Response> {
      return new Response(JSON.stringify({ events: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function projectionRow(over: Partial<ShardJobRow> = {}): ShardJobRow {
  return {
    tenantId: "tenant-1",
    workspaceId: "tenant-1",
    chainId: "saga-1",
    jobKey: "saga",
    version: 1,
    status: "submitted",
    stage: "payment",
    capabilityId: "saga",
    detail: "Saga submitted; payment leg starting.",
    resultJson: JSON.stringify({ sagaId: "saga-1" }),
    createdAtMs: 1761984000000,
    updatedAtMs: 1761984000000,
    provenanceWriter: "saga-entry-route",
    provenanceSourceDo: "saga",
    provenanceSourceVersion: "1",
    ...over,
  };
}

function fakeProjectionReader(rows: ShardJobRow[]) {
  return {
    async listJobsForChain(): Promise<ShardJobRow[]> {
      return rows;
    },
  };
}

function statusUrl(sagaId: string) {
  return new URL(`https://agent.internal/api/saga/${sagaId}/status`);
}

async function getStatus(
  sagaId: string,
  auditRows: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return handleSagaStatusRoutes(
    new Request(statusUrl(sagaId), { method: "GET" }),
    statusUrl(sagaId),
    `/api/saga/${sagaId}/status`,
    {},
    "u1login",
    { auditStub: fakeAuditStub(auditRows), ...overrides } as never,
  );
}

function fakeBinding(
  status: string,
  error?: { message: string },
  throws = false,
) {
  return {
    get: async (_id: string) => {
      if (throws) throw new Error("no such instance");
      return {
        status: async () => ({
          status,
          ...(error ? { error } : {}),
        }),
      };
    },
  };
}

describe("saga failure surfacing — status route errored surfacing (#2810)", () => {
  it("errored + binding error text surfaces that text as instanceError", async () => {
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: fakeProjectionReader([projectionRow()]),
      sagaBinding: fakeBinding("errored", { message: PRICE_FAIL_CLOSED }),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBe("errored");
    expect(body.instanceError).toBe(PRICE_FAIL_CLOSED);
  });

  it("errored + no binding error + fallback row names the last known step + instance errored", async () => {
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: fakeProjectionReader([projectionRow()]),
      sagaBinding: fakeBinding("errored"),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBe("errored");
    expect(typeof body.instanceError).toBe("string");
    expect(body.instanceError as string).toContain("payment");
    expect(body.instanceError as string).toContain("instance errored");
  });

  it("errored + terminal audit row reason surfaces that reason even without a binding error", async () => {
    const res = await getStatus(
      "saga-1",
      [
        auditRow("saga.started"),
        auditRow("saga.failed", {
          leg: "payment",
          reason: "payment binding unavailable",
          outcomeCode: "FAILURE_SAGA_FAILED",
        }),
      ],
      {
        tenantId: "tenant-1",
        projectionReader: fakeProjectionReader([projectionRow()]),
        sagaBinding: fakeBinding("errored"),
      },
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBe("errored");
    expect(body.instanceError).toBe("payment binding unavailable");
  });

  it("errored + binding read failure still answers 200 with no instanceError (never a 503)", async () => {
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: fakeProjectionReader([projectionRow()]),
      sagaBinding: fakeBinding("errored", undefined, true),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBeUndefined();
    expect(body.instanceError).toBeUndefined();
  });

  it("a non-errored instance carries no instanceError field", async () => {
    const res = await getStatus("saga-1", [], {
      tenantId: "tenant-1",
      projectionReader: fakeProjectionReader([projectionRow()]),
      sagaBinding: fakeBinding("running"),
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.instanceStatus).toBe("running");
    expect("instanceError" in body).toBe(false);
  });

  it("mapSagaAuditToJobs maps saga.failed to a failed stage row naming leg + reason", async () => {
    const jobs = mapSagaAuditToJobs(
      [
        auditRow("saga.failed", {
          leg: "payment",
          reason: "payment binding unavailable",
          outcomeCode: "FAILURE_SAGA_FAILED",
        }),
      ],
      "saga-1",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].stage).toBe("failed");
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].detail).toContain("payment");
    expect(jobs[0].detail).toContain("payment binding unavailable");
  });
});
