/**
 * Client for the Cloudflare Agentic Payments wallet backend (x402 & MPP),
 * surfaced in the UI by AgenticWalletPanel (issue #139).
 *
 * The wallet status type is imported type-only from src/types so the wire
 * shape stays single-sourced with the server (ETradeAgenticPaymentService
 * .getWalletStatus) — the panel can never drift from the endpoint it calls.
 *
 * Honesty contract (issue #122, carried to this surface by #139): the
 * wallet balance is a SIMULATED local-ledger figure — a local starting
 * credit plus/minus locally recorded entries; the service never reads an
 * on-chain balance. The status payload carries that disclosure itself
 * (simulated / source / startingCreditUSD / note) and this module's
 * helpers keep the disclosure attached to the number: `walletSimulated`
 * defaults to DISCLOSED when the markers are missing, so a payload that
 * omits them can never render as a bare, real-looking balance.
 *
 * All requests go through apiFetch (issue #71): the deployed worker
 * answers with a 202 async-job stub that must be polled — the global
 * fetch would hand the renderer the stub as if it were the payload.
 */

import type { AgenticWalletStatus } from "../types";
import { apiFetch } from "./apiFetch";

export type { AgenticWalletStatus };

/**
 * One row of the durable financial ledger as returned by
 * GET /api/payments/transactions (the orchestrator's transaction-ledger
 * route). The agentic wallet's ledger is the subset of rows whose
 * gateway is "x402" or "mpp" — the same subset the service itself counts
 * in AgenticWalletStatus.transactionCount and the NLQ micropayments_list
 * action lists. There is no separate agentic-ledger endpoint.
 */
export interface AgenticLedgerEntry {
  id: string;
  /** "agentic_payment" (inbound/earned) | "micropayment" (outbound/spent) for wallet rows. */
  action: string;
  amount: number;
  currency: string;
  /** Counterparty: the payer for inbound rows, the recipient for outbound rows. */
  customer: string;
  gateway: string;
  gatewayRef: string;
  /** "simulated" for locally synthesised records; "completed" only after real verification/settlement paths. */
  status: string;
  note: string;
  createdAt: string;
  proposerDid: string;
  authorizerDid?: string;
}

interface TransactionsResponse {
  count?: number;
  transactions?: Array<Record<string, unknown>>;
  error?: string;
}

/** Disclosure used when the payload's own note is absent — the disclosure itself is never absent. */
export const AGENTIC_WALLET_DISCLOSURE_FALLBACK =
  "Simulated local-ledger balance: a local starting credit plus/minus locally recorded agentic payment entries. This wallet does not read any on-chain balance.";

/**
 * True when the balance must be rendered with the simulated disclosure.
 * Disclosure wins every ambiguity: an explicit `simulated: false` is the
 * ONLY payload that renders without it, and a "local-ledger" source
 * forces disclosure even then (a local ledger is simulated by definition).
 */
export function walletSimulated(status: Pick<AgenticWalletStatus, "simulated" | "source">): boolean {
  if (status.source === "local-ledger") return true;
  return status.simulated !== false;
}

/** The disclosure sentence rendered inseparably under the balance: the payload's own note when present. */
export function walletDisclosureNote(status: Pick<AgenticWalletStatus, "note">): string {
  const note = typeof status.note === "string" ? status.note.trim() : "";
  return note || AGENTIC_WALLET_DISCLOSURE_FALLBACK;
}

/**
 * A ledger row is a simulated local record when its status says so (the
 * service records simulated receipts with status "simulated", never
 * "completed") or when its note carries the simulated-record marker the
 * service appends. Simulated rows must never render as verified/settled.
 */
export function isSimulatedLedgerEntry(entry: Pick<AgenticLedgerEntry, "status" | "note">): boolean {
  if (String(entry.status || "").trim().toLowerCase() === "simulated") return true;
  return String(entry.note || "").includes("Simulated local payment record");
}

/** Per-entry status label: simulated rows read "Simulated"; real rows keep their recorded status, titled. */
export function ledgerStatusLabel(entry: Pick<AgenticLedgerEntry, "status" | "note">): string {
  if (isSimulatedLedgerEntry(entry)) return "Simulated";
  switch (String(entry.status || "").trim().toLowerCase()) {
    case "completed":
      return "Completed";
    case "authorized":
      return "Authorized";
    case "failed":
      return "Failed";
    case "awaiting_confirmation":
      return "Awaiting confirmation";
    default:
      return entry.status ? String(entry.status) : "Unknown status";
  }
}

/** Direction label mirroring the service's own accounting (earned vs spent actions). */
export function ledgerDirectionLabel(entry: Pick<AgenticLedgerEntry, "action">): string {
  if (entry.action === "agentic_payment" || entry.action === "charge") return "Earned";
  if (entry.action === "micropayment" || entry.action === "payout") return "Spent";
  return entry.action || "Payment";
}

export async function fetchAgenticWalletStatus(): Promise<AgenticWalletStatus> {
  const resp = await apiFetch("/api/payments/agentic/wallet");
  const data = (await resp.json().catch(() => ({}))) as AgenticWalletStatus & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  // Shape guard (issue #71): a 200 body that is not a wallet status (e.g.
  // an async-job stub that was not polled) must surface as an error
  // state, never reach the renderer and render as a $0 / blank wallet.
  if (!data || typeof data.balanceUSD !== "number" || typeof data.walletAddress !== "string") {
    throw new Error("Unexpected agentic wallet response shape — the status payload was incomplete.");
  }
  return data;
}

export async function fetchAgenticLedger(): Promise<AgenticLedgerEntry[]> {
  const resp = await apiFetch("/api/payments/transactions");
  const data = (await resp.json().catch(() => ({}))) as TransactionsResponse;
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  if (!data || !Array.isArray(data.transactions)) {
    throw new Error("Unexpected transactions response shape — the ledger payload was incomplete.");
  }
  return data.transactions
    .filter((t) => t.gateway === "x402" || t.gateway === "mpp")
    .map((t) => ({
      id: String(t.id ?? ""),
      action: String(t.action ?? ""),
      amount: Number(t.amount || 0),
      currency: String(t.currency || "USD"),
      customer: String(t.customer ?? ""),
      gateway: String(t.gateway || ""),
      gatewayRef: String(t.gatewayRef || ""),
      status: String(t.status ?? ""),
      note: String(t.note || ""),
      createdAt: String(t.createdAt ?? ""),
      proposerDid: String(t.proposerDid || ""),
      authorizerDid: t.authorizerDid ? String(t.authorizerDid) : undefined,
    }));
}

/**
 * Issue #2543: receipts read-back (GET /api/payments/receipts) — the
 * caller's own meter rows, tier-decision audit rows, and joined gateway
 * rows, newest first, each with a derived provenance. No money totals:
 * a summed figure over mixed provenance would read as revenue.
 */
export type ReceiptKind = "meter" | "tier" | "transaction";
export type ReceiptProvenance = "real" | "simulated" | "audit";

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

export interface ReceiptsResponse {
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

export async function fetchReceipts(): Promise<ReceiptsResponse> {
  const resp = await apiFetch("/api/payments/receipts");
  const data = (await resp.json().catch(() => ({}))) as ReceiptsResponse & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  if (!data || !Array.isArray(data.receipts)) {
    throw new Error("Unexpected receipts response shape — the receipts payload was incomplete.");
  }
  return data;
}

/** Row-kind label: what the row evidences. */
export function receiptKindLabel(entry: Pick<ReceiptEntry, "kind">): string {
  switch (entry.kind) {
    case "meter":
      return "Paid call";
    case "tier":
      return "Tier decision";
    case "transaction":
      return "Ledger entry";
    default:
      return "Receipt";
  }
}

/** Provenance label: Real / Simulated / Audit — simulated rows are never "Verified" or "Settled". */
export function receiptProvenanceLabel(entry: Pick<ReceiptEntry, "provenance">): string {
  switch (entry.provenance) {
    case "real":
      return "Real";
    case "simulated":
      return "Simulated";
    case "audit":
      return "Audit";
    default:
      return "Unknown";
  }
}

/** Formats an ISO ledger timestamp for display; falls back to the raw string when unparseable. */
export function fmtLedgerTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
