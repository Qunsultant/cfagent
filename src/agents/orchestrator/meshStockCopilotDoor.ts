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
  createStockCopilotMemoryPort,
  createStockCopilotPositionPort,
} from "../../data/createStockCopilotStorePorts";
import type {
  CopilotExecutionMode,
  CopilotLearningRecord,
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
  COPILOT_UNIVERSE_SETTING_KEY,
  COPILOT_STRATEGIES_SETTING_KEY,
  resolveCopilotUniverse,
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
  universe: string[];
  strategies: string[];
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
  cadence?: string;
  pauseUntil?: string;
  executionMode?: CopilotExecutionMode;
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
  universe: string[];
  strategies: string[];
  updatedAt: string;
}

export interface StockCopilotLearningsResult {
  learnings: CopilotLearningRecord[];
  summary: string;
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
    universe,
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
  const universe = resolveCopilotUniverse({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const strategies = resolveCopilotStrategies({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const pauseUntil = ctx.readSettingRaw?.("stock_copilot:pause_until") ?? null;

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
    universe,
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


