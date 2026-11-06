/**
 * Issue #3451 — the Stock Copilot's trading-mode selection: the ONE
 * broker and ONE mode in effect for a copilot cycle, resolved from
 * the platform's existing selection model (AOP — the selection lives
 * in the panel menu's stores, never in copilot-private state):
 *
 * - ACTIVE BROKER: the tenant's provider selection in the commercial
 *   store (data layer, #3233) — one `brokerId` per tenant, the same
 *   row the tenant settings surface reads and writes. Read through
 *   the composition root (createCommercialAdapter) via the port's
 *   presence-aware read (getTenantBrokerSelection): a stored value
 *   is the selection, exactly as stored. NO stored selection ⇒ the
 *   COPILOT's default broker, alpaca (owner rule on #3451: "by
 *   default — no selection made — it must be Alpaca in Paper mode";
 *   the paper half comes from the mode default below). That default
 *   lives HERE, in the copilot's resolver, only: the shared store
 *   default (etrade, applied by getTenantProviders) is unchanged
 *   and still governs the manual broker routes. An unbound store
 *   (no AGENT_DB) or a FAILED read makes the selection UNRESOLVED —
 *   a failure is never mistaken for an absent selection, so the
 *   default never covers a store outage on a money path.
 * - ACTIVE MODE: the per-login stored trade environment (#2482's
 *   `etrade:environment` setting in the instance's own settings),
 *   read with trade semantics (#3382, resolveTradeEnvironmentFromSettings):
 *   the stored value wins; unset means TEST — live is an explicit
 *   act, never a deployment default. Mapped to paper/live through
 *   the broker catalog (#3232, tradingTypeFor).
 *
 * Both halves are server-side reads over stores that already exist;
 * this module adds no store of its own. Consumers: the copilot's
 * scheduled-task host (which mode the cycle runs) and the #3422
 * status route (which broker + mode the panel reports). Exactly one
 * broker and one mode are ever in effect: the resolution is a single
 * value, and the cycle fails closed on `resolved: false` rather than
 * guessing a mode for a money path.
 */

import { createCommercialAdapter } from "../data/createCommercialPorts";
import type { CommercialStore } from "../data/commercialPorts";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { isBrokerId, tradingTypeFor, type TradingType } from "../trading";
import type { Env } from "../types";
import {
  BROKER_ENVIRONMENT_SETTING_KEY,
  resolveTradeEnvironmentFromSettings,
  type BrokerEnvironment,
} from "./routes/brokerEnvironment";

/** The copilot's broker id: the platform the cycle would trade on. */
export const COPILOT_BROKER_ID = "alpaca";

/** One resolved selection: exactly one broker, exactly one mode. */
export interface CopilotTradingSelection {
  /** The tenant's active broker: the raw stored id (e.g. "alpaca"),
   *  or the copilot default (alpaca) when no selection is stored. */
  brokerId: string;
  /** The selected environment the mode was derived from. The host
   *  constructs the trading platform with this selection, so the
   *  platform's own credential/base resolution follows the mode. */
  environment: BrokerEnvironment;
  /** paper | live, per the broker catalog's mapping (#3232). */
  mode: TradingType;
}

export type CopilotSelectionResolution =
  | { resolved: true; selection: CopilotTradingSelection }
  | { resolved: false };

export interface CopilotSelectionReaders {
  env: Partial<Env>;
  /** The instance's settings reader (the #2482 store). Absent ⇒ the
   *  #3382 trade default (TEST) applies, exactly as on the manual
   *  trade routes. */
  readSettingRaw?: ((key: string) => string | null) | undefined;
  /** Composition seam: when omitted, the commercial store is
   *  composed from env (null when AGENT_DB is unbound); tests and
   *  alternate hosts inject the store directly. */
  commercial?: CommercialStore | null;
}

/**
 * Resolve the active broker + mode. Fail-closed by construction:
 * any inability to read the broker selection returns
 * `{ resolved: false }` — the caller must refuse, never default a
 * money path to a guessed broker or mode. The one default that DOES
 * apply is the owner's stated rule for a successfully-read ABSENT
 * selection: no broker selection stored ⇒ the copilot's broker is
 * alpaca (COPILOT_BROKER_ID), with the mode default (TEST/paper)
 * coming from the trade-environment semantics below — together,
 * "Alpaca in Paper mode" for a tenant who has selected nothing.
 */
export async function resolveCopilotTradingSelection(
  readers: CopilotSelectionReaders,
): Promise<CopilotSelectionResolution> {
  const commercial =
    readers.commercial !== undefined
      ? readers.commercial
      : createCommercialAdapter(readers.env);
  if (!commercial) return { resolved: false };
  let brokerId: string;
  try {
    const storedBrokerId = await commercial.getTenantBrokerSelection(
      resolveIaaaTenant(readers.env),
    );
    brokerId = storedBrokerId ?? COPILOT_BROKER_ID;
  } catch {
    return { resolved: false };
  }
  let environment: BrokerEnvironment;
  const storedEnv =
    typeof readers.readSettingRaw === "function"
      ? readers.readSettingRaw(BROKER_ENVIRONMENT_SETTING_KEY)
      : null;
  if (storedEnv === "TEST" || storedEnv === "PROD") {
    environment = storedEnv;
  } else {
    // #3541: When no tenant environment is stored, align with externalized
    // copilot mode or deployment pin before falling back to TEST.
    const explicitMode = String(
      readers.env?.STOCK_COPILOT_MODE ?? readers.env?.ALPACA_TRADING_TYPE ?? ""
    ).trim().toLowerCase();
    if (explicitMode === "live" || explicitMode === "prod") {
      environment = "PROD";
    } else {
      environment = resolveTradeEnvironmentFromSettings(
        readers.readSettingRaw,
        readers.env,
      );
    }
  }
  const mode = isBrokerId(brokerId)
    ? tradingTypeFor(brokerId, environment)
    : environment === "TEST"
      ? "paper"
      : "live";
  return { resolved: true, selection: { brokerId, environment, mode } };
}
