/**
 * Issue #896 (from the #785 audit): the payment ledger of record is
 * `mas_transactions`, owned by the OrchestratorAgent's SQLite store.
 * This module is the single translation + transport layer between the
 * PaymentsAgent / BudgetGuard world (cents, agent ids, idempotency
 * keys) and that ledger:
 *
 * - Pure mapping/derivation helpers (used by the ledger owner's route
 *   handlers in src/agents/routes/agenticPayments.ts, and unit-pinned
 *   in tests/payments_ledger_state.test.ts).
 * - A client that reaches the ledger owner over the same ORCHESTRATOR_AGENT
 *   Durable Object channel other cross-agent writes use (the
 *   persistAudit pattern, issue #700): stub fetch to the canonical
 *   orchestrator instance. Every client function fails LOUD when the
 *   ledger owner is unbound or unreachable — a payment must never be
 *   recorded into the void again.
 *
 * Attribution rules (the reconciliation contract for BudgetGuard):
 * - A PaymentsAgent-origin row carries session_id
 *   `payments-agent:<agentId>`, gateway_ref = the BudgetGuard
 *   idempotency key, amount in USD (the ledger's unit), status
 *   "completed", action "micropayment", gateway "x402".
 * - Outbound agentic-payments spend (action "micropayment", gateway
 *   x402/mpp, status "completed", recorded by
 *   AgenticPaymentsService.recordPaymentTransaction) is executed by
 *   the orchestrator identity, so it is attributed to agentId
 *   "orchestrator" — the default agent ScheduledAgent budget-checks
 *   for. That is the spend the #785 audit found invisible to the
 *   guard; it now moves it. Inbound agentic earnings
 *   (action "agentic_payment") and simulated rows never count.
 */

import type { BudgetGuardState } from "./budget-guard";
import type { Env, TransactionRecord } from "../types";
import { getServiceUserLogin, SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";

/** The PaymentsAgent ledger record shape (its RPC surface, unchanged). */
export interface PaymentRecord {
  id: string;
  agentId: string;
  operation: string;
  amountCents: number;
  timestamp: string;
  idempotencyKey: string;
  status: "pending" | "verified" | "failed";
}

/** Canonical orchestrator instance that owns the system ledger —
 *  the same instance cron/scheduled traffic uses (cf.
 *  INBOUND_EMAIL_ORCHESTRATOR_INSTANCE in src/trading/email/agent.ts).
 *  This is an ADDRESS (the shared instance name), never an identity:
 *  ledger forwards assert the configured service identity instead
 *  (issue #1185). */
export const PAYMENTS_LEDGER_ORCHESTRATOR_INSTANCE = SHARED_ORCHESTRATOR_INSTANCE;

/** session_id prefix marking a mas_transactions row as PaymentsAgent-origin. */
export const PAYMENTS_AGENT_SESSION_PREFIX = "payments-agent:";

/** BudgetGuard agentId that agentic-payments outbound spend is attributed to. */
export const AGENTIC_SPEND_AGENT_ID = "orchestrator";

const MAX_SEEN_KEYS = 2000;

export function paymentsAgentSessionId(agentId: string): string {
  return `${PAYMENTS_AGENT_SESSION_PREFIX}${agentId}`;
}

export function utcTodayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface LedgerPaymentInput {
  agentId: string;
  operation: string;
  amountCents: number;
  idempotencyKey: string;
  payer?: string;
  proofSignature?: string;
  /**
   * Two-part attribution, part 2 (issue #2426): the edge-
   * authenticated A2A caller identity, when the payment arrived
   * over the A2A door. The ledger row's own attribution stays the
   * agentId (session_id / customer, unchanged — the budget
   * derivation keys on it); the caller part is recorded in the
   * ledger owner's audit record for the write.
   */
  caller?: string;
  /**
   * Issue #2428 (Agent Mesh S17): the W3C trace id of the
   * caller's mesh trace, when the payment arrived over a
   * traced door. Rides the ledger record beside the caller so
   * the write joins the trace it was part of; the budget
   * derivation never keys on it.
   */
  traceId?: string;
  /** Original timestamp to preserve (legacy migration); defaults to now. */
  createdAt?: string;
}

/** Build the mas_transactions row for a verified PaymentsAgent payment. */
export function buildLedgerTransaction(
  input: LedgerPaymentInput,
  proposerDid: string
): TransactionRecord {
  const ts = input.createdAt ?? new Date().toISOString();
  return {
    id: `pay_${crypto.randomUUID().slice(0, 8)}`,
    sessionId: paymentsAgentSessionId(input.agentId),
    action: "micropayment",
    amount: input.amountCents / 100,
    currency: "USD",
    customer: input.agentId,
    gateway: "x402",
    gatewayRef: input.idempotencyKey,
    status: "completed",
    checkoutUrl: "",
    proposerDid,
    authorizerDid: input.payer ? `did:key:${input.payer}` : undefined,
    proofSignature: input.proofSignature || "none (no signature recorded)",
    note: input.operation,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Map a PaymentsAgent-origin ledger row back to the RPC record shape. */
export function toPaymentRecord(tx: TransactionRecord): PaymentRecord {
  const sid = String(tx.sessionId ?? "");
  return {
    id: String(tx.id),
    agentId: sid.startsWith(PAYMENTS_AGENT_SESSION_PREFIX)
      ? sid.slice(PAYMENTS_AGENT_SESSION_PREFIX.length)
      : String(tx.customer ?? ""),
    operation: String(tx.note ?? ""),
    amountCents: Math.round(Number(tx.amount) * 100),
    timestamp: String(tx.createdAt),
    idempotencyKey: String(tx.gatewayRef ?? ""),
    status: "verified",
  };
}

export function isPaymentsAgentRow(tx: TransactionRecord): boolean {
  return String(tx.sessionId ?? "").startsWith(PAYMENTS_AGENT_SESSION_PREFIX);
}

/** Find the PaymentsAgent-origin row carrying an idempotency key, if any. */
export function findPaymentsAgentRowByKey(
  rows: TransactionRecord[],
  idempotencyKey: string
): TransactionRecord | undefined {
  return rows.find((t) => isPaymentsAgentRow(t) && t.gatewayRef === idempotencyKey);
}

/**
 * Derive BudgetGuard state from the ledger of record. This is the
 * reconciliation the #785 audit required: the guard no longer keeps
 * its own spend/idempotency state — every check restores the guard
 * from mas_transactions, so ledger spend and guard truth cannot
 * diverge. `agentId === null` derives the cross-agent view (used by
 * todaySpent); a specific agentId scopes spend and keys to that agent
 * (agentic outbound spend counts only for the orchestrator identity).
 */
export function deriveBudgetGuardState(
  rows: TransactionRecord[],
  agentId: string | null,
  today: string = utcTodayKey()
): BudgetGuardState {
  const spendByAgent = new Map<string, number>();
  const seen: Array<{ key: string; createdAt: string }> = [];
  const addSpend = (agent: string, cents: number) =>
    spendByAgent.set(agent, (spendByAgent.get(agent) ?? 0) + cents);

  for (const row of rows) {
    if (row.status !== "completed") continue;
    const cents = Math.round(Number(row.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const createdAt = String(row.createdAt ?? "");

    if (isPaymentsAgentRow(row)) {
      const owner = String(row.sessionId).slice(PAYMENTS_AGENT_SESSION_PREFIX.length);
      if (agentId !== null && owner !== agentId) continue;
      if (row.gatewayRef) seen.push({ key: String(row.gatewayRef), createdAt });
      if (createdAt.startsWith(today)) addSpend(owner, cents);
      continue;
    }

    // Agentic-payments outbound spend (see header: attribution rules).
    if (
      row.action === "micropayment" &&
      (row.gateway === "x402" || row.gateway === "mpp") &&
      (agentId === null || agentId === AGENTIC_SPEND_AGENT_ID) &&
      createdAt.startsWith(today)
    ) {
      addSpend(AGENTIC_SPEND_AGENT_ID, cents);
    }
  }

  seen.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seenKeys = seen.slice(-MAX_SEEN_KEYS).map((s) => s.key);
  const dailySpend: Array<[string, string, number]> = [];
  for (const [agent, cents] of spendByAgent) {
    if (cents > 0) dailySpend.push([agent, today, cents]);
  }
  return { dailySpend, seenKeys };
}

// ---------------------------------------------------------------------------
// Client: PaymentsAgent -> ledger owner (OrchestratorAgent) over ORCHESTRATOR_AGENT
// ---------------------------------------------------------------------------

interface LedgerStub {
  fetch: (req: Request) => Promise<Response>;
}

function ledgerStub(env: Env): LedgerStub {
  const ns = (env as any)?.ORCHESTRATOR_AGENT as
    | { idFromName: (name: string) => unknown; get: (id: unknown) => LedgerStub }
    | undefined;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw new Error(
      "payment ledger unavailable: ORCHESTRATOR_AGENT (the mas_transactions ledger owner) is not bound"
    );
  }
  return ns.get(ns.idFromName(PAYMENTS_LEDGER_ORCHESTRATOR_INSTANCE));
}

async function ledgerFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = ledgerStub(env);
  // Issue #1185: the forward's identity is the configured service
  // identity — the instance constant above is only the address.
  const serviceLogin = getServiceUserLogin(env);
  if (!serviceLogin) {
    throw new Error(
      "payment ledger unavailable: no service identity configured (SERVICE_USER_LOGIN) to forward under"
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
      })
    );
  } catch (err) {
    throw new Error(
      `payment ledger unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** BudgetGuard state derived from the ledger of record. Throws (loud) on any failure. */
export async function fetchLedgerBudgetState(
  env: Env,
  agentId?: string
): Promise<BudgetGuardState> {
  const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await ledgerFetch(env, `/payments/agentic/ledger/budget-state${q}`);
  if (!res.ok) {
    throw new Error(`payment ledger unavailable: budget-state returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { state?: BudgetGuardState };
  if (!body.state) throw new Error("payment ledger unavailable: malformed budget-state response");
  return body.state;
}

/**
 * Record a verified payment in mas_transactions. Idempotent by
 * idempotency key: a key that already has a row returns
 * `{ duplicate: true }` with the existing record instead of writing
 * a second row. Throws (loud) when the ledger cannot be reached.
 */
export async function recordLedgerPayment(
  env: Env,
  input: LedgerPaymentInput
): Promise<{ record: PaymentRecord; duplicate: boolean }> {
  const res = await ledgerFetch(env, "/payments/agentic/ledger/record", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { record: PaymentRecord };
    return { record: body.record, duplicate: true };
  }
  if (!res.ok) {
    throw new Error(`payment ledger record failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { record: PaymentRecord };
  return { record: body.record, duplicate: false };
}

/** Recent PaymentsAgent-origin payments, read back from the ledger. Throws on failure. */
export async function listLedgerPayments(env: Env, limit: number = 50): Promise<PaymentRecord[]> {
  const res = await ledgerFetch(
    env,
    `/payments/agentic/ledger/payments?limit=${encodeURIComponent(String(limit))}`
  );
  if (!res.ok) {
    throw new Error(`payment ledger unavailable: payments list returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { payments?: PaymentRecord[] };
  return body.payments ?? [];
}
