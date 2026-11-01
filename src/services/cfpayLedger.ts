/**
 * Issue #2019 (Goal 1 Phase 4) — the durable cfpay ledger.
 *
 * cfpay payments live in `mas_transactions`, the ledger of record owned
 * by the OrchestratorAgent's SQLite store — exactly like PaymentsAgent
 * rows, but with a DIFFERENT attribution, which is why
 * `recordLedgerPayment` (src/payments/ledger.ts) is deliberately NOT
 * reused here: it builds PaymentsAgent-origin x402 rows only, and
 * reusing it for cfpay would mislabel gateway and session.
 *
 * Attribution for a cfpay row (per #2043):
 * - session_id `screener-payment:<runRequestId>` — the run id is the
 *   join key: cfpay checkout.create used requestId == runRequestId.
 * - gateway `stripe` — the cfpay checkout settles via Stripe fulfil
 *   (checkout.fulfil, called only after a verified Stripe webhook).
 * - action `charge` for a confirmed payment, `credit` for a one-time
 *   replacement-run credit. A credit is value granted, not a cash
 *   refund, and no code path in this ledger moves cash back (cash
 *   refunds live in the operator-approved refund service, #2204,
 *   are never issued automatically, and per #2549 never stack on
 *   top of a credit for the same failure).
 * - proposerDid is the orchestrator: no workflow DID exists, and the
 *   orchestrator is both the ledger owner and the workflow's caller.
 *   The payer is `customer` (the verified user id).
 *
 * Transport mirrors src/payments/ledger.ts: the workflow reaches the
 * ledger owner over the SEARCH_AGENT Durable Object channel, forwarding
 * under the configured service identity (#1185). Ledger writes FAIL
 * LOUD — a payment must never be recorded into the void — and are
 * deduped server-side (one charge row and one credit row per run), so
 * a retried workflow step can never double-record.
 *
 * Audit rows (mas_events) are a different contract: like the
 * orchestrator's own audit(), the audit client here is best-effort
 * with a loud Workers Logs fallback. An audit write must never fail a
 * paid run's workflow — the ledger row is the durable record, the
 * audit row is the readable trail.
 *
 * Boundary, stated plainly: this module ISSUES credits (durable,
 * deduped, audited). REDEMPTION — a later run consuming a stored
 * credit instead of charging — belongs to the account store (#2015),
 * which reads these rows; the gate today reads only caller-supplied
 * account state. Nothing here claims redemption works.
 */
import type { Env, TransactionRecord } from "../types";
import { AGENT_DIDS } from "../agents/did";
import { getServiceUserLogin, SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";

/** session_id prefix marking a mas_transactions row as cfpay-origin. */
export const CFPAY_LEDGER_SESSION_PREFIX = "screener-payment:";

export function cfpayLedgerSessionId(runRequestId: string): string {
  return `${CFPAY_LEDGER_SESSION_PREFIX}${runRequestId}`;
}

export function isCfpayLedgerRow(tx: TransactionRecord): boolean {
  return String(tx.sessionId ?? "").startsWith(CFPAY_LEDGER_SESSION_PREFIX);
}

/** Find the cfpay row of one kind for one run, if any. */
export function findCfpayRowBySessionAndAction(
  rows: TransactionRecord[],
  runRequestId: string,
  action: "charge" | "credit",
): TransactionRecord | undefined {
  const sessionId = cfpayLedgerSessionId(runRequestId);
  return rows.find((t) => t.sessionId === sessionId && t.action === action);
}

export interface CfpayLedgerChargeInput {
  runRequestId: string;
  userId: string;
  family: string;
  priceUSD: number;
  /** cfpay checkout id; falls back to the run id (checkout requestId). */
  checkoutId?: string;
  claimTxHash?: string;
  paymentIntentId?: string;
}

export interface CfpayLedgerCreditInput {
  runRequestId: string;
  userId: string;
  family: string;
  /** The run's list price: the replacement value owed. */
  priceUSD: number;
}

function rowId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Build the mas_transactions row for a confirmed cfpay payment. */
export function buildCfpayChargeTransaction(
  input: CfpayLedgerChargeInput,
  now: Date = new Date(),
): TransactionRecord {
  const ts = now.toISOString();
  return {
    id: rowId("cfpay"),
    sessionId: cfpayLedgerSessionId(input.runRequestId),
    action: "charge",
    amount: input.priceUSD,
    currency: "USD",
    customer: input.userId,
    gateway: "stripe",
    gatewayRef: input.checkoutId ?? input.runRequestId,
    status: "completed",
    checkoutUrl: "",
    proposerDid: AGENT_DIDS.ORCHESTRATOR,
    proofSignature: input.claimTxHash ?? input.paymentIntentId ?? "none (no on-chain claim recorded)",
    note:
      `${input.family} run ${input.runRequestId} via cfpay checkout` +
      (input.paymentIntentId ? `; payment intent ${input.paymentIntentId}` : ""),
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Build the mas_transactions row for a one-time replacement-run credit.
 * One credit row per run (enforced server-side); a second issue for the
 * same run returns the existing row as a duplicate, never a second row.
 */
export function buildCfpayCreditTransaction(
  input: CfpayLedgerCreditInput,
  now: Date = new Date(),
): TransactionRecord {
  const ts = now.toISOString();
  return {
    id: rowId("cfpay"),
    sessionId: cfpayLedgerSessionId(input.runRequestId),
    action: "credit",
    amount: input.priceUSD,
    currency: "USD",
    customer: input.userId,
    gateway: "stripe",
    gatewayRef: `credit:${input.runRequestId}`,
    status: "completed",
    checkoutUrl: "",
    proposerDid: AGENT_DIDS.ORCHESTRATOR,
    proofSignature: "none (replacement-run credit, no payment)",
    note:
      `One-time replacement-run credit for failed paid run ${input.runRequestId} ` +
      `(${input.family}); redeemable for one future run of the same family; this credit is not a cash refund.`,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Pure reconciliation of one run's ledger rows against the cfpay
 * checkout status: a run counts as paid in exactly one ledger iff a
 * charge row exists exactly when cfpay reports fulfilled/paid. Credit
 * rows do not change the paid-match — a paid-then-failed-then-credited
 * run still counts as paid with a credit owed, not as unpaid.
 */
export interface CfpayReconciliation {
  runRequestId: string;
  cfpayStatus: string;
  chargePresent: boolean;
  creditPresent: boolean;
  matched: boolean;
  reasons: string[];
}

export function reconcileCfpayRun(
  rows: TransactionRecord[],
  runRequestId: string,
  cfpayStatus: string,
): CfpayReconciliation {
  const state = String(cfpayStatus ?? "").toLowerCase();
  const cfpayPaid = state === "fulfilled" || state === "paid";
  const chargePresent = findCfpayRowBySessionAndAction(rows, runRequestId, "charge") !== undefined;
  const creditPresent = findCfpayRowBySessionAndAction(rows, runRequestId, "credit") !== undefined;
  const reasons: string[] = [];
  if (cfpayPaid && !chargePresent) reasons.push("cfpay reports paid but no charge row exists");
  if (!cfpayPaid && chargePresent) reasons.push("charge row exists but cfpay does not report paid");
  return {
    runRequestId,
    cfpayStatus: state,
    chargePresent,
    creditPresent,
    matched: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Client: PaymentWorkflow -> ledger owner (OrchestratorAgent) over SEARCH_AGENT
// ---------------------------------------------------------------------------

interface LedgerStub {
  fetch: (req: Request) => Promise<Response>;
}

function cfpayLedgerStub(env: Env): LedgerStub {
  const ns = (env as unknown as Record<string, unknown>)?.SEARCH_AGENT as
    | { idFromName: (name: string) => unknown; get: (id: unknown) => LedgerStub }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw new Error(
      "cfpay ledger unavailable: SEARCH_AGENT (the mas_transactions ledger owner) is not bound",
    );
  }
  return ns.get(ns.idFromName(SHARED_ORCHESTRATOR_INSTANCE));
}

async function cfpayLedgerFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = cfpayLedgerStub(env);
  // Issue #1185: the forward's identity is the configured service
  // identity — the instance constant above is only the address.
  const serviceLogin = getServiceUserLogin(env);
  if (!serviceLogin) {
    throw new Error(
      "cfpay ledger unavailable: no service identity configured (SERVICE_USER_LOGIN) to forward under",
    );
  }
  try {
    return await stub.fetch(
      new Request(new URL(path, "https://agent.internal"), {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "x-user-login": serviceLogin,
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
    );
  } catch (err) {
    throw new Error(
      `cfpay ledger unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record a cfpay charge or credit row. Idempotent per run+kind: a row
 * that already exists returns `{ duplicate: true }` with the existing
 * record instead of writing a second row. Throws (loud) when the
 * ledger cannot be reached.
 */
export async function recordCfpayLedgerRow(
  env: Env,
  kind: "charge" | "credit",
  input: CfpayLedgerChargeInput | CfpayLedgerCreditInput,
): Promise<{ record: TransactionRecord; duplicate: boolean }> {
  const res = await cfpayLedgerFetch(env, "/payments/agentic/ledger/record-cfpay", {
    method: "POST",
    body: JSON.stringify({ kind, ...input }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { record: TransactionRecord };
    return { record: body.record, duplicate: true };
  }
  if (!res.ok) {
    throw new Error(`cfpay ledger record failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { record: TransactionRecord };
  return { record: body.record, duplicate: false };
}

/** Read back the cfpay rows for one run (reconciliation + verification). Throws on failure. */
export async function listCfpayLedgerRows(
  env: Env,
  runRequestId: string,
): Promise<TransactionRecord[]> {
  const res = await cfpayLedgerFetch(
    env,
    `/payments/agentic/ledger/cfpay?runRequestId=${encodeURIComponent(runRequestId)}`,
  );
  if (!res.ok) {
    throw new Error(`cfpay ledger unavailable: cfpay list returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { rows?: TransactionRecord[] };
  return body.rows ?? [];
}

export interface CfpayAuditEvent {
  type: string;
  runRequestId: string;
  tenantId: string;
  priceUSD?: number;
  checkoutId?: string;
  claimTxHash?: string;
  paymentIntentId?: string;
  /**
   * Screener family (stock | goal | options | strategy). Added by the
   * adapter, which holds the run's family — the flow's events do not
   * carry it. Present on every payment event so the revenue report
   * (#2022) can attribute runs to families without parsing ledger
   * note text.
   */
  family?: string;
  /**
   * How a covered run was covered (subscription_included | credits |
   * free_flag_off | already_paid). Set by the flow on payment.covered
   * events only; used for the per-coverage-type revenue view.
   */
  paidVia?: string;
}

/**
 * Append one mas_events audit row for a payment-lifecycle event.
 * Best-effort by design (mirrors the orchestrator's audit()): on any
 * failure the event is logged loudly to Workers Logs and `false` is
 * returned — an audit write must never fail a paid run's workflow.
 * The ledger row, not this audit row, is the durable record.
 */
export async function recordCfpayAuditEvent(
  env: Env,
  event: CfpayAuditEvent,
): Promise<boolean> {
  try {
    const res = await cfpayLedgerFetch(env, "/api/audit/event", {
      method: "POST",
      body: JSON.stringify({
        type: event.type,
        agent: "payments",
        payload: {
          runRequestId: event.runRequestId,
          tenantId: event.tenantId,
          ...(event.priceUSD !== undefined ? { priceUSD: event.priceUSD } : {}),
          ...(event.checkoutId ? { checkoutId: event.checkoutId } : {}),
          ...(event.claimTxHash ? { claimTxHash: event.claimTxHash } : {}),
          ...(event.paymentIntentId ? { paymentIntentId: event.paymentIntentId } : {}),
          ...(event.family ? { family: event.family } : {}),
          ...(event.paidVia ? { paidVia: event.paidVia } : {}),
        },
      }),
    });
    if (!res.ok) {
      console.error(
        `[payment-workflow] audit write failed: HTTP ${res.status} for ${event.type} run=${event.runRequestId}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[payment-workflow] audit write failed for ${event.type} run=${event.runRequestId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** One usage_events row for a saga paid run (see the meter route). */
export interface MeterUsageInput {
  receiptId: string;
  protocol: "stripe" | "x402";
  userLogin: string;
  priceUSD: number;
}

/**
 * #2041 G-METERING: record one usage_event for a saga paid run
 * via the meter route (same SEARCH_AGENT stub channel as the
 * audit forwarder above). THROWS on any failure (fail-closed):
 * the flow's record-usage step fails and retries durably rather
 * than completing unmetered — the deliberate opposite of the
 * best-effort audit write. A 201 duplicate is informational
 * success (a retried step re-inserting the same receipt-scoped
 * id). Category is fixed to "saga" here (the route also
 * enforces it): only saga-originated runs ever reach this call.
 */
export async function recordMeterUsageEvent(
  env: Env,
  usage: MeterUsageInput,
): Promise<{ duplicate: boolean }> {
  const res = await cfpayLedgerFetch(env, "/api/meter/event", {
    method: "POST",
    body: JSON.stringify({ ...usage, category: "saga" }),
  });
  if (!res.ok) {
    throw new Error(`meter usage record failed: HTTP ${res.status} for receipt=${usage.receiptId}`);
  }
  const body = (await res.json()) as { duplicate?: boolean };
  return { duplicate: body.duplicate ?? false };
}

export interface CfpayRevenueByFamily {
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

export interface CfpayRevenueReport {
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
  byFamily: Record<string, CfpayRevenueByFamily>;
  coveredByPaidVia: Record<string, number>;
  /** Charges with no matching payment.confirmed audit row (audit writes are best-effort). */
  chargesWithoutFamily: number;
  creditsWithoutFamily: number;
  /** Covered runs with no paidVia on the audit row (pre-amendment rows). */
  coveredWithoutPaidVia: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function runIdOfRow(row: TransactionRecord): string | null {
  const sessionId = String(row.sessionId ?? "");
  return sessionId.startsWith(CFPAY_LEDGER_SESSION_PREFIX)
    ? sessionId.slice(CFPAY_LEDGER_SESSION_PREFIX.length)
    : null;
}

function payloadFamily(payload: Record<string, unknown>): string | null {
  return typeof payload["family"] === "string" && (payload["family"] as string)
    ? (payload["family"] as string)
    : null;
}

/**
 * Pure revenue aggregation for #2022. Money is authoritative from
 * the ledger rows; family and coverage attribution come from the
 * audit payloads joined on run id, with explicit "unknown" buckets
 * where an audit row is missing. Totals never depend on audit
 * completeness — only the breakdown does. Cost is an
 * OWNER-DIRECTED ASSUMPTION (1/5 of revenue), not measured cost:
 * no per-run cost accounting exists yet.
 */
export function aggregateCfpayRevenue(
  chargeRows: TransactionRecord[],
  creditRows: TransactionRecord[],
  confirmedPayloads: Array<Record<string, unknown>>,
  coveredPayloads: Array<Record<string, unknown>>,
  creditPayloads: Array<Record<string, unknown>>,
): CfpayRevenueReport {
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

  const byFamily: Record<string, CfpayRevenueByFamily> = {};
  const bucket = (family: string): CfpayRevenueByFamily => {
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
    const run = runIdOfRow(row);
    const amount = Number(row.amount);
    const value = Number.isFinite(amount) ? amount : 0;
    chargeTotal += value;
    const family = run ? (confirmedFamily.get(run) ?? null) : null;
    if (!family) chargesWithoutFamily += 1;
    const b = bucket(family ?? "unknown");
    b.charges += 1;
    b.chargeTotalUSD = round2(b.chargeTotalUSD + value);
  }

  let creditTotal = 0;
  let creditsWithoutFamily = 0;
  for (const row of creditRows) {
    const run = runIdOfRow(row);
    const amount = Number(row.amount);
    const value = Number.isFinite(amount) ? amount : 0;
    creditTotal += value;
    const family = run ? (creditFamily.get(run) ?? null) : null;
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

  // Owner-directed cost assumption (NOT measured cost): cost is 1/5
  // of revenue. Applied per family on charge totals and in total on
  // the charge total, so the "unknown" bucket carries cost too —
  // cost applies to revenue regardless of attribution.
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
