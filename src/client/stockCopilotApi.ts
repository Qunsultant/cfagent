/**
 * Client for the Stock Copilot surface endpoints (issue #3422):
 * GET /api/stock-copilot/status and POST /api/stock-copilot/control.
 *
 * The status read composes the signed-in user's own copilot loop
 * state (flag, pause control, market hours, positions, activity);
 * the control write is the panel's pause/resume — the only write
 * this surface makes. Shapes mirror src/agents/routes/stockCopilot.ts.
 */

import { apiFetch } from "./apiFetch";

export interface StockCopilotOpenPosition {
  id: string;
  symbol: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  brokerOrderRef: string;
  openedAt: string;
}

export interface StockCopilotClosedPosition {
  id: string;
  symbol: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface StockCopilotActivityExit {
  symbol: string;
  reason: string;
}

export interface StockCopilotActivityRecord {
  id: string;
  cycleAt: string;
  outcome: "traded" | "no_trade" | "refused";
  entries: string[];
  exits: StockCopilotActivityExit[];
  detail: string | null;
}

export type StockCopilotStatusKind =
  | "off"
  | "paused"
  | "outside_market_hours"
  | "live";

export interface StockCopilotStatus {
  flagEnabled: boolean;
  paused: boolean;
  marketOpen: boolean;
  status: StockCopilotStatusKind;
  userLogin: string;
  controlUpdatedAt: string | null;
  openPositions: StockCopilotOpenPosition[];
  closedPositions: StockCopilotClosedPosition[];
  activity: StockCopilotActivityRecord[];
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchStockCopilotStatus(): Promise<StockCopilotStatus> {
  const data = await send<StockCopilotStatus>("/api/stock-copilot/status");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return {
    ...data,
    openPositions: Array.isArray(data?.openPositions) ? data.openPositions : [],
    closedPositions: Array.isArray(data?.closedPositions) ? data.closedPositions : [],
    activity: Array.isArray(data?.activity) ? data.activity : [],
  };
}

export async function setStockCopilotPaused(
  paused: boolean,
): Promise<{ ok: boolean; paused: boolean }> {
  return send<{ ok: boolean; paused: boolean }>("/api/stock-copilot/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
}

/** "Nov 4, 2026, 10:00 AM" style timestamp; "—" for missing/invalid. */
export function fmtCopilotTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "$98.00" style price; "—" for missing values. */
export function fmtCopilotMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Business labels for the cycle's exit reasons. */
export function exitReasonLabel(reason: string | null): string {
  switch (reason) {
    case "strategy_exit":
      return "Strategy exit";
    case "stop_loss":
      return "Stop loss";
    case "take_profit":
      return "Take profit";
    default:
      return reason ?? "Closed";
  }
}
