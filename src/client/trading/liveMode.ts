/**
 * Issue #4649 (matrix gap 1) — the one rule set for "this broker cannot
 * simulate, so the paper mode is not a real mode for it".
 *
 * Public.com has a single live MCP endpoint: there is no paper host, no
 * sandbox account and no simulation anywhere. Placement in TEST is refused at
 * the platform seam (`FAILURE_PUBLIC_NO_PAPER_MODE`), so a surface that shows
 * "Public.com / Paper" states a mode that cannot exist. The decided behaviour
 * (Ceos, 2026-11-15) is not display-only: selecting Public while the stored
 * mode is TEST auto-switches the stored mode to PROD, with a confirmation
 * dialog as the disclosure.
 *
 * This module holds the decisions (does this broker need live? does this
 * switch need a confirmation? what does the dialog say?), so the settings
 * menu, the trading hub and the crumb read one implementation instead of
 * three branches. The "has a paper mode" fact itself lives in the broker
 * catalog (`BrokerDefinition.paperMode`), never here.
 */
import { brokerCanSimulate, type BrokerEnvironment } from "../brokerEnvironment";

/**
 * True when the broker has no simulated account, so its only placeable mode is
 * live. An unrecognised broker id answers false: an unknown broker is never
 * forced live.
 */
export function brokerRequiresLiveMode(broker: unknown): boolean {
  return !brokerCanSimulate(broker);
}

/**
 * True when the (broker, stored mode) pair is the impossible combination a
 * surface must disclose: the broker cannot simulate and the stored mode is
 * paper. This is the predicate behind the standing Notice on the settings menu
 * and above the ticket's Approve button.
 */
export function needsLiveModeForBroker(broker: unknown, env: BrokerEnvironment): boolean {
  return env !== "PROD" && brokerRequiresLiveMode(broker);
}

/**
 * True when moving between these two environments arms live trading and so
 * needs an explicit confirmation. Only the TEST→PROD direction qualifies:
 * going back to paper de-arms nothing and cannot move money.
 */
export function requiresLiveModeConfirm(
  target: BrokerEnvironment,
  current: BrokerEnvironment,
): boolean {
  return target === "PROD" && current !== "PROD";
}

export interface LiveModeConfirmCopy {
  /** The dialog's accessible name — the question it asks. */
  title: string;
  /** What confirming does, one paragraph per consequence. */
  body: string[];
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * The dialog copy for a TEST→PROD switch (#4649). It names the broker, says
 * what will happen (real money), says the scope (the mode is global), and — for
 * a broker with no paper account — why live is the only mode that can place.
 * Pure data so the copy is pinned by a test instead of by a snapshot.
 */
export function liveModeConfirmCopy(input: {
  brokerLabel: string;
  broker: unknown;
}): LiveModeConfirmCopy {
  const body = [
    `Confirming moves this account to live mode: orders will place with real money at ${input.brokerLabel}.`,
    "The trading mode is shared by every broker in this tenant, so the switch applies to all of them, not only the one selected.",
  ];
  if (brokerRequiresLiveMode(input.broker)) {
    body.push(
      `${input.brokerLabel} has no paper trading mode, so live is the only mode in which an order can be placed. Preview and data stay available.`,
    );
  }
  body.push(
    "Switching back to paper stops new live placement; it does not cancel orders already sent to the broker.",
  );
  return {
    title: `Switch to live trading on ${input.brokerLabel}?`,
    body,
    confirmLabel: "Switch to live trading",
    cancelLabel: "Stay in paper",
  };
}

/**
 * The standing Notice's copy for the impossible combination (#4649): shown
 * while the broker cannot simulate and the stored mode is paper. It states the
 * consequence (placement is refused) and the way out, without blocking preview.
 */
export function liveOnlyNoticeCopy(input: { brokerLabel: string }): {
  title: string;
  body: string;
} {
  return {
    title: `${input.brokerLabel} has no paper mode`,
    body: `Paper mode is preview and data only on ${input.brokerLabel}: any placement is refused while the mode is paper. Switch to live to place orders with real money.`,
  };
}
