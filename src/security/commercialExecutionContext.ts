/**
 * GAP-5 (#5477; CISO coordination #5350; design #5343 / ADR 0034) —
 * ExecutionContext staged wiring, advanced for the commercial path.
 *
 * The #1078 contract (`executionContext.ts`) is the ONE validated
 * context: resolved once from authoritative sources, frozen, carrying
 * the PDP decision (policyVersion), revalidated at boundaries, with
 * delegation narrowing never widening. Its live wiring is deliberately
 * staged, and this module advances exactly one stage: the commercial
 * workflow-to-handler path — the payment/saga workflows' ledger writes
 * (`recordCfpayLedgerRow`) across the Durable Object stub-fetch boundary
 * to the ledger write-through handlers in `agenticPayments.ts`.
 *
 * What this module is:
 * - A thin mapping over the unchanged contract, following the
 *   `resolveScreenExecutionContext` precedent: the PDP decision, the
 *   binding check, and the fail-closed denials are the contract's, not
 *   this module's. No second context shape is introduced, and the
 *   contract module itself is untouched.
 * - The composition the ledger gate (hardening slice 1, G-1) consumes:
 *   the caller resolves a context for the system actor (GAP-3's
 *   `service:<login>` derivation) holding the money permission (GAP-2's
 *   `ledger:record`), carries it across the boundary as a header, and
 *   the handler revalidates it against current authority.
 *
 * What this module is NOT: enforcement. Both ends run in OBSERVE mode
 * (the #1078 staging plan: observe first, so production validation
 * outcomes are visible before enforcement can deny real work; the
 * enforcement flip is a separate, separately reviewed step). A failed
 * resolution means no header is attached and the write proceeds exactly
 * as today; a failed revalidation is logged and audited and the request
 * proceeds exactly as today. This slice gates nothing — the G-1 hole
 * stays open until the ledger-gate slice lands, by the owner's explicit
 * choice (ADR 0034 D2).
 *
 * Mappings proposed here, put to CISO review (nothing CISO-decided):
 * - Environment is `live` with `consequential: true` for every ledger
 *   write: no sandbox ledger exists, and every write records real value
 *   movement. No sandbox/live signal exists on the commercial path.
 * - The approval reference is the evidence that authorized the write:
 *   for a charge, the verified payment proof (precedence
 *   paymentIntentId, then claimTxHash, then checkoutId); for a credit,
 *   `failure-credit:<runRequestId>`, the failure-credit issuance the
 *   run's record reconstructs. A charge with no proof reference resolves
 *   no context — never an invented reference.
 * - The tenant is the workflow's verified tenant, threaded from verified
 *   identity (#3182). Where no verified tenant is present, no context
 *   resolves — never an invented tenant.
 * - The service login is validated by GAP-3's rules: a malformed login
 *   or the shared-orchestrator address never resolves a context.
 *
 * Production honesty: resolution requires a tenant-admin binding for
 * `service:<login>` in the ledger's tenant (GAP-3's binding story), and
 * no such binding is provisioned today — provisioning is CISO-owned.
 * Until it is provisioned, resolution denies in observe mode and no
 * header travels. The wiring is proven by tests against a memory store;
 * the staged state is recorded in `authz.md` §2, not smoothed over.
 */

import type { MembershipStore } from "./authorization";
import {
  parseExecutionContext,
  revalidateExecutionContext,
  resolveExecutionContext,
  serializeExecutionContext,
  type ContextDenyCode,
  type ExecutionContext,
  type ExecutionContextAuthority,
  type ResolveExecutionContextResult,
} from "./executionContext";
import {
  isLoginShaped,
  isSharedOrchestratorAddress,
  serviceUserInternalUserId,
} from "./serviceIdentity";

/** Header carrying the serialized ExecutionContext across the stub-fetch boundary. */
export const EXECUTION_CONTEXT_HEADER = "x-execution-context";

/** `serviceId` carried by ledger-write contexts. */
export const LEDGER_WRITE_SERVICE_ID = "ledger-write";

/**
 * The authority a ledger-write context resolves against. Ledger writes
 * carry no provider connection, so the binding check denies by
 * construction: a context naming a connection is not bound, ever.
 * Fail-closed — a tampered context smuggling a connectionId denies at
 * revalidation instead of slipping past an unimplemented check.
 */
export function ledgerWriteAuthority(
  memberships: MembershipStore,
): ExecutionContextAuthority {
  return {
    memberships,
    async isConnectionBound(): Promise<boolean> {
      return false;
    },
  };
}

export interface LedgerWriteApprovalInput {
  kind: "charge" | "credit";
  runRequestId: string;
  checkoutId?: string;
  claimTxHash?: string;
  paymentIntentId?: string;
}

/**
 * The approval reference for a ledger write: the evidence that
 * authorized it. Charge: the verified payment proof, precedence
 * paymentIntentId, then claimTxHash, then checkoutId. Credit: the
 * failure-credit issuance for the run. A charge with no proof
 * reference yields undefined — the caller resolves no context.
 */
export function ledgerWriteApprovalReference(
  input: LedgerWriteApprovalInput,
): string | undefined {
  const proof = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  if (input.kind === "credit") {
    const run = proof(input.runRequestId);
    return run === undefined ? undefined : `failure-credit:${run}`;
  }
  return (
    proof(input.paymentIntentId) ??
    proof(input.claimTxHash) ??
    proof(input.checkoutId)
  );
}

export interface ResolveLedgerWriteContextInput {
  /** GAP-3 service principal id (`service:<login>`), never a bare login. */
  servicePrincipalId: string;
  /** The workflow's verified tenant. Never client-supplied. */
  tenantId: string;
  /** The run/operation id; becomes taskId and the default correlationId. */
  runRequestId: string;
  /** Evidence that authorized the write (see ledgerWriteApprovalReference). */
  approvalReference: string;
  nowMs: number;
  correlationId?: string;
}

/**
 * Resolve a validated ExecutionContext for a ledger write. Thin mapping
 * over the contract's only constructor: permission `ledger:record`
 * (GAP-2), principal type `service`, environment `live`, consequential.
 * Any failed check denies the whole resolution; there is no partial
 * context and no fallback identity.
 */
export async function resolveLedgerWriteContext(
  authority: ExecutionContextAuthority,
  input: ResolveLedgerWriteContextInput,
): Promise<ResolveExecutionContextResult> {
  return resolveExecutionContext(authority, {
    principalId: input.servicePrincipalId,
    principalType: "service",
    tenantId: input.tenantId,
    taskId: input.runRequestId,
    serviceId: LEDGER_WRITE_SERVICE_ID,
    environment: "live",
    permission: "ledger:record",
    consequential: true,
    approvalReference: input.approvalReference,
    correlationId: input.correlationId ?? input.runRequestId,
    nowMs: input.nowMs,
  });
}

export type LedgerWriteContextHeaderResult =
  | {
      attached: true;
      name: string;
      value: string;
      context: ExecutionContext;
    }
  | { attached: false; reason: string };

export interface ResolveLedgerWriteContextHeaderInput {
  memberships: MembershipStore;
  /** Configured service login, or null when unconfigured. */
  serviceLogin: string | null;
  /** The workflow's verified tenant; absent means unattributed, never invented. */
  tenantId: string | null | undefined;
  kind: "charge" | "credit";
  runRequestId: string;
  checkoutId?: string;
  claimTxHash?: string;
  paymentIntentId?: string;
  nowMs: number;
}

/**
 * Resolve a ledger-write context and serialize it for the boundary
 * header. Returns `{ attached: false, reason }` — never throws — for
 * every expected non-attachment: no service identity, a malformed login
 * or the shared-orchestrator address (GAP-3's rules), no verified
 * tenant, no approval reference, or a denied resolution. Authority /
 * store failures propagate: the caller treats them as observe-mode
 * noise (log, proceed without a header), never as a write failure.
 */
export async function resolveLedgerWriteContextHeader(
  input: ResolveLedgerWriteContextHeaderInput,
): Promise<LedgerWriteContextHeaderResult> {
  const serviceLogin = input.serviceLogin;
  if (serviceLogin === null || !isLoginShaped(serviceLogin)) {
    return { attached: false, reason: "no-service-identity" };
  }
  if (isSharedOrchestratorAddress(serviceLogin)) {
    return { attached: false, reason: "shared-address" };
  }
  const tenantId =
    typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  if (!tenantId) {
    return { attached: false, reason: "no-verified-tenant" };
  }
  const approvalReference = ledgerWriteApprovalReference(input);
  if (approvalReference === undefined) {
    return { attached: false, reason: "no-approval-reference" };
  }
  const resolution = await resolveLedgerWriteContext(
    ledgerWriteAuthority(input.memberships),
    {
      servicePrincipalId: serviceUserInternalUserId(serviceLogin),
      tenantId,
      runRequestId: input.runRequestId,
      approvalReference,
      nowMs: input.nowMs,
    },
  );
  if (!resolution.ok) {
    return {
      attached: false,
      reason: `resolution-denied:${resolution.code}`,
    };
  }
  return {
    attached: true,
    name: EXECUTION_CONTEXT_HEADER,
    value: serializeExecutionContext(resolution.context),
    context: resolution.context,
  };
}

/**
 * Re-check a carried ledger-write context against CURRENT authority at
 * the point of use: the PDP runs again for `ledger:record` (revocation
 * since resolution denies) and the connection binding is re-checked
 * (deny-all — see ledgerWriteAuthority). A context whose tenant no
 * longer matches the principal's memberships — including one tampered
 * with in transit — denies.
 */
export async function revalidateLedgerWriteContext(
  authority: ExecutionContextAuthority,
  context: ExecutionContext,
  nowMs: number,
): Promise<
  | { ok: true }
  | {
      ok: false;
      code: ContextDenyCode;
      error: string;
      pdpReason?: string;
    }
> {
  return revalidateExecutionContext(authority, context, "ledger:record", nowMs);
}

/** Minimal logger shape the observe helper needs (the structured logger satisfies it). */
export interface LedgerWriteContextLog {
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

export interface ObserveLedgerWriteContextInput {
  /** Lazy store construction: called only when a header is present. */
  getStore: () => MembershipStore;
  request: Request;
  nowMs: number;
  /** The handler's existing audit funnel. */
  audit: (type: string, payload: Record<string, unknown>) => void;
  log: LedgerWriteContextLog;
}

export type ObserveLedgerWriteContextOutcome =
  | { observed: false }
  | { observed: true; revalidated: true; context: ExecutionContext }
  | {
      observed: true;
      revalidated: false;
      code: ContextDenyCode | "MALFORMED_CONTEXT" | "OBSERVE_ERROR";
      error: string;
    };

/**
 * Observe-mode boundary check for a ledger-write handler. No header:
 * silent no-op (absence is the pre-wiring normal; the gate slice, not
 * this helper, decides what absence means). Header present: parse,
 * revalidate against current authority, log and audit the outcome —
 * and NEVER deny, NEVER throw. A malformed header, a denied
 * revalidation, or an authority failure is observed evidence, not a
 * request failure: the handler proceeds exactly as it would without
 * this call. The enforcement flip is a separate, separately reviewed
 * step under #1078 / the ledger-gate slice.
 */
export async function observeLedgerWriteContext(
  input: ObserveLedgerWriteContextInput,
): Promise<ObserveLedgerWriteContextOutcome> {
  const raw = input.request.headers.get(EXECUTION_CONTEXT_HEADER);
  if (raw === null || raw.trim().length === 0) {
    return { observed: false };
  }
  try {
    const context = parseExecutionContext(raw);
    if (context === null) {
      input.log.error(
        "commercialExecutionContext.malformed_context",
        {
          message:
            "[commercial-context] ledger-write request carried a malformed ExecutionContext header; observed only, request proceeds (observe mode).",
        },
      );
      input.audit("execution_context.revalidation", {
        outcome: "malformed",
      });
      return {
        observed: true,
        revalidated: false,
        code: "MALFORMED_CONTEXT",
        error: "ExecutionContext header is not a well-formed context",
      };
    }
    const outcome = await revalidateLedgerWriteContext(
      ledgerWriteAuthority(input.getStore()),
      context,
      input.nowMs,
    );
    if (!outcome.ok) {
      input.log.error(
        "commercialExecutionContext.revalidation_denied",
        {
          message:
            "[commercial-context] carried ExecutionContext failed revalidation; observed only, request proceeds (observe mode).",
          tenantId: context.tenantId,
          principalId: context.principalId,
          taskId: context.taskId,
          correlationId: context.correlationId,
          code: outcome.code,
          pdpReason: outcome.pdpReason,
        },
      );
      input.audit("execution_context.revalidation", {
        outcome: "denied",
        tenantId: context.tenantId,
        principalId: context.principalId,
        taskId: context.taskId,
        correlationId: context.correlationId,
        policyVersion: context.policyVersion,
        code: outcome.code,
        pdpReason: outcome.pdpReason,
      });
      return {
        observed: true,
        revalidated: false,
        code: outcome.code,
        error: outcome.error,
      };
    }
    input.log.info("commercialExecutionContext.revalidated", {
      message:
        "[commercial-context] carried ExecutionContext revalidated at the ledger-write boundary.",
      tenantId: context.tenantId,
      principalId: context.principalId,
      taskId: context.taskId,
      correlationId: context.correlationId,
      policyVersion: context.policyVersion,
    });
    input.audit("execution_context.revalidation", {
      outcome: "allowed",
      tenantId: context.tenantId,
      principalId: context.principalId,
      taskId: context.taskId,
      correlationId: context.correlationId,
      policyVersion: context.policyVersion,
    });
    return { observed: true, revalidated: true, context };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      input.log.error("commercialExecutionContext.observe_failed", {
        message:
          "[commercial-context] ExecutionContext observation failed; request proceeds (observe mode).",
        error: message,
      });
    } catch {
      // Observe must never throw, including when the log sink fails.
    }
    return {
      observed: true,
      revalidated: false,
      code: "OBSERVE_ERROR",
      error: message,
    };
  }
}
