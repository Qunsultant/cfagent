/**
 * Issue #3451 — the Stock Copilot's trading-mode selection: the ONE
 * broker and ONE mode in effect for a copilot cycle, resolved from
 * the platform's existing selection model (AOP — the selection lives
 * in the panel menu's stores, never in copilot-private state):
 *
 * - ACTIVE BROKER: the tenant's provider selection in the commercial
 *   store (data layer, #3233) — one `brokerId` per tenant, the same
 *   row the tenant settings surface reads and writes. Read through
 *   the composition root (createCommercialAdapter); an unbound store
 *   (no AGENT_DB) or a failed read makes the selection UNRESOLVED.
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
  resolveTradeEnvironmentFromSettings,
  type BrokerEnvironment,
} from "./routes/brokerEnvironment";

/** The copilot's broker id: the platform the cycle would trade on. */
export const COPILOT_BROKER_ID = "alpaca";

/** One resolved selection: exactly one broker, exactly one mode. */
export interface CopilotTradingSelection {
  /** The tenant's active broker (raw stored id, e.g. "alpaca"). */
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
 * money path to a guessed broker or mode.
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
    const providers = await commercial.getTenantProviders(
      resolveIaaaTenant(readers.env),
    );
    brokerId = providers.brokerId;
  } catch {
    return { resolved: false };
  }
  const environment = resolveTradeEnvironmentFromSettings(
    readers.readSettingRaw,
    readers.env,
  );
  const mode = isBrokerId(brokerId)
    ? tradingTypeFor(brokerId, environment)
    : environment === "TEST"
      ? "paper"
      : "live";
  return { resolved: true, selection: { brokerId, environment, mode } };
}
