/**
 * Issue #2543 (Monetization Phase 1.4): receipts/ledger surfacing.
 *
 * The single user's read-back over the existing stores — no new ledger,
 * no new table (one additive mas_events index, shipped in the retention
 * ensure path), no port changes, no pins touched:
 *
 * - Meter rows: usage_events WHERE user_login=? (indexed), WITH
 *   detail_json (the usage port's listByUser drops it, so this module
 *   reads over the sql seam with the adapter's raw-SQL pattern).
 * - Tier decisions: mas_events WHERE session_id=? AND
 *   type='commercial.tier.decision' — sessionId=userLogin is PROVEN by
 *   the slice-3 write sites (agenticPayments.ts). Other commercial.*
 *   route audit rows are EXCLUDED: their sessionId is the DO session
 *   key (orchestrator recordAudit), not the user login, and joining
 *   them needs a session→user mapping that does not exist.
 * - Gateway rows: joined, never the unscoped list — PRIMARY KEY
 *   lookups id = tx_<receiptId> per meter receipt (proven join key,
 *   agenticPayments.ts:1023) + one bounded customer=login query for
 *   Stripe/cfpay rows (customer=userId proven in stripeCheckoutAdapter
 *   / cfpayLedger). Deduped by id.
 *
 * Identity: the caller is the session login (x-user-login, set by the
 * worker from the verified session). Anonymous payer-scope rows
 * (userLogin = x402:<payer>) are recorded but NEVER returned to a
 * session caller — a different identity key with no proof mapping;
 * read-back for them arrives with Phase 2 identity work.
 *
 * Provenance is derived, never asserted (issue #122):
 * - Meter rows are real by construction: the gate only meters verified,
 *   served calls (x402 on-chain claim verification, mpp via the mppx
 *   gateway). A corrupt detail_json keeps the row (its existence proves
 *   the served call) with null price/tier/protocol.
 * - Gateway rows are simulated iff status is "simulated", the note
 *   carries a SIMULATED marker, or the proof signature is the unsigned
 *   simulated marker — mirroring (and extending) the client's
 *   isSimulatedLedgerEntry. Anything else is real with its gateway named.
 * - Tier decisions are audit rows: they evidence a decision, not a payment.
 *
 * No money totals are computed here: a summed figure over mixed
 * provenance would read as revenue. Counts by kind + by provenance only.
 * This module moves no money and confirms nothing — it is read-only.
 */
import { SIMULATED_PROOF_SIGNATURE } from "./agenticPayments";

export { SIMULATED_PROOF_SIGNATURE };

export type ReceiptKind = "meter" | "tier" | "transaction";
export type ReceiptProvenance = "real" | "simulated" | "audit";

export interface MeterReceiptRow {
  id: string;
  runId: string;
  category: string;
  createdAt: string;
  receiptId: string;
  priceUSD: number | null;
  tier: string | null;
  protocol: string | null;
  detailAvailable: boolean;
}

export interface TierDecisionRow {
  id: string;
  createdAt: string;
  userLogin: string;
  tier: string;
  receiptId: string;
  category: string;
  priceUSD: number;
  protocol: string;
}

export interface GatewayReceiptRow {
  id: string;
  sessionId: string;
  action: string;
  amount: number;
  currency: string;
  customer: string;
  gateway: string;
  gatewayRef: string;
  status: string;
  checkoutUrl: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptEntry {
  id: string;
  kind: ReceiptKind;
  createdAt: string;
  provenance: ReceiptProvenance;
  provenanceNote: string;
  receiptId: string | null;
  amountUSD: number | null;
  tier: string | null;
  protocol: string | null;
  gateway: string | null;
  status: string | null;
}

export interface ReceiptsResult {
  userLogin: string;
  limit: number;
  receipts: ReceiptEntry[];
  counts: {
    meter: number;
    tier: number;
    transaction: number;
    real: number;
    simulated: number;
    audit: number;
  };
}

/** Exact meter read (SEARCHes idx_usage_events_user). */
export const METER_RECEIPTS_SQL =
  "SELECT id, user_login, run_id, category, created_at, detail_json FROM usage_events WHERE user_login = ? ORDER BY created_at DESC LIMIT ?";

/** Exact tier-decision read (SEARCHes idx_mas_events_session_type). */
export const TIER_DECISIONS_SQL =
  "SELECT * FROM mas_events WHERE session_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?";

export const TIER_DECISION_TYPE = "commercial.tier.decision";

/** Meter rows are real by construction: the gate only meters verified, served calls. */
export function resolveMeterProvenance(protocol: string | null): {
  provenance: "real";
  note: string;
} {
  return {
    provenance: "real",
    note: protocol
      ? `Verified ${protocol} payment served through the premium gate`
      : "Verified paid call served through the premium gate (protocol detail unavailable)",
  };
}

/** Gateway rows are simulated iff the SIMULATED markers say so. The note
 *  check is deliberately case-insensitive (an extension beyond the
 *  client's exact-phrase rule): it errs toward simulated, never toward
 *  real — a real payment's note never mentions simulation in any case. */
export function resolveGatewayProvenance(row: {
  status: string;
  note: string;
  proofSignature: string;
  gateway?: string;
}): { provenance: "real" | "simulated"; note: string } {
  const status = String(row.status || "")
    .trim()
    .toLowerCase();
  if (
    status === "simulated" ||
    String(row.note || "")
      .toLowerCase()
      .includes("simulated")
  ) {
    return {
      provenance: "simulated",
      note: "Simulated local record — no real payment was made or verified",
    };
  }
  if (row.proofSignature === SIMULATED_PROOF_SIGNATURE) {
    return {
      provenance: "simulated",
      note: "Simulated local record — unsigned proof, no on-chain settlement",
    };
  }
  return {
    provenance: "real",
    note: `Recorded ${row.gateway || "gateway"} payment`,
  };
}

/** Pure composition: map the three stores' rows into one newest-first receipt list, capped at limit. */
export function buildReceipts(input: {
  userLogin: string;
  meterRows: MeterReceiptRow[];
  tierRows: TierDecisionRow[];
  gatewayRows: GatewayReceiptRow[];
  limit: number;
}): ReceiptsResult {
  const entries: ReceiptEntry[] = [];
  for (const m of input.meterRows) {
    const p = resolveMeterProvenance(m.protocol);
    entries.push({
      id: m.id,
      kind: "meter",
      createdAt: m.createdAt,
      provenance: p.provenance,
      provenanceNote: p.note,
      receiptId: m.receiptId,
      amountUSD: m.priceUSD,
      tier: m.tier,
      protocol: m.protocol,
      gateway: null,
      status: "served",
    });
  }
  for (const t of input.tierRows) {
    entries.push({
      id: t.id,
      kind: "tier",
      createdAt: t.createdAt,
      provenance: "audit",
      provenanceNote: "Tier-decision audit row (evidence of a decision, not a payment)",
      receiptId: t.receiptId,
      amountUSD: t.priceUSD,
      tier: t.tier,
      protocol: t.protocol,
      gateway: null,
      status: null,
    });
  }
  for (const g of input.gatewayRows) {
    const p = resolveGatewayProvenance(g);
    entries.push({
      id: g.id,
      kind: "transaction",
      createdAt: g.createdAt,
      provenance: p.provenance,
      provenanceNote: p.note,
      receiptId: g.gatewayRef || null,
      amountUSD: g.amount,
      tier: null,
      protocol: null,
      gateway: g.gateway,
      status: g.status,
    });
  }
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  const capped = entries.slice(0, input.limit);
  const counts = { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 };
  for (const e of capped) {
    counts[e.kind] += 1;
    counts[e.provenance] += 1;
  }
  return { userLogin: input.userLogin, limit: input.limit, receipts: capped, counts };
}

export interface ReceiptSqlExecutor {
  exec(query: string, ...args: unknown[]): Iterable<unknown> | unknown[];
}

export interface ReceiptOrm {
  transactions: {
    findById(id: string): unknown | null;
    findMany(options: {
      where?: Record<string, unknown>;
      orderBy?: string;
      limit?: number;
    }): unknown[];
  };
}

/** Meter rows WITH detail_json (the usage port's listByUser drops it). */
export function readMeterRows(
  sql: ReceiptSqlExecutor,
  userLogin: string,
  limit: number,
): MeterReceiptRow[] {
  const rows = Array.from(sql.exec(METER_RECEIPTS_SQL, userLogin, limit)) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(String(r.detail_json ?? ""));
      detail = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    // runId is the receipt id by slice-2 construction, so it is the safe
    // fallback when detail is corrupt; the row itself proves the served call.
    return {
      id: String(r.id ?? ""),
      runId: String(r.run_id ?? ""),
      category: String(r.category ?? ""),
      createdAt: String(r.created_at ?? ""),
      receiptId:
        detail && detail.receiptId ? String(detail.receiptId) : String(r.run_id ?? ""),
      priceUSD:
        detail && typeof detail.priceUSD === "number" ? (detail.priceUSD as number) : null,
      tier: detail && detail.tier ? String(detail.tier) : null,
      protocol: detail && detail.protocol ? String(detail.protocol) : null,
      detailAvailable: detail !== null,
    };
  });
}

/** Tier-decision rows for one login. Unparseable payloads are skipped: without the payload there is no tier evidence. */
export function readTierDecisions(
  sql: ReceiptSqlExecutor,
  userLogin: string,
  limit: number,
): TierDecisionRow[] {
  const rows = Array.from(
    sql.exec(TIER_DECISIONS_SQL, userLogin, TIER_DECISION_TYPE, limit),
  ) as Array<Record<string, unknown>>;
  const out: TierDecisionRow[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(r.payload ?? ""));
      if (!parsed || typeof parsed !== "object") continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({
      id: String(r.id ?? ""),
      createdAt: String(r.created_at ?? ""),
      userLogin: payload.userLogin ? String(payload.userLogin) : userLogin,
      tier: payload.tier ? String(payload.tier) : "",
      receiptId: payload.receiptId ? String(payload.receiptId) : "",
      category: payload.category ? String(payload.category) : "",
      priceUSD: typeof payload.priceUSD === "number" ? (payload.priceUSD as number) : 0,
      protocol: payload.protocol ? String(payload.protocol) : "",
    });
  }
  return out;
}

function coerceGatewayRow(row: Record<string, unknown>): GatewayReceiptRow {
  return {
    id: String(row.id ?? ""),
    sessionId: String(row.sessionId ?? ""),
    action: String(row.action ?? ""),
    amount: typeof row.amount === "number" ? (row.amount as number) : Number(row.amount || 0),
    currency: String(row.currency || "USD"),
    customer: String(row.customer ?? ""),
    gateway: String(row.gateway ?? ""),
    gatewayRef: String(row.gatewayRef ?? ""),
    status: String(row.status ?? ""),
    checkoutUrl: String(row.checkoutUrl ?? ""),
    proposerDid: String(row.proposerDid ?? ""),
    authorizerDid: row.authorizerDid ? String(row.authorizerDid) : undefined,
    proofSignature: String(row.proofSignature ?? ""),
    note: String(row.note ?? ""),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

/** Gateway rows joined to the caller: PRIMARY KEY lookups per meter receiptId + one bounded customer query. Deduped by id. */
export function readGatewayRows(
  orm: ReceiptOrm,
  userLogin: string,
  receiptIds: string[],
  limit: number,
): GatewayReceiptRow[] {
  const byId = new Map<string, GatewayReceiptRow>();
  for (const receiptId of receiptIds) {
    const row = orm.transactions.findById(`tx_${receiptId}`) as Record<string, unknown> | null;
    if (row) byId.set(String(row.id ?? ""), coerceGatewayRow(row));
  }
  const customerRows = orm.transactions.findMany({
    where: { customer: userLogin },
    orderBy: "created_at DESC",
    limit,
  }) as Array<Record<string, unknown>>;
  for (const row of customerRows) {
    byId.set(String(row.id ?? ""), coerceGatewayRow(row));
  }
  return [...byId.values()];
}

/**
 * Full read-back for one login. Meter rows are always read (they supply
 * the gateway join keys); the kind filter applies to the OUTPUT, so
 * kind=transaction still joins gateway rows by receiptId.
 */
export function readReceipts(
  deps: { sql: ReceiptSqlExecutor; orm: ReceiptOrm },
  userLogin: string,
  opts: { limit: number; kind: "meter" | "tier" | "transaction" | "all" },
): ReceiptsResult {
  const meterRows = readMeterRows(deps.sql, userLogin, opts.limit);
  const tierRows =
    opts.kind === "all" || opts.kind === "tier"
      ? readTierDecisions(deps.sql, userLogin, opts.limit)
      : [];
  const gatewayRows =
    opts.kind === "all" || opts.kind === "transaction"
      ? readGatewayRows(
          deps.orm,
          userLogin,
          meterRows.map((m) => m.receiptId),
          opts.limit,
        )
      : [];
  return buildReceipts({
    userLogin,
    meterRows: opts.kind === "all" || opts.kind === "meter" ? meterRows : [],
    tierRows,
    gatewayRows,
    limit: opts.limit,
  });
}
