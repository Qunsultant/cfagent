/**
 * Issue #4585 — the DataHub home: one address, sub-routes, and the
 * retirement of the duplicate addresses.
 *
 * Home: `?tab=data-hub`. Sub-route scheme, following the app's existing
 * `?tab=` + `?view=` deep-link pattern (`src/client/router.ts`
 * `parseViewFromSearch`):
 * `?tab=data-hub&view=data-providers|data-lifecycle|downloads`.
 *
 * - `view=data-providers` (default): the market-data provider provisioning
 *   lifecycle (`DataProvidersPanel`) plus the BYOK provider-credential cards
 *   (`AlpacaSignInCard` TEST + PROD) — moved here from Platform Admin.
 * - `view=data-lifecycle`: clean state, platform bootstrap & tenant
 *   bootstrap (`DataLifecyclePanel`) — moved here from Platform Admin.
 * - `view=downloads`: parameters & export (`DownloadsPanel`) — moved here
 *   from Platform Admin.
 *
 * Retired addresses (each maps to the home):
 * - `?tab=platform-admin&view=data-providers` → `?tab=data-hub&view=data-providers`.
 * - `?tab=platform-admin&view=data-lifecycle` → `?tab=data-hub&view=data-lifecycle`.
 * - `?tab=platform-admin&view=downloads` → `?tab=data-hub&view=downloads`.
 *
 * This module is pure: URLSearchParams in, values out. No window, no
 * fetch, no Cloudflare — the same hexagonal shape as the S1 primitives
 * (`src/services/consolidatedScheduling.ts`). The shell (`Chat.tsx`)
 * applies `legacyPlatformAdminHubRedirect` with a replace (never a push,
 * so back/forward never re-lands on a retired address).
 */

/** The one DataHub home tab id. */
export const DATA_HUB_TAB = "data-hub";

/** The consolidated home's views. */
export type DataHubView = "data-providers" | "feeds" | "data-lifecycle" | "downloads";

export const DATA_HUB_VIEWS: readonly DataHubView[] = [
  "data-providers",
  "feeds",
  "data-lifecycle",
  "downloads",
];

export const DATA_HUB_VIEW_LABELS: Record<DataHubView, string> = {
  "data-providers": "Data Providers",
  feeds: "Feeds",
  "data-lifecycle": "Data Lifecycle",
  downloads: "Parameters & Export",
};

export function isDataHubView(value: unknown): value is DataHubView {
  return (
    typeof value === "string" && (DATA_HUB_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Canonicalize a raw `?view=` value: an unknown or missing view falls
 * back to `data-providers`. Never throws, never returns an invalid view.
 */
export function normalizeDataHubView(value: unknown): DataHubView {
  if (isDataHubView(value)) return value;
  return "data-providers";
}

export interface DataHubDeepLink {
  view: DataHubView;
}

/** Parse the home's deep link out of a query string. */
export function parseDataHubDeepLink(search: string): DataHubDeepLink {
  const params = new URLSearchParams(search);
  return {
    view: normalizeDataHubView(params.get("view")),
  };
}
