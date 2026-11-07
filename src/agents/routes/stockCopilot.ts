/**
 * Issue #3422 — Stock Copilot status + pause/resume control routes,
 * in the orchestrator route family (one handler invoked from
 * routeRequest, returning a Response on match or null otherwise).
 *
 *   GET  /stock-copilot/status  — the chat-tab panel's read: global
 *        flag state, per-instance pause state, market-open state,
 *        open positions WITH their exit plans, recently closed
 *        positions, and recent cycle activity. #3451 adds the
 *        effective trading selection (active broker + mode, from
 *        the panel menu's selection model) and the named
 *        mode_unresolved / inactive_broker states, so the panel
 *        reports the mode the cycle will actually run — selection
 *        itself stays in the dynamic panel menu. #3398 adds the
 *        session state: the user's enabled trading sessions, the
 *        session open right now, and the named
 *        outside_enabled_sessions state that replaces the old
 *        regular-hours-only outside_market_hours state.
 *   POST /stock-copilot/control — the panel's writes: set the
 *        caller's own pause control ({ paused: boolean }) and/or
 *        the caller's enabled trading sessions
 *        ({ sessions: [...] }, #3398 — persisted to the caller's
 *        own settings store, the same store the cycle resolves at
 *        firing). Paused ⇒ the cycle keeps managing exits but
 *        places no entries; the global
 *        STOCK_COPILOT_PAPER_ENABLED flag stays the master kill
 *        switch above these per-instance controls.
 *
 * Identity: the caller's login comes from the instance's screener
 * execution context — the same acting identity the copilot cycle
 * itself runs under (scheduledTasksCopilot.ts) — so the panel can
 * only ever see and control the signed-in user's own instance.
 * No context (an instance without a verified login) fails closed
 * with 401 for both routes, reads and writes alike. All storage
 * goes through the #3399/#3422 data-layer ports composed over the
 * instance's storage handle; this module holds no statements.
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
  COPILOT_SESSIONS,
  COPILOT_SESSION_SETTING_KEY,
  type CopilotSessionId,
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
import { evaluateStockCopilotStrategy } from "../../services/stockCopilotEvaluation";
import { summarizeLearnings } from "../../services/stockCopilotAgenticLoop";
import { introspectStockCopilot } from "../../services/stockCopilotIntrospection";

/** Structural mirror of OrchestratorAgent's ScreenerExecutionContext
 *  (the schedules.ts idiom — routes do not import the orchestrator). */
type ScreenerExecutionContext = {
  userLogin: string;
  environment?: "TEST" | "PROD";
};

/** The subset of OrchestratorAgent surface these handlers need. */
export interface StockCopilotRouteContext {
  env: Env;
  /** The instance's storage handle the ports compose over. */
  sql: StockCopilotStoreSqlExecutor;
  /** The instance's acting identity (the cycle's own login source). */
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  /** The instance's settings reader (#3451: the stored trade
   *  environment half of the mode selection). */
  readSettingRaw: (key: string) => string | null;
  /** The instance's settings writer (#3398: the session-choice
   *  write). Optional because read-only hosts omit it; a sessions
   *  write without it fails closed (500) rather than reporting
   *  success while storing nothing (the #2482 switch discipline). */
  writeSetting?: (key: string, value: string) => void;
  /** #3451 composition seam for the broker-selection read: when
   *  omitted, the resolver composes the commercial store from env;
   *  tests inject the store directly. */
  commercial?: CommercialStore | null;
  /** Control changes are audited (optional: read-only hosts omit it). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
}

/** Recent-history bounds for the status read (the panel's lists). */
const CLOSED_POSITION_LIMIT = 10;
const ACTIVITY_LIMIT = 20;

function projectOpenPosition(p: CopilotPositionRecord) {
  return {
    id: p.id,
    symbol: p.symbol,
    strategy: p.strategy,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
    targetPrice: p.targetPrice,
    brokerOrderRef: p.brokerOrderRef,
    // #3398: the session + order type the entry was placed under.
    entrySession: p.entrySession ?? null,
    entryOrderType: p.entryOrderType ?? null,
    openedAt: p.openedAt,
  };
}

function projectClosedPosition(p: CopilotPositionRecord) {
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
 * Handles the Stock Copilot routes. Returns a Response on match,
 * null when neither path matches (the orchestrator then continues
 * its sequential matching).
 */
export async function handleStockCopilotRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: StockCopilotRouteContext
): Promise<Response | null> {
  const isStatusRead = path.endsWith("/stock-copilot/status") && request.method === "GET";
  const isIntrospectRead = path.endsWith("/stock-copilot/introspect") && request.method === "GET";
  const isLearningsRead = path.endsWith("/stock-copilot/learnings") && request.method === "GET";
  const isEvaluateAction = path.endsWith("/stock-copilot/evaluate") && request.method === "POST";
  const isControlWrite = path.endsWith("/stock-copilot/control") && request.method === "POST";
  if (!isStatusRead && !isControlWrite && !isIntrospectRead && !isLearningsRead && !isEvaluateAction) return null;

  // Fail closed: without the instance's verified login context
  // there is no "own instance" to read or control.
  const executionContext = await ctx
    .getScreenerExecutionContext()
    .catch(() => undefined);
  const userLogin = executionContext?.userLogin;
  if (!userLogin) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const positions = createStockCopilotPositionPort(ctx.sql);
  const activity = createStockCopilotActivityPort(ctx.sql);
  const control = createStockCopilotControlPort(ctx.sql);

  if (isStatusRead) {
    try {
      positions.ensureSchema();
      activity.ensureSchema();
      control.ensureSchema();
      const flagEnabled = isStockCopilotPaperEnabled(ctx.env);
      const controlRecord = control.getControl(userLogin);
      const paused = controlRecord?.paused === true;
      const now = new Date();
      const marketOpen = isUsMarketOpen(now);
      // #3398: the session state, resolved exactly as the cycle
      // resolves it — the user's enabled sessions from their
      // externalized settings, and the session open right now.
      const enabledSessions = resolveCopilotSessions({
        readSettingRaw: ctx.readSettingRaw,
        env: ctx.env,
      });
      const aroundTheClock =
        String(ctx.env?.STOCK_COPILOT_AROUND_THE_CLOCK ?? "").toLowerCase() === "true" ||
        String(ctx.env?.STOCK_COPILOT_FORCE_ALL_SESSIONS ?? "").toLowerCase() === "true" ||
        String(ctx.env?.STOCK_COPILOT_IGNORE_SESSIONS ?? "").toLowerCase() === "true";
      const currentSession = copilotSessionAt(now, aroundTheClock);
      // #3451: the effective selection, resolved exactly as the
      // cycle resolves it — the panel reports the broker + mode the
      // next cycle will run under, or the named state that stops it.
      const selection = await resolveCopilotTradingSelection({
        env: ctx.env,
        readSettingRaw: ctx.readSettingRaw,
        commercial: ctx.commercial,
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
      const cadence = resolveCopilotCadence({
        env: ctx.env,
        readSettingRaw: ctx.readSettingRaw,
      });
      return Response.json({
        flagEnabled,
        paused,
        marketOpen,
        currentSession,
        enabledSessions,
        cadence: {
          configured: cadence.configured,
          effective: cadence.effective,
        },
        executionMode: resolveCopilotExecutionMode({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        universe: resolveCopilotUniverse({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        strategies: resolveCopilotStrategies({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        status,
        selectionResolved: selection.resolved,
        activeBroker: selection.resolved ? selection.selection.brokerId : null,
        activeMode: selection.resolved ? selection.selection.mode : null,
        userLogin,
        controlUpdatedAt: controlRecord?.updatedAt ?? null,
        openPositions: positions.listOpenPositions(userLogin).map(projectOpenPosition),
        closedPositions: positions
          .listClosedPositions(userLogin, CLOSED_POSITION_LIMIT)
          .map(projectClosedPosition),
        activity: activity.listActivity(userLogin, ACTIVITY_LIMIT),
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to load copilot status" },
        { status: 500 },
      );
    }
  }

  if (isIntrospectRead) {
    try {
      positions.ensureSchema();
      activity.ensureSchema();
      control.ensureSchema();
      const introspection = await introspectStockCopilot({
        env: ctx.env,
        userLogin,
        readSettingRaw: ctx.readSettingRaw,
        positionPort: positions,
        activityPort: activity,
        controlPort: control,
      });
      return Response.json(introspection);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to load copilot introspection" },
        { status: 500 },
      );
    }
  }

  if (isLearningsRead) {
    try {
      const memory = createStockCopilotMemoryPort(ctx.sql);
      memory.ensureSchema();
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;
      const learnings = memory.listLearnings(
        userLogin,
        Number.isFinite(limit) && limit > 0 ? limit : 20,
      );
      const summary = summarizeLearnings(learnings);
      return Response.json({
        learnings,
        summary,
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to load copilot learnings" },
        { status: 500 },
      );
    }
  }

  if (isEvaluateAction) {
    try {
      const body = (await request.json().catch(() => null)) as {
        symbol?: string;
        strategies?: string[] | string;
      } | null;
      if (!body?.symbol || typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const loadBars = async (sym: string) => {
        return [100, 102, 101, 103, 105, 104, 106];
      };
      const result = await evaluateStockCopilotStrategy(
        body.symbol,
        { loadBars },
        body.strategies ??
          resolveCopilotStrategies({ readSettingRaw: ctx.readSettingRaw, env: ctx.env }),
      );
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to evaluate copilot strategies" },
        { status: 500 },
      );
    }
  }

  // Control writes: the caller's own instance only (the login
  // above IS the instance identity — there is no target parameter).
  // Two independent controls ride this route: the #3422 pause and
  // the #3398 enabled-sessions choice. Either or both may be sent;
  // everything is validated before anything is written.
  try {
    const body = (await request.json().catch(() => null)) as {
      paused?: unknown;
      sessions?: unknown;
      cadence?: unknown;
      executionMode?: unknown;
      universe?: unknown;
      strategies?: unknown;
    } | null;
    const hasPaused = body !== null && "paused" in body;
    const hasSessions = body !== null && "sessions" in body;
    const hasCadence = body !== null && "cadence" in body;
    const hasExecutionMode =
      body !== null && typeof body.executionMode === "string" && isCopilotExecutionMode(body.executionMode);
    const hasUniverse = body !== null && "universe" in body;
    const hasStrategies = body !== null && "strategies" in body;
    if (
      !body ||
      (!hasPaused &&
        !hasSessions &&
        !hasCadence &&
        !hasExecutionMode &&
        !hasUniverse &&
        !hasStrategies)
    ) {
      return Response.json(
        {
          error:
            "Must supply paused, sessions, cadence, executionMode, universe, or strategies to update",
        },
        { status: 400 },
      );
    }
    if (hasPaused && typeof body.paused !== "boolean") {
      return Response.json(
        { error: "paused must be true or false" },
        { status: 400 },
      );
    }
    let validatedCadence: string | null = null;
    if (hasCadence) {
      if (typeof body.cadence !== "string" || parseCadenceMinutes(body.cadence) === null) {
        return Response.json(
          { error: "cadence must be a valid interval string (e.g. 'every 30 minutes', 'every 1 hour', '1h', '60m')" },
          { status: 400 },
        );
      }
      if (typeof ctx.writeSetting !== "function") {
        return Response.json(
          { error: "Cadence settings are unavailable on this host" },
          { status: 500 },
        );
      }
      validatedCadence = formatCadenceString(parseCadenceMinutes(body.cadence)!);
    }
    let sessions: CopilotSessionId[] | null = null;
    if (hasSessions) {
      if (!Array.isArray(body.sessions) || !body.sessions.every(isCopilotSessionId)) {
        return Response.json(
          {
            error:
              "sessions must be an array of session ids (pre_market, regular, after_hours, exto)",
          },
          { status: 400 },
        );
      }
      // Canonical order, duplicates collapsed — the stored form
      // and the response agree with what the cycle will resolve.
      const requested = new Set(body.sessions);
      sessions = COPILOT_SESSIONS.filter((s) => requested.has(s));
      if (typeof ctx.writeSetting !== "function") {
        // Fail closed: never report a settings change that was
        // not stored (the #2482 switch discipline).
        return Response.json(
          { error: "Session settings are unavailable on this host" },
          { status: 500 },
        );
      }
    }
    if (hasPaused) {
      control.ensureSchema();
      control.setControl({
        userLogin,
        paused: body.paused as boolean,
        updatedAt: new Date().toISOString(),
        updatedBy: userLogin,
      });
    }
    if (sessions !== null) {
      ctx.writeSetting!(
        COPILOT_SESSION_SETTING_KEY,
        serializeCopilotSessionList(sessions),
      );
    }
    if (validatedCadence !== null) {
      ctx.writeSetting!(
        COPILOT_CADENCE_SETTING_KEY,
        validatedCadence,
      );
    }
    if (hasExecutionMode) {
      ctx.writeSetting!(
        COPILOT_EXECUTION_MODE_SETTING_KEY,
        body.executionMode as string,
      );
    }
    let updatedUniverse: string[] | null = null;
    if (hasUniverse) {
      if (typeof ctx.writeSetting !== "function") {
        return Response.json(
          { error: "Universe settings are unavailable on this host" },
          { status: 500 },
        );
      }
      updatedUniverse = parseUniverseInput(body.universe as string | string[]);
      ctx.writeSetting(COPILOT_UNIVERSE_SETTING_KEY, updatedUniverse.join(","));
    }
    let updatedStrategies: string[] | null = null;
    if (hasStrategies) {
      if (typeof ctx.writeSetting !== "function") {
        return Response.json(
          { error: "Strategies settings are unavailable on this host" },
          { status: 500 },
        );
      }
      updatedStrategies = parseStrategiesInput(body.strategies as string | string[]);
      ctx.writeSetting(COPILOT_STRATEGIES_SETTING_KEY, updatedStrategies.join(","));
    }
    const resolvedCadence = resolveCopilotCadence({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    const resolvedExecutionMode = resolveCopilotExecutionMode({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    const resolvedUniverse = resolveCopilotUniverse({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    const resolvedStrategies = resolveCopilotStrategies({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    ctx.audit?.("stock_copilot.control", "orchestrator", {
      userLogin,
      ...(hasPaused ? { paused: body.paused } : {}),
      ...(sessions !== null ? { sessions } : {}),
      ...(validatedCadence !== null ? { cadence: validatedCadence } : {}),
      ...(hasExecutionMode ? { executionMode: body.executionMode } : {}),
      ...(hasUniverse ? { universe: updatedUniverse } : {}),
      ...(hasStrategies ? { strategies: updatedStrategies } : {}),
    });
    return Response.json({
      ok: true,
      ...(hasPaused ? { paused: body.paused } : {}),
      ...(sessions !== null ? { sessions } : {}),
      ...(validatedCadence !== null ? { cadence: resolvedCadence } : {}),
      ...(hasExecutionMode ? { executionMode: resolvedExecutionMode } : {}),
      ...(hasUniverse ? { universe: resolvedUniverse } : {}),
      ...(hasStrategies ? { strategies: resolvedStrategies } : {}),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update copilot control" },
      { status: 500 },
    );
  }
}
