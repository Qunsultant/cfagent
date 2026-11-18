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
 * interfaces (NativeLedgerPort, ProductBundleStore, BillingPort,
 * RefundPaymentSourceResolver) and pure helpers. It imports no
 * store client, no gateway SDK, no env binding, and writes no SQL.
 * The route (composition root) builds the resolvers from the D1
 * adapters; tests use the in-memory adapters or stub ports.
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
  ProductBundleStore,
} from "../data/productBundles";
import type { BillingPort } from "./billingPorts";
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

/**
 * Issue #5227 (Monetization Phase 2.29) — bundle payment-intent
 * resolution over the product-bundle store + the Billing port.
 *
 * A bundle purchase is a subscription-mode Checkout, so its row
 * carries NO payment intent (the session evidence has none, and
 * Stripe's `payment_intent` on a subscription-mode session is
 * null): the charge lives on the provider subscription's FIRST
 * invoice. Resolution order, all fail-closed:
 * - No purchase row for the ref -> null. A missing bundle price
 *   also resolves to null (the amount cannot be known).
 * - Stored `stripePaymentIntentId` (a row recorded with one, or a
 *   later backfill) wins; the invoice lookup is never consulted.
 * - Else the provider subscription's first invoice, via
 *   `billing.retrieveFirstInvoicePaymentIntent` (earliest invoice
 *   wins; a renewal's intent is never returned). A null billing
 *   port, a missing provider subscription id, a provider error,
 *   or a null first-invoice intent all leave `paymentIntentId`
 *   null ON THE RETURNED SOURCE (the service refuses with the
 *   named no-stored-PI error) — an id is never guessed, and no
 *   session id is ever passed to the gateway as if it were a
 *   payment intent.
 * - Rail mapping mirrors the subscription resolver: "stripe" ->
 *   card; "x402" -> crypto; anything else (legacy "cfpay" rows)
 *   -> null rail, which the service refuses as unresolvable.
 * - The bundle price is the source amount, the purchase creation
 *   time is the window anchor, and the entitlement period is
 *   carried so the service can compute the prorated remainder.
 * - Tenant is carried on the resolved source so executeRefund can
 *   refuse a cross-tenant match; this module itself performs no
 *   scoping decision beyond returning the row's own tenantId.
 */
export function createBundlePaymentResolver(
  bundleStore: ProductBundleStore,
  billing: Pick<BillingPort, "retrieveFirstInvoicePaymentIntent"> | null,
): RefundPaymentSourceResolver {
  return {
    async resolve(originalPaymentRef: string): Promise<RefundPaymentSource | null> {
      const purchase = await bundleStore.findBundlePurchaseByPaymentRef(originalPaymentRef);
      if (!purchase) return null;
      const bundle = await bundleStore.getBundle(purchase.bundleId).catch(() => null);
      if (!bundle) return null;
      let paymentIntentId = purchase.stripePaymentIntentId;
      if (!paymentIntentId && billing && purchase.providerSubscriptionId) {
        paymentIntentId = await billing
          .retrieveFirstInvoicePaymentIntent(purchase.providerSubscriptionId)
          .catch(() => null);
      }
      return {
        paymentIntentId,
        rail: purchase.provider === "stripe" ? "card" : purchase.provider === "x402" ? "crypto" : null,
        originalAmountUSD: bundle.priceUSD,
        originalPaidAtMs: purchase.createdAtMs,
        userId: purchase.userId,
        tenantId: purchase.tenantId,
        subscriptionId: null,
        bundlePeriodStartMs: purchase.periodStartMs,
        bundlePeriodEndMs: purchase.periodEndMs,
      };
    },
  };
}
