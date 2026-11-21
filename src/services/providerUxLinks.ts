/**
 * Issue #3812 — the canonical provider UX deep links.
 *
 * When a money path cannot proceed (no live quote, no broker credentials,
 * no credit coverage), the refusal must tell the user exactly where to fix
 * it. "Ask support" is not an answer, and a bare error code is not a UX.
 * Every surface that can block an order or a run links here, so the same
 * fix lives at the same URL everywhere: chat, MCP tool results, the RCA
 * runbook, and the Workflow Runs detail.
 *
 * These are in-product relative links (the SPA reads `?tab=`); the connect
 * link is an API route because it starts the broker OAuth/key-pair flow.
 */

export const PROVIDER_UX_LINKS = {
  /** Trading hub: broker panel, connection status, mode switch. */
  trading: "?tab=trading",
  /** Alpaca connection card inside the trading hub. */
  alpacaPanel: "?tab=trading",
  /** Start the Alpaca paper sign-in / key-pair flow. */
  alpacaConnectPaper: "/api/broker/connect/alpaca?environment=TEST",
  /** Start the Alpaca live sign-in / key-pair flow (explicit act). */
  alpacaConnectLive: "/api/broker/connect/alpaca?environment=PROD",
  /** Checkout — buy credits (the "Top up" tab). */
  creditsTopUp: "?tab=checkout&checkoutTab=topup",
  /** Checkout — subscriptions. */
  subscriptions: "?tab=checkout&checkoutTab=subscriptions",
  /** Checkout landing. */
  checkout: "?tab=checkout",
  /** Workflow Runs ledger — every recorded run, stage, and refusal. */
  workflowRuns: "?tab=workflow-runs",
  /** Data providers and feeds. */
  providers: "?tab=stock-hub&view=research",
  /** Workflows hub (schedules, pipelines). */
  workflows: "?tab=workflows",
} as const;

export type ProviderUxLinkKey = keyof typeof PROVIDER_UX_LINKS;

/**
 * Issue #5921 — the Workflow Runs deep link for one run id.
 * The async dispatch receipt points the caller at the run's
 * Workflow Runs page (the copilot prompt's own convention:
 * `?tab=workflow-runs&run=<runId>`). A relative in-product
 * link — never an API URL (user rule: UX URLs only).
 */
export function workflowRunUrl(jobId: string): string {
  return `?tab=workflow-runs&run=${encodeURIComponent(jobId)}`;
}

/**
 * One human-readable line naming the fix for each requested link. Stable
 * labels so a chat reply or a refusal can carry the exact same sentence.
 */
const LINK_LABELS: Record<ProviderUxLinkKey, string> = {
  trading: "Trading hub",
  alpacaPanel: "Alpaca panel",
  alpacaConnectPaper: "Connect Alpaca (paper)",
  alpacaConnectLive: "Connect Alpaca (live)",
  creditsTopUp: "Add credits (Checkout → Top up)",
  subscriptions: "Subscriptions (Checkout)",
  checkout: "Checkout",
  workflowRuns: "Workflow Runs",
  providers: "Data providers & feeds",
  workflows: "Workflows hub",
};

export function providerUxLine(keys: ProviderUxLinkKey[]): string {
  return keys
    .map((key) => `${LINK_LABELS[key]}: ${PROVIDER_UX_LINKS[key]}`)
    .join(" | ");
}

/**
 * The credit-coverage refusal's next step. The platform charges one price
 * per run-request; a signed-in user without coverage buys credits in
 * Checkout → Top up (or activates a subscription). Included verbatim in
 * 402 responses and chat refusals so "how do I add credits?" is answered
 * at the moment it is asked.
 */
export const CREDITS_TOP_UP_HINT =
  `Add credits at ${PROVIDER_UX_LINKS.creditsTopUp} (Checkout → Top up) or activate a subscription at ${PROVIDER_UX_LINKS.subscriptions}. ` +
  `Credit balance and included runs are shown on the same Checkout page.`;

/**
 * The broker-credential refusal's next step for Alpaca. Paper is the
 * default and needs a connection only when the deployment keys are absent;
 * live always needs the user's own verified pair (#3401).
 */
export const ALPACA_CONNECT_HINT =
  `Connect Alpaca (paper) at ${PROVIDER_UX_LINKS.alpacaConnectPaper} or from the Alpaca panel at ${PROVIDER_UX_LINKS.alpacaPanel}. ` +
  `Live trading needs your own verified Alpaca key pair at ${PROVIDER_UX_LINKS.alpacaConnectLive}.`;
