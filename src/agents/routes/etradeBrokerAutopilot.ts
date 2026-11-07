/**
 * Autopilot execution-verdict gate, extracted from
 * src/agents/routes/etradeBroker.ts (#3515 S3 batch 3).
 *
 * Why a separate module: the #359 50,000 B dispatcher ceiling. The
 * console migration added the module logger to etradeBroker.ts and
 * pushed the dispatcher to 50,533 B (pinned by
 * tests/etrade_broker_portfolio_risk_split_2943.test.ts) — further
 * growth goes in a helper module, per the #359 pattern. This block is
 * the extraction: it holds no route condition and constructs no
 * ETradeService, so the #2943 pins (route conditions stay in the
 * dispatcher, 21 ETradeService construction sites in the dispatcher) and
 * the thin-router inventory (route conditions per handler function)
 * are all untouched.
 *
 * Behavior is unchanged: same evaluation call, same 409 when the
 * policy blocks execution, same 503 when the evaluation fails while
 * autopilot is running, same structured event name
 * (`etradeBroker.autopilot_policy_evaluation_failed`) and audit row
 * (`autopilot.policy_check_failed`). A failed evaluation with
 * autopilot stopped still falls through with a null verdict, exactly
 * as the inline block did.
 */
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import type { OrderIntent, PolicyVerdict } from "../../services/riskPolicyEngine";
import type { EtradeBrokerRouteContext } from "./etradeBroker";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/etradeBrokerAutopilot",
});

export interface AutopilotExecutionVerdictInput {
  ctx: EtradeBrokerRouteContext;
  userLogin: string;
  requestedEnv: unknown;
  sessionId: string;
  orderId: string;
  intent: OrderIntent;
}

export interface AutopilotExecutionVerdict {
  /** The policy verdict, or null when the evaluation failed. */
  verdict: PolicyVerdict | null;
  /** A refusal response (409 blocked / 503 evaluation failed), or null to proceed. */
  response: Response | null;
}

/**
 * Autopilot policy envelope gate (autopilot Phase 1). Re-evaluated at
 * execution time because orders/day, drawdown, and exposure may have
 * moved since the draft was previewed.
 */
export async function evaluateAutopilotExecutionVerdict(
  input: AutopilotExecutionVerdictInput,
): Promise<AutopilotExecutionVerdict> {
  const { ctx, userLogin, requestedEnv, sessionId, orderId, intent } = input;
  let verdict: PolicyVerdict | null = null;
  try {
    const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
      userLogin,
      requestedEnv,
      sessionId,
      draftId: orderId,
      intent,
    });
    verdict = evaluated.verdict;
    if (!evaluated.verdict.executionAllowed) {
      return {
        verdict,
        response: Response.json(
          {
            error: `Autopilot policy blocked execution: ${evaluated.verdict.detail}`,
            bindingRule: evaluated.verdict.bindingRule,
            policyVerdict: evaluated.verdict,
          },
          { status: 409 },
        ),
      };
    }
  } catch (policyErr) {
    structuredLog.warn("etradeBroker.autopilot_policy_evaluation_failed", {
      message: "[OrchestratorAgent] Autopilot policy evaluation failed at execute:",
      stage: "execute",
      orderId,
      error: policyErr instanceof Error ? policyErr.message : String(policyErr),
    });
    ctx.audit("autopilot.policy_check_failed", "trading", {
      stage: "execute",
      orderId,
      error: policyErr instanceof Error ? policyErr.message : String(policyErr),
    });
    if (ctx.getAutopilotState().running) {
      return {
        verdict,
        response: Response.json(
          { error: "Autopilot policy check could not be completed; refusing to execute while autopilot is running." },
          { status: 503 },
        ),
      };
    }
  }
  return { verdict, response: null };
}
