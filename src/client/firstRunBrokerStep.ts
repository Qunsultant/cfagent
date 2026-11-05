/**
 * Issue #3371 — first-run step 3 asks the selected broker.
 *
 * The wizard's connect step was E*TRADE end to end: it polled E*TRADE's OAuth
 * status, told the user "Your E*TRADE account is connected", and offered a
 * Connect E*TRADE button that redirected into E*TRADE's authorization. On an
 * Alpaca tenant that is a screen asking the user to authorize a broker they do
 * not trade on — the last E*TRADE-only journey in the product (#3292).
 *
 * This module is a pure decision: the caller (a `.tsx`, which may read the broker
 * catalogue) passes the broker id, its label and its declared credential kind.
 * That keeps `src/client/*.ts` out of `src/trading` (the boundary, #290) while
 * keeping the rule in one testable place — and it means a third broker needs a
 * catalogue entry, not a new branch here.
 */

/** How this broker is connected, as the wizard needs to know it. */
export type FirstRunBrokerMode = "oauth" | "key_pair";

export interface FirstRunBrokerStepInput {
  /** The stored selection, unvalidated: this function does not trust it. */
  readonly broker: unknown;
  /** The broker's own label, from the catalogue. */
  readonly label: string;
  /** The catalogue's `credentialKind` for this broker. */
  readonly credentialKind: string;
}

export interface FirstRunBrokerStep {
  readonly broker: string;
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
 * The wizard's view of one broker.
 *
 * `broker === "etrade"` is the same branch the hub uses to pick a panel: an
 * unrecognised stored id is not E*TRADE, so it must not be offered E*TRADE's
 * authorization. The caller resolves the label and credential kind for the broker
 * it decided on, so this function never invents either.
 */
export function firstRunBrokerStep(input: FirstRunBrokerStepInput): FirstRunBrokerStep {
  const broker = input.broker === "etrade" ? "etrade" : "alpaca";
  const mode: FirstRunBrokerMode = input.credentialKind === "api_key_pair" ? "key_pair" : "oauth";
  return {
    broker,
    label: input.label,
    mode,
    connectsInWizard: mode === "oauth",
  };
}
