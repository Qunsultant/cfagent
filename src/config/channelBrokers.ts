/**
 * Issue #5131 — the broker a legacy channel surface falls back to.
 *
 * #4999 (Gap 10) made Voice, NLQ and Slack resolve the tenant's selected
 * broker, but kept E*TRADE as the per-channel fallback when nothing is
 * selected (`resolveTenantBrokerSelection(env) ?? "etrade"`). That value is
 * a setting, not a literal: it lives in `config/channel-brokers.json` so a
 * deployment can change it without touching the channel code.
 *
 * This module reads that file and nothing else. Validation against the
 * broker catalogue lives one step away, in `src/trading/channelBroker.ts`
 * (which also owns the one resolution that turns the setting into a broker).
 * Keeping this file import-free is deliberate: the trading barrel imports it,
 * and a static edge from here into `services/tenantProviders` would close a
 * cycle (that module imports the barrel for `DATA_PROVIDER_IDS`) which
 * crashed worker module initialisation with a TDZ error on the first import
 * order that reached it.
 *
 * NOT here, by design: the platform default for surfaces that require a
 * concrete broker (#3937's `resolveTenantBroker` → `DEFAULT_TENANT_PROVIDERS`).
 * Reconciling the two defaults is a behavior decision tracked separately.
 */
import raw from "../../config/channel-brokers.json";

export interface ChannelBrokersConfig {
  /** Broker a channel names and executes for when the tenant selected none. */
  readonly legacyDefaultBroker: string;
}

/** The setting as written in `config/channel-brokers.json`. */
export const CHANNEL_BROKERS: Readonly<ChannelBrokersConfig> = raw as ChannelBrokersConfig;
