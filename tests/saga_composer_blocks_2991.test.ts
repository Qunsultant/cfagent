/**
 * Issue #2991 (#2770 Phase A) — saga as a THIN composer: the saga's
 * capabilities are registered Blocks, the composition resolves, and
 * the flow runs end-to-end on the registry-built leg port — not on
 * hand fakes for the extracted capabilities. If the composer file
 * started owning leg, gate, or compensation logic, this composition
 * would have nothing to delegate to.
 */
import { describe, expect, it } from "vitest";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import { validateComposition } from "../src/workflows/blocks/blockContract";
import {
  BROKER_SINGLE_ASSET_COMPOSITION,
  GOAL_SCREEN_COMPOSITION,
  SAGA_BLOCKS,
  SAGA_COMPOSITION,
} from "../src/workflows/blocks/sagaBlocks";
import { createLegRegistry, legPortFromRegistry } from "../src/workflows/legRegistry";
import {
  sagaLegInstanceId,
  type SagaLegBinding,
} from "../src/workflows/sagaLegPort";
import type { WorkflowBindingLike } from "../src/workflows/cfWorkflowAdapter";
import {
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaDeps,
  type SagaParams,
  type SagaStep,
} from "../src/workflows/sagaWorkflowFlow";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneyWithdrawResult,
} from "../src/workflows/sagaJourneyGate";

const resolves = (code: string) => resolveOutcome(code).resolved;

describe("saga composer blocks #2991", () => {
  it("the saga composition resolves against its registered blocks", () => {
    expect(() =>
      validateComposition(SAGA_COMPOSITION, SAGA_BLOCKS, {
        outcomeCodeResolves: resolves,
      }),
    ).not.toThrow();
  });

  it("every saga composition terminal resolves in the outcome catalog", () => {
    for (const code of Object.values(SAGA_COMPOSITION.terminals)) {
      expect(resolveOutcome(code).resolved).toBe(true);
    }
    expect(Object.keys(SAGA_COMPOSITION.terminals).length).toBeGreaterThanOrEqual(15);
  });

  it("the saga composition covers all four capabilities: legs, gate, compensation, notice", () => {
    const kinds = new Map(SAGA_BLOCKS.map((b) => [b.id, b.kind]));
    const refKinds = SAGA_COMPOSITION.refs.map((r) => kinds.get(r.blockId));
    expect(refKinds).toContain("leg");
    expect(refKinds).toContain("gate");
    expect(refKinds).toContain("compensation");
    expect(refKinds).toContain("notice");
    expect(refKinds).toContain("disclosure");
  });

  it("a goal screen composes stock-leg + options-leg; a broker screen is one leg Block", () => {
    expect(() =>
      validateComposition(GOAL_SCREEN_COMPOSITION, SAGA_BLOCKS, {
        outcomeCodeResolves: resolves,
      }),
    ).not.toThrow();
    expect(GOAL_SCREEN_COMPOSITION.refs.map((r) => r.blockId)).toEqual([
      "stock-leg",
      "options-leg",
    ]);
    expect(() =>
      validateComposition(BROKER_SINGLE_ASSET_COMPOSITION, SAGA_BLOCKS, {
        outcomeCodeResolves: resolves,
      }),
    ).not.toThrow();
    expect(BROKER_SINGLE_ASSET_COMPOSITION.refs).toHaveLength(1);
    expect(BROKER_SINGLE_ASSET_COMPOSITION.refs[0].blockId).toBe("stock-leg");
  });

  it("the flow runs end-to-end on the registry-built leg port (composer delegates)", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const notices: unknown[] = [];
    const clock = { ms: 0 };
    const paymentBinding: WorkflowBindingLike = {
      async create(options: { id: string; params: unknown }) {
        return { id: options.id } as never;
      },
      async get() {
        return {
          status: async () => ({
            status: "complete",
            output: {
              status: "started",
              runRequestId: "run-1",
              paidVia: "stripe_checkout",
              screenerWorkflowId: "scr-wf-1",
              priceUSD: 0.1,
            },
          }),
        } as never;
      },
    };
    const screenBinding: WorkflowBindingLike = {
      async create(options: { id: string; params: unknown }) {
        return { id: options.id } as never;
      },
      async get() {
        return {
          status: async () => ({
            status: "complete",
            output: { lifecycle: "Completed" },
          }),
        } as never;
      },
    };
    let tradeStarted = false;
    const tradeBinding: WorkflowBindingLike = {
      async create(options: { id: string; params: unknown }) {
        tradeStarted = true;
        return { id: options.id } as never;
      },
      async get() {
        if (!tradeStarted) throw new Error("no such instance");
        return {
          status: async () => ({
            status: "complete",
            output: { status: "settled", decision: "approved", orderId: "order-1" },
          }),
        } as never;
      },
    };
    const registry = createLegRegistry([
      {
        id: "payment",
        bindingName: "PAYMENT_WORKFLOW",
        parameterSchema: ["runRequestId"],
        stageContract: { observeStages: ["start", "poll"] },
        terminalSemantics: { complete: "SUCCESS" },
        deriveInstanceId: (sagaId: string) => sagaLegInstanceId(sagaId, "payment"),
        deriveFallbackId: (sagaId: string) =>
          sagaLegInstanceId(`${sagaId}:fallback`, "payment"),
      },
      {
        id: "screener",
        bindingName: "SCREENER_WORKFLOW",
        parameterSchema: [],
        stageContract: { observeStages: ["poll"] },
        terminalSemantics: { complete: "SUCCESS" },
        deriveInstanceId: (sagaId: string) => sagaLegInstanceId(sagaId, "screener"),
        deriveFallbackId: (sagaId: string) =>
          sagaLegInstanceId(`${sagaId}:fallback`, "screener"),
      },
      {
        id: "trade",
        bindingName: "TRADE_WORKFLOW",
        parameterSchema: ["tradeIntent"],
        stageContract: { observeStages: ["propose", "poll"] },
        terminalSemantics: { complete: "SUCCESS" },
        deriveInstanceId: (sagaId: string) => sagaLegInstanceId(sagaId, "trade"),
        deriveFallbackId: (sagaId: string) =>
          sagaLegInstanceId(`${sagaId}:fallback`, "trade"),
      },
    ]);
    const legPort = legPortFromRegistry(
      registry,
      {
        PAYMENT_WORKFLOW: paymentBinding,
        SCREENER_WORKFLOW: screenBinding,
        TRADE_WORKFLOW: tradeBinding,
      } as Partial<Record<SagaLegBinding, WorkflowBindingLike | undefined>>,
      "saga-1",
    );
    const step: SagaStep = {
      async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
      async sleep(_name: string, ms: number): Promise<void> {
        clock.ms += ms;
      },
      async waitForEvent(): Promise<{ payload: unknown }> {
        return {
          payload: {
            sagaId: "saga-1",
            decision: "approved",
            deciderLogin: "u1login",
            surface: "panel",
          },
        };
      },
    };
    const deps: SagaDeps = {
      legPort,
      recordAudit: async (event: SagaAuditEvent) => {
        auditEvents.push(event);
      },
      deliverPrompts: async (_prompt: JourneyGatePrompt): Promise<JourneyPromptReceipts> => ({
        slackSkipped: "test: no Slack",
      }),
      withdrawPrompts: async (): Promise<JourneyWithdrawResult> => ({
        slack: "skipped",
        panel: "state-driven",
        chat: "state-driven",
      }),
      issueCredit: async () => {},
      getRefundPorts: async () => {
        throw new Error("unused");
      },
      monetizationEnabled: async () => true,
      proposeTrade: async () => ({ ok: true, orderId: "order-1" }),
      deliverNotice: async (notice: unknown) => {
        notices.push(notice);
        return { slack: "posted" };
      },
      nowMs: () => clock.ms,
    };
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
      tradeIntent: {
        kind: "stock",
        symbol: "AAPL",
        action: "buy",
        quantity: 10,
        orderType: "market",
      },
      pollIntervalMs: 1000,
      paymentPollDeadlineMs: 60000,
      screenPollDeadlineMs: 60000,
      tradePollDeadlineMs: 60000,
    };
    const outcome = await runSagaWorkflowFlow(params, deps, step);
    expect(outcome.status).toBe("trade_settled");
    expect(outcome.code).toBe("SUCCESS_SAGA_TRADE_SETTLED");
    const types = auditEvents.map((e) => e.type);
    expect(types).toContain("saga.started");
    expect(types).toContain("saga.journey_prompted");
    expect(types).toContain("saga.journey_decided");
    expect(types).toContain("saga.journey_prompts_withdrawn");
    expect(types).toContain("saga.ended");
    expect(notices).toHaveLength(1);
  });
});
