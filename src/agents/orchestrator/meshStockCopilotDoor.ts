/**
 * Issue #3513 — the Stock Copilot mesh door: chat turns and external MCP
 * callers query the autonomous trading loop's status, open positions with
 * bracket exit plans, cycle activity, and refusal telemetry through the
 * SAME data-layer ports the REST status route uses (createStockCopilotPositionPort,
 * createStockCopilotActivityPort, createStockCopilotControlPort).
 *
 * Controls: pause/resume and session updates through the same control semantics.
 * Identity discipline: requires the acting login (the signed-in user) and fails
 * closed without it.
 */

import {
  COPILOT_BROKER_ID,
  resolveCopilotTradingSelection,
} from "../copilotTradingMode";
import type { CommercialStore } from "../../data/commercialPorts";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../../data/createStockCopilotStorePorts";
import type {
  CopilotPositionRecord,
  StockCopilotStoreSqlExecutor,
} from "../../data/stockCopilotStorePorts";
import type { Env } from "../../types";
import {
  isStockCopilotPaperEnabled,
  isUsMarketOpen,
} from "../../services/stockCopilot";
import {
  copilotSessionAt,
  isCopilotSessionId,
  resolveCopilotSessions,
  serializeCopilotSessionList,
  type CopilotSessionId,
  COPILOT_SESSION_SETTING_KEY,
} from "../../services/stockCopilotSessions";
import { MeshDoorError, requireActingLogin } from "./meshDoors";

export interface StockCopilotDoorContext {
  env: Env;
  sql: StockCopilotStoreSqlExecutor;
  readSettingRaw: (key: string) => string | null;
  writeSetting?: (key: string, value: string) => void;
  commercial?: CommercialStore | null;
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
}

export interface StockCopilotOpenPositionView {
  id: string;
  symbol: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  brokerOrderRef: string;
  entrySession: string | null;
  entryOrderType: string | null;
  openedAt: string;
}

export interface StockCopilotClosedPositionView {
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

export interface StockCopilotStatusResult {
  flagEnabled: boolean;
  paused: boolean;
  marketOpen: boolean;
  currentSession: CopilotSessionId | null;
  enabledSessions: readonly CopilotSessionId[];
  status: string;
  selectionResolved: boolean;
  activeBroker: string | null;
  activeMode: string | null;
  userLogin: string;
  controlUpdatedAt: string | null;
  openPositions: StockCopilotOpenPositionView[];
  closedPositions: StockCopilotClosedPositionView[];
  activity: Array<Record<string, unknown>>;
  lastCycle: Record<string, unknown> | null;
}

export interface StockCopilotControlInput {
  paused?: boolean;
  sessions?: string[];
}

export interface StockCopilotControlResult {
  success: boolean;
  paused: boolean;
  enabledSessions: readonly CopilotSessionId[];
  updatedAt: string;
}

function projectOpenPosition(p: CopilotPositionRecord): StockCopilotOpenPositionView {
  return {
    id: p.id,
    symbol: p.symbol,
    strategy: p.strategy,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
    targetPrice: p.targetPrice,
    brokerOrderRef: p.brokerOrderRef,
    entrySession: p.entrySession ?? null,
    entryOrderType: p.entryOrderType ?? null,
    openedAt: p.openedAt,
  };
}

function projectClosedPosition(p: CopilotPositionRecord): StockCopilotClosedPositionView {
  return {
    id: p.id,
    symbol: p.symbol,
    strategy: p.strategy,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    exitReason: p.exitReason,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
  };
}

/**
 * Reads Stock Copilot status and loop telemetry for the acting user via the data layer ports.
 */
export async function getStockCopilotStatusViaDoor(
  ctx: StockCopilotDoorContext,
  actingLogin?: string | null,
): Promise<StockCopilotStatusResult> {
  const login = requireActingLogin(actingLogin);

  const positions = createStockCopilotPositionPort(ctx.sql);
  const activity = createStockCopilotActivityPort(ctx.sql);
  const control = createStockCopilotControlPort(ctx.sql);

  positions.ensureSchema();
  activity.ensureSchema();
  control.ensureSchema();

  const flagEnabled = isStockCopilotPaperEnabled(ctx.env);
  const controlRecord = control.getControl(login);
  const paused = controlRecord?.paused === true;
  const now = new Date();
  const marketOpen = isUsMarketOpen(now);
  const enabledSessions = resolveCopilotSessions({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const currentSession = copilotSessionAt(now);
  const commercial =
    ctx.commercial !== undefined
      ? ctx.commercial
      : ({
          getTenantBrokerSelection: async () => COPILOT_BROKER_ID,
        } as unknown as CommercialStore);

  const selection = await resolveCopilotTradingSelection({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
    commercial,
  });

  const status = !flagEnabled
    ? "off"
    : !selection.resolved
      ? "mode_unresolved"
      : selection.selection.brokerId !== COPILOT_BROKER_ID
        ? "inactive_broker"
        : paused
          ? "paused"
          : currentSession === null || !enabledSessions.includes(currentSession)
            ? "outside_enabled_sessions"
            : "live";

  const rawActivity = activity.listActivity(login, 20);
  const lastCycle =
    rawActivity.length > 0
      ? (rawActivity[0] as unknown as Record<string, unknown>)
      : null;

  return {
    flagEnabled,
    paused,
    marketOpen,
    currentSession,
    enabledSessions,
    status,
    selectionResolved: selection.resolved,
    activeBroker: selection.resolved ? selection.selection.brokerId : null,
    activeMode: selection.resolved ? selection.selection.mode : null,
    userLogin: login,
    controlUpdatedAt: controlRecord?.updatedAt ?? null,
    openPositions: positions.listOpenPositions(login).map(projectOpenPosition),
    closedPositions: positions.listClosedPositions(login, 10).map(projectClosedPosition),
    activity: rawActivity as unknown as Array<Record<string, unknown>>,
    lastCycle,
  };
}

/**
 * Updates pause state or enabled sessions for the acting user via the control port and settings.
 */
export async function controlStockCopilotViaDoor(
  ctx: StockCopilotDoorContext,
  actingLogin: string | null | undefined,
  input: StockCopilotControlInput,
): Promise<StockCopilotControlResult> {
  const login = requireActingLogin(actingLogin);

  const control = createStockCopilotControlPort(ctx.sql);
  control.ensureSchema();

  let nowIso = new Date().toISOString();

  if (typeof input.paused === "boolean") {
    control.setControl({
      userLogin: login,
      paused: input.paused,
      updatedAt: nowIso,
      updatedBy: login,
    });
    ctx.audit?.("stock_copilot.control_paused_via_door", "orchestrator", {
      userLogin: login,
      paused: input.paused,
    });
  }

  if (Array.isArray(input.sessions)) {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update trading sessions: writeSetting is not configured on this door context.",
      );
    }
    const validatedSessions: CopilotSessionId[] = [];
    for (const s of input.sessions) {
      if (isCopilotSessionId(s)) {
        validatedSessions.push(s);
      }
    }
    ctx.writeSetting(
      COPILOT_SESSION_SETTING_KEY,
      serializeCopilotSessionList(validatedSessions),
    );
    ctx.audit?.("stock_copilot.control_sessions_via_door", "orchestrator", {
      userLogin: login,
      sessions: validatedSessions,
    });
  }

  const updatedControl = control.getControl(login);
  const enabledSessions = resolveCopilotSessions({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });

  return {
    success: true,
    paused: updatedControl?.paused === true,
    enabledSessions,
    updatedAt: updatedControl?.updatedAt ?? nowIso,
  };
}
