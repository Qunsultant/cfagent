/**
 * Issue #3045 (monetization Phase 2.20, program #2405) — refund flow
 * UI in the Billing servicing surface, alongside the 2.19
 * RefundPolicySection.
 *
 * This section CALLS existing 2.7 routes only and creates none: POST
 * /refunds (request), POST /refunds/approve (decide), POST
 * /refunds/execute (execute, retry from execution_failed), GET
 * /refunds (own list + ?refundId= verify). It never edits policy
 * values — 2.19 owns that — and never changes the refund rail.
 *
 * Access mirrors 2.19 exactly: operator action buttons render only
 * when GET /operators succeeds; otherwise the record view is
 * read-only. The server routes remain the access control — nothing
 * here enforces anything the server does not. Record visibility is
 * owner-or-operator per the route.
 *
 * After every action the section re-reads (GET by id, plus a list
 * refresh) and renders ONLY the fresh read, never the POST answer
 * and never an optimistic assertion. Failures render as fixed strings
 * keyed by HTTP status (and, for execute 422, by the client-known
 * kind); server error bodies are never rendered.
 *
 * Honest limits, stated in copy: pay-per-run execution is refused
 * today as not resolvable (a pay-per-run record never carries a
 * payment-intent id and no resolver exists) — the UI surfaces that
 * refusal, it does not fix it; crypto refunds are refused as
 * non-refundable; legacy subscription rows without a stored
 * payment-intent id are refused, never guessed.
 * ui primitives only, token-only styling.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Notice } from "./components/ui/Notice";
import { Select } from "./components/ui/Select";
import { TextInput } from "./components/ui/TextInput";
import {
  getRefundPolicy,
  listOperators,
  type RefundKind,
  type RefundPolicyView,
} from "./refundPolicyApi";
import {
  requestRefund,
  decideRefund,
  executeRefund,
  getRefund,
  listRefunds,
  RefundFlowApiError,
  type RefundRecord,
  type RefundStatus,
} from "./refundFlowApi";

function statusOf(error: unknown): number {
  return error instanceof RefundFlowApiError ? error.status : 0;
}

function statusLabel(status: RefundStatus): string {
  switch (status) {
    case "requested":
      return "Requested";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "executed":
      return "Executed";
    case "execution_failed":
      return "Execution failed";
  }
}

function requestMessage(status: number): string {
  if (status === 403) return "Refunds are disabled while monetization is off.";
  if (status === 422) return "Refunds of this kind are not approved yet. An operator must approve this kind first.";
  if (status === 400) return "The request was refused. Check the payment reference and amount: the amount must equal the full original payment.";
  if (status === 503) return "The refund service is temporarily unavailable. Try again later.";
  return "The refund could not be requested. Try again later.";
}

function verifyMessage(status: number): string {
  if (status === 404) return "No refund with that id.";
  if (status === 403) return "Only the refund owner or a store operator can read a refund.";
  return "The refund could not be looked up. Try again later.";
}

function decideMessage(status: number): string {
  if (status === 403) return "Only a store operator can decide refunds.";
  if (status === 404) return "No refund with that id.";
  if (status === 400) return "This refund can no longer be decided.";
  return "The decision could not be saved. Try again later.";
}

function executeMessage(status: number, kind: RefundKind): string {
  if (status === 403) return "Only a store operator can execute refunds.";
  if (status === 409) return "Only an approved refund can be executed.";
  if (status === 422 && kind === "pay_per_run") {
    return "Pay-per-run refunds cannot be executed yet: no payment-intent id can be resolved for pay-per-run records.";
  }
  if (status === 422) return "This refund could not be executed. Check the refund window, the policy approval, and the original payment.";
  if (status === 503) return "The refund service is temporarily unavailable. Try again later.";
  return "The execution could not be completed. Try again later.";
}

interface FieldErrors {
  ref?: string;
  amount?: string;
  reason?: string;
}

export function RefundFlowSection() {
  const [policy, setPolicy] = useState<RefundPolicyView | null>(null);
  const [policyFailed, setPolicyFailed] = useState(false);
  const [isOperator, setIsOperator] = useState(false);
  const [refunds, setRefunds] = useState<RefundRecord[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<RefundRecord | null>(null);
  const [kind, setKind] = useState<RefundKind>("subscription");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [requestPending, setRequestPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  const refRef = useRef<HTMLInputElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const verifyRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const [policyResult, operatorsResult, listResult] = await Promise.allSettled([
        getRefundPolicy(),
        listOperators(),
        listRefunds(),
      ]);
      if (policyResult.status === "fulfilled") {
        setPolicy(policyResult.value.policy);
        setPolicyFailed(false);
      } else {
        setPolicy(null);
        setPolicyFailed(true);
      }
      // Operators success alone proves operator status — the route
      // refuses non-operators server-side. Any failure falls back to
      // the read-only view; the server still refuses any action the
      // UI should not offer.
      setIsOperator(operatorsResult.status === "fulfilled");
      if (listResult.status === "fulfilled") {
        setRefunds(listResult.value);
      } else {
        setRefunds([]);
        setListError("Your refunds could not be loaded.");
      }
    } catch {
      setPolicy(null);
      setPolicyFailed(true);
      setIsOperator(false);
      setRefunds([]);
      setListError("Your refunds could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) {
        setPolicy(null);
        setPolicyFailed(true);
        setIsOperator(false);
        setRefunds([]);
        setListError("Your refunds could not be loaded.");
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const kindBlocked = policy !== null && !policy.approvedKinds.includes(kind);

  const submitRequest = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setFieldErrors({});
      setFormError(null);
      const originalPaymentRef = refRef.current?.value.trim() ?? "";
      const amountRaw = amountRef.current?.value.trim() ?? "";
      const reason = reasonRef.current?.value.trim() ?? "";
      if (!originalPaymentRef) {
        setFieldErrors({ ref: "Enter the original payment reference." });
        return;
      }
      const amountUSD = Number(amountRaw);
      if (amountRaw === "" || !Number.isFinite(amountUSD) || amountUSD <= 0) {
        setFieldErrors({ amount: "Enter a valid amount greater than zero." });
        return;
      }
      if (!reason) {
        setFieldErrors({ reason: "Enter a reason for the refund." });
        return;
      }
      setRequestPending(true);
      try {
        const posted = await requestRefund({ kind, originalPaymentRef, amountUSD, reason });
        // Fresh-read discipline: render only the GET result, never
        // the POST answer.
        setCurrent(await getRefund(posted.id));
        setRefunds(await listRefunds());
        if (refRef.current) refRef.current.value = "";
        if (amountRef.current) amountRef.current.value = "";
        if (reasonRef.current) reasonRef.current.value = "";
      } catch (err) {
        setFormError(requestMessage(statusOf(err)));
      } finally {
        setRequestPending(false);
      }
    },
    [kind],
  );

  const loadRecord = useCallback(async (id: string) => {
    setVerifyError(null);
    setRecordError(null);
    try {
      setCurrent(await getRefund(id));
    } catch (err) {
      setVerifyError(verifyMessage(statusOf(err)));
    }
  }, []);

  const verify = useCallback(async () => {
    const id = verifyRef.current?.value.trim() ?? "";
    setVerifyError(null);
    if (!id) {
      setVerifyError("Enter a refund id to look up.");
      return;
    }
    setVerifyPending(true);
    try {
      await loadRecord(id);
    } finally {
      setVerifyPending(false);
    }
  }, [loadRecord]);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (!current) return;
      const note = noteRef.current?.value.trim() || undefined;
      setRecordError(null);
      setActionPending(true);
      try {
        await decideRefund(current.id, decision, note);
        setCurrent(await getRefund(current.id));
        setRefunds(await listRefunds());
      } catch (err) {
        setRecordError(decideMessage(statusOf(err)));
      } finally {
        setActionPending(false);
      }
    },
    [current],
  );

  const execute = useCallback(async () => {
    if (!current) return;
    setRecordError(null);
    setActionPending(true);
    try {
      await executeRefund(current.id);
      setCurrent(await getRefund(current.id));
      setRefunds(await listRefunds());
    } catch (err) {
      const status = statusOf(err);
      if (status === 502) {
        // A gateway failure marks execution_failed server-side, so
        // re-read and render the failed record with its retry.
        try {
          setCurrent(await getRefund(current.id));
        } catch {
          // Keep the previous record; the notice still explains the failure.
        }
        setRecordError("Execution failed at the gateway. Retry when ready.");
      } else {
        setRecordError(executeMessage(status, current.kind));
      }
    } finally {
      setActionPending(false);
    }
  }, [current]);

  return (
    <Card>
      <p>Refund flow</p>
      <p>
        Request a refund, decide and execute it as operator, and verify its outcome — over the
        existing refund routes. A full subscription refund revokes access immediately and removes
        included runs. Partial refunds are not allowed: the amount must equal the full original
        payment.
      </p>
      <p>
        Limits: pay-per-run execution is refused today as not resolvable — a pay-per-run record
        never carries a payment-intent id and no resolver exists; crypto refunds are refused as
        non-refundable; legacy subscription rows without a stored payment-intent id are refused,
        never guessed.
      </p>
      <form onSubmit={submitRequest}>
        <Select
          id="refund-kind"
          label="Refund kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RefundKind)}
        >
          <option value="subscription">Subscription</option>
          <option value="pay_per_run">Pay-per-run</option>
        </Select>
        <TextInput
          id="refund-original-ref"
          label="Original payment reference"
          hint="Subscription id or provider payment reference"
          ref={refRef}
          error={fieldErrors.ref}
        />
        <TextInput
          id="refund-amount"
          label="Amount (USD)"
          hint="Must equal the full original payment"
          ref={amountRef}
          error={fieldErrors.amount}
        />
        <TextInput
          id="refund-reason"
          label="Reason"
          ref={reasonRef}
          error={fieldErrors.reason}
        />
        {kindBlocked && (
          <Notice tone="warning">
            Refunds of this kind are not approved yet. An operator must approve this kind first.
          </Notice>
        )}
        {policyFailed && (
          <Notice tone="warning">
            Refund policy status unavailable; the server checks each request.
          </Notice>
        )}
        {formError && <Notice tone="danger">{formError}</Notice>}
        <Button type="submit" variant="primary" loading={requestPending} disabled={kindBlocked}>
          Request refund
        </Button>
      </form>
      <div>
        <p>Verify a refund</p>
        <TextInput id="refund-verify-id" label="Refund id" ref={verifyRef} />
        <Button variant="secondary" loading={verifyPending} onClick={verify}>
          Look up refund
        </Button>
        {verifyError && <Notice tone="danger">{verifyError}</Notice>}
      </div>
      {current && (
        <div>
          <p>Refund {current.id}</p>
          <p>Kind: {current.kind}</p>
          <p>Original payment: {current.originalPaymentRef}</p>
          <p>Amount: ${current.amountUSD.toFixed(2)} USD</p>
          <p>Original amount: ${current.originalAmountUSD.toFixed(2)} USD</p>
          <p>Reason: {current.reason}</p>
          <p>Status: {statusLabel(current.status)}</p>
          {current.approverLogin && (
            <p>
              {current.status === "approved"
                ? "Approved by"
                : current.status === "denied"
                  ? "Denied by"
                  : "Decided by"}{" "}
              {current.approverLogin}
            </p>
          )}
          {current.decisionNote && <p>Decision note: {current.decisionNote}</p>}
          {current.gatewayRefundId && <p>Gateway refund: {current.gatewayRefundId}</p>}
          {current.status === "executed" && current.entitlementConsequence && (
            <p>{current.entitlementConsequence}</p>
          )}
          {!isOperator && <p>Only a store operator can decide or execute refunds.</p>}
          {isOperator && current.status === "requested" && (
            <>
              <TextInput id="refund-decision-note" label="Decision note (optional)" ref={noteRef} />
              <Button variant="secondary" loading={actionPending} onClick={() => decide("approve")}>
                Approve refund
              </Button>
              <Button variant="secondary" loading={actionPending} onClick={() => decide("deny")}>
                Deny refund
              </Button>
            </>
          )}
          {isOperator && current.status === "approved" && (
            <Button variant="primary" loading={actionPending} onClick={execute}>
              Execute refund
            </Button>
          )}
          {isOperator && current.status === "execution_failed" && (
            <Button variant="primary" loading={actionPending} onClick={execute}>
              Retry execution
            </Button>
          )}
          {recordError && <Notice tone="danger">{recordError}</Notice>}
        </div>
      )}
      <div>
        <p>Your refunds</p>
        {loading && <p>Loading refunds</p>}
        {!loading && listError && (
          <>
            <Notice tone="warning">{listError}</Notice>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </>
        )}
        {!loading && !listError && refunds && refunds.length === 0 && <p>No refunds recorded yet.</p>}
        {!loading &&
          !listError &&
          refunds &&
          refunds.map((record) => (
            <div key={record.id}>
              <p>
                {record.id} — {record.kind} — ${record.amountUSD.toFixed(2)} USD —{" "}
                {statusLabel(record.status)}
              </p>
              <Button variant="secondary" onClick={() => loadRecord(record.id)}>
                View
              </Button>
            </div>
          ))}
      </div>
    </Card>
  );
}
