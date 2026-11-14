/**
 * Payment workflow submission — the OrchestratorAgent caller seam
 * (Goal 1 Phase 2, #2014, operational wiring).
 *
 * Mirrors src/services/goalScreenWorkflowSubmission.ts, but for money:
 * the caller (a screener route or the schedule service) already built
 * the screener command; this seam only wraps it in a payment workflow
 * start. It does NOT start a screener, does NOT extend
 * OrchestratorAgent, and does NOT fall back to a free direct screen
 * when payment cannot start.
 *
 * Caller relationship (corrected 2026-10-27):
 *   OrchestratorAgent (caller) → PaymentWorkflow (ThinkWorkflow)
 *   → ScreenerScreenWorkflow (via the screener workflow port)
 * PaymentsAgent is NOT created here — it already exists (PortThink,
 * #1957) and its budgetCheck/processPaidRequest surface is used by
 * the orchestrator/scheduler before creating work, not by this seam.
 *
 * Two start paths, both documented in the repo:
 *   - Binding path (screener-style): env.PAYMENT_WORKFLOW.create()
 *     with { id, params }. The instance id is the runRequestId, so
 *     a retried start adopts the same instance instead of charging
 *     twice — the gate is idempotent on runRequestId regardless.
 *   - Host-agent path (trade-style, cfpay.md): a host agent with
 *     runWorkflow(binding, params) starts it, and decisions are
 *     delivered via sendWorkflowEvent(binding, workflowId, event).
 *     The host interface below is structural; the wiring step must
 *     confirm its exact signature against @cloudflare/think 0.19.0
 *     before a host-agent caller is used in production. Until then,
 *     the binding path is the primary path.
 *
 * Approval / verified-payment delivery:
 *   - Approval: host.sendWorkflowEvent(PAYMENT_WORKFLOW, workflowId,
 *     { type: "approval", payload: { approved, approverId } }).
 *     The #1262 shared approval engine is the production source of
 *     that decision (signed link / principal re-check); this seam
 *     only carries the decision, it does not mint approvals.
 *   - Verified payment: the same channel with type
 *     "payment_verified" and payload { claimTxHash?, paymentIntentId? }.
 *     The workflow still re-reads checkout.status before capture —
 *     an event alone is never proof.
 *
 * Fail-closed rules for callers:
 *   - No PAYMENT_WORKFLOW binding/host and monetization ON → throw.
 *     The caller must NOT start the screener for free in that case.
 *   - Monetization OFF → the caller does not use this seam at all;
 *     it proceeds on the existing free path (Phase 2 design).
 *   - "Monetization ON/OFF" is the Flagship feature flag
 *     "monetization" (#2043, via createFeatureFlagPort), not a raw
 *     env var: the adopting route must evaluate that flag and
 *     only use this seam when it is ON; the workflow re-evaluates
 *     the same flag itself before any checkout.
 *   - A payment workflow that returns payment_required,
 *     coverage_required, approval_rejected, or expired → the caller
 *     must NOT start the screener. Only "started" starts it, and
 *     the workflow itself already started it via the port.
 */

import type { CommercialAccount } from "../services/cfpayMonetization";
import type { PaymentWorkflowEventParams } from "../workflows/paymentWorkflow";
import { startManagedWorkflowInstance } from "../workflows/workflowInstanceSeam";
import type { WorkflowJobCommand } from "../workflows/workflowPorts";

export const PAYMENT_WORKFLOW_BINDING = "PAYMENT_WORKFLOW" as const;

export interface PaymentWorkflowSubmissionInput {
  runRequestId: string;
  family: "stock" | "goal" | "options" | "strategy";
  trigger: "manual" | "scheduled";
  scheduleKind?: "one_off" | "recurring";
  authorizedAtSubmission?: boolean;
  tenantId: string;
  userId: string;
  email: string;
  /** Caller-verified account (pay-per-use identity until #2015 store). */
  account: CommercialAccount;
  /** Caller-built screener command (ids + references only). */
  screenerCommand: WorkflowJobCommand;
}

export function buildPaymentWorkflowParams(
  input: PaymentWorkflowSubmissionInput,
): PaymentWorkflowEventParams {
  // Issue #2373 (S1b, gate-before-email): identity is the
  // verified userId + tenantId; the email is the CHECKOUT
  // contact, enforced by the gate only when a checkout is
  // minted. A covered run has no checkout, so it submits with
  // an empty email and the gate covers it without one; an
  // uncovered run fails at the mint, never with an invented
  // contact. No default identity is ever substituted here.
  if (!input.userId || !input.tenantId) {
    throw new Error("Payment workflow submission requires verified userId and tenantId.");
  }
  if (!input.screenerCommand || typeof input.screenerCommand.jobId !== "string") {
    throw new Error("Payment workflow submission requires a screenerCommand with a jobId.");
  }
  if (input.account.tenantId && input.tenantId !== input.account.tenantId) {
    throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
  }
  return {
    runRequestId: input.runRequestId,
    family: input.family,
    trigger: input.trigger,
    scheduleKind: input.scheduleKind,
    authorizedAtSubmission: input.authorizedAtSubmission,
    tenantId: input.tenantId,
    userId: input.userId,
    email: input.email,
    account: input.account,
    screenerCommand: input.screenerCommand,
    // Issue #2762: the payment run joins the trace its screener
    // command already carries (#1743's field, stamped by the
    // command's producer) — carried into the workflow params so
    // PaymentWorkflow's steps record under the same trace.
    // Absent on the command → absent here; never minted at this
    // seam, never a caller input.
    ...(input.screenerCommand.traceparent
      ? { traceparent: input.screenerCommand.traceparent }
      : {}),
  };
}

export interface PaymentWorkflowBinding {
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{
    sendEvent?: (event: { type: string; payload: unknown }) => Promise<void>;
    status?: () => Promise<{ status: string; output?: unknown; error?: { message: string } }>;
  }>;
}

export interface PaymentWorkflowHost {
  runWorkflow(binding: string, params: unknown): Promise<{ id: string }>;
  sendWorkflowEvent(binding: string, workflowId: string, event: { type: string; payload: unknown }): Promise<void>;
}

/** Binding path: create the payment workflow instance via the ONE seam. Throws if unbound. */
export async function startPaymentWorkflowViaBinding(
  binding: PaymentWorkflowBinding | undefined,
  params: PaymentWorkflowEventParams,
): Promise<{ workflowId: string }> {
  if (!binding || typeof binding.create !== "function") {
    throw new Error(
      "Payment workflow binding PAYMENT_WORKFLOW is not configured; refusing to start a screener for free while monetization is on.",
    );
  }
  // Issue #2409 (G6): create-or-adopt via the ONE seam
  // (workflowInstanceSeam, no fallback — the run-request id IS
  // the instance id, so there is no second id to fall back to).
  // The Workflows binding errors when the instance id is already
  // taken, so a retried submission whose first create actually
  // landed (e.g. the caller timed out waiting) would fail here
  // instead of adopting the run it already started — and a caller
  // that then re-submitted under a NEW run-request id would
  // double-charge, against this seam's own contract (header: one
  // run per run-request; a retried start adopts the same
  // instance). A get whose status() resolves proves the instance
  // exists; adopt it. Any other failure rethrows the original
  // create error — a genuine provider outage must stay loud,
  // never be masked as an adoption.
  const started = await startManagedWorkflowInstance(binding, {
    id: params.runRequestId,
    params,
  });
  return { workflowId: started.workflowId };
}

/** Host-agent path: start via an agent's runWorkflow. Throws if host lacks it. */
export async function startPaymentWorkflowViaHost(
  host: PaymentWorkflowHost | undefined,
  params: PaymentWorkflowEventParams,
): Promise<{ workflowId: string }> {
  if (!host || typeof host.runWorkflow !== "function") {
    throw new Error("Payment workflow host does not support runWorkflow; refusing to start a screener for free.");
  }
  const instance = await host.runWorkflow(PAYMENT_WORKFLOW_BINDING, params);
  return { workflowId: instance.id };
}

/** Deliver a human approval decision to a running payment workflow. */
export async function deliverPaymentApprovalViaHost(
  host: PaymentWorkflowHost | undefined,
  workflowId: string,
  decision: { approved: boolean; approverId?: string },
): Promise<void> {
  if (!host || typeof host.sendWorkflowEvent !== "function") {
    throw new Error("Payment workflow host does not support sendWorkflowEvent; approval cannot be delivered.");
  }
  await host.sendWorkflowEvent(PAYMENT_WORKFLOW_BINDING, workflowId, {
    type: "approval",
    payload: decision,
  });
}

/**
 * Deliver a verified-payment wake-up (not proof) to a running workflow.
 * The proof carries the provider join keys the flow forwards to the
 * gate's confirmPaid (PaymentVerifiedEvent): the Stripe session id for
 * card and the x402 payment proof (+ claimed payer) for crypto, in
 * addition to the legacy cfpay claimTxHash/paymentIntentId. The wake-up
 * itself proves nothing — confirmPaid re-reads provider state.
 */
export async function deliverPaymentVerifiedViaHost(
  host: PaymentWorkflowHost | undefined,
  workflowId: string,
  proof: { claimTxHash?: string; paymentIntentId?: string; sessionId?: string; paymentProof?: string; payer?: string },
): Promise<void> {
  if (!host || typeof host.sendWorkflowEvent !== "function") {
    throw new Error("Payment workflow host does not support sendWorkflowEvent; verified-payment event cannot be delivered.");
  }
  await host.sendWorkflowEvent(PAYMENT_WORKFLOW_BINDING, workflowId, {
    type: "payment_verified",
    payload: proof,
  });
}
