/**
 * Issue #3272 (S5): one place that decides which screening endpoint a surface calls.
 *
 * Why: the client hardcoded the E*TRADE routes, so a tenant on another broker
 * was sent to a path that cannot serve it. The servers now expose neutral
 * equivalents (`/api/broker/options/screen`, `/api/broker/screen`, #3272), but
 * switching every tenant onto them would change E*TRADE behaviour — those
 * routes carry the legacy paid seam, universe discovery and listings branch.
 *
 * So the rule is explicit and testable: E*TRADE keeps its own endpoint, every
 * other broker gets the neutral one. No default, no fallback: an unknown
 * selection is treated as non-E*TRADE and gets the neutral route, whose
 * refusals are coded and named rather than silently wrong.
 */
import { readTenantProvidersState } from "./tenantProviders";

export const LEGACY_OPTION_SCREEN_ENDPOINT = "/api/trading/options/screen";
export const NEUTRAL_OPTION_SCREEN_ENDPOINT = "/api/broker/options/screen";
export const LEGACY_STOCK_SCREEN_ENDPOINT = "/api/etrade/screen";
export const NEUTRAL_STOCK_SCREEN_ENDPOINT = "/api/broker/screen";
export const LEGACY_STATUS_ENDPOINT = "/api/etrade/status";
export const NEUTRAL_STATUS_ENDPOINT = "/api/broker/status";
export const LEGACY_QUOTE_ENDPOINT = "/api/etrade/quote";
export const NEUTRAL_QUOTE_ENDPOINT = "/api/broker/quote";
export const LEGACY_POSITIONS_ENDPOINT = "/api/etrade/positions";
export const NEUTRAL_POSITIONS_ENDPOINT = "/api/broker/positions";
export const LEGACY_ACCOUNTS_ENDPOINT = "/api/etrade/accounts";
export const NEUTRAL_ACCOUNTS_ENDPOINT = "/api/broker/accounts";

/** The options-screen endpoint for a broker selection (defaults to the live one). */
export function optionScreenEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_OPTION_SCREEN_ENDPOINT : NEUTRAL_OPTION_SCREEN_ENDPOINT;
}

/** The stock-screen endpoint for a broker selection (defaults to the live one). */
export function stockScreenEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_STOCK_SCREEN_ENDPOINT : NEUTRAL_STOCK_SCREEN_ENDPOINT;
}

/** Issue #3294: the hub reads follow the same rule. */
export function statusEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_STATUS_ENDPOINT : NEUTRAL_STATUS_ENDPOINT;
}

export function quoteEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_QUOTE_ENDPOINT : NEUTRAL_QUOTE_ENDPOINT;
}

export function positionsEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_POSITIONS_ENDPOINT : NEUTRAL_POSITIONS_ENDPOINT;
}

export function accountsEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_ACCOUNTS_ENDPOINT : NEUTRAL_ACCOUNTS_ENDPOINT;
}

/**
 * Diagnostics read E*TRADE OAuth state and have no neutral equivalent: the
 * hub must not call them for another broker. Null means "do not call".
 */
export function diagnosticsEndpoint(brokerId: string = readTenantProvidersState().brokerId): string | null {
  return brokerId === "etrade" ? "/api/etrade/diagnostics" : null;
}

/**
 * Issue #3669: where the order page asks whether the selected broker is
 * connected. Each broker answers that question on its own connect surface:
 * E*TRADE's OAuth status, Alpaca's neutral connect read (configured for
 * this trading type, or signed in with the user's own pair — the same
 * `GET /api/broker/connect/alpaca` the dynamic menu uses). A broker with
 * no connect surface here gets null ("do not call"), never another
 * broker's status read, which is exactly how an Alpaca tenant ended up
 * staring at a permanent "Connect your E*TRADE account" notice.
 */
export function connectStatusEndpoint(brokerId: string = readTenantProvidersState().brokerId): string | null {
  if (brokerId === "etrade") return "/api/etrade/oauth/status";
  if (brokerId === "alpaca") return "/api/broker/connect/alpaca";
  if (brokerId === "public") return "/api/broker/connect/public";
  return null;
}

/**
 * Issue #3990: where a personal-token broker's token is pasted and
 * dropped. Only Public uses this kind today; a broker with no token
 * surface here gets null ("do not call"), never another broker's
 * connect endpoint.
 */
export function tokenConnectEndpoint(brokerId: string = readTenantProvidersState().brokerId): string | null {
  if (brokerId === "public") return "/api/public/connect";
  return null;
}

export function tokenDisconnectEndpoint(brokerId: string = readTenantProvidersState().brokerId): string | null {
  if (brokerId === "public") return "/api/public/disconnect";
  return null;
}

/**
 * Issue #3368: where the Sync control asks.
 *
 * E*TRADE's diagnostics answer a question only E*TRADE has (its OAuth session);
 * `diagnosticsEndpoint` already says "do not call" for every other broker, and
 * the menu used to ignore that. The neutral status read answers the question the
 * control actually asks ("is this broker usable right now"), so it is the
 * target when diagnostics do not exist — and `diagnostics` says whether
 * E*TRADE's window events belong to the call.
 */
export function syncTarget(
  brokerId: string = readTenantProvidersState().brokerId,
): { path: string; diagnostics: boolean } {
  const diagnostics = diagnosticsEndpoint(brokerId);
  return diagnostics ? { path: diagnostics, diagnostics: true } : { path: statusEndpoint(brokerId), diagnostics: false };
}
