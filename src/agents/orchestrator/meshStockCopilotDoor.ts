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
import { isCopilotBroker } from "../../trading";
import type { CommercialStore } from "../../data/commercialPorts";
import { createOrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotMemoryPort,
  createStockCopilotPositionPort,
} from "../../data/createStockCopilotStorePorts";
import type {
  CopilotExecutionMode,
  CopilotLearningRecord,
  CopilotPositionRecord,
  StockCopilotStoreSqlExecutor,
} from "../../data/stockCopilotStorePorts";
import {
  normalizeAutopilotLimits,
  type AutopilotPolicyLimits,
} from "../../services/riskPolicyEngine";
import type { Env } from "../../types";
import {
  isStockCopilotPaperEnabled,
  isUsMarketOpen,
} from "../../services/stockCopilot";
import {
  copilotSessionAt,
  isAroundTheClock,
  isCopilotSessionId,
  resolveCopilotSessions,
  serializeCopilotSessionList,
  type CopilotSessionId,
  COPILOT_SESSION_SETTING_KEY,
} from "../../services/stockCopilotSessions";
import {
  COPILOT_CADENCE_SETTING_KEY,
  resolveCopilotCadence,
  parseCadenceMinutes,
  formatCadenceString,
} from "../../services/stockCopilotCadence";
import {
  COPILOT_EXECUTION_MODE_SETTING_KEY,
  resolveCopilotExecutionMode,
  isCopilotExecutionMode,
} from "../../services/stockCopilotExecutionMode";
import {
  COPILOT_RSI_MODE_SETTING_KEY,
  resolveStockCopilotRsiMode,
  isStockCopilotRsiMode,
  type StockCopilotRsiMode,
} from "../../services/stockCopilotRsiMode";
import {
  COPILOT_UNIVERSE_SETTING_KEY,
  COPILOT_STRATEGIES_SETTING_KEY,
  resolveCopilotUniverse,
  resolveCopilotUniversePreset,
  resolveCopilotStrategies,
  parseUniverseInput,
  parseStrategiesInput,
} from "../../services/stockCopilotConfiguration";
import {
  evaluateStockCopilotStrategy,
  type StockCopilotEvaluationResult,
} from "../../services/stockCopilotEvaluation";
import { summarizeLearnings } from "../../services/stockCopilotAgenticLoop";
import {
  introspectStockCopilot,
  type StockCopilotIntrospectionResult,
} from "../../services/stockCopilotIntrospection";
import { MeshDoorError, requireActingLogin } from "./meshDoors";

export interface StockCopilotDoorContext {
  env: Env;
  sql: StockCopilotStoreSqlExecutor;
  readSettingRaw: (key: string) => string | null;
  writeSetting?: (key: string, value: string) => void;
  commercial?: CommercialStore | null;
  loadBars?: (symbol: string) => Promise<number[]>;
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

export const COPILOT_CHAT_EXECUTION_MODE_SETTING_KEY = "stock_copilot:chat_execution_mode";
export const AUTOPILOT_DOOR_STATE_KEY = "autopilot_state_v1";

export type CopilotChatExecutionMode = "hitl" | "autonomous";

export interface StockCopilotAutopilotLimits extends AutopilotPolicyLimits {
  maxOrdersPerDay: number;
  minCashReservePct: number;
  universeAllowlist?: string[] | null;
}

export interface StockCopilotAutopilotSnapshot {
  running: boolean;
  killSwitch: boolean;
  killSwitchReason: string | null;
  mode: "autonomous" | "hitl";
  ordersToday: number;
  limits: StockCopilotAutopilotLimits;
  updatedAt: string | null;
}

export interface StockCopilotStatusResult {
  flagEnabled: boolean;
  paused: boolean;
  marketOpen: boolean;
  currentSession: CopilotSessionId | null;
  enabledSessions: readonly CopilotSessionId[];
  cadence: {
    configured: string;
    effective: string;
  };
  executionMode: CopilotExecutionMode;
  copilotExecutionMode: CopilotChatExecutionMode;
  autopilot: StockCopilotAutopilotSnapshot;
  universe: string[];
  universePreset: string | null;
  strategies: string[];
  status: string;
  selectionResolved: boolean;
  activeBroker: string | null;
  activeMode: string | null;
  rsiMode: StockCopilotRsiMode;
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
  cadence?: string;
  pauseUntil?: string;
  executionMode?: CopilotExecutionMode;
  copilotExecutionMode?: CopilotChatExecutionMode;
  autopilotRunning?: boolean;
  killSwitch?: boolean;
  killSwitchReason?: string;
  autopilotLimits?: Partial<StockCopilotAutopilotLimits>;
  rsiMode?: StockCopilotRsiMode;
  universe?: string | string[];
  strategies?: string | string[];
}

export interface StockCopilotControlResult {
  success: boolean;
  paused: boolean;
  enabledSessions: readonly CopilotSessionId[];
  cadence: {
    configured: string;
    effective: string;
  };
  pauseUntil?: string | null;
  executionMode: CopilotExecutionMode;
  copilotExecutionMode: CopilotChatExecutionMode;
  autopilot: StockCopilotAutopilotSnapshot;
  rsiMode: StockCopilotRsiMode;
  universe: string[];
  universePreset: string | null;
  strategies: string[];
  updatedAt: string;
}

export interface StockCopilotLearningsResult {
  learnings: CopilotLearningRecord[];
  summary: string;
}

function normalizeDoorAutopilotLimits(
  raw?: Partial<StockCopilotAutopilotLimits> | null,
): StockCopilotAutopilotLimits {
  const input = (raw ?? {}) as Partial<StockCopilotAutopilotLimits>;
  const base = normalizeAutopilotLimits({
    ...input,
    ordersPerDay: input.maxOrdersPerDay ?? input.ordersPerDay,
    cashReservePct: input.minCashReservePct ?? input.cashReservePct,
    universeSymbols: input.universeAllowlist ?? input.universeSymbols,
  });
  return {
    ...base,
    maxOrdersPerDay: base.ordersPerDay,
    minCashReservePct: base.cashReservePct,
    universeAllowlist: base.universeSymbols ?? null,
  };
}

function readDoorAutopilotRaw(sql: StockCopilotStoreSqlExecutor): Record<string, unknown> {
  try {
    const port = createOrchestratorTablePorts(sql as never).autopilot;
    port.ensureSchema();
    const raw = port.getValue(AUTOPILOT_DOOR_STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readDoorAutopilotSnapshot(sql: StockCopilotStoreSqlExecutor): StockCopilotAutopilotSnapshot {
  const raw = readDoorAutopilotRaw(sql);
  const today = new Date().toISOString().slice(0, 10);
  const storedDate = typeof raw.ordersDate === "string" ? raw.ordersDate : today;
  const running = Boolean(raw.running);
  const killSwitch = Boolean(raw.killSwitch);
  return {
    running,
    killSwitch,
    killSwitchReason: typeof raw.killSwitchReason === "string" ? raw.killSwitchReason : null,
    mode: running && !killSwitch ? "autonomous" : "hitl",
    ordersToday: storedDate === today ? Number(raw.ordersToday) || 0 : 0,
    limits: normalizeDoorAutopilotLimits((raw.limits as Partial<StockCopilotAutopilotLimits> | null) ?? null),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

function writeDoorAutopilotState(
  sql: StockCopilotStoreSqlExecutor,
  patch: Record<string, unknown>,
): StockCopilotAutopilotSnapshot {
  const raw = readDoorAutopilotRaw(sql);
  const current = readDoorAutopilotSnapshot(sql);
  const updatedAt = new Date().toISOString();
  const next = {
    ...raw,
    running: current.running,
    killSwitch: current.killSwitch,
    killSwitchReason: current.killSwitchReason,
    limits: current.limits,
    ordersToday: current.ordersToday,
    ordersDate: new Date().toISOString().slice(0, 10),
    ...patch,
    updatedAt,
  };
  try {
    const port = createOrchestratorTablePorts(sql as never).autopilot;
    port.ensureSchema();
    port.putValue(AUTOPILOT_DOOR_STATE_KEY, JSON.stringify(next), updatedAt);
  } catch {
    // Best-effort persistence when mock SQL is used in unit tests
  }
  const running = Boolean(next.running);
  const killSwitch = Boolean(next.killSwitch);
  return {
    running,
    killSwitch,
    killSwitchReason: typeof next.killSwitchReason === "string" ? next.killSwitchReason : null,
    mode: running && !killSwitch ? "autonomous" : "hitl",
    ordersToday: Number(next.ordersToday) || 0,
    limits: normalizeDoorAutopilotLimits((next.limits as Partial<StockCopilotAutopilotLimits> | null) ?? null),
    updatedAt,
  };
}

export function resolveCopilotChatExecutionMode(opts: {
  readSettingRaw?: ((key: string) => string | null) | undefined;
  env?: Partial<Env>;
  sql?: StockCopilotStoreSqlExecutor;
  autopilotRunning?: boolean;
}): CopilotChatExecutionMode {
  const settingVal = opts.readSettingRaw?.(COPILOT_CHAT_EXECUTION_MODE_SETTING_KEY)?.trim().toLowerCase();
  if (settingVal === "autonomous" || settingVal === "hitl") {
    return settingVal;
  }
  if (opts.sql) {
    const raw = readDoorAutopilotRaw(opts.sql);
    if (raw.chatExecutionMode === "autonomous" || raw.chatExecutionMode === "hitl") {
      return raw.chatExecutionMode;
    }
  }
  const envVal = String((opts.env as Record<string, unknown> | undefined)?.STOCK_COPILOT_CHAT_EXECUTION_MODE ?? "")
    .trim()
    .toLowerCase();
  if (envVal === "autonomous" || envVal === "hitl") {
    return envVal;
  }
  if (opts.autopilotRunning === true) {
    return "autonomous";
  }
  return "hitl";
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
  const aroundTheClock = isAroundTheClock({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const currentSession = copilotSessionAt(now, aroundTheClock);
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
      : !isCopilotBroker(selection.selection.brokerId)
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

  const cadence = resolveCopilotCadence({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
  });

  const executionMode = resolveCopilotExecutionMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });

  const universe = resolveCopilotUniverse({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const strategies = resolveCopilotStrategies({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const rsiMode = resolveStockCopilotRsiMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const autopilot = readDoorAutopilotSnapshot(ctx.sql);
  const copilotExecutionMode = resolveCopilotChatExecutionMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
    sql: ctx.sql,
    autopilotRunning: autopilot.running && !autopilot.killSwitch,
  });

  return {
    flagEnabled,
    paused,
    marketOpen,
    currentSession,
    enabledSessions,
    cadence: {
      configured: cadence.configured,
      effective: cadence.effective,
    },
    executionMode,
    copilotExecutionMode,
    autopilot,
    rsiMode,
    universe,
    universePreset: resolveCopilotUniversePreset(universe),
    strategies,
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

  if (typeof input.pauseUntil === "string") {
    control.setControl({
      userLogin: login,
      paused: true,
      updatedAt: nowIso,
      updatedBy: login,
    });
    if (ctx.writeSetting) {
      ctx.writeSetting("stock_copilot:pause_until", input.pauseUntil);
    }
    ctx.audit?.("stock_copilot.control_pause_until_via_door", "orchestrator", {
      userLogin: login,
      pauseUntil: input.pauseUntil,
    });
  }

  if (typeof input.cadence === "string") {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update loop cadence: writeSetting is not configured on this door context.",
      );
    }
    const mins = parseCadenceMinutes(input.cadence);
    if (mins === null) {
      throw new MeshDoorError(
        "door_unavailable",
        `Invalid cadence "${input.cadence}". Format must be e.g. 'every 1 hour', 'every 30 minutes', '1h', '60m'.`,
      );
    }
    const formatted = formatCadenceString(mins);
    ctx.writeSetting(COPILOT_CADENCE_SETTING_KEY, formatted);
    ctx.audit?.("stock_copilot.control_cadence_via_door", "orchestrator", {
      userLogin: login,
      cadence: formatted,
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

  if (typeof input.executionMode === "string" && isCopilotExecutionMode(input.executionMode)) {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update execution mode: writeSetting is not configured on this door context.",
      );
    }
    ctx.writeSetting(COPILOT_EXECUTION_MODE_SETTING_KEY, input.executionMode);
    ctx.audit?.("stock_copilot.control_execution_mode_via_door", "orchestrator", {
      userLogin: login,
      executionMode: input.executionMode,
    });
  }

  if (input.universe !== undefined) {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update universe: writeSetting is not configured on this door context.",
      );
    }
    const parsedUniverse = parseUniverseInput(input.universe);
    ctx.writeSetting(COPILOT_UNIVERSE_SETTING_KEY, parsedUniverse.join(","));
    ctx.audit?.("stock_copilot.control_universe_via_door", "orchestrator", {
      userLogin: login,
      universe: parsedUniverse,
    });
  }

  if (input.strategies !== undefined) {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update strategies: writeSetting is not configured on this door context.",
      );
    }
    const parsedStrategies = parseStrategiesInput(input.strategies);
    ctx.writeSetting(COPILOT_STRATEGIES_SETTING_KEY, parsedStrategies.join(","));
    ctx.audit?.("stock_copilot.control_strategies_via_door", "orchestrator", {
      userLogin: login,
      strategies: parsedStrategies,
    });
  }

  if (typeof input.rsiMode === "string" && isStockCopilotRsiMode(input.rsiMode)) {
    if (!ctx.writeSetting) {
      throw new MeshDoorError(
        "door_unavailable",
        "Cannot update RSI mode: writeSetting is not configured on this door context.",
      );
    }
    ctx.writeSetting(COPILOT_RSI_MODE_SETTING_KEY, input.rsiMode);
    ctx.audit?.("stock_copilot.control_rsi_mode_via_door", "orchestrator", {
      userLogin: login,
      rsiMode: input.rsiMode,
    });
  }

  if (typeof input.autopilotRunning === "boolean") {
    writeDoorAutopilotState(ctx.sql, { running: input.autopilotRunning });
    if (typeof input.paused !== "boolean") {
      control.setControl({
        userLogin: login,
        paused: !input.autopilotRunning,
        updatedAt: nowIso,
        updatedBy: login,
      });
    }
    ctx.audit?.("stock_copilot.control_autopilot_running_via_door", "orchestrator", {
      userLogin: login,
      autopilotRunning: input.autopilotRunning,
    });
  }

  if (typeof input.killSwitch === "boolean") {
    const reason = input.killSwitch
      ? String(input.killSwitchReason || "Emergency stop triggered via Stock Copilot chat").slice(0, 200)
      : null;
    writeDoorAutopilotState(ctx.sql, {
      killSwitch: input.killSwitch,
      killSwitchReason: reason,
    });
    if (input.killSwitch) {
      control.setControl({
        userLogin: login,
        paused: true,
        updatedAt: nowIso,
        updatedBy: login,
      });
    }
    ctx.audit?.("stock_copilot.control_kill_switch_via_door", "orchestrator", {
      userLogin: login,
      killSwitch: input.killSwitch,
      killSwitchReason: reason,
    });
  }

  if (input.autopilotLimits !== undefined && typeof input.autopilotLimits === "object" && input.autopilotLimits !== null) {
    const currentSnap = readDoorAutopilotSnapshot(ctx.sql);
    const mergedLimits = normalizeDoorAutopilotLimits({
      ...currentSnap.limits,
      ...input.autopilotLimits,
    });
    writeDoorAutopilotState(ctx.sql, { limits: mergedLimits });
    ctx.audit?.("stock_copilot.control_autopilot_limits_via_door", "orchestrator", {
      userLogin: login,
      limits: mergedLimits,
    });
  }

  if (input.copilotExecutionMode === "hitl" || input.copilotExecutionMode === "autonomous") {
    ctx.writeSetting?.(COPILOT_CHAT_EXECUTION_MODE_SETTING_KEY, input.copilotExecutionMode);
    writeDoorAutopilotState(ctx.sql, { chatExecutionMode: input.copilotExecutionMode });
    ctx.audit?.("stock_copilot.control_chat_execution_mode_via_door", "orchestrator", {
      userLogin: login,
      copilotExecutionMode: input.copilotExecutionMode,
    });
  }

  const updatedControl = control.getControl(login);
  const enabledSessions = resolveCopilotSessions({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const cadence = resolveCopilotCadence({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
  });
  const executionMode = resolveCopilotExecutionMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const rsiMode = resolveStockCopilotRsiMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const universe = resolveCopilotUniverse({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const strategies = resolveCopilotStrategies({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const pauseUntil = ctx.readSettingRaw?.("stock_copilot:pause_until") ?? null;
  const autopilot = readDoorAutopilotSnapshot(ctx.sql);
  const copilotExecutionMode = resolveCopilotChatExecutionMode({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
    sql: ctx.sql,
    autopilotRunning: autopilot.running && !autopilot.killSwitch,
  });

  return {
    success: true,
    paused: updatedControl?.paused === true,
    enabledSessions,
    cadence: {
      configured: cadence.configured,
      effective: cadence.effective,
    },
    pauseUntil,
    executionMode,
    copilotExecutionMode,
    autopilot,
    rsiMode,
    universe,
    universePreset: resolveCopilotUniversePreset(universe),
    strategies,
    updatedAt: updatedControl?.updatedAt ?? nowIso,
  };
}

export async function getLearningsViaDoor(
  ctx: StockCopilotDoorContext,
  actingLogin?: string | null,
  limit?: number,
): Promise<StockCopilotLearningsResult> {
  const login = requireActingLogin(actingLogin);
  const memory = createStockCopilotMemoryPort(ctx.sql);
  memory.ensureSchema();

  const learnings = memory.listLearnings(login, limit ?? 20);
  const summary = summarizeLearnings(learnings);

  ctx.audit?.("stock_copilot.learnings_via_door", "orchestrator", {
    userLogin: login,
    count: learnings.length,
  });

  return {
    learnings,
    summary,
  };
}

export async function introspectStockCopilotViaDoor(
  ctx: StockCopilotDoorContext,
  actingLogin?: string | null,
): Promise<StockCopilotIntrospectionResult> {
  const login = requireActingLogin(actingLogin);
  const positions = createStockCopilotPositionPort(ctx.sql);
  const activity = createStockCopilotActivityPort(ctx.sql);
  const control = createStockCopilotControlPort(ctx.sql);

  const result = await introspectStockCopilot({
    env: ctx.env,
    userLogin: login,
    readSettingRaw: ctx.readSettingRaw,
    positionPort: positions,
    activityPort: activity,
    controlPort: control,
    commercial: ctx.commercial,
  });

  ctx.audit?.("stock_copilot.introspect_via_door", "orchestrator", {
    userLogin: login,
    broker: result.configuration.broker,
    mode: result.configuration.mode,
    openPositionsCount: result.telemetry.openPositionsCount,
  });

  return result;
}

export async function evaluateStockCopilotViaDoor(
  ctx: StockCopilotDoorContext,
  actingLogin?: string | null,
  symbol?: string,
  strategies?: string | readonly string[],
): Promise<StockCopilotEvaluationResult> {
  const login = requireActingLogin(actingLogin);
  if (!symbol || symbol.trim().length === 0) {
    throw new MeshDoorError("door_unavailable", "symbol is required for evaluation");
  }

  const loadBars =
    ctx.loadBars ??
    (async (sym: string) => {
      // Return placeholder bars if no live feed provided in context
      return [100, 102, 101, 103, 105, 104, 106];
    });

  const resolvedStrategies = strategies ?? resolveCopilotStrategies({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });

  const result = await evaluateStockCopilotStrategy(
    symbol,
    { loadBars },
    resolvedStrategies,
  );

  ctx.audit?.("stock_copilot.evaluate_via_door", "orchestrator", {
    userLogin: login,
    symbol: result.symbol,
    barsCount: result.barsCount,
  });

  return result;
}


