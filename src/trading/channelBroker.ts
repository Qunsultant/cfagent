/**
 * Issue #5131 — the ONE resolution of "which broker does this channel
 * surface name, and which broker does it execute on".
 * Issue #5147 — the no-selection answer is the platform default, so the
 * channel surfaces and the neutral routes cannot route an unselected tenant
 * to different brokers.
 *
 * #4999 (Gap 10) taught voice, NLQ and Slack to execute on the tenant's
 * selected broker with the expression
 *
 *   request override ?? resolveTenantBrokerSelection(env) ?? "etrade"
 *
 * but each of the three re-typed that expression, and each surface then
 * printed its own hard-coded broker name beside it. #5131 moved the
 * expression here and made the labels read it. #5147 removed the remaining
 * divergence in its fallback: an unselected tenant now resolves the same
 * platform default (#3937) every other surface resolves, instead of the
 * channel-only E*TRADE fallback #4999 left behind.
 *
 * The three cases the resolution keeps apart:
 *   1. a known broker is selected (or overridden) → that broker;
 *   2. nothing is selected → the configured no-selection default, which is
 *      the platform default (`resolveTenantBroker`, #3937) unless a
 *      deployment explicitly pins the legacy per-channel broker;
 *   3. an id was supplied but the catalogue does not know it → the id is
 *      passed through so the registry refuses it loudly, while the
 *      presentation uses the name-free fallback (never a guessed broker).
 */
import { CHANNEL_BROKERS, type ChannelBrokersConfig } from "../config/channelBrokers";
import { brokerPresentation, type BrokerPresentation } from "./brokerPresentation";
import { isBrokerId, type BrokerId } from "./brokerCatalog";

/**
 * Where the resolved id came from. Slack keeps its pre-#5131 execution shape
 * for the no-selection case (`ETradeService` when that default is E*TRADE),
 * so it needs to tell the two sources apart.
 */
export type ChannelBrokerSource = "override" | "selection" | "no-selection";

export interface ChannelBroker {
  /**
   * The broker the surface executes on. An absent selection resolves to the
   * configured default; a *supplied* id the catalogue does not know is passed
   * through unchanged, so the registry's own refusal fires instead of an
   * order silently reaching a broker the caller did not ask for.
   */
  readonly executing: BrokerId;
  /** How the surface names this broker (label, desk name, mode words). */
  readonly presentation: BrokerPresentation;
  /** Which of the three cases produced `executing`. */
  readonly source: ChannelBrokerSource;
}

/**
 * Which broker an unselected tenant gets. Pure, so both branches are pinned
 * by a test without mocking the module's config:
 *  - the shipped policy (`"platform"`) is the ONE platform default (#3937);
 *  - `"legacy"` is an explicit operator choice of the pre-#5147 broker, and
 *    only a *known* broker id is honoured — a typo falls back to the platform
 *    default instead of inventing a broker.
 */
export function resolveNoSelectionBroker(
  config: Pick<ChannelBrokersConfig, "noSelectionDefault" | "legacyDefaultBroker">,
  platformDefault: BrokerId,
): BrokerId {
  if (config.noSelectionDefault === "legacy" && isBrokerId(config.legacyDefaultBroker)) {
    return config.legacyDefaultBroker;
  }
  return platformDefault;
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
 * The ONE platform default (#3937): `resolveTenantBroker` applies
 * `DEFAULT_TENANT_PROVIDERS.brokerId` and validates it, so a deployment
 * changes the default in that one place — never here. Reused rather than
 * re-derived for exactly that reason.
 */
async function platformDefaultBroker(env: unknown): Promise<BrokerId> {
  const { resolveTenantBroker } = await import("../services/tenantProviders");
  return resolveTenantBroker(env);
}

function build(broker: unknown, source: ChannelBrokerSource): ChannelBroker {
  return {
    // An unknown supplied id is passed through: `brokerPresentation` reports
    // it as unknown, and the registry refuses it before any order is placed.
    executing: broker as BrokerId,
    presentation: brokerPresentation(broker),
    source,
  };
}

/**
 * Resolve a channel surface's broker once per turn/event.
 *
 * `override` is the per-turn value a caller may pass (the voice hub's
 * `copilotBrokerId`); the tenant selection is read only when it is absent,
 * exactly as #4999 ordered the two.
 */
export async function resolveChannelBroker(env: unknown, override?: unknown): Promise<ChannelBroker> {
  if (override !== undefined && override !== null) return build(override, "override");

  const selected = await selectedBroker(env);
  if (selected) return build(selected, "selection");

  return build(
    resolveNoSelectionBroker(CHANNEL_BROKERS, await platformDefaultBroker(env)),
    "no-selection",
  );
}
