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
 *        firing). #3738 adds the channel-switch write
 *        ({ channels: { voice: false, ... } }) — the stored layer
 *        of the per-copilot channel switches (src/services/
 *        copilotChannels.ts), persisted under the stock
 *        registration's settings key and echoed back resolved.
 *        Paused ⇒ the cycle keeps managing exits but
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
import { SqlIndexListStore } from "../../data/doSqliteIndexListAdapter";
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
  isAroundTheClock,
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
  resolveCopilotUniverseFull,
  resolveCopilotStrategies,
  parseUniverseInput,
  parseStrategiesInput,
} from "../../services/stockCopilotConfiguration";
import { evaluateStockCopilotStrategy } from "../../services/stockCopilotEvaluation";
import { summarizeLearnings } from "../../services/stockCopilotAgenticLoop";
import { introspectStockCopilot } from "../../services/stockCopilotIntrospection";
import { hasCopilotCycleLedgerRows } from "../orchestrator/meshStockCopilotDoor";
import { readCopilotCycleDispatchProbe } from "../orchestrator/scheduledTasksCopilot";
import {
  copilotChannelsSettingKey,
  parseStoredCopilotChannelEntries,
  serializeStoredCopilotChannelEntries,
} from "../../services/copilotChannels";
import { CAPABILITY_CHANNELS } from "../../actors/capabilityManifest";
import {
  projectCopilotChannelStatuses,
  projectCopilotVoiceBackend,
} from "./copilotChannelProjection";

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
  /** The instance's KV storage handle (the #4001 dispatch-probe
   *  read). Optional: read-only hosts omit it and the probe reads
   *  null. */
  storage?: { get: (key: string) => Promise<unknown> } | null;
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

/**
 * Issue #3738: the stock registration's channel-switch projection —
 * every channel's switch resolution (stored > env > default, source
 * named), with voice carrying the composition the panel consumes:
 * the switch AND the #3720 class-level activation must both be on
 * for the channel to serve (`effective`); the activation's manifest
 * state rides along so the two config layers stay distinguishable.
 *
 * Issue #3773: the composition itself lives in the shared
 * routes-layer helper (copilotChannelProjection.ts) so the chat
 * surface's per-registration read projects byte-identically; this
 * wrapper keeps the stock call sites unchanged.
 */
function projectStockCopilotChannels(ctx: StockCopilotRouteContext) {
  return projectCopilotChannelStatuses({
    registrationId: "stock",
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
}

/**
 * Issue #3773: the stock registration's voice BACKEND projection
 * (which speech machinery serves its voice turns), through the
 * same shared helper the chat read uses — the two surfaces'
 * projections stay structurally identical.
 */
function projectStockCopilotVoiceBackend(ctx: StockCopilotRouteContext) {
  return projectCopilotVoiceBackend({
    registrationId: "stock",
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
}

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
      const aroundTheClock = isAroundTheClock({
        readSettingRaw: ctx.readSettingRaw,
        env: ctx.env,
      });
      const currentSession = copilotSessionAt(now, aroundTheClock);
      // #3451: the effective selection, resolved exactly as the
      // cycle resolves it — the panel reports the broker + mode the
      // next cycle will run under, or the named state that stops it.
      const selection = await resolveCopilotTradingSelection({
        env: ctx.env,
        readSettingRaw: ctx.readSettingRaw,
        commercial: ctx.commercial,
      });
      const rawActivity = activity.listActivity(userLogin, ACTIVITY_LIMIT);
      const lastCycle =
        rawActivity.length > 0
          ? (rawActivity[0] as unknown as Record<string, unknown>)
          : null;
      // Issue #3899 (RC3): "live" means a cycle has run, not just that
      // the gates pass — with no activity record and no ledger row the
      // copilot has never executed, and the status says so.
      const neverExecuted =
        lastCycle === null && !hasCopilotCycleLedgerRows(ctx.sql);
      // Issue #4001 (follow-up): the dispatch-boundary probe — the
      // last firing the handler actually entered, and the last reason
      // the task was not declared, so a silent firing is diagnosable
      // from the status read instead of invisible.
      const dispatchProbe = await readCopilotCycleDispatchProbe(
        ctx.storage ?? null,
      );
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
                : neverExecuted
                  ? "never_executed"
                  : "live";
      const cadence = resolveCopilotCadence({
        env: ctx.env,
        readSettingRaw: ctx.readSettingRaw,
      });
      // Issue #3936: the status reports the SAME resolution the cycle runs —
      // the index's stored membership when it is fresh, the labelled fallback
      // (with its reason) when it is not. The sync preset alone would name an
      // index while showing a hand-written subset.
      const universeResolution = await resolveCopilotUniverseFull({
        readSettingRaw: ctx.readSettingRaw,
        env: ctx.env,
        indexListStore: new SqlIndexListStore(ctx.sql as never),
      });
      const universe = universeResolution.symbols;
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
        universe,
        universePreset: universeResolution.preset,
        universeSource: universeResolution.source,
        universeStale: universeResolution.stale,
        universeSnapshotDate: universeResolution.snapshotDate,
        universeFallbackReason: universeResolution.reason,
        strategies: resolveCopilotStrategies({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        status,
        selectionResolved: selection.resolved,
        activeBroker: selection.resolved ? selection.selection.brokerId : null,
        activeMode: selection.resolved ? selection.selection.mode : null,
        // #3738: the registration's channel switches (the panel's
        // voice affordance renders from channels.voice.effective).
        channels: projectStockCopilotChannels(ctx),
        // #3773: the voice channel's backend switch (webspeech |
        // model) + its deciding layer, beside the channels.
        voiceBackend: projectStockCopilotVoiceBackend(ctx),
        userLogin,
        controlUpdatedAt: controlRecord?.updatedAt ?? null,
        openPositions: positions.listOpenPositions(userLogin).map(projectOpenPosition),
        closedPositions: positions
          .listClosedPositions(userLogin, CLOSED_POSITION_LIMIT)
          .map(projectClosedPosition),
        activity: activity.listActivity(userLogin, ACTIVITY_LIMIT),
        // Issue #3899 (RC3): the panel's liveness proof — null until a
        // cycle actually fires and records.
        lastCycle,
        neverExecuted,
        // Issue #4001 (follow-up): the dispatch-boundary probe — null
        // until a firing enters the handler / the task goes undeclared.
        lastCycleFiringAttempt: dispatchProbe.lastFiringAttempt,
        lastCycleNotDeclared: dispatchProbe.lastNotDeclared,
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
        // Issue #3899 (RC3): the real commercial store, composed from
        // env by the resolver when absent — never the fake default.
        commercial: ctx.commercial,
        sql: ctx.sql,
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
      channels?: unknown;
    } | null;
    const hasPaused = body !== null && "paused" in body;
    const hasSessions = body !== null && "sessions" in body;
    const hasCadence = body !== null && "cadence" in body;
    const hasExecutionMode =
      body !== null && typeof body.executionMode === "string" && isCopilotExecutionMode(body.executionMode);
    const hasUniverse = body !== null && "universe" in body;
    const hasStrategies = body !== null && "strategies" in body;
    const hasChannels = body !== null && "channels" in body;
    if (
      !body ||
      (!hasPaused &&
        !hasSessions &&
        !hasCadence &&
        !hasExecutionMode &&
        !hasUniverse &&
        !hasStrategies &&
        !hasChannels)
    ) {
      return Response.json(
        {
          error:
            "Must supply paused, sessions, cadence, executionMode, universe, strategies, or channels to update",
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
    let channelUpdates: Partial<Record<string, boolean>> | null = null;
    if (hasChannels) {
      // #3738: the stored-layer door for the registration's channel
      // switches — a record of channel id → on/off, validated whole
      // before anything is written (the route family's discipline).
      const raw = body.channels;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Response.json(
          {
            error:
              "channels must be an object mapping channel ids (chat, webhooks, email, slack, voice) to true or false",
          },
          { status: 400 },
        );
      }
      const entries = Object.entries(raw as Record<string, unknown>);
      if (
        entries.length === 0 ||
        entries.some(
          ([channel, value]) =>
            !(CAPABILITY_CHANNELS as readonly string[]).includes(channel) ||
            typeof value !== "boolean",
        )
      ) {
        return Response.json(
          {
            error:
              "channels must be an object mapping channel ids (chat, webhooks, email, slack, voice) to true or false",
          },
          { status: 400 },
        );
      }
      if (typeof ctx.writeSetting !== "function") {
        // Fail closed: never report a switch that was not stored
        // (the #2482 switch discipline, as for sessions above).
        return Response.json(
          { error: "Channel settings are unavailable on this host" },
          { status: 500 },
        );
      }
      channelUpdates = Object.fromEntries(entries) as Partial<
        Record<string, boolean>
      >;
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
    if (channelUpdates !== null) {
      // Merge into the decisions already stored under the stock
      // registration's key — a channel write never erases a
      // decision it did not name.
      const key = copilotChannelsSettingKey("stock");
      const existing = parseStoredCopilotChannelEntries(ctx.readSettingRaw(key));
      const merged = { ...existing.decisions, ...channelUpdates };
      ctx.writeSetting!(key, serializeStoredCopilotChannelEntries(merged));
    }
    const resolvedCadence = resolveCopilotCadence({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    const resolvedExecutionMode = resolveCopilotExecutionMode({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
    });
    const resolvedUniverseResolution = await resolveCopilotUniverseFull({
      env: ctx.env,
      readSettingRaw: ctx.readSettingRaw,
      indexListStore: new SqlIndexListStore(ctx.sql as never),
    });
    const resolvedUniverse = resolvedUniverseResolution.symbols;
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
      ...(channelUpdates !== null ? { channels: channelUpdates } : {}),
    });
    return Response.json({
      ok: true,
      ...(hasPaused ? { paused: body.paused } : {}),
      ...(sessions !== null ? { sessions } : {}),
      ...(validatedCadence !== null ? { cadence: resolvedCadence } : {}),
      ...(hasExecutionMode ? { executionMode: resolvedExecutionMode } : {}),
      ...(hasUniverse
        ? {
            universe: resolvedUniverse,
            universePreset: resolvedUniverseResolution.preset,
            universeSource: resolvedUniverseResolution.source,
            universeSnapshotDate: resolvedUniverseResolution.snapshotDate,
            universeFallbackReason: resolvedUniverseResolution.reason,
          }
        : {}),
      ...(hasStrategies ? { strategies: resolvedStrategies } : {}),
      ...(channelUpdates !== null
        ? { channels: projectStockCopilotChannels(ctx) }
        : {}),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update copilot control" },
      { status: 500 },
    );
  }
}
