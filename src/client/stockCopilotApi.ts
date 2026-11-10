/**
 * Client for the Stock Copilot surface endpoints (issue #3422):
 * GET /api/stock-copilot/status and POST /api/stock-copilot/control.
 *
 * The status read composes the signed-in user's own copilot loop
 * state (flag, pause control, sessions, positions, activity); the
 * control writes are the panel's pause/resume (#3422) and its
 * enabled-sessions choice (#3398). Shapes mirror
 * src/agents/routes/stockCopilot.ts.
 */

import { apiFetch } from "./apiFetch";
import { currentBrokerLabel } from "./tenantProviders";

/** #3398: the copilot's trading sessions, in canonical order. */
export type StockCopilotSessionId =
  | "pre_market"
  | "regular"
  | "after_hours"
  | "exto";

export const COPILOT_SESSION_IDS: readonly StockCopilotSessionId[] = [
  "pre_market",
  "regular",
  "after_hours",
  "exto",
];

/** Display facts per session (label + ET hours, Mon–Fri unless noted). */
export const COPILOT_SESSION_VIEWS: Record<
  StockCopilotSessionId,
  { label: string; hours: string }
> = {
  pre_market: { label: "Pre-market", hours: "4:00–9:30 AM ET" },
  regular: { label: "Regular", hours: "9:30 AM–4:00 PM ET" },
  after_hours: { label: "After-hours", hours: "4:00–8:00 PM ET" },
  exto: { label: "Overnight (EXTO)", hours: "8:00 PM–4:00 AM ET, Sun–Thu nights" },
};

/** Business label for a session id; the raw id for unknown values. */
export function copilotSessionLabel(session: string | null): string {
  if (!session) return "No session";
  return (
    COPILOT_SESSION_VIEWS[session as StockCopilotSessionId]?.label ?? session
  );
}

export interface StockCopilotOpenPosition {
  id: string;
  symbol: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  brokerOrderRef: string;
  /** #3398: the session + order type the entry was placed under. */
  entrySession: string | null;
  entryOrderType: string | null;
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
  outcome: "traded" | "no_trade" | "refused" | "inactive" | "outside_sessions" | "selection_changed";
  /** #3398: the session the cycle fired in; null when none was open. */
  session: string | null;
  entries: string[];
  exits: StockCopilotActivityExit[];
  detail: string | null;
}

export type StockCopilotStatusKind =
  | "off"
  | "paused"
  | "outside_enabled_sessions"
  | "live"
  | "mode_unresolved"
  | "inactive_broker"
  | "never_executed";

/**
 * #3738: one channel's switch resolution as the status read
 * projects it (src/services/copilotChannels.ts) — the switch state
 * and the layer that decided it.
 */
export interface CopilotChannelSwitchStatus {
  enabled: boolean;
  source: "stored" | "env" | "default";
}

/**
 * #3738: the voice channel's projection — the switch composed
 * with the #3720 class-level activation. `effective` is what
 * serves: switch on AND the manifest activation enabled. The
 * panel renders its voice control exactly when effective is true.
 */
export interface CopilotVoiceChannelStatus extends CopilotChannelSwitchStatus {
  manifestState: string;
  effective: boolean;
}

/** #3738: the stock registration's channel switches, by channel. */
export interface StockCopilotChannelsStatus {
  chat: CopilotChannelSwitchStatus;
  webhooks: CopilotChannelSwitchStatus;
  email: CopilotChannelSwitchStatus;
  slack: CopilotChannelSwitchStatus;
  voice: CopilotVoiceChannelStatus;
}

export interface StockCopilotStatus {
  flagEnabled: boolean;
  paused: boolean;
  marketOpen: boolean;
  /** #3398: the session open right now, or null when none is. */
  currentSession: StockCopilotSessionId | null;
  /** #3398: the sessions the user has enabled for the copilot. */
  enabledSessions: StockCopilotSessionId[];
  cadence?: {
    configured: string;
    effective: string;
  };
  universe?: string[];
  universePreset?: string | null;
  /** #3936: where the reported universe came from — the stored index
   *  membership, the labelled preset fallback, or the configured list. */
  universeSource?: "configured" | "stored-index" | "preset-fallback";
  universeStale?: boolean;
  universeSnapshotDate?: string | null;
  universeFallbackReason?: string | null;
  strategies?: string[];
  status: StockCopilotStatusKind;
  /** #3451: the effective trading selection the next cycle runs
   *  under (from the panel menu's selection model). */
  selectionResolved: boolean;
  activeBroker: string | null;
  activeMode: "paper" | "live" | null;
  /** #3899: true when no cycle has ever executed (no activity record
   *  and no cycle row in the runs ledger). */
  neverExecuted?: boolean;
  /** #3899: the latest recorded cycle, or null when none ever ran. */
  lastCycle?: StockCopilotActivityRecord | null;
  userLogin: string;
  controlUpdatedAt: string | null;
  /** #3738: the registration's channel switches (voice affordance source). */
  channels?: StockCopilotChannelsStatus;
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
    enabledSessions: Array.isArray(data?.enabledSessions) ? data.enabledSessions : [],
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

/**
 * #3398: persist the user's enabled-sessions choice (the control
 * route writes it to the user's own settings store; the cycle
 * resolves it at its next firing).
 */
export async function setStockCopilotSessions(
  sessions: StockCopilotSessionId[],
): Promise<{ ok: boolean; sessions: StockCopilotSessionId[] }> {
  return send<{ ok: boolean; sessions: StockCopilotSessionId[] }>(
    "/api/stock-copilot/control",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions }),
    },
  );
}

/**
 * #3738: persist the user's channel-switch decisions for the
 * stock copilot (the control route writes them to the user's own
 * settings store; the voice route and the status read resolve
 * them stored > env > default). The response echoes the full
 * resolved channel projection.
 */
export async function setStockCopilotChannels(
  channels: Partial<Record<string, boolean>>,
): Promise<{ ok: boolean; channels: StockCopilotChannelsStatus }> {
  return send<{ ok: boolean; channels: StockCopilotChannelsStatus }>(
    "/api/stock-copilot/control",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels }),
    },
  );
}

/**
 * #3451: the effective selection as the panel shows it — e.g.
 * "Alpaca · Paper" / "Alpaca · Live". Null when the selection did
 * not resolve (the status kind carries that state instead).
 * Display-only: selection itself lives in the dynamic panel menu.
 * #3751: the broker name resolves through the tenant-providers
 * identity projection (the server's one identity map, served) —
 * this module keeps no display-name copy of its own.
 */
export function copilotSelectionLabel(status: StockCopilotStatus): string | null {
  if (!status.selectionResolved || !status.activeBroker || !status.activeMode) {
    return null;
  }
  const broker = currentBrokerLabel(status.activeBroker);
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
