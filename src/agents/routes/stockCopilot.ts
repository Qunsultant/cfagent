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
 *        itself stays in the dynamic panel menu.
 *   POST /stock-copilot/control — the panel's only write: set the
 *        caller's own pause control ({ paused: boolean }). Paused
 *        ⇒ the cycle keeps managing exits but places no entries;
 *        the global STOCK_COPILOT_PAPER_ENABLED flag stays the
 *        master kill switch above this per-instance control.
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
  const isControlWrite = path.endsWith("/stock-copilot/control") && request.method === "POST";
  if (!isStatusRead && !isControlWrite) return null;

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
      const marketOpen = isUsMarketOpen(new Date());
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
              : !marketOpen
                ? "outside_market_hours"
                : "live";
      return Response.json({
        flagEnabled,
        paused,
        marketOpen,
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

  // Pause/resume write: the caller's own instance only (the login
  // above IS the instance identity — there is no target parameter).
  try {
    const body = (await request.json().catch(() => null)) as {
      paused?: unknown;
    } | null;
    if (!body || typeof body.paused !== "boolean") {
      return Response.json(
        { error: "paused must be true or false" },
        { status: 400 },
      );
    }
    control.ensureSchema();
    control.setControl({
      userLogin,
      paused: body.paused,
      updatedAt: new Date().toISOString(),
      updatedBy: userLogin,
    });
    ctx.audit?.("stock_copilot.control", "orchestrator", {
      userLogin,
      paused: body.paused,
    });
    return Response.json({ ok: true, paused: body.paused });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update copilot control" },
      { status: 500 },
    );
  }
}
