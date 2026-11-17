/**
 * Issue #5131 — the ONE resolution of "which broker does this channel
 * surface name, and which broker does it execute on".
 *
 * #4999 (Gap 10) taught voice, NLQ and Slack to execute on the tenant's
 * selected broker with the expression
 *
 *   request override ?? resolveTenantBrokerSelection(env) ?? "etrade"
 *
 * but each of the three re-typed that expression, and each surface then
 * printed its own hard-coded broker name beside it. Execution followed the
 * selection; the label did not. That is the defect class
 * `brokerPresentation` (#3417) exists to remove: the name on screen and the
 * broker the order reaches must come from one value.
 *
 * So the expression lives here, once, and returns both facts together:
 *   - `executing` — the id the surface passes to `TradingPlatformRegistry`
 *     (unchanged from #4999, including its pass-through of an unknown id so
 *     the registry refuses it loudly rather than substituting a broker);
 *   - `presentation` — the vocabulary `brokerPresentation` renders.
 *
 * The three cases the presentation must keep apart:
 *   1. a known broker is selected (or overridden) → that broker's own name;
 *   2. nothing is selected → the configured legacy channel broker
 *      (`config/channel-brokers.json`), which keeps the wording these
 *      surfaces shipped with, and must not move for existing tenants;
 *   3. an id was supplied but the catalogue does not know it → the name-free
 *      fallback, never a guessed default broker.
 */
import { CHANNEL_BROKERS } from "../config/channelBrokers";
import { brokerPresentation, type BrokerPresentation } from "./brokerPresentation";
import { isBrokerId, type BrokerId } from "./brokerCatalog";

/**
 * The fallback broker for voice/NLQ/Slack. An unrecognised value in the
 * setting degrades to E*TRADE — the behavior these surfaces shipped with
 * before the setting existed — rather than to a broker nobody asked for.
 */
export const LEGACY_CHANNEL_BROKER: BrokerId = isBrokerId(CHANNEL_BROKERS.legacyDefaultBroker)
  ? CHANNEL_BROKERS.legacyDefaultBroker
  : "etrade";

export interface ChannelBroker {
  /**
   * The broker the surface executes on. An absent selection resolves to the
   * legacy channel broker; a *supplied* id the catalogue does not know is
   * passed through unchanged, so the registry's own refusal fires instead of
   * an order silently reaching a broker the caller did not ask for.
   */
  readonly executing: BrokerId;
  /** How the surface names this broker (label, desk name, mode words). */
  readonly presentation: BrokerPresentation;
  /**
   * Where the id came from. Callers that must keep their pre-#5131 execution
   * shape use this: Slack constructed the legacy service when nothing was
   * selected and the registry platform when a broker was — and the platform
   * carries guards (e.g. #1393's frozen-terms check) the bare service does
   * not, so the two are not interchangeable.
   */
  readonly source: "override" | "selection" | "fallback";
}

/**
 * The tenant's stored selection (or its env override), or null when the
 * tenant selected nothing. The import is dynamic on purpose:
 * `services/tenantProviders` imports the trading barrel for
 * `DATA_PROVIDER_IDS`, so a static edge from this barrel-exported module
 * would make the barrel depend on a module that depends on the barrel — the
 * cycle crashes module initialisation with a TDZ error.
 */
async function selectedBroker(env: unknown): Promise<BrokerId | null> {
  const { resolveTenantBrokerSelection } = await import("../services/tenantProviders");
  return resolveTenantBrokerSelection(env).catch(() => null);
}

/**
 * Resolve a channel surface's broker once per turn/event.
 *
 * `override` is the per-turn value a caller may pass (the voice hub's
 * `copilotBrokerId`); the tenant selection is read only when it is absent,
 * exactly as #4999 ordered the two.
 */
export async function resolveChannelBroker(env: unknown, override?: unknown): Promise<ChannelBroker> {
  const overridden = override !== undefined && override !== null;
  const requested = overridden ? override : await selectedBroker(env);
  // Case 2 needs a broker that exists; cases 1 and 3 need the id as supplied
  // (known → itself, unknown → the registry refuses it and the presentation
  // falls back to a name-free label).
  const broker = requested ?? LEGACY_CHANNEL_BROKER;
  return {
    executing: broker as BrokerId,
    presentation: brokerPresentation(broker),
    source: overridden ? "override" : requested == null ? "fallback" : "selection",
  };
}
