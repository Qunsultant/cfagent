/**
 * Issue #2204 follow-up — pay-per-run payment-intent resolution via the
 * native ledger seam (related issue #2204, CBO refunds).
 *
 * Until this slice, executeRefund consulted deps.sourceResolver ONLY
 * for subscription records, so an approved pay-per-run refund whose
 * PI id was not already stored on the record always failed closed —
 * even when the native ledger charge row carried the PI. This module
 * wires the native ledger's run->PI lookup into the resolver seam.
 *
 * Port-first (ADR 0002 R1): this module depends only on port
 * interfaces (NativeLedgerPort, RefundPaymentSourceResolver) and
 * pure helpers. It imports no store client, no gateway SDK, no env
 * binding, and writes no SQL. The route (composition root) builds
 * the resolver from the D1 adapter; tests use the in-memory
 * adapter or a stub port.
 *
 * Resolution rules, all fail-closed:
 * - Charge row only: findRow(runRequestId, "charge"). A credit row
 *   is a replacement-run entitlement, never a payment source, and
 *   is never consulted here.
 * - Card rail only: a native row with gateway "x402" has no Stripe
 *   payment intent (its gatewayRef is an on-chain claim hash), so
 *   it resolves to null. Crypto stays non-refundable (#2204).
 * - PI extraction order, mirroring buildNativeChargeTransaction
 *   (src/data/nativeLedgerPorts.ts): gatewayRef when it IS a pi_ id
 *   (a row recorded with no session id), else proofSignature when
 *   it IS a pi_ id (for card rows it equals paymentIntentId when
 *   one was recorded), else the "; payment intent pi_…" token in
 *   the note. Anything else resolves to null.
 * - A charge recorded with only a Stripe session id (gatewayRef =
 *   session id, proofSignature = "none (no on-chain claim
 *   recorded)", no PI in the note) stays unresolvable and the
 *   refund still fails closed exactly as before — an id is never
 *   guessed, and no session id is ever passed to the gateway as
 *   if it were a payment intent.
 * - Tenant is carried on the resolved source so executeRefund can
 *   refuse a cross-tenant match; this module itself performs no
 *   scoping decision beyond returning the row's own tenantId.
 */
import type {
  NativeLedgerPort,
  NativeLedgerRow,
} from "../data/nativeLedgerPorts";
import type {
  RefundPaymentSource,
  RefundPaymentSourceResolver,
} from "../data/refundPorts";

const PAYMENT_INTENT_PATTERN = /^pi_[A-Za-z0-9_]+$/;
const NOTE_PAYMENT_INTENT_PATTERN = /payment intent (pi_[A-Za-z0-9_]+)/;

function asPiId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PAYMENT_INTENT_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Pure PI extraction from a native charge row, in the order
 * gatewayRef, proofSignature, note token. Returns null when no
 * field carries a pi_ id. Exported for unit tests; the resolver
 * below is the only production caller.
 */
export function extractPaymentIntentFromNativeChargeRow(row: Pick<
  NativeLedgerRow,
  "gateway" | "gatewayRef" | "proofSignature" | "note"
>): string | null {
  if (row.gateway !== "stripe") return null;
  return (
    asPiId(row.gatewayRef) ??
    asPiId(row.proofSignature) ??
    (() => {
      const match = NOTE_PAYMENT_INTENT_PATTERN.exec(row.note ?? "");
      return match ? match[1] : null;
    })()
  );
}

/**
 * RefundPaymentSourceResolver over an existing NativeLedgerPort:
 * the pay-per-run half of the composite resolver the execute route
 * passes to executeRefund (the other half is the subscription
 * resolver from #2200). Returns null for a missing row, an x402
 * row, or a row with no resolvable PI — never a guessed id.
 */
export function createPayPerRunPaymentResolver(
  ledger: NativeLedgerPort,
): RefundPaymentSourceResolver {
  return {
    async resolve(originalPaymentRef: string): Promise<RefundPaymentSource | null> {
      const row = await ledger.findRow(originalPaymentRef, "charge");
      if (!row) return null;
      const paymentIntentId = extractPaymentIntentFromNativeChargeRow(row);
      if (!paymentIntentId) return null;
      return {
        paymentIntentId,
        rail: "card",
        originalAmountUSD: row.amount,
        originalPaidAtMs: row.createdAtMs,
        userId: row.customer,
        tenantId: row.tenantId,
        subscriptionId: null,
      };
    },
  };
}
