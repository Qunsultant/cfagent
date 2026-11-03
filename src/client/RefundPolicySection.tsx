/**
 * Issue #2985 (monetization Phase 2.19, program #2405) — refund
 * approval UI in the Billing servicing surface.
 *
 * This section CALLS existing 2.7 routes only and creates none: GET
 * refund-policy (any verified login) for values, disclosure, and
 * per-kind approval state; POST refund-policy/approve (operator-only)
 * for per-kind approve/withdraw; GET operators (operator-only) to
 * learn whether the viewer is an operator. The server routes remain
 * the access control — a non-operator sees values and state
 * read-only, with no action buttons, because the operators read
 * refused them; nothing here enforces anything the server does not.
 *
 * After every action the section re-reads the policy and renders
 * ONLY the fresh read, never the POST answer and never an optimistic
 * assertion. Failures render as fixed strings keyed by HTTP status;
 * server error bodies are never rendered. This section never
 * requests, approves, or executes a refund, and never edits policy
 * values — it configures per-kind approval only.
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import {
  getRefundPolicy,
  listOperators,
  setRefundKindApproval,
  RefundPolicyApiError,
  type RefundKind,
  type RefundPolicyView,
} from "./refundPolicyApi";

const KINDS: Array<{ kind: RefundKind; label: string; approveLabel: string }> = [
  { kind: "subscription", label: "Subscription refunds", approveLabel: "Approve subscription refunds" },
  { kind: "pay_per_run", label: "Pay-per-run refunds", approveLabel: "Approve pay-per-run refunds" },
];

function statusOf(error: unknown): number {
  return error instanceof RefundPolicyApiError ? error.status : 0;
}

function loadMessage(status: number): string {
  if (status === 503) return "The refund policy is not configured yet.";
  return "The refund policy could not be loaded.";
}

function actionMessage(status: number): string {
  if (status === 403) return "Only a store operator can change refund approvals.";
  if (status === 503) return "The refund service is temporarily unavailable. Try again later.";
  return "The approval could not be saved. Try again later.";
}

function formatApprovedAt(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function RefundPolicySection() {
  const [policy, setPolicy] = useState<RefundPolicyView | null>(null);
  const [disclosure, setDisclosure] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [pendingKind, setPendingKind] = useState<RefundKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [policyResult, operatorsResult] = await Promise.allSettled([
        getRefundPolicy(),
        listOperators(),
      ]);
      if (policyResult.status === "fulfilled") {
        setPolicy(policyResult.value.policy);
        setDisclosure(policyResult.value.disclosure);
      } else {
        setPolicy(null);
        setLoadError(loadMessage(statusOf(policyResult.reason)));
      }
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure (including a
      // transient outage) falls back to the read-only view; the
      // server still refuses any action the UI should not offer.
      setIsOperator(operatorsResult.status === "fulfilled");
    } catch {
      setPolicy(null);
      setLoadError(loadMessage(0));
      setIsOperator(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setLoadError(loadMessage(0));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const act = useCallback(async (kind: RefundKind, approved: boolean) => {
    setPendingKind(kind);
    setActionError(null);
    try {
      await setRefundKindApproval(kind, approved);
      const fresh = await getRefundPolicy();
      setPolicy(fresh.policy);
      setDisclosure(fresh.disclosure);
    } catch (err) {
      setActionError(actionMessage(statusOf(err)));
    } finally {
      setPendingKind(null);
    }
  }, []);

  return (
    <Card>
      <p>Refund policy</p>
      {loading && <p>Loading refund policy</p>}
      {!loading && loadError && (
        <>
          <Notice tone="warning">{loadError}</Notice>
          <Button variant="secondary" onClick={load}>
            Retry
          </Button>
        </>
      )}
      {!loading && !loadError && policy && (
        <>
          <p>Refund window: {policy.windowDays} days</p>
          <p>Approver: {policy.approver}</p>
          <p>Partial refunds: {policy.allowPartial ? "allowed" : "not allowed"}</p>
          <p>Subscription full refund: {policy.subscriptionFullEffect}</p>
          <p>Subscription partial refund: {policy.subscriptionPartialEffect}</p>
          <p>Pay-per-run refund: {policy.payPerRunEffect}</p>
          <p>Credit refund: {policy.creditEffect}</p>
          {disclosure && <p>{disclosure}</p>}
          {!isOperator && <p>Only a store operator can change approvals.</p>}
          {KINDS.map(({ kind, label, approveLabel }) => {
            const approved = policy.approvedKinds.includes(kind);
            return (
              <div key={kind}>
                <p>
                  {label}:{" "}
                  {approved
                    ? `Approved by ${policy.approvedBy ?? "—"} on ${formatApprovedAt(policy.approvedAtMs)}`
                    : "Not approved"}
                </p>
                {isOperator && (
                  <Button
                    variant="secondary"
                    loading={pendingKind === kind}
                    onClick={() => act(kind, !approved)}
                  >
                    {approved ? "Withdraw approval" : approveLabel}
                  </Button>
                )}
              </div>
            );
          })}
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          <p>
            Approval configures policy only. It never requests, approves, or executes a refund.
          </p>
        </>
      )}
    </Card>
  );
}
