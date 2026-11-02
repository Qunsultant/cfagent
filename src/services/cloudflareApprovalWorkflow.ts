/**
 * Issue #1780 (Adapter S6, program #1717) — the Cloudflare
 * implementation of the ApprovalWorkflow port
 * (`approvalWorkflowPorts.ts`).
 *
 * This is the ONLY module that invokes the workflow doors for
 * trade approval. Application code (TradingAgent) imports the
 * port and this factory, never the doors directly.
 *
 * Why the doors, not a raw workflow binding: the SDK doors are
 * the Cloudflare Workflows transport for an agent-originated run.
 * Starting through them stamps the originating agent instance
 * onto the run's params, generates the workflow id, tracks the
 * run, and retries event delivery; a raw `binding.create` /
 * `binding.get(id).sendEvent` start would silently drop that
 * agent origin, tracking, and retry behaviour — a semantic
 * change this slice refuses to make. So the adapter centralises
 * the exact pre-S6 calls, verbatim: same binding name, same
 * params, same event type and payload, no options argument (so
 * id generation stays the SDK's), no reordering, no retry or
 * defaulting added on top of the doors' own behaviour.
 *
 * The adapter is stateless and resolves the host's doors at
 * call time (never captured at construction): a host whose
 * doors are stubbed after construction — the existing approval
 * tests' idiom — still flows through the port unchanged.
 */

import type {
  ApprovalWorkflow,
  ApprovalWorkflowDecision,
  ApprovalWorkflowHost,
  ApprovalWorkflowStartParams,
} from "./approvalWorkflowPorts";

export type { ApprovalWorkflowHost } from "./approvalWorkflowPorts";

/** The event type a waiting trade approval run waits on. */
export const TRADE_APPROVAL_EVENT_TYPE = "approval" as const;

function requireRunWorkflow(
  host: ApprovalWorkflowHost | undefined | null,
): ApprovalWorkflowHost["runWorkflow"] {
  if (!host || typeof host.runWorkflow !== "function") {
    throw new Error(
      "ApprovalWorkflow: workflow host does not support runWorkflow; refusing to start a trade approval.",
    );
  }
  return host.runWorkflow;
}

function requireSendWorkflowEvent(
  host: ApprovalWorkflowHost | undefined | null,
): ApprovalWorkflowHost["sendWorkflowEvent"] {
  if (!host || typeof host.sendWorkflowEvent !== "function") {
    throw new Error(
      "ApprovalWorkflow: workflow host does not support sendWorkflowEvent; refusing to deliver a trade approval decision.",
    );
  }
  return host.sendWorkflowEvent;
}

/** Provider adapter: the approval-workflow port over the host doors. */
export class CloudflareApprovalWorkflow implements ApprovalWorkflow {
  constructor(
    private readonly host: ApprovalWorkflowHost,
    private readonly bindingName: string,
  ) {
    if (!bindingName || typeof bindingName !== "string") {
      throw new Error("ApprovalWorkflow: a workflow binding name is required.");
    }
  }

  async start(params: ApprovalWorkflowStartParams): Promise<string> {
    const runWorkflow = requireRunWorkflow(this.host);
    return runWorkflow(this.bindingName, params);
  }

  async decide(workflowId: string, decision: ApprovalWorkflowDecision): Promise<void> {
    const sendWorkflowEvent = requireSendWorkflowEvent(this.host);
    await sendWorkflowEvent(this.bindingName, workflowId, {
      type: TRADE_APPROVAL_EVENT_TYPE,
      payload: {
        decision: decision.decision,
        authorizerDid: decision.authorizerDid,
        reason: decision.reason,
        expectedTerms: decision.expectedTerms,
      },
    });
  }
}

/**
 * Build the Cloudflare ApprovalWorkflow for a host and binding
 * name. TradingAgent calls this with itself as the host and
 * `TRADE_WORKFLOW_BINDING` as the binding, so the run keeps its
 * existing agent origin (the instance name the S5 gateway
 * addressed) and its existing binding.
 */
export function createApprovalWorkflow(
  host: ApprovalWorkflowHost,
  bindingName: string,
): ApprovalWorkflow {
  return new CloudflareApprovalWorkflow(host, bindingName);
}
