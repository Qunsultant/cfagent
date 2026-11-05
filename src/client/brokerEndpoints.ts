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

/** The options-screen endpoint for a broker selection (defaults to the live one). */
export function optionScreenEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_OPTION_SCREEN_ENDPOINT : NEUTRAL_OPTION_SCREEN_ENDPOINT;
}

/** The stock-screen endpoint for a broker selection (defaults to the live one). */
export function stockScreenEndpoint(brokerId: string = readTenantProvidersState().brokerId): string {
  return brokerId === "etrade" ? LEGACY_STOCK_SCREEN_ENDPOINT : NEUTRAL_STOCK_SCREEN_ENDPOINT;
}
