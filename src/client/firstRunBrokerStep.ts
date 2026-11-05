/**
 * Issue #3371 — first-run step 3 asks the selected broker.
 *
 * The wizard's connect step was E*TRADE end to end: it polled E*TRADE's OAuth
 * status, told the user "Your E*TRADE account is connected", and offered a
 * Connect E*TRADE button that redirected into E*TRADE's authorization. On an
 * Alpaca tenant that is a screen asking the user to authorize a broker they do
 * not trade on — the last E*TRADE-only journey in the product (#3292).
 *
 * The decision is derived, not listed: the broker catalogue declares each
 * broker's `credentialKind` (#3232), and a key-pair broker signs in from its
 * panel in the trading view (#3351 owns that flow). This module answers only
 * what the wizard needs, and answers it for every broker, so a third broker
 * cannot arrive without one.
 */
import {
  BROKER_CATALOG,
  brokerCredentialGuidance,
  isBrokerId,
  type BrokerId,
} from "../trading/brokerCatalog";

/** How this broker is connected, as the wizard needs to know it. */
export type FirstRunBrokerMode = "oauth" | "key_pair";

export interface FirstRunBrokerStep {
  readonly broker: BrokerId;
  readonly label: string;
  readonly mode: FirstRunBrokerMode;
  /**
   * True when the wizard itself can complete the connection (an OAuth
   * redirect). False when the sign-in belongs to the broker's panel — the
   * wizard then explains where it lives and moves on.
   */
  readonly connectsInWizard: boolean;
}

/**
 * An unrecognised stored selection resolves as E*TRADE, the same rule the hub
 * and the section nav apply — one fallback, expressed once per consumer rather
 * than three different defaults.
 */
export function firstRunBrokerStep(broker: unknown): FirstRunBrokerStep {
  const id: BrokerId = isBrokerId(broker) ? (broker as BrokerId) : "etrade";
  const mode: FirstRunBrokerMode = brokerCredentialGuidance(id).kind === "api_key_pair" ? "key_pair" : "oauth";
  return {
    broker: id,
    label: BROKER_CATALOG[id].label,
    mode,
    connectsInWizard: mode === "oauth",
  };
}
