/**
 * Issue #2041 S4 — trading leg (Leg 3).
 *
 * After journey approval the saga proposes via the existing
 * preview surfaces (trade_stock / trade_options propose
 * preview-only drafts) and starts a TradingTradeWorkflow child
 * through the leg port. The saga NEVER places an order itself
 * and NEVER settles: the existing per-order HITL approval engine
 * (decideTradeApproval by the leg-port workflowId, settlement
 * through executeApprovedOrder) remains the only execution path.
 *
 * Trade outcomes pass through as saga outcomes: the child's
 * terminal output decides the saga outcome code, never an inline
 * string. Execution failure gets NO compensation (design §3.3);
 * a refused proposal ends the saga without starting a child.
 *
 * Adopt-precheck: before proposing, the leg reads the derived
 * trade leg id (sagaLegInstanceId). An existing running child is
 * adopted (polled, no new proposal); an existing complete child
 * passes its output through (no new proposal). step.do
 * durability already covers in-execution retries; the pre-check
 * covers fresh re-runs under the same sagaId. The entry route
 * is the single creation path (create-or-adopt under one
 * instance id), so same-sagaId concurrent direct starts are a
 * caller error outside this leg's guarantee.
 *
 * Q10 stays OUT of S4: this module has no refund dependency and
 * never consults refund ports; refund execution remains
 * operator-only.
 */
import {
  sagaLegInstanceId,
  type SagaLegInstanceStatus,
  type SagaLegPort,
} from "./sagaLegPort";
import type {
  SagaAuditEvent,
  SagaWorkflowStep,
} from "./sagaWorkflowFlow";
import type { JourneySurface } from "./sagaJourneyGate";
import { pollLegToTerminal, type LegTerminal } from "./sagaWorkflowFlow";

/** Working default (Q2-open): trade poll deadline mirrors the payment leg's 24h + margin. */
export const SAGA_TRADE_POLL_DEADLINE_MS_DEFAULT = 25 * 60 * 60 * 1000;

/** Trade intent, caller-supplied like screenerCommand. The saga never invents what to trade. */
export interface SagaTradeIntent {
  kind: "stock" | "options";
  symbol: string;
  action: "buy" | "sell";
  quantity: number;
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  optionLegs?: Array<Record<string, unknown>>;
  strategyNetDebit?: number;
  provider?: string;
}

/**
 * proposeTrade result: ok/err, NOT throw, for service refusals
 * (provider unsupported, bad intent, disabled service). A
 * missing TRADING_AGENT binding THROWS (config failure: the step
 * retries after the operator fixes the binding — a paid saga
 * must not terminal-fail on configuration).
 */
export type ProposeTradeResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: string };

export interface SagaTradeDeps {
  legPort: SagaLegPort;
  recordAudit: (event: SagaAuditEvent) => Promise<void>;
  proposeTrade: (intent: SagaTradeIntent) => Promise<ProposeTradeResult>;
  nowMs: () => number;
}

/** Trade-leg outcomes: the trade members of SagaWorkflowOutcome. */
export type SagaTradeOutcome =
  | {
      status: "trade_settled";
      code: "SUCCESS_SAGA_TRADE_SETTLED";
      orderId: string;
      tradeWorkflowId: string;
      sagaId: string;
      runRequestId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
      screenerWorkflowId?: string;
    }
  | {
      status: "trade_rejected";
      code: "FAILURE_SAGA_TRADE_REJECTED";
      orderId: string;
      tradeWorkflowId: string;
      sagaId: string;
      runRequestId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
      screenerWorkflowId?: string;
    }
  | {
      status: "trade_expired";
      code: "FAILURE_SAGA_TRADE_EXPIRED";
      orderId: string;
      tradeWorkflowId: string;
      sagaId: string;
      runRequestId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
      screenerWorkflowId?: string;
    }
  | {
      status: "trade_leg_failed";
      code: "FAILURE_SAGA_TRADE_LEG_FAILED";
      orderId?: string;
      tradeWorkflowId?: string;
      sagaId: string;
      runRequestId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
      screenerWorkflowId?: string;
      reason: string;
    }
  | {
      status: "proposal_failed";
      code: "FAILURE_SAGA_PROPOSAL_FAILED";
      sagaId: string;
      runRequestId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
      screenerWorkflowId?: string;
      reason: string;
    };

export type SagaTradeTerminalEvent = Omit<
  SagaAuditEvent,
  "sagaId" | "runRequestId" | "tenantId" | "userLogin" | "family" | "rail"
>;

/**
 * The flow's endSaga, passed in so the leg never ends the saga
 * itself: the terminal audit row, the outcome notice, and the
 * saga.ended row all stay in the flow's single ending path.
 */
export type SagaTradeFinish = (
  outcome: SagaTradeOutcome,
  terminalEvent: SagaTradeTerminalEvent,
) => Promise<SagaTradeOutcome>;

export interface SagaTradeLegArgs {
  sagaId: string;
  runRequestId: string;
  userLogin: string;
  tenantId: string;
  family: "goal";
  rail?: "stripe" | "x402";
  tradeIntent?: SagaTradeIntent;
  screenerWorkflowId?: string;
  decidingSurface: JourneySurface;
  tradePollDeadlineMs?: number;
  pollIntervalMs?: number;
}

type BaseAudit = Omit<
  SagaAuditEvent,
  "type" | "orderId" | "tradeWorkflowId" | "reason" | "decision"
>;

/** Terminal audit type for a trade outcome (settled vs decided vs failed). */
function tradeTerminalType(
  status: SagaTradeOutcome["status"],
): "saga.trade_settled" | "saga.trade_decided" | "saga.trade_leg_failed" {
  if (status === "trade_settled") return "saga.trade_settled";
  if (status === "trade_rejected" || status === "trade_expired") {
    return "saga.trade_decided";
  }
  return "saga.trade_leg_failed";
}

/** Map a terminal trade-child output to its saga outcome. */
function tradeOutputToOutcome(
  output: Record<string, unknown> | undefined,
  args: SagaTradeLegArgs,
  orderId: string,
  tradeWorkflowId: string,
): SagaTradeOutcome {
  const shared = {
    sagaId: args.sagaId,
    runRequestId: args.runRequestId,
    orderId,
    tradeWorkflowId,
    decidingSurface: args.decidingSurface,
    ...(args.rail ? { rail: args.rail } : {}),
    ...(args.screenerWorkflowId
      ? { screenerWorkflowId: args.screenerWorkflowId }
      : {}),
  };
  const status = typeof output?.["status"] === "string" ? output["status"] : "";
  if (status === "settled") {
    if (output?.["decision"] === "approved") {
      return { status: "trade_settled", code: "SUCCESS_SAGA_TRADE_SETTLED", ...shared };
    }
    if (output?.["decision"] === "rejected") {
      return { status: "trade_rejected", code: "FAILURE_SAGA_TRADE_REJECTED", ...shared };
    }
    return {
      status: "trade_leg_failed",
      code: "FAILURE_SAGA_TRADE_LEG_FAILED",
      ...shared,
      reason: "trade_output_unrecognized",
    };
  }
  if (status === "expired") {
    return { status: "trade_expired", code: "FAILURE_SAGA_TRADE_EXPIRED", ...shared };
  }
  return {
    status: "trade_leg_failed",
    code: "FAILURE_SAGA_TRADE_LEG_FAILED",
    ...shared,
    reason: "trade_output_unrecognized",
  };
}

export async function runTradeLeg(
  args: SagaTradeLegArgs,
  deps: SagaTradeDeps,
  step: SagaWorkflowStep,
  baseAudit: BaseAudit,
  finish: SagaTradeFinish,
): Promise<SagaTradeOutcome> {
  const shared = {
    sagaId: args.sagaId,
    runRequestId: args.runRequestId,
    decidingSurface: args.decidingSurface,
    ...(args.rail ? { rail: args.rail } : {}),
    ...(args.screenerWorkflowId
      ? { screenerWorkflowId: args.screenerWorkflowId }
      : {}),
  };

  const tradeLegId = sagaLegInstanceId(args.sagaId, "trade");
  const pre = await step.do("check-trade-leg", () =>
    deps.legPort.getLegStatus("trade", tradeLegId),
  );
  if (pre && pre.status === "complete") {
    const output = (pre.output ?? {}) as Record<string, unknown>;
    const orderId =
      typeof output["orderId"] === "string" ? output["orderId"] : "";
    const outcome = tradeOutputToOutcome(output, args, orderId, tradeLegId);
    return finish(outcome, {
      type: tradeTerminalType(outcome.status),
      orderId,
      tradeWorkflowId: tradeLegId,
      ...(outcome.status === "trade_leg_failed"
        ? { reason: outcome.reason }
        : {}),
      ...shared,
    });
  }
  if (pre && (pre.status === "errored" || pre.status === "terminated")) {
    return finish(
      {
        status: "trade_leg_failed",
        code: "FAILURE_SAGA_TRADE_LEG_FAILED",
        tradeWorkflowId: tradeLegId,
        ...shared,
        reason: `trade_leg_${pre.status}`,
      },
      {
        type: "saga.trade_leg_failed",
        tradeWorkflowId: tradeLegId,
        reason: `trade_leg_${pre.status}`,
        ...shared,
      },
    );
  }
  if (pre && pre.status === "running") {
    // Adopt: poll the existing child, no new proposal.
    return pollAdoptedTrade(args, deps, step, tradeLegId, finish);
  }

  // No existing child: propose, then start.
  if (!args.tradeIntent) {
    return finish(
      {
        status: "proposal_failed",
        code: "FAILURE_SAGA_PROPOSAL_FAILED",
        ...shared,
        reason: "trade_intent_missing",
      },
      {
        type: "saga.proposal_failed",
        reason: "trade_intent_missing",
        ...shared,
      },
    );
  }
  // A throwing proposeTrade propagates (config failure, retried
  // by the step); a returned ok:false is a service refusal.
  const proposed = await step.do("propose-trade", () =>
    deps.proposeTrade(args.tradeIntent as SagaTradeIntent),
  );
  if (!proposed.ok) {
    return finish(
      {
        status: "proposal_failed",
        code: "FAILURE_SAGA_PROPOSAL_FAILED",
        ...shared,
        reason: proposed.reason,
      },
      {
        type: "saga.proposal_failed",
        reason: proposed.reason,
        ...shared,
      },
    );
  }
  const started = await step.do("start-trade-leg", () =>
    deps.legPort.startLeg("trade", {
      orderId: proposed.orderId,
      provider: args.tradeIntent?.provider,
      userLogin: args.userLogin,
    }),
  );
  await step.do("record-audit-trade-proposed", () =>
    deps.recordAudit({
      ...baseAudit,
      type: "saga.trade_proposed",
      orderId: proposed.orderId,
      tradeWorkflowId: started.workflowId,
    }),
  );
  return pollAdoptedTrade(args, deps, step, started.workflowId, finish, proposed.orderId);
}

async function pollAdoptedTrade(
  args: SagaTradeLegArgs,
  deps: SagaTradeDeps,
  step: SagaWorkflowStep,
  tradeWorkflowId: string,
  finish: SagaTradeFinish,
  orderId?: string,
): Promise<SagaTradeOutcome> {
  const shared = {
    sagaId: args.sagaId,
    runRequestId: args.runRequestId,
    decidingSurface: args.decidingSurface,
    ...(args.rail ? { rail: args.rail } : {}),
    ...(args.screenerWorkflowId
      ? { screenerWorkflowId: args.screenerWorkflowId }
      : {}),
  };
  const terminal: LegTerminal = await pollLegToTerminal(
    deps,
    step,
    "trade",
    tradeWorkflowId,
    args.tradePollDeadlineMs ?? SAGA_TRADE_POLL_DEADLINE_MS_DEFAULT,
    args.pollIntervalMs ?? 30_000,
  );
  if (terminal.terminal === "complete") {
    const output = (terminal.output ?? {}) as Record<string, unknown>;
    const resolvedOrderId =
      orderId ??
      (typeof output["orderId"] === "string" ? output["orderId"] : "");
    const outcome = tradeOutputToOutcome(output, args, resolvedOrderId, tradeWorkflowId);
    const terminalType = tradeTerminalType(outcome.status);
    return finish(outcome, {
      type: terminalType,
      orderId: resolvedOrderId,
      tradeWorkflowId,
      ...(outcome.status === "trade_leg_failed"
        ? { reason: outcome.reason }
        : {}),
      ...shared,
    });
  }
  if (terminal.terminal === "errored" || terminal.terminal === "terminated") {
    return finish(
      {
        status: "trade_leg_failed",
        code: "FAILURE_SAGA_TRADE_LEG_FAILED",
        ...(orderId ? { orderId } : {}),
        tradeWorkflowId,
        ...shared,
        reason: `trade_leg_${terminal.terminal}`,
      },
      {
        type: "saga.trade_leg_failed",
        ...(orderId ? { orderId } : {}),
        tradeWorkflowId,
        reason: `trade_leg_${terminal.terminal}`,
        ...shared,
      },
    );
  }
  // Deadline: surfaced, never compensated.
  return finish(
    {
      status: "trade_leg_failed",
      code: "FAILURE_SAGA_TRADE_LEG_FAILED",
      ...(orderId ? { orderId } : {}),
      tradeWorkflowId,
      ...shared,
      reason: "trade_poll_deadline",
    },
    {
      type: "saga.trade_leg_failed",
      ...(orderId ? { orderId } : {}),
      tradeWorkflowId,
      reason: "trade_poll_deadline",
      ...shared,
    },
  );
}

export type { SagaLegInstanceStatus };
