/**
 * Issue #3471 — the Stock Copilot push leg, receiving half: the
 * OrchestratorAgent's onWebhook implementation for the `settings`
 * source (deliveries arrive through PortThink's built-in channel,
 * #3474 — signature-verified before this code ever sees them; the
 * sender is ../settingsWebhookNotify.ts).
 *
 * The event is a NOTIFICATION, not data: its payload carries only
 * the fact of a change (kind, login, changedAt). On a settings
 * event this handler:
 *
 * 1. Acts only for the instance's OWN login — the payload login
 *    must equal the login in this instance's screener execution
 *    context (the same acting identity the cycle and the status
 *    route use). A context-less instance cannot verify ownership
 *    and ignores the event; an event naming another login is
 *    ignored with a log. (The instance name IS the login in
 *    production routing; the execution context is the identity
 *    the copilot itself runs under, so it is the authority here.)
 * 2. RE-RESOLVES the effective selection through the #3451
 *    resolver — the stores stay authoritative, so even a
 *    verified-but-wrong event can only cause a re-read. An
 *    unresolved resolution holds nothing and records nothing
 *    (the status route and the cycle name that state themselves).
 * 3. Compares with the selection HELD in the instance's Agent
 *    state (this module's `copilotSelection` key, written only
 *    here). No held baseline ⇒ this notification establishes it
 *    (a state write, so the base Agent broadcast carries the
 *    current selection to connected clients) with NO activity
 *    record — nothing demonstrably changed against a held truth.
 *    A real change ⇒ a "selection changed" entry in the copilot
 *    activity feed through the activity port (old → new,
 *    source: notified — #3473's observed records carry their own
 *    source), an audit event, and the state write that pushes
 *    the new selection to connected websocket clients (#3472).
 *    No change ⇒ silence: no record, no broadcast.
 */

import type { ActorWebhookEvent } from "../../actors/actorPorts";
import type { CommercialStore } from "../../data/commercialPorts";
import type { StockCopilotActivityPort } from "../../data/stockCopilotStorePorts";
import type { Env } from "../../types";
import {
  resolveCopilotTradingSelection,
  type CopilotTradingSelection,
} from "../copilotTradingMode";
import {
  SETTINGS_WEBHOOK_SOURCE,
  type SettingsChangeKind,
} from "../settingsWebhookNotify";
import type { ScreenerExecutionContext } from "./scheduleMaintenance";

/** The Agent-state key under which the held selection lives. */
export const COPILOT_SELECTION_STATE_KEY = "copilotSelection";

/** The selection this instance currently holds as notified truth. */
export interface HeldCopilotSelection {
  brokerId: string;
  environment: string;
  mode: string;
  /** Only one writer exists today (this hook); the field keeps the
   *  held record self-describing next to #3473's observe writes. */
  source: "notified";
  /** ISO timestamp of the change that produced this selection. */
  updatedAt: string;
}

export interface SettingsWebhookContext {
  env: Partial<Env>;
  /** The copilot activity feed (the data-layer port over the
   *  instance's own storage, composed by the class). */
  activity: StockCopilotActivityPort;
  /** The instance's settings reader (the #2482 store). */
  readSettingRaw: (key: string) => string | null;
  /** The instance's acting identity (the cycle's own login source). */
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  /** Composition seam for the broker-selection read: when omitted,
   *  the resolver composes the commercial store from env; tests
   *  inject the store directly. */
  commercial?: CommercialStore | null;
  /** The base Agent state accessors (unwrapped — a setState here
   *  is the base Agent's own broadcast to connected clients). */
  getState: () => unknown;
  setState: (next: unknown) => void;
  /** Audit funnel (optional: read-only hosts omit it). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
  /** Clock seam for tests; production uses the wall clock. */
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSettingsChangeKind(value: unknown): value is SettingsChangeKind {
  return value === "broker_selection_changed" || value === "mode_changed";
}

/** Read the held selection out of an Agent state value, or null
 *  when none (or an unrecognisable shape) is held. */
export function readHeldCopilotSelection(state: unknown): HeldCopilotSelection | null {
  if (!isRecord(state)) return null;
  const held = state[COPILOT_SELECTION_STATE_KEY];
  if (!isRecord(held)) return null;
  if (
    typeof held.brokerId !== "string" ||
    typeof held.environment !== "string" ||
    typeof held.mode !== "string" ||
    typeof held.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    brokerId: held.brokerId,
    environment: held.environment,
    mode: held.mode,
    source: "notified",
    updatedAt: held.updatedAt,
  };
}

/** The feed label for a selection: `alpaca · paper`. */
function selectionLabel(selection: { brokerId: string; mode: string }): string {
  return `${selection.brokerId} · ${selection.mode}`;
}

function sameSelection(
  held: HeldCopilotSelection,
  selection: CopilotTradingSelection,
): boolean {
  return (
    held.brokerId === selection.brokerId &&
    held.environment === selection.environment &&
    held.mode === selection.mode
  );
}

/**
 * Handle one verified webhook delivery for the orchestrator.
 * Never throws for payload/identity/resolution problems — those
 * are logged and ignored (the port answers 200; a retry could not
 * fix any of them, and the observe floor owns convergence).
 */
export async function handleSettingsWebhook(
  ctx: SettingsWebhookContext,
  event: ActorWebhookEvent,
): Promise<void> {
  if (event.source !== SETTINGS_WEBHOOK_SOURCE) return;
  const payload = event.payload;
  if (
    !isRecord(payload) ||
    !isSettingsChangeKind(payload.kind) ||
    typeof payload.login !== "string" ||
    !payload.login.trim()
  ) {
    console.warn(
      "[SettingsWebhook] ignoring a settings delivery with a malformed payload " +
        "(expected { kind, login, changedAt })",
    );
    return;
  }
  const kind = payload.kind;
  const changedAt =
    typeof payload.changedAt === "string" &&
    !Number.isNaN(Date.parse(payload.changedAt))
      ? payload.changedAt
      : (ctx.now ? ctx.now() : new Date()).toISOString();

  const executionContext = await ctx
    .getScreenerExecutionContext()
    .catch(() => undefined);
  const ownLogin = executionContext?.userLogin;
  if (!ownLogin) {
    console.warn(
      "[SettingsWebhook] ignoring a settings delivery: this instance holds no " +
        "execution context, so it cannot verify the event is its own",
    );
    return;
  }
  if (payload.login !== ownLogin) {
    console.warn(
      `[SettingsWebhook] ignoring a settings delivery for login "${payload.login}" ` +
        `on the instance for "${ownLogin}" — an agent acts only on its own selection`,
    );
    return;
  }

  const resolution = await resolveCopilotTradingSelection({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
    commercial: ctx.commercial,
  });
  if (!resolution.resolved) {
    console.warn(
      `[SettingsWebhook] settings change for "${ownLogin}" could not be re-resolved ` +
        "(the broker store is unreadable) — nothing held, nothing recorded; " +
        "the status route and the next cycle name the unresolved state",
    );
    return;
  }
  const selection = resolution.selection;
  const held = readHeldCopilotSelection(ctx.getState());
  if (held && sameSelection(held, selection)) return;

  if (held) {
    // A real change against the held truth: feed entry first
    // (display-grade — a failed append is logged, never allowed
    // to cost the state update), then the audit annotation.
    try {
      ctx.activity.ensureSchema();
      ctx.activity.appendActivity({
        id: crypto.randomUUID(),
        userLogin: ownLogin,
        cycleAt: changedAt,
        outcome: "selection_changed",
        entries: [],
        exits: [],
        detail:
          `${selectionLabel(held)} → ${selectionLabel(selection)} ` +
          "(source: notified)",
      });
    } catch (err) {
      console.warn(
        "[SettingsWebhook] the selection-changed activity entry could not be written",
        err,
      );
    }
    try {
      ctx.audit?.("stock_copilot.selection_changed", "orchestrator", {
        userLogin: ownLogin,
        kind,
        from: {
          brokerId: held.brokerId,
          environment: held.environment,
          mode: held.mode,
        },
        to: {
          brokerId: selection.brokerId,
          environment: selection.environment,
          mode: selection.mode,
        },
      });
    } catch {
      // Audit is an annotation here, never a control.
    }
  }

  const nextHeld: HeldCopilotSelection = {
    brokerId: selection.brokerId,
    environment: selection.environment,
    mode: selection.mode,
    source: "notified",
    updatedAt: changedAt,
  };
  const previousState = ctx.getState();
  ctx.setState({
    ...(isRecord(previousState) ? previousState : {}),
    [COPILOT_SELECTION_STATE_KEY]: nextHeld,
  });
}
