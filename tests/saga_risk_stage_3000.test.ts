/**
 * Issue #3000 — risk-analysis stage in the saga trading leg.
 *
 * TDD RED: the stage module does not exist yet. The stage assesses a
 * saga trade intent with the existing engine (no-view path — the saga
 * carries no market view, so the view path can never run here) and
 * gates draft creation:
 *
 * - assessable mode (limits + contracts/snapshot present): an options
 *   intent whose legs match an engine-validated candidate passes with
 *   its risk report; a non-matching intent FAILS CLOSED (no draft) —
 *   the engine does not validate that trade. A stock intent with spot
 *   strictly above AVWAP passes; spot at or below AVWAP fails closed
 *   (strict AVWAP rule: equality rejects).
 * - unassessable mode (limits or market data missing): the stage
 *   records an explicit unassessed-with-reason assessment and the draft
 *   proceeds. Unassessed never blocks — blocking on missing inputs
 *   would break every existing saga trade, which carries no limits.
 *   The gap (no data seam at the leg today) is named, not hidden.
 * - the stage never approves anything: per-order HITL approval is
 *   unchanged, and a violation produces no child workflow at all.
 */
import { describe, expect, it } from "vitest";
import {
  assessSagaTradeRisk,
  type SagaRiskLimits,
} from "../src/workflows/sagaRiskStage";
import { StrategyRiskAgent } from "../src/trading/options/strategyRiskAgent";
import type { ScreenedOptionContractItem } from "../src/types";
import {
  runTradeLeg,
  type ProposeTradeResult,
  type SagaTradeDeps,
  type SagaTradeIntent,
  type SagaTradeOutcome,
} from "../src/workflows/sagaTradeLeg";
import {
  validateSagaEntryBody,
} from "../src/agents/routes/sagaEntry";
import type {
  SagaAuditEvent,
  SagaWorkflowStep,
} from "../src/workflows/sagaWorkflowFlow";
import {
  type SagaLegInstanceStatus,
  type SagaLegPort,
} from "../src/workflows/sagaLegPort";

// --- option-chain fixtures (adapted from the no-view engine suite) ---

const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const expiryDate = expiry.toISOString().slice(0, 10);

function makeContracts(): ScreenedOptionContractItem[] {
  const quoteTimestamp = Date.now();
  return [90, 95, 100, 105, 110].flatMap((strike) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
    const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
    const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(quoteTimestamp).toISOString(),
      quoteFreshness: "FRESH" as const,
      bidSize: 10,
      askSize: 10,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      spreadOi: undefined,
      technicalSignal: "Test fixture",
      highlightReason: "Test fixture",
      volumeOiRatio: 0.5,
    };
    return [
      {
        ...base,
        optionType: "CALL" as const,
        symbol: `XYZ${strike}C`,
        strikePrice: strike,
        bid: callMid - 0.1,
        ask: callMid + 0.1,
        delta,
      },
      {
        ...base,
        optionType: "PUT" as const,
        symbol: `XYZ${strike}P`,
        strikePrice: strike,
        bid: putMid - 0.1,
        ask: putMid + 0.1,
        delta: -delta,
      },
    ];
  });
}

const LIMITS: SagaRiskLimits = { maxPlannedLoss: 1_000, minRewardRisk: 0.1 };

function optionsIntent(over: Partial<SagaTradeIntent> = {}): SagaTradeIntent {
  return {
    kind: "options",
    symbol: "XYZ",
    action: "buy",
    quantity: 1,
    optionLegs: [],
    ...over,
  };
}

function stockIntent(over: Partial<SagaTradeIntent> = {}): SagaTradeIntent {
  return {
    kind: "stock",
    symbol: "AAPL",
    action: "buy",
    quantity: 10,
    ...over,
  };
}

describe("saga risk stage, options (engine, no-view path)", () => {
  it("assesses a matching engine-validated candidate with its risk report", () => {
    const agent = new StrategyRiskAgent();
    const contracts = makeContracts();
    const built = agent.buildNoViewStrategies(contracts, {
      symbol: "XYZ",
      ...LIMITS,
    });
    const candidate = built.candidates.find((c) =>
      c.legs.every((l) => l.optionType === "CALL" || l.optionType === "PUT"),
    );
    expect(candidate).toBeDefined();
    const intent = optionsIntent({
      optionLegs: candidate!.legs.map((l) => ({
        side: l.side,
        optionType: l.optionType,
        strike: l.strike,
        expirationDate: l.expirationDate,
        quantity: l.quantity,
      })),
    });
    const assessment = assessSagaTradeRisk({ intent, limits: LIMITS, contracts });
    expect(assessment.status).toBe("assessed");
    if (assessment.status !== "assessed" || assessment.kind !== "options") {
      throw new Error("expected an assessed options assessment");
    }
    expect(assessment.violation).toBe(false);
    expect(assessment.report.id).toBe(candidate!.id);
    expect(assessment.report.withinBudget).toBe(true);
  });

  it("fails closed when the intent legs match no engine-validated candidate", () => {
    const assessment = assessSagaTradeRisk({
      intent: optionsIntent({
        optionLegs: [
          {
            side: "BUY",
            optionType: "CALL",
            strike: 999,
            expirationDate: expiryDate,
            quantity: 1,
          },
        ],
      }),
      limits: LIMITS,
      contracts: makeContracts(),
    });
    expect(assessment.status).toBe("assessed");
    if (assessment.status !== "assessed" || assessment.kind !== "options") {
      throw new Error("expected an assessed options assessment");
    }
    expect(assessment.violation).toBe(true);
    expect(assessment.reason).toMatch(/not.*engine-validated/i);
  });

  it("records unassessed when limits are missing (never blocks)", () => {
    const assessment = assessSagaTradeRisk({
      intent: optionsIntent({
        optionLegs: [
          {
            side: "BUY",
            optionType: "CALL",
            strike: 100,
            expirationDate: expiryDate,
            quantity: 1,
          },
        ],
      }),
      contracts: makeContracts(),
    });
    expect(assessment).toMatchObject({
      status: "unassessed",
      reason: expect.stringMatching(/limits/i),
    });
  });

  it("records unassessed when contracts are missing (never blocks)", () => {
    const assessment = assessSagaTradeRisk({
      intent: optionsIntent({
        optionLegs: [
          {
            side: "BUY",
            optionType: "CALL",
            strike: 100,
            expirationDate: expiryDate,
            quantity: 1,
          },
        ],
      }),
      limits: LIMITS,
    });
    expect(assessment).toMatchObject({
      status: "unassessed",
      reason: expect.stringMatching(/contracts/i),
    });
  });
});

describe("saga risk stage, stocks (AVWAP guard, strict)", () => {
  it("passes when spot is strictly above AVWAP", () => {
    const assessment = assessSagaTradeRisk({
      intent: stockIntent(),
      marketSnapshot: { spot: 150, avwap: 149 },
    });
    expect(assessment).toMatchObject({
      status: "assessed",
      kind: "stock",
      violation: false,
    });
  });

  it("fails closed on AVWAP equality (strict rule: equality rejects)", () => {
    const assessment = assessSagaTradeRisk({
      intent: stockIntent(),
      marketSnapshot: { spot: 150, avwap: 150 },
    });
    expect(assessment).toMatchObject({
      status: "assessed",
      kind: "stock",
      violation: true,
    });
  });

  it("fails closed when spot is below AVWAP", () => {
    const assessment = assessSagaTradeRisk({
      intent: stockIntent(),
      marketSnapshot: { spot: 148, avwap: 149 },
    });
    expect(assessment).toMatchObject({
      status: "assessed",
      kind: "stock",
      violation: true,
    });
  });

  it("records unassessed when no market snapshot is available", () => {
    const assessment = assessSagaTradeRisk({ intent: stockIntent() });
    expect(assessment).toMatchObject({
      status: "unassessed",
      reason: expect.stringMatching(/snapshot/i),
    });
  });
});

describe("saga risk stage, entry contract", () => {
  function entryBody(over: Record<string, unknown> = {}) {
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
        kind: "options",
        symbol: "XYZ",
        action: "buy",
        quantity: 1,
        optionLegs: [{ side: "BUY", optionType: "CALL", strike: 100 }],
      },
      email: "u1@example.com",
      ...over,
    };
  }

  it("accepts valid riskLimits and passes them through verbatim", () => {
    const input = validateSagaEntryBody(
      entryBody({
        tradeIntent: {
          kind: "options",
          symbol: "XYZ",
          action: "buy",
          quantity: 1,
          optionLegs: [{ side: "BUY", optionType: "CALL", strike: 100 }],
          riskLimits: { maxPlannedLoss: 1000, minRewardRisk: 0.5 },
        },
      }),
      "u1login",
    );
    expect(input.tradeIntent).toMatchObject({
      riskLimits: { maxPlannedLoss: 1000, minRewardRisk: 0.5 },
    });
  });

  it("rejects a non-positive maxPlannedLoss", () => {
    expect(() =>
      validateSagaEntryBody(
        entryBody({
          tradeIntent: {
            kind: "stock",
            symbol: "AAPL",
            action: "buy",
            quantity: 10,
            riskLimits: { maxPlannedLoss: 0, minRewardRisk: 0.5 },
          },
        }),
        "u1login",
      ),
    ).toThrow(/maxPlannedLoss/);
  });

  it("rejects a negative minRewardRisk", () => {
    expect(() =>
      validateSagaEntryBody(
        entryBody({
          tradeIntent: {
            kind: "stock",
            symbol: "AAPL",
            action: "buy",
            quantity: 10,
            riskLimits: { maxPlannedLoss: 1000, minRewardRisk: -1 },
          },
        }),
        "u1login",
      ),
    ).toThrow(/minRewardRisk/);
  });

  it("rejects non-object riskLimits", () => {
    expect(() =>
      validateSagaEntryBody(
        entryBody({
          tradeIntent: {
            kind: "stock",
            symbol: "AAPL",
            action: "buy",
            quantity: 10,
            riskLimits: "1000",
          },
        }),
        "u1login",
      ),
    ).toThrow(/riskLimits/);
  });
});

// --- trade-leg wiring harness (mirrors the S4 leg suite) ---

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
  statuses: Record<string, Array<SagaLegInstanceStatus | null>> = {};

  async startLeg(
    leg: "payment" | "screener" | "trade",
    params: unknown,
  ): Promise<{ workflowId: string; existing: boolean }> {
    this.starts.push({ leg, params });
    return { workflowId: "trade-wf-1", existing: false };
  }

  async getLegStatus(
    leg: "payment" | "screener" | "trade",
    workflowId: string,
  ): Promise<SagaLegInstanceStatus | null> {
    const queue = this.statuses[`${leg}:${workflowId}`];
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }
}

function wireHarness(legPort: FakeLegPort) {
  const auditEvents: SagaAuditEvent[] = [];
  const finishCalls: Array<{
    outcome: SagaTradeOutcome;
    terminalEvent: Record<string, unknown>;
  }> = [];
  const clock = { ms: 0 };
  const deps: SagaTradeDeps = {
    legPort,
    recordAudit: async (event: SagaAuditEvent) => {
      auditEvents.push(event);
    },
    proposeTrade: async (): Promise<ProposeTradeResult> => ({
      ok: true,
      orderId: "order-1",
    }),
    nowMs: () => clock.ms,
  };
  const finish = async (
    outcome: SagaTradeOutcome,
    terminalEvent: Record<string, unknown>,
  ): Promise<SagaTradeOutcome> => {
    finishCalls.push({ outcome, terminalEvent });
    return outcome;
  };
  return { deps, auditEvents, finishCalls, clock, finish };
}

function wireArgs(over: Record<string, unknown> = {}) {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    tenantId: "tenant-1",
    family: "goal" as const,
    rail: "stripe" as const,
    tradeIntent: stockIntent(),
    screenerWorkflowId: "scr-wf-1",
    decidingSurface: "panel" as const,
    ...over,
  };
}

function wireAudit(over: Record<string, unknown> = {}) {
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

describe("saga risk stage, trade-leg wiring", () => {
  it("a risk violation produces no draft: no startLeg, proposal_failed with risk_violation", async () => {
    const legPort = new FakeLegPort();
    const { deps, finishCalls, clock, finish } = wireHarness(legPort);
    deps.riskInputs = { marketSnapshot: { spot: 148, avwap: 149 } };
    const outcome = await runTradeLeg(
      wireArgs(),
      deps,
      fakeStep(clock),
      wireAudit(),
      finish,
    );
    expect(legPort.starts).toHaveLength(0);
    expect(outcome.status).toBe("proposal_failed");
    expect(outcome.code).toBe("FAILURE_SAGA_PROPOSAL_FAILED");
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0].outcome).toMatchObject({ reason: "risk_violation" });
    expect(finishCalls[0].terminalEvent).toMatchObject({
      type: "saga.proposal_failed",
      riskAssessment: expect.objectContaining({ violation: true }),
    });
  });

  it("an assessed survivor starts the child and carries its assessment on the proposed audit", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [
      { status: "complete", output: { status: "settled", orderId: "order-1" } },
    ];
    const { deps, auditEvents, clock, finish } = wireHarness(legPort);
    deps.riskInputs = { marketSnapshot: { spot: 150, avwap: 149 } };
    await runTradeLeg(
      wireArgs(),
      deps,
      fakeStep(clock),
      wireAudit(),
      finish,
    );
    expect(legPort.starts).toHaveLength(1);
    const proposed = auditEvents.find((e) => e.type === "saga.trade_proposed");
    expect(proposed).toMatchObject({
      orderId: "order-1",
      riskAssessment: expect.objectContaining({
        status: "assessed",
        violation: false,
      }),
    });
  });

  it("an unassessed draft proceeds with its explicit reason on the proposed audit", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["trade:trade-wf-1"] = [
      { status: "complete", output: { status: "settled", orderId: "order-1" } },
    ];
    const { deps, auditEvents, clock, finish } = wireHarness(legPort);
    // No riskInputs at all: today's leg has no data seam, so the
    // stage records unassessed and the draft proceeds.
    await runTradeLeg(
      wireArgs(),
      deps,
      fakeStep(clock),
      wireAudit(),
      finish,
    );
    expect(legPort.starts).toHaveLength(1);
    const proposed = auditEvents.find((e) => e.type === "saga.trade_proposed");
    expect(proposed).toMatchObject({
      orderId: "order-1",
      riskAssessment: expect.objectContaining({ status: "unassessed" }),
    });
  });
});
