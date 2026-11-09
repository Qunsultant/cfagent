/**
 * Issue #2482 — the single E*TRADE environment source of truth.
 *
 * The persisted per-login selection lives in the user's own
 * OrchestratorAgent DO instance settings (mas_settings, key
 * `etrade:environment`). When no selection is persisted, the default
 * is TEST (paper) — issue #3857, owner rule: the default broker mode
 * is paper, never live; live is an explicit stored selection. The
 * deployment chain no longer selects the default: a TEST deployment
 * resolved TEST before and still does, and a PROD deployment used to
 * default to PROD and now defaults to TEST. Every interactive E*TRADE
 * data route resolves through this module, never through the request
 * header: a stale client key must not be able to split surfaces again.
 *
 * Deliberately NOT consulted here: token presence. A login can hold
 * both a TEST and a PROD token, so token presence cannot disambiguate;
 * the explicit selection can. This module changes only the environment
 * argument fed into the token seam — the seam itself (key-scope order,
 * identity pass-through, rejection propagation) belongs to #2442 and
 * is untouched.
 *
 * The switch handler lives here (not in etradeBroker.ts) for the same
 * reason the diagnostics handlers moved out under #995: etradeBroker.ts
 * sits at the #359 50 KB module target, and this block is a coherent
 * unit on its own. etradeBroker.ts delegates to it.
 */

import type { Env } from "../../types";
import type { SettingsChangeNotifier } from "../settingsWebhookNotify";

export const BROKER_ENVIRONMENT_SETTING_KEY = "etrade:environment";

export type BrokerEnvironment = "TEST" | "PROD";

export function isBrokerEnvironment(value: unknown): value is BrokerEnvironment {
  return value === "TEST" || value === "PROD";
}

/**
 * Resolve the source of truth from a stored settings value. Anything
 * other than an exact TEST/PROD falls back to TEST (paper) — issue
 * #3857: the default mode is paper, never live. This function takes
 * no header input by construction: headers are not an authority for
 * broker data.
 */
export function resolveBrokerEnvironment(stored: string | null | undefined): BrokerEnvironment {
  return isBrokerEnvironment(stored) ? stored : "TEST";
}

/**
 * The unset default: TEST (paper), issue #3857. The deployment chain
 * no longer selects it — a TEST deployment resolved TEST before and
 * still does; a PROD deployment used to default to PROD and now
 * defaults to TEST, because live is an explicit stored selection.
 * The workerEnv parameter stays so callers do not change.
 */
export function resolveBrokerEnvironmentDefault(_workerEnv: Partial<Env>): BrokerEnvironment {
  return "TEST";
}

/**
 * Resolve from a settings reader plus the worker env. Selection wins
 * when set; otherwise the paper default applies.
 */
export function resolveBrokerEnvironmentFromSettings(
  readSettingRaw: ((key: string) => string | null) | undefined,
  workerEnv: Partial<Env>,
): BrokerEnvironment {
  const stored =
    typeof readSettingRaw === "function"
      ? readSettingRaw(BROKER_ENVIRONMENT_SETTING_KEY)
      : null;
  if (isBrokerEnvironment(stored)) return stored;
  return resolveBrokerEnvironmentDefault(workerEnv);
}

/**
 * Issue #3382 — the mode a TRADE is authorised under, for both brokers.
 *
 * Reads and actions do not share a default, and that asymmetry is the point:
 * the deployment's environment is right for READS (a tenant on the live worker
 * sees the live account), but it is wrong for an ACTION. A tenant who has never
 * chosen anything previews, executes and signs in on PAPER; live is an explicit
 * act that persists a selection. Without this, a first order on a live worker is
 * a live order nobody asked for.
 *
 * Only the trade routes use this: brokerOrders (preview + execute) and
 * brokerConnect (which credential side is verified and stored). Read routes keep
 * resolveBrokerEnvironmentFromSettings so the data plane does not move.
 */
export function resolveTradeEnvironmentFromSettings(
  readSettingRaw: ((key: string) => string | null) | undefined,
  workerEnv: Partial<Env>,
): BrokerEnvironment {
  const stored =
    typeof readSettingRaw === "function"
      ? readSettingRaw(BROKER_ENVIRONMENT_SETTING_KEY)
      : null;
  if (isBrokerEnvironment(stored)) return stored;
  void workerEnv;
  return "TEST";
}

/**
 * Settings access the switch handler needs. The writer is optional
 * because older test-constructed contexts carry only the reader; the
 * switch handler fails closed (500) without it rather than returning
 * success while storing nothing. The worker env is required so the
 * GET path applies the same deployment default as the data routes.
 */
export interface BrokerEnvironmentSwitchContext {
  readSettingRaw(key: string): string | null;
  writeSetting?(key: string, value: string): void;
  env: Partial<Env>;
  /**
   * Issue #3471: after a switch persists, notify the caller's own
   * orchestrator instance through the webhook channel (the push
   * leg — the Stock Copilot learns the new mode immediately
   * instead of at its next firing). Optional: hosts without the
   * notifier keep the pre-#3471 behavior (the observe floor
   * bounds the staleness). The notifier is fire-and-forget and
   * never throws; the switch's response never depends on it.
   */
  notifySettingsChanged?: SettingsChangeNotifier;
}

/** Issue #2482: read the current selection (GET on either spelling). */
export function handleBrokerEnvironmentGet(ctx: BrokerEnvironmentSwitchContext): Response {
  return Response.json({
    environment: resolveBrokerEnvironmentFromSettings(ctx.readSettingRaw, ctx.env),
  });
}

/**
 * Issue #314 — single-owner handler for the environment switcher.
 * Both spellings (`/environment/switch` and the advertised
 * `/broker/etrade/environment` from ETradeDynamicMenu.tsx) delegate here,
 * so the request/response contract, validation, and auth are identical.
 *
 * Issue #2482: the switch PERSISTS the selection to the caller's
 * instance settings, making it the single source of truth. It must
 * never again return success while storing nothing.
 */
export async function handleEnvironmentSwitch(
  request: Request,
  ctx: BrokerEnvironmentSwitchContext,
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const requested = String(body.environment || "PROD").toUpperCase().trim();
    if (requested === "TEST" || requested === "PROD") {
      if (!ctx.writeSetting) {
        return Response.json(
          { error: "Environment persistence unavailable." },
          { status: 500 },
        );
      }
      ctx.writeSetting(BROKER_ENVIRONMENT_SETTING_KEY, requested);
      // Issue #3471: the write has committed — notify the caller's
      // own instance (the session login server.ts stamps on the
      // request). No login, no instance to notify: the write still
      // stands and the observe floor owns convergence.
      const login = request.headers.get("x-user-login")?.trim();
      if (ctx.notifySettingsChanged && login) {
        try {
          ctx.notifySettingsChanged({
            kind: "mode_changed",
            login,
            changedAt: new Date().toISOString(),
          });
        } catch {
          // Notification is best-effort by contract; a notifier
          // that throws anyway must never fail the switch.
        }
      }
      return Response.json({ success: true, environment: requested });
    }
    return Response.json({ error: "Invalid environment. Expected TEST or PROD." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: "Failed to switch environment" }, { status: 500 });
  }
}
