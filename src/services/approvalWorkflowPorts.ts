/**
 * Issue #1780 (Adapter S6, program #1717) — the one ApprovalWorkflow
 * port (start/decide).
 *
 * Before S6, TradingAgent called the agents-SDK workflow doors
 * directly for its two trade-approval operations. After S6 both
 * operations go through this interface, and the Cloudflare
 * implementation in `cloudflareApprovalWorkflow.ts` is the ONLY
 * module that invokes those doors for trade approval.
 *
 * This file carries types + the interface ONLY — no provider
 * access, no SDK import, no binding type. The params are ids and
 * references only (order id, owner login, traceparent carrier),
 * never credentials — the same discipline as TradeApprovalParams.
 *
 * Instance naming (S5 consistency): this port introduces NO
 * naming scheme. A start originates from the TradingAgent
 * instance the S5 gateway / mesh door already addressed with
 * `tradingAgentName` (`trading:<login>`, bare `trading` for the
 * configured service identity), and the SDK stamps that instance
 * name onto the run. Workflow ids stay SDK-generated (no
 * caller-supplied id is ever passed), so a retried start is a
 * new run exactly as before — this slice changes addressing /
 * transport behind the port, NOT approval semantics, and NOT
 * instance or workflow-id derivation.
 *
 * No config switch is needed for this slice, on the S5 precedent:
 * no behavior variant is introduced, only the access path moves,
 * and there is exactly one adapter (Cloudflare). Scoped adapter
 * selection therefore resolves to the built-in default; no caller
 * — and no route — can configure away an enforcement through
 * this port. The HITL gate itself (input validation, the
 * binding-presence guard, owner-login fail-closed, and the
 * blocking decision audit) still runs in TradingAgent BEFORE
 * either port call, exactly as before.
 */

/** Params for starting a trade approval run (ids + references only). */
export interface ApprovalWorkflowStartParams {
  orderId: string;
  provider?: string;
  userLogin: string;
  /** W3C traceparent carrier (#2730), server-side only, never minted here. */
  traceparent?: string;
}

/** A decision delivered to a waiting trade approval run. */
export interface ApprovalWorkflowDecision {
  decision: "approved" | "rejected";
  authorizerDid: string;
  reason?: string;
  /**
   * The approval's frozen proposal terms (#1393 invariant 5), when
   * present. Carried verbatim into the event payload; the settle
   * core, not this port, enforces them.
   */
  expectedTerms?: unknown;
}

/**
 * The host surface the Cloudflare adapter needs: the two workflow
 * doors, in the same structural shape as the existing
 * `PaymentWorkflowHost` seam. The host is resolved by the caller
 * (TradingAgent passes itself); the adapter invokes the doors at
 * call time, so instance-level stubs keep working unchanged.
 */
export interface ApprovalWorkflowHost {
  runWorkflow(binding: string, params: unknown): Promise<string>;
  sendWorkflowEvent(
    binding: string,
    workflowId: string,
    event: { type: string; payload: unknown },
  ): Promise<void>;
}

/**
 * The one approval-workflow port: start a durable approval run,
 * or deliver a decision to a waiting run. Both operations are
 * transport only — neither mints, validates, nor alters a
 * decision; validation and audit stay with the caller.
 */
export interface ApprovalWorkflow {
  /** Start a run; returns the workflow id. */
  start(params: ApprovalWorkflowStartParams): Promise<string>;
  /** Deliver a decision event to a waiting run. */
  decide(workflowId: string, decision: ApprovalWorkflowDecision): Promise<void>;
}
