/**
 * Issue #2041 S4 — trading leg (gap G-CATALOG trading part).
 *
 * TDD: written before the leg module. After journey approval the
 * saga proposes via the preview surfaces (preview-only drafts —
 * the saga NEVER places an order itself) and starts a
 * TradingTradeWorkflow child through the leg port; the existing
 * per-order HITL approval engine remains the only execution path.
 * Trade outcomes pass through as saga outcomes (catalog codes,
 * not inline strings). Q10 stays OUT of S4: the leg never
 * consults refund deps and never approves a refund.
 */
import { describe, expect, it } from "vitest";
import {
  SAGA_TRADE_POLL_DEADLINE_MS_DEFAULT,
  type ProposeTradeResult,
  type SagaTradeDeps,
  type SagaTradeIntent,
  type SagaTradeOutcome,
  runTradeLeg,
} from "../src/workflows/sagaTradeLeg";
import type { SagaWorkflowStep } from "../src/workflows/sagaWorkflowFlow";
import type { SagaAuditEvent } from "../src/workflows/sagaWorkflowFlow";
import {
  sagaLegInstanceId,
  type SagaLegInstanceStatus,
  type SagaLegPort,
} from "../src/workflows/sagaLegPort";

function fakeStep(clock: { ms: number }): SagaWorkflowStep {
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    async waitForEvent(): Promise<{ payload: unknown }> {
      throw new Error("trade leg never waits on journey events");
    },
  };
}

class FakeLegPort implements SagaLegPort {
  starts: Array<{ leg: string; params: unknown }> = [];
  statusCalls: Array<{ leg: string; workflowId: string }> = [];
  startResult: { workflowId: string; existing: boolean } = {
    workflowId: "trade-wf-1",
    existing: false,
  };
  startThrows?: Error;
  statuses: Record<string, Array<SagaLegInstanceStatus | null>> = {};

  async startLeg(
    leg: "payment" | "screener" | "trade",
    params: unknown,
  ): Promise<{ workflowId: string; existing: boolean }> {
    this.starts.push({ leg, params });
    if (this.startThrows) throw this.startThrows;
    return this.startResult;
  }

  async getLegStatus(
    leg: "payment" | "screener" | "trade",
    workflowId: string,
  ): Promise<SagaLegInstanceStatus | null> {
    this.statusCalls.push({ leg, workflowId });
    const queue = this.statuses[`${leg}:${workflowId}`];
    // No queue = no instance (the real port maps a missing
    // instance to null); the poll loop supplies its own running
    // entries where a test needs them.
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }
}

function tradeIntent(over: Partial<SagaTradeIntent> = {}): SagaTradeIntent {
  return {
    kind: "stock",
    symbol: "AAPL",
    action: "buy",
    quantity: 10,
    orderType: "market",
    ...over,
  };
}

interface TradeHarness {
  deps: SagaTradeDeps;
  auditEvents: SagaAuditEvent[];
  proposeCalls: SagaTradeIntent[];
  finishCalls: Array<{
    outcome: SagaTradeOutcome;
    terminalEvent: Record<string, unknown>;
  }>;
  clock: { ms: number };
}

function harness(
  legPort: FakeLegPort,
  opts: {
    propose?: (intent: SagaTradeIntent) => Promise<ProposeTradeResult>;
    clock?: { ms: number };
  } = {},
): TradeHarness {
  const auditEvents: SagaAuditEvent[] = [];
  const proposeCalls: SagaTradeIntent[] = [];
  const finishCalls: TradeHarness["finishCalls"] = [];
  const clock = opts.clock ?? { ms: 0 };
  const deps: SagaTradeDeps = {
    legPort,
    recordAudit: async (event: SagaAuditEvent) => {
      auditEvents.push(event);
    },
    proposeTrade: async (intent: SagaTradeIntent) => {
      proposeCalls.push(intent);
      if (opts.propose) return opts.propose(intent);
      return { ok: true, orderId: "order-1" };
    },
    nowMs: () => clock.ms,
  };
  // The finish callback stands in for the flow's endSaga: it
  // records the terminal event + a synthetic ended row so tests
  // can assert what the flow would have ended with.
  const finish = async (
    outcome: SagaTradeOutcome,
    terminalEvent: Record<string, unknown>,
  ): Promise<SagaTradeOutcome> => {
    finishCalls.push({ outcome, terminalEvent });
    return outcome;
  };
  return { deps, auditEvents, proposeCalls, finishCalls, clock, finish } as TradeHarness & {
    finish: typeof finish;
  };
}

function baseArgs(over: Record<string, unknown> = {}) {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    tenantId: "tenant-1",
    family: "goal" as const,
    rail: "stripe" as const,
    tradeIntent: tradeIntent(),
    screenerWorkflowId: "scr-wf-1",
    decidingSurface: "panel" as const,
    ...over,
  };
}

function baseAudit(over: Record<string, unknown> = {}) {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    tenantId: "tenant-1",
    userLogin: "u1login",
    family: "goal" as const,
    rail: "stripe" as const,
    ...over,
  };
}

function tradeOutput(status: string, over: Record<string, unknown> = {}) {
  return { status: "complete", output: { status, orderId: "order-1", ...over } };
}

describe("saga trade leg (S4, #2041)", () => {
  it("proposes via the preview surface, starts the trade child, and passes a settled approval through", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [
      tradeOutput("settled", { decision: "approved" }),
    ];
    const { deps, auditEvents, proposeCalls, finishCalls, clock, finish } =
      harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_settled");
    expect(outcome.code).toBe("SUCCESS_SAGA_TRADE_SETTLED");
    expect(outcome.decidingSurface).toBe("panel");
    expect(outcome.rail).toBe("stripe");
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]).toMatchObject({
      kind: "stock",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
    });
    expect(legPort.starts).toHaveLength(1);
    expect(legPort.starts[0]).toMatchObject({
      leg: "trade",
      params: { orderId: "order-1", userLogin: "u1login" },
    });
    const proposed = auditEvents.find((e) => e.type === "saga.trade_proposed");
    expect(proposed?.orderId).toBe("order-1");
    expect(proposed?.tradeWorkflowId).toBe("trade-wf-1");
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0].outcome.code).toBe("SUCCESS_SAGA_TRADE_SETTLED");
    expect(finishCalls[0].terminalEvent).toMatchObject({
      type: "saga.trade_settled",
      orderId: "order-1",
      tradeWorkflowId: "trade-wf-1",
      decidingSurface: "panel",
    });
  });

  it("adopts a running trade child on re-run: no second proposal, no second start", async () => {
    const legPort = new FakeLegPort();
    const derivedId = sagaLegInstanceId("saga-1", "trade");
    // Pre-check reads the derived id (running) and the poll then
    // reads the same id to its terminal output.
    legPort.statuses[`trade:${derivedId}`] = [
      { status: "running" },
      tradeOutput("settled", { decision: "approved" }),
    ];
    const { deps, proposeCalls, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_settled");
    expect(proposeCalls).toHaveLength(0);
    expect(legPort.starts).toHaveLength(0);
  });

  it("adopts an already-complete trade child: outcome passes through without proposing", async () => {
    const legPort = new FakeLegPort();
    const derivedId = sagaLegInstanceId("saga-1", "trade");
    legPort.statuses[`trade:${derivedId}`] = [
      tradeOutput("settled", { decision: "approved" }),
    ];
    const { deps, proposeCalls, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_settled");
    expect(proposeCalls).toHaveLength(0);
    expect(legPort.starts).toHaveLength(0);
  });

  it("a settled rejection passes through as trade_rejected (user decision, not an error)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [
      tradeOutput("settled", { decision: "rejected" }),
    ];
    const { deps, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_rejected");
    expect(outcome.code).toBe("FAILURE_SAGA_TRADE_REJECTED");
  });

  it("an expired per-order wait passes through as trade_expired", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [tradeOutput("expired")];
    const { deps, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_expired");
    expect(outcome.code).toBe("FAILURE_SAGA_TRADE_EXPIRED");
  });

  it.each(["errored", "terminated"])(
    "a %s trade child surfaces as trade_leg_failed (never compensated)",
    async (status) => {
      const legPort = new FakeLegPort();
      legPort.statuses["trade:trade-wf-1"] = [{ status: status as "errored" }];
      const { deps, clock, finish } = harness(legPort);
      const outcome = await runTradeLeg(
        baseArgs(),
        deps,
        fakeStep(clock),
        baseAudit(),
        finish,
      );
      expect(outcome.status).toBe("trade_leg_failed");
      expect(outcome.code).toBe("FAILURE_SAGA_TRADE_LEG_FAILED");
    },
  );

  it("a trade poll deadline surfaces as trade_leg_failed", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs({ tradePollDeadlineMs: 0 }),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_leg_failed");
    expect(outcome.code).toBe("FAILURE_SAGA_TRADE_LEG_FAILED");
  });

  it("an unrecognized trade output surfaces as trade_leg_failed", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [
      tradeOutput("bogus-status"),
    ];
    const { deps, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("trade_leg_failed");
    expect(outcome.code).toBe("FAILURE_SAGA_TRADE_LEG_FAILED");
  });

  it("a refused proposal ends proposal_failed and never starts a child", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock, finish } = harness(legPort, {
      propose: async () => ({ ok: false, reason: "provider_unsupported" }),
    });
    const outcome = await runTradeLeg(
      baseArgs(),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("proposal_failed");
    expect(outcome.code).toBe("FAILURE_SAGA_PROPOSAL_FAILED");
    expect(legPort.starts).toHaveLength(0);
  });

  it("a missing trade intent ends proposal_failed defensively (never invents a trade)", async () => {
    const legPort = new FakeLegPort();
    const { deps, proposeCalls, clock, finish } = harness(legPort);
    const outcome = await runTradeLeg(
      baseArgs({ tradeIntent: undefined }),
      deps,
      fakeStep(clock),
      baseAudit(),
      finish,
    );
    expect(outcome.status).toBe("proposal_failed");
    expect(outcome.code).toBe("FAILURE_SAGA_PROPOSAL_FAILED");
    expect(proposeCalls).toHaveLength(0);
    expect(legPort.starts).toHaveLength(0);
  });

  it("a throwing proposeTrade propagates (config failure retries; it is not a proposal refusal)", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock, finish } = harness(legPort, {
      propose: async () => {
        throw new Error("TRADING_AGENT binding is not bound");
      },
    });
    await expect(
      runTradeLeg(baseArgs(), deps, fakeStep(clock), baseAudit(), finish),
    ).rejects.toThrow(/TRADING_AGENT binding/);
    expect(legPort.starts).toHaveLength(0);
  });

  it("the trade poll deadline defaults to 25h (payment's 24h + margin, Q2-open)", () => {
    expect(SAGA_TRADE_POLL_DEADLINE_MS_DEFAULT).toBe(25 * 60 * 60 * 1000);
  });
});
