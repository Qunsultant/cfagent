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
  outcome: "traded" | "no_trade" | "refused" | "inactive";
  entries: string[];
  exits: StockCopilotActivityExit[];
  detail: string | null;
}

export type StockCopilotStatusKind =
  | "off"
  | "paused"
  | "outside_market_hours"
  | "live"
  | "mode_unresolved"
  | "inactive_broker";

export interface StockCopilotStatus {
  flagEnabled: boolean;
  paused: boolean;
  marketOpen: boolean;
  status: StockCopilotStatusKind;
  /** #3451: the effective trading selection the next cycle runs
   *  under (from the panel menu's selection model). */
  selectionResolved: boolean;
  activeBroker: string | null;
  activeMode: "paper" | "live" | null;
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

const BROKER_DISPLAY_NAMES: Record<string, string> = {
  alpaca: "Alpaca",
  etrade: "E*TRADE",
};

/**
 * #3451: the effective selection as the panel shows it — e.g.
 * "Alpaca · Paper" / "Alpaca · Live". Null when the selection did
 * not resolve (the status kind carries that state instead).
 * Display-only: selection itself lives in the dynamic panel menu.
 */
export function copilotSelectionLabel(status: StockCopilotStatus): string | null {
  if (!status.selectionResolved || !status.activeBroker || !status.activeMode) {
    return null;
  }
  const broker =
    BROKER_DISPLAY_NAMES[status.activeBroker] ?? status.activeBroker;
  const mode = status.activeMode === "paper" ? "Paper" : "Live";
  return `${broker} · ${mode}`;
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
