/**
 * TradingTradeWorkflow — the durable approval wrapper for TradingAgent
 * order proposals (issue #291, slice T3b).
 *
 * The cfpay TradeWorkflow shape, verbatim in spirit:
 *   proposal (a previewed draft, by id) -> wait for an approval event
 *   (24h) -> verify the approver (the settle core refuses anonymous
 *   decisions) -> claim-then-execute through the platform's
 *   executeOrder, which re-validates the draft state.
 *
 * Params carry ids only — never credentials (cfpay rule). The workflow
 * holds no broker state of its own; settling delegates to the order
 * owner's TradingAgent approval door (executeApprovedOrder), which
 * settles through settleTradingOrder — the same core the synchronous
 * approval door uses — inside the Durable Object that holds the draft
 * store the proposal was previewed into (#2375: before this, the
 * settle ran workflow-side ORM-less and could not see any real
 * draft), so both paths enforce identical validation.
 *
 * The class is a thin adapter: run() extracts the params and delegates
 * to runTradeApprovalFlow, which is unit-testable with a fake step.
 */

import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import {
  tradingAgentName,
  type TradeApprovalDecision,
  type TradeApprovalParams,
} from "./trading-agent";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { recordWorkflowTraceHop } from "../observability/meshTrace";
import { meshTraceStoreForEnv } from "../data/createMeshTracePorts";

/** How long a proposal waits for its decision before lapsing. */
export const TRADE_APPROVAL_TIMEOUT = "24 hours";

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface TradeApprovalStep {
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<{ payload: TradeApprovalDecision }>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type TradeApprovalOutcome =
  | { status: "settled"; orderId: string; decision: "approved" | "rejected"; result: unknown }
  | { status: "expired"; orderId: string };

/**
 * Settle through the order owner's TradingAgent approval door
 * (#2375). The door method is the synchronous settle
 * (executeApprovedOrder) — the workflow supplies the decision, the
 * agent supplies its own draft store. Fails closed when the DO
 * binding is not configured: there is no workflow-side fallback,
 * because a fallback would settle against a store that does not
 * hold the draft.
 */
async function settleThroughApprovalDoor(
  env: Env,
  params: TradeApprovalParams,
  decision: TradeApprovalDecision,
): Promise<unknown> {
  const ns = env.TRADING_AGENT;
  if (!ns) {
    throw new Error(
      "Trade approval workflow cannot settle: the TRADING_AGENT binding is not configured, so the approval door that holds the draft store is unreachable.",
    );
  }
  const stub = ns.get(
    ns.idFromName(tradingAgentName(params.userLogin, getServiceUserLogin(env))),
  ) as unknown as {
    executeApprovedOrder(input: {
      provider?: string;
      userLogin: string;
      orderId: string;
      authorizerDid: string;
      decision: "approved" | "rejected";
      expectedTerms?: TradeApprovalDecision["expectedTerms"];
    }): Promise<unknown>;
  };
  return stub.executeApprovedOrder({
    provider: params.provider,
    userLogin: params.userLogin,
    orderId: params.orderId,
    authorizerDid: decision.authorizerDid,
    decision: decision.decision,
    expectedTerms: decision.expectedTerms,
  });
}

/**
 * Issue #2730 (tracker #2708 A5): record one step hop for this
 * trade run, from the params' traceparent into the env-resolved
 * hop store — the S17 mechanism the screener workflow wires in
 * its buildDeps (recordWorkflowTraceHop over
 * meshTraceStoreForEnv). Called AFTER a step's journaled result
 * returns, never inside a step callback, so durable replay
 * re-records the identical deterministic span and the store
 * converges. Params without a traceparent record nothing (the
 * helper's contract — never minted mid-flight); a store failure
 * is swallowed here: tracing degrades, the trade does not (the
 * #1743 rule). Trace carriage is data — it never branches the
 * flow, gates the settle, or alters a step input.
 */
async function traceTradeStep(
  env: Env,
  params: TradeApprovalParams,
  operation: string,
  note?: string,
): Promise<void> {
  try {
    await recordWorkflowTraceHop(
      meshTraceStoreForEnv(env),
      {
        traceparent: params.traceparent,
        jobId: params.orderId,
        userLogin: params.userLogin,
        agent: "TradingTradeWorkflow",
      },
      { kind: "workflow-step", operation, ...(note ? { note } : {}) },
    );
  } catch {
    // Best-effort by design (the #1743 degradation rule).
  }
}

/**
 * The flow: wait for the decision event, then settle exactly once
 * inside a durable step. Any failure to obtain a decision (timeout,
 * termination) ends the flow as expired and settles NOTHING — a trade
 * is placed only from an explicit, authorized decision event.
 */
export async function runTradeApprovalFlow(
  env: Env,
  params: TradeApprovalParams,
  step: TradeApprovalStep,
): Promise<TradeApprovalOutcome> {
  let decision: TradeApprovalDecision;
  try {
    const event = await step.waitForEvent("await-approval", {
      type: "approval",
      timeout: TRADE_APPROVAL_TIMEOUT,
    });
    decision = event.payload;
  } catch {
    // The wait completed with no decision: the hop records the
    // elapsed wait under the carried trace, noted as expired.
    await traceTradeStep(env, params, "await-approval", "expired");
    return { status: "expired", orderId: params.orderId };
  }
  await traceTradeStep(env, params, "await-approval");
  const result = await step.do("settle-trade", () =>
    settleThroughApprovalDoor(env, params, decision),
  );
  await traceTradeStep(env, params, "settle-trade");
  return { status: "settled", orderId: params.orderId, decision: decision.decision, result };
}

export class TradingTradeWorkflow extends ThinkWorkflow<
  // Issue #1738: TradingAgent is an Agents SDK actor now, not a
  // Think class, so it cannot satisfy ThinkWorkflow's agent-type
  // constraint. ADR 0004 W13 already prescribes `any` here (the
  // screener workflow does the same). Since #2375 the workflow
  // settles through the agent's approval door over the DO binding
  // (not an agent-class method call), so the `any` stands.
  any,
  TradeApprovalParams,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<TradeApprovalParams>,
    step: WorkflowStep,
  ): Promise<TradeApprovalOutcome> {
    // Issue #1185: the workflow acts under the order owner's login,
    // recorded in the payload at start — absent means the run fails
    // closed rather than settling under a synthetic identity.
    if (!event.payload.userLogin) {
      throw new Error("Trade approval workflow payload is missing the required userLogin (issue #1185: no default identity).");
    }
    const params: TradeApprovalParams = {
      orderId: event.payload.orderId,
      provider: event.payload.provider,
      userLogin: event.payload.userLogin,
      // Issue #2730: the run's traceparent rides the payload
      // into the flow, whose step hops record under it.
      ...(event.payload.traceparent
        ? { traceparent: event.payload.traceparent }
        : {}),
    };
    return runTradeApprovalFlow(this.env, params, step as unknown as TradeApprovalStep);
  }
}
