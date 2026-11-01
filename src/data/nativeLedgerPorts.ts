/**
 * Issue #2192 ([Native payments] Slice 0, sub-issue of #2012,
 * umbrella #2146) — native ledger port.
 *
 * The native ledger is the TWIN of the cfpay ledger
 * (src/services/cfpayLedger.ts), not a rewrite of it: same row
 * attribution shape, same dedupe contract (one charge + one
 * credit row per run; a replay returns the existing row), but a
 * different store and a different provenance prefix, so the
 * cfpay-era history stays intact and readable.
 *
 * Differences from the cfpay twin, all deliberate:
 * - Store: D1 (via the Drizzle adapter) instead of the
 *   orchestrator DO's mas_transactions. D1 is shared across
 *   instances, so no canonical-instance hop is needed; the
 *   record-native endpoint and the webhook arm build the port
 *   straight from env.AGENT_DB. The DO ledger stays the cfpay
 *   record; native rows are a new, separate record.
 * - Session prefix `screener-payment-native:` (cfpay rows keep
 *   `screener-payment:`), so every report can tell the eras
 *   apart by prefix alone.
 * - TRUTHFUL gateway per rail: `"stripe"` for card,
 *   `"x402"` for crypto. The cfpay ledger hardcodes `"stripe"`
 *   even for cfpay x402 payments (an existing misattribution,
 *   left untouched as history); native rows must not repeat it.
 * - gatewayRef is the Stripe session id / payment-intent id
 *   (card) or the claim tx hash (x402) — never a checkout URL.
 * - proposerDid stays ORCHESTRATOR: no workflow DID exists, and
 *   the orchestrator is the ledger caller, exactly as for cfpay.
 * - Rows carry tenantId and family natively (the cfpay row
 *   carries neither — family attribution there comes from an
 *   audit-payload join). Tenant-scoped reads only: there is no
 *   unscoped list-all on this port.
 *
 * Hard constraint (BudgetGuard isolation): action is `"charge"`
 * or `"credit"`, NEVER `"micropayment"`. deriveBudgetGuardState
 * counts PaymentsAgent rows + `micropayment` x402/mpp rows; a
 * native screener row labeled `micropayment` would pollute
 * BudgetGuard state. As defense in depth, native rows live in
 * D1, never in mas_transactions, so BudgetGuard — which reads
 * mas_transactions — cannot see them at all. src/payments/
 * ledger.ts is NOT reused and NOT modified here.
 *
 * Port-first (ADR 0002 R1/R2): this module carries record
 * types, the port interface, and pure helpers ONLY. It imports
 * no store client, references no env binding, and writes no
 * SQL. All query-builder code lives in d1NativeLedgerAdapter.ts;
 * the in-memory adapter shares the validators and builders
 * below so the two implementations cannot drift. A structural
 * test pins the import rule. (The AGENT_DIDS import is pure
 * constants — the single source of truth for proposerDid — not
 * a store client or a gateway SDK.)
 *
 * Money-path note: the native ledger records and audits only
 * in this slice. No gate reads it yet, no checkout writes to
 * it, and no payment behavior changes until slice 1.
 */

import { AGENT_DIDS } from "../agents/did";

/** session_id prefix marking a D1 row as native-origin. */
export const NATIVE_LEDGER_SESSION_PREFIX = "screener-payment-native:";

export function nativeLedgerSessionId(runRequestId: string): string {
  return `${NATIVE_LEDGER_SESSION_PREFIX}${runRequestId}`;
}

export function isNativeLedgerRow(row: { sessionId?: unknown }): boolean {
  return String(row.sessionId ?? "").startsWith(NATIVE_LEDGER_SESSION_PREFIX);
}

/** The rail a native payment settled on. Gateway is truthful per rail. */
export type NativeRail = "stripe" | "x402";

export function parseNativeRail(value: unknown): NativeRail | null {
  return value === "stripe" || value === "x402" ? value : null;
}

/** One native ledger row, as stored in D1. */
export interface NativeLedgerRow {
  id: string;
  sessionId: string;
  action: "charge" | "credit";
  amount: number;
  currency: "USD";
  customer: string;
  gateway: NativeRail;
  gatewayRef: string;
  status: "completed";
  checkoutUrl: string;
  proposerDid: string;
  proofSignature: string;
  note: string;
  tenantId: string;
  family: string;
  runRequestId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface NativeLedgerRowInput {
  kind: "charge" | "credit";
  runRequestId: string;
  tenantId: string;
  userId: string;
  family: string;
  priceUSD: number;
  rail: NativeRail;
  /** Stripe session id (card). First gatewayRef candidate for card. */
  sessionId?: string;
  /** Stripe payment-intent id (card). Second gatewayRef candidate. */
  paymentIntentId?: string;
  /** On-chain claim tx hash (x402). First gatewayRef candidate for crypto. */
  claimTxHash?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Shared validator: every adapter runs inputs through the
 * builders below (which call this), so a D1 row and an
 * in-memory row can never disagree on what is recordable.
 */
export function validateNativeLedgerInput(input: NativeLedgerRowInput): void {
  if (input.kind !== "charge" && input.kind !== "credit") {
    throw new Error('native ledger: kind must be "charge" or "credit"');
  }
  for (const [field, value] of [
    ["runRequestId", input.runRequestId],
    ["tenantId", input.tenantId],
    ["userId", input.userId],
    ["family", input.family],
  ] as const) {
    if (!nonEmpty(value)) throw new Error(`native ledger: ${field} is required`);
  }
  if (!Number.isFinite(input.priceUSD) || input.priceUSD <= 0) {
    throw new Error("native ledger: priceUSD must be a positive number");
  }
  if (input.rail !== "stripe" && input.rail !== "x402") {
    throw new Error('native ledger: rail must be "stripe" or "x402"');
  }
}

function rowId(): string {
  return `native_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * gatewayRef, truthfully per rail: the Stripe session id (then
 * payment-intent id) for card, the claim tx hash for crypto,
 * falling back to the run id when no rail reference is known —
 * the same fallback shape as the cfpay twin.
 */
export function nativeGatewayRef(input: NativeLedgerRowInput): string {
  if (input.rail === "x402") return input.claimTxHash ?? input.runRequestId;
  return input.sessionId ?? input.paymentIntentId ?? input.runRequestId;
}

/** Build the D1 row for a confirmed native payment. */
export function buildNativeChargeTransaction(
  input: NativeLedgerRowInput,
  nowMs: number = Date.now(),
): NativeLedgerRow {
  validateNativeLedgerInput(input);
  if (input.kind !== "charge") {
    throw new Error("native ledger: buildNativeChargeTransaction requires kind charge");
  }
  return {
    id: rowId(),
    sessionId: nativeLedgerSessionId(input.runRequestId),
    action: "charge",
    amount: input.priceUSD,
    currency: "USD",
    customer: input.userId,
    gateway: input.rail,
    gatewayRef: nativeGatewayRef(input),
    status: "completed",
    checkoutUrl: "",
    proposerDid: AGENT_DIDS.ORCHESTRATOR,
    proofSignature:
      input.claimTxHash ?? input.paymentIntentId ?? "none (no on-chain claim recorded)",
    note:
      `${input.family} run ${input.runRequestId} via native ${input.rail} checkout` +
      (input.paymentIntentId ? `; payment intent ${input.paymentIntentId}` : ""),
    tenantId: input.tenantId,
    family: input.family,
    runRequestId: input.runRequestId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/**
 * Build the D1 row for a one-time replacement-run credit.
 * One credit row per run (enforced by the port's dedupe);
 * a second issue for the same run returns the existing row
 * as a duplicate, never a second row. A credit is value
 * granted, not a cash refund (cash refunds are
 * operator-initiated only, #2204 / #2549).
 */
export function buildNativeCreditTransaction(
  input: NativeLedgerRowInput,
  nowMs: number = Date.now(),
): NativeLedgerRow {
  validateNativeLedgerInput(input);
  if (input.kind !== "credit") {
    throw new Error("native ledger: buildNativeCreditTransaction requires kind credit");
  }
  return {
    id: rowId(),
    sessionId: nativeLedgerSessionId(input.runRequestId),
    action: "credit",
    amount: input.priceUSD,
    currency: "USD",
    customer: input.userId,
    gateway: input.rail,
    gatewayRef: `credit:${input.runRequestId}`,
    status: "completed",
    checkoutUrl: "",
    proposerDid: AGENT_DIDS.ORCHESTRATOR,
    proofSignature: "none (replacement-run credit, no payment)",
    note:
      `One-time replacement-run credit for failed paid run ${input.runRequestId} ` +
      `(${input.family}); redeemable for one future run of the same family; this credit is not a cash refund.`,
    tenantId: input.tenantId,
    family: input.family,
    runRequestId: input.runRequestId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Find the native row of one kind for one run, if any. */
export function findNativeRowBySessionAndAction(
  rows: NativeLedgerRow[],
  runRequestId: string,
  action: "charge" | "credit",
): NativeLedgerRow | undefined {
  const sessionId = nativeLedgerSessionId(runRequestId);
  return rows.find((t) => t.sessionId === sessionId && t.action === action);
}

export interface NativeLedgerPort {
  /**
   * Record a charge or credit row. Idempotent per run+kind: a
   * row that already exists returns `{ duplicate: true }` with
   * the existing row instead of writing a second row.
   */
  recordRow(input: NativeLedgerRowInput): Promise<{ row: NativeLedgerRow; duplicate: boolean }>;
  /** The row of one kind for one run, if any. */
  findRow(
    runRequestId: string,
    kind: "charge" | "credit",
  ): Promise<NativeLedgerRow | undefined>;
  /** All native rows for one run, oldest first. */
  listRowsForRun(runRequestId: string): Promise<NativeLedgerRow[]>;
  /**
   * All native rows for one tenant, oldest first. No unscoped
   * read exists on this port: cross-tenant aggregation is an
   * operator concern for a later slice, not a port operation.
   */
  listRowsForTenant(tenantId: string): Promise<NativeLedgerRow[]>;
}

// ---------------------------------------------------------------------------
// Pure reconciliation (mirrors reconcileCfpayRun, native confirm source)
// ---------------------------------------------------------------------------

export interface NativeReconciliation {
  runRequestId: string;
  /** Whether the native confirm source reports this run paid. */
  nativePaid: boolean;
  chargePresent: boolean;
  creditPresent: boolean;
  matched: boolean;
  reasons: string[];
}

/**
 * Pure reconciliation of one run's native rows against the
 * native confirm source (slice 1 supplies it: Stripe session
 * retrieve complete + paid, or facilitator-verified x402
 * claim). A run counts as paid in exactly one ledger iff a
 * charge row exists exactly when the confirm source reports
 * paid. Credit rows do not change the paid-match — a
 * paid-then-failed-then-credited run still counts as paid
 * with a credit owed, not as unpaid.
 */
export function reconcileNativeRun(
  rows: NativeLedgerRow[],
  runRequestId: string,
  nativePaid: boolean,
): NativeReconciliation {
  const chargePresent =
    findNativeRowBySessionAndAction(rows, runRequestId, "charge") !== undefined;
  const creditPresent =
    findNativeRowBySessionAndAction(rows, runRequestId, "credit") !== undefined;
  const reasons: string[] = [];
  if (nativePaid && !chargePresent) reasons.push("native confirm reports paid but no charge row exists");
  if (!nativePaid && chargePresent) reasons.push("charge row exists but native confirm does not report paid");
  return {
    runRequestId,
    nativePaid,
    chargePresent,
    creditPresent,
    matched: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Pure revenue aggregation (mirrors aggregateCfpayRevenue, native only)
// ---------------------------------------------------------------------------

export interface NativeRevenueByFamily {
  charges: number;
  chargeTotalUSD: number;
  credits: number;
  creditTotalUSD: number;
  /**
   * OWNER-DIRECTED ASSUMPTION, not measured cost: 1/5 of this
   * family's charge total. No per-run cost accounting exists yet.
   */
  assumedCostUSD: number;
  /** Charge total minus credit total minus assumed cost. */
  profitUSD: number;
}

export interface NativeRevenueReport {
  charges: { count: number; totalUSD: number };
  credits: { count: number; totalUSD: number };
  /** Charge total minus credit total: net value retained. */
  netUSD: number;
  /**
   * OWNER-DIRECTED ASSUMPTION, not measured cost: 1/5 of charge
   * total. No per-run cost accounting exists yet.
   */
  assumedCostUSD: number;
  /** Charge total minus assumed cost. */
  grossProfitUSD: number;
  /** Net value retained minus assumed cost. */
  netProfitUSD: number;
  /** States the cost assumption in plain language for API consumers. */
  costAssumption: string;
  byFamily: Record<string, NativeRevenueByFamily>;
  coveredByPaidVia: Record<string, number>;
  /**
   * Charges with no family attribution from either a
   * payment.confirmed audit row or the row itself. Always 0
   * for validated native rows, which carry family natively —
   * kept for report-shape parity with the cfpay report.
   */
  chargesWithoutFamily: number;
  creditsWithoutFamily: number;
  /** Covered runs with no paidVia on the audit row (pre-amendment rows). */
  coveredWithoutPaidVia: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function payloadFamily(payload: Record<string, unknown>): string | null {
  return typeof payload["family"] === "string" && (payload["family"] as string)
    ? (payload["family"] as string)
    : null;
}

/**
 * Pure native revenue aggregation. Money is authoritative from
 * the native ledger rows; family and coverage attribution come
 * from the audit payloads joined on run id, with explicit
 * "unknown" buckets where an audit row is missing. Totals
 * never depend on audit completeness — only the breakdown
 * does. Cost is an OWNER-DIRECTED ASSUMPTION (1/5 of revenue),
 * not measured cost. Rows that are not native rows (any other
 * session prefix, e.g. cfpay-era rows) are EXCLUDED entirely:
 * counting them as native revenue would misattribute eras.
 * The cfpay aggregation is untouched; this is its native
 * counterpart, not a replacement.
 */
export function aggregateNativeRevenue(
  rows: NativeLedgerRow[],
  confirmedPayloads: Array<Record<string, unknown>>,
  coveredPayloads: Array<Record<string, unknown>>,
  creditPayloads: Array<Record<string, unknown>>,
): NativeRevenueReport {
  const nativeRows = rows.filter(isNativeLedgerRow);
  const chargeRows = nativeRows.filter((t) => t.action === "charge");
  const creditRows = nativeRows.filter((t) => t.action === "credit");

  const confirmedFamily = new Map<string, string>();
  for (const p of confirmedPayloads) {
    const run = typeof p["runRequestId"] === "string" ? (p["runRequestId"] as string) : "";
    const family = payloadFamily(p);
    if (run && family) confirmedFamily.set(run, family);
  }
  const creditFamily = new Map<string, string>();
  for (const p of creditPayloads) {
    const run = typeof p["runRequestId"] === "string" ? (p["runRequestId"] as string) : "";
    const family = payloadFamily(p);
    if (run && family) creditFamily.set(run, family);
  }

  const byFamily: Record<string, NativeRevenueByFamily> = {};
  const bucket = (family: string): NativeRevenueByFamily => {
    let b = byFamily[family];
    if (!b) {
      b = { charges: 0, chargeTotalUSD: 0, credits: 0, creditTotalUSD: 0, assumedCostUSD: 0, profitUSD: 0 };
      byFamily[family] = b;
    }
    return b;
  };

  let chargeTotal = 0;
  let chargesWithoutFamily = 0;
  for (const row of chargeRows) {
    const amount = Number(row.amount);
    const value = Number.isFinite(amount) ? amount : 0;
    chargeTotal += value;
    const family = confirmedFamily.get(row.runRequestId) ?? row.family ?? null;
    if (!family) chargesWithoutFamily += 1;
    const b = bucket(family ?? "unknown");
    b.charges += 1;
    b.chargeTotalUSD = round2(b.chargeTotalUSD + value);
  }

  let creditTotal = 0;
  let creditsWithoutFamily = 0;
  for (const row of creditRows) {
    const amount = Number(row.amount);
    const value = Number.isFinite(amount) ? amount : 0;
    creditTotal += value;
    const family = creditFamily.get(row.runRequestId) ?? row.family ?? null;
    if (!family) creditsWithoutFamily += 1;
    const b = bucket(family ?? "unknown");
    b.credits += 1;
    b.creditTotalUSD = round2(b.creditTotalUSD + value);
  }

  const coveredByPaidVia: Record<string, number> = {};
  let coveredWithoutPaidVia = 0;
  for (const p of coveredPayloads) {
    const paidVia = typeof p["paidVia"] === "string" && (p["paidVia"] as string)
      ? (p["paidVia"] as string)
      : "unknown";
    if (paidVia === "unknown") coveredWithoutPaidVia += 1;
    coveredByPaidVia[paidVia] = (coveredByPaidVia[paidVia] ?? 0) + 1;
  }

  for (const b of Object.values(byFamily)) {
    b.assumedCostUSD = round2(b.chargeTotalUSD / 5);
    b.profitUSD = round2(b.chargeTotalUSD - b.creditTotalUSD - b.assumedCostUSD);
  }
  const assumedCostUSD = round2(chargeTotal / 5);
  const netUSD = round2(chargeTotal - creditTotal);

  return {
    charges: { count: chargeRows.length, totalUSD: round2(chargeTotal) },
    credits: { count: creditRows.length, totalUSD: round2(creditTotal) },
    netUSD,
    assumedCostUSD,
    grossProfitUSD: round2(chargeTotal - assumedCostUSD),
    netProfitUSD: round2(netUSD - assumedCostUSD),
    costAssumption: "cost assumed at 1/5 of revenue (owner-directed, not measured)",
    byFamily,
    coveredByPaidVia,
    chargesWithoutFamily,
    creditsWithoutFamily,
    coveredWithoutPaidVia,
  };
}
