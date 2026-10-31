/**
 * Client for the broker account endpoints surfaced by issue #67:
 * alerts, transactions, watchlists, and remote (broker-side) orders.
 * Response types are type-only imports from src/types — single-sourced.
 */

import type {
  ETradeAlert,
  ETradeAlertDetails,
  ETradeCancelOrderResult,
  ETradeRemoteOrder,
  ETradeTransaction,
  ETradeTransactionDetails,
  ETradeWatchlist,
} from "../types";
import { apiFetch } from "./apiFetch";

export type { ETradeAlert, ETradeAlertDetails, ETradeCancelOrderResult, ETradeRemoteOrder, ETradeTransaction, ETradeTransactionDetails, ETradeWatchlist };

/**
 * Issue #2573: the client-side end of the coded broker-error contract.
 *
 * The broker routes now answer a failure with the coded form
 * `{ code, message, retryable }` (see
 * `src/agents/routes/brokerCodedError.ts`). These helpers render
 * exactly that coded message — `"[CODE] business message"` — and
 * NEVER the server's `error` field, which used to carry the raw
 * broker `lastError` string (raw upstream body included, e.g.
 * `oauth_problem=...`). A response without a coded payload falls
 * back to the generic coded message below, not to the raw string
 * and not to a bare HTTP status. That fallback's code and wording
 * match the `FAILURE_ETRADE_UPSTREAM` catalog entry verbatim; this
 * module does not resolve codes itself — the catalog remains the
 * single resolver, server-side.
 *
 * Consequence for `AccountPanels.tsx`: every error it renders from
 * these helpers is already a coded message, so assigning
 * `err.message` into an error div is safe here — the translation
 * happens in this module, before the panel ever sees the string.
 */
export const ACCOUNT_PANEL_FALLBACK_MESSAGE =
  "[FAILURE_ETRADE_UPSTREAM] Broker data is temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.";

type CodedErrorBody = { code?: string; message?: string; error?: string };

function codedErrorFromBody(data: CodedErrorBody): Error {
  if (data.code && data.message) {
    const err = new Error(`[${data.code}] ${data.message}`);
    (err as Error & { code?: string }).code = data.code;
    return err;
  }
  // No coded payload (legacy/uncoded error, validation error, or a
  // body that failed to parse): generic coded message, never the
  // raw `error` field.
  return new Error(ACCOUNT_PANEL_FALLBACK_MESSAGE);
}

async function getJson<T>(path: string, env: string): Promise<T> {
  const resp = await apiFetch(path, { headers: { "x-environment": env } });
  const data = (await resp.json().catch(() => ({}))) as T & CodedErrorBody;
  if (!resp.ok) throw codedErrorFromBody(data);
  return data;
}

async function sendJson<T>(path: string, env: string, method: string, body?: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method,
    headers: { "Content-Type": "application/json", "x-environment": env },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as T & CodedErrorBody;
  if (!resp.ok) throw codedErrorFromBody(data);
  return data;
}

// Alerts ----------------------------------------------------------------------

/**
 * The broker returns alert createTime in epoch SECONDS while the rest of
 * the app (and the alert type) uses epoch milliseconds — unnormalized,
 * alerts render as January 1970. Values below 1e12 are seconds-scale for
 * any date in this product's lifetime; normalize them to ms.
 */
export function normalizeEpochMs(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

export async function fetchAlerts(env: string): Promise<{ count: number; alerts: ETradeAlert[] }> {
  const data = await getJson<{ count: number; alerts: ETradeAlert[] }>("/api/etrade/alerts?count=50", env);
  // Shape guard (issue #71): never hand the renderer a non-array.
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  return { count: data?.count ?? 0, alerts: alerts.map((a) => ({ ...a, createTime: normalizeEpochMs(a.createTime) })) };
}

export async function fetchAlertDetails(env: string, id: string | number): Promise<ETradeAlertDetails> {
  const details = await getJson<ETradeAlertDetails>(`/api/etrade/alerts/${encodeURIComponent(String(id))}`, env);
  return { ...details, createTime: normalizeEpochMs(details.createTime) };
}

export function deleteAlert(env: string, id: string | number): Promise<{ success: boolean }> {
  return sendJson(`/api/etrade/alerts/${encodeURIComponent(String(id))}`, env, "DELETE");
}

// Transactions ----------------------------------------------------------------

export async function fetchTransactions(env: string): Promise<{ count: number; transactions: ETradeTransaction[] }> {
  const data = await getJson<{ count: number; transactions: ETradeTransaction[] }>("/api/etrade/transactions?count=50&sortOrder=DESC", env);
  return { count: data?.count ?? 0, transactions: Array.isArray(data?.transactions) ? data.transactions : [] };
}

export function fetchTransactionDetails(env: string, id: string): Promise<ETradeTransactionDetails> {
  return getJson(`/api/etrade/transactions/${encodeURIComponent(id)}`, env);
}

// Watchlists ------------------------------------------------------------------

export async function fetchWatchlists(env: string): Promise<{ count: number; watchlists: ETradeWatchlist[] }> {
  const data = await getJson<{ count: number; watchlists: ETradeWatchlist[] }>("/api/etrade/watchlists", env);
  return { count: data?.count ?? 0, watchlists: Array.isArray(data?.watchlists) ? data.watchlists : [] };
}

export function fetchWatchlistDetails(env: string, id: string | number): Promise<ETradeWatchlist> {
  return getJson(`/api/etrade/watchlist/details?id=${encodeURIComponent(String(id))}`, env);
}

// Positions ------------------------------------------------------------------

/**
 * Issue #2116: symbols held in the portfolio, for the tape's holdings set.
 * Option contracts are excluded — their broker symbols are not
 * feed-servable tape symbols. Returns [] when the account is unconnected.
 */
export async function fetchPositionSymbols(env: string): Promise<string[]> {
  const data = await getJson<{ positions?: { symbol?: unknown; optionType?: unknown }[] }>(
    "/api/etrade/positions",
    env,
  );
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  const symbols: string[] = [];
  for (const p of positions) {
    if (p?.optionType) continue;
    if (typeof p?.symbol === "string" && p.symbol.trim()) symbols.push(p.symbol);
  }
  return parseSymbolList(symbols.join(","));
}

export function createWatchlist(env: string, name: string, symbols: string[]): Promise<unknown> {
  return sendJson("/api/etrade/watchlist/create", env, "POST", { name, symbols });
}

export function saveScreenAsWatchlist(env: string, name: string, symbols: string[]): Promise<unknown> {
  return sendJson("/api/etrade/watchlist/save-screen", env, "POST", { name, symbols });
}

export function deleteWatchlist(env: string, id: string | number): Promise<{ success: boolean }> {
  return sendJson(`/api/etrade/watchlist/delete?id=${encodeURIComponent(String(id))}`, env, "DELETE");
}

// Remote (broker-side) orders ---------------------------------------------------

export async function fetchRemoteOrders(env: string): Promise<{ count: number; orders: ETradeRemoteOrder[] }> {
  const data = await getJson<{ count: number; orders: ETradeRemoteOrder[] }>("/api/etrade/orders/remote?count=50", env);
  return { count: data?.count ?? 0, orders: Array.isArray(data?.orders) ? data.orders : [] };
}

export function cancelRemoteOrder(env: string, orderId: string | number): Promise<ETradeCancelOrderResult> {
  return sendJson("/api/etrade/orders/cancel", env, "POST", { orderId });
}

// Helpers (unit-tested) ---------------------------------------------------------

/** Parses a free-form symbol list ("aapl, msft  SPY") into unique uppercase symbols. */
export function parseSymbolList(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    const symbol = token.trim().toUpperCase();
    if (symbol) seen.add(symbol);
  }
  return [...seen];
}
