/**
 * Issue #5131 — the setting that decides which broker a channel surface
 * (voice, NLQ, Slack) names and executes on when the tenant selected none.
 * Issue #5147 — the shipped value is now "platform": the divergence is retired.
 *
 * History, because the two defaults are easy to confuse:
 *   - #3937 (user decision 2026-11-10) made the "no selection" default ONE:
 *     the platform default (`DEFAULT_TENANT_PROVIDERS.brokerId`, resolved by
 *     `resolveTenantBroker`) for every surface that needs a concrete broker.
 *   - #4999 (Gap 10) taught voice/NLQ/Slack to resolve the selected broker but
 *     left E*TRADE as a per-channel fallback inside its expression, so an
 *     unselected tenant's channel order still went to E*TRADE while the same
 *     tenant's neutral routes and hub went to the platform default.
 *   - #5131 externalized that fallback here as `legacyDefaultBroker` so the
 *     divergence was a setting rather than a literal.
 *   - #5147 recorded the decision: the channels adopt the platform default
 *     (`noSelectionDefault: "platform"`). `"legacy"` remains as the explicit,
 *     documented escape hatch for a deployment that needs the pre-#5147
 *     routing; it is never the default, and an unrecognised broker in it
 *     falls back to the platform default rather than to a guess.
 *
 * This module reads that file and nothing else. Keeping it import-free is
 * deliberate: the trading barrel imports it, and a static edge from here into
 * `services/tenantProviders` would close a cycle (that module imports the
 * barrel for `DATA_PROVIDER_IDS`) which crashed worker module initialisation
 * with a TDZ error on the first import order that reached it.
 */
import raw from "../../config/channel-brokers.json";

export interface ChannelBrokersConfig {
  /**
   * Which broker an unselected tenant's channel surface uses.
   * `"platform"` = the one platform default (#3937) — the shipped decision.
   * Anything else is treated as `"platform"`: a typo must not reintroduce a
   * second default silently.
   */
  readonly noSelectionDefault: string;
  /**
   * The pre-#5147 per-channel fallback. Read only when
   * `noSelectionDefault` is `"legacy"`; kept so that escape hatch is a
   * setting, not a literal in the channel code.
   */
  readonly legacyDefaultBroker: string;
}

/** The setting as written in `config/channel-brokers.json`. */
export const CHANNEL_BROKERS: Readonly<ChannelBrokersConfig> = raw as ChannelBrokersConfig;
