/**
 * Issue 4682 — the Marketing Hub home: one address, sub-routes, and the
 * retirement of the three standalone marketing addresses.
 *
 * Home: `?tab=marketing-hub`. Sub-route scheme, following the app's
 * existing `?tab=` + `?view=` deep-link pattern (`src/client/router.ts`
 * `parseViewFromSearch`):
 * `?tab=marketing-hub&view=referrals|ads|social`.
 *
 * - `view=referrals` (default): the referral engine (`ReferralsTab`).
 * - `view=ads`: the sponsored marketplace (`AdsTab`).
 * - `view=social`: social posting (`SocialPostingPanel`).
 *
 * Each section keeps its own inner tabs on its own nested param
 * (the #4576 flowsTab/researchTab precedent — an inner tab never
 * overwrites the hub tab it is nested inside):
 * `?tab=marketing-hub&view=ads&adsTab=offers|submit`,
 * `?tab=marketing-hub&view=referrals&referralsTab=share|activity|links|community`,
 * `?tab=marketing-hub&view=social&socialTab=brief|goal|approvals|posts|tokens`.
 *
 * Retired addresses (each maps to the home via
 * `legacyMarketingHubRedirect` in router.ts, applied in Chat.tsx
 * applyRoute after legacyDualHomeRedirect):
 * - `?tab=referrals` (+ `view=<inner>` or `referralsTab=<inner>`) →
 *   `?tab=marketing-hub&view=referrals` (+ `referralsTab=<inner>`).
 * - `?tab=ads` (+ `view=<inner>` or `adsTab=<inner>`) →
 *   `?tab=marketing-hub&view=ads` (+ `adsTab=<inner>`).
 * - `?tab=social` (+ `view=<inner>` or `socialTab=<inner>`) →
 *   `?tab=marketing-hub&view=social` (+ `socialTab=<inner>`).
 *
 * This module is pure: URLSearchParams in, values out. No window, no
 * fetch, no Cloudflare — the same hexagonal shape as the S1 primitives
 * (`src/services/consolidatedScheduling.ts`) and dataHubView.ts.
 */

/** The one Marketing Hub home tab id. */
export const MARKETING_HUB_TAB = "marketing-hub";

/** The consolidated home's views, in nav order. */
export type MarketingHubView = "referrals" | "ads" | "social";

export const MARKETING_HUB_VIEWS: readonly MarketingHubView[] = [
  "referrals",
  "ads",
  "social",
];

export const MARKETING_HUB_VIEW_LABELS: Record<MarketingHubView, string> = {
  referrals: "Referrals & Earn",
  ads: "Sponsored Marketplace",
  social: "Social Posting",
};

export function isMarketingHubView(value: unknown): value is MarketingHubView {
  return (
    typeof value === "string" &&
    (MARKETING_HUB_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Canonicalize a raw `?view=` value: an unknown or missing view falls
 * back to `referrals`. Never throws, never returns an invalid view.
 */
export function normalizeMarketingHubView(value: unknown): MarketingHubView {
  if (isMarketingHubView(value)) return value;
  return "referrals";
}

/** Inner-tab vocabularies, one nested param per section. */
export type AdsInnerTab = "offers" | "submit";
export type ReferralsInnerTab = "share" | "activity" | "links" | "community";
export type SocialInnerTab = "brief" | "goal" | "approvals" | "posts" | "tokens";

export const ADS_INNER_TABS: readonly AdsInnerTab[] = ["offers", "submit"];
export const REFERRALS_INNER_TABS: readonly ReferralsInnerTab[] = [
  "share",
  "activity",
  "links",
  "community",
];
export const SOCIAL_INNER_TABS: readonly SocialInnerTab[] = [
  "brief",
  "goal",
  "approvals",
  "posts",
  "tokens",
];

export function isAdsInnerTab(value: unknown): value is AdsInnerTab {
  return (
    typeof value === "string" &&
    (ADS_INNER_TABS as readonly string[]).includes(value)
  );
}

export function isReferralsInnerTab(value: unknown): value is ReferralsInnerTab {
  return (
    typeof value === "string" &&
    (REFERRALS_INNER_TABS as readonly string[]).includes(value)
  );
}

export function isSocialInnerTab(value: unknown): value is SocialInnerTab {
  return (
    typeof value === "string" &&
    (SOCIAL_INNER_TABS as readonly string[]).includes(value)
  );
}

export interface MarketingHubDeepLink {
  view: MarketingHubView;
}

/** Parse the home's deep link out of a query string. */
export function parseMarketingHubDeepLink(search: string): MarketingHubDeepLink {
  const params = new URLSearchParams(search);
  return {
    view: normalizeMarketingHubView(params.get("view")),
  };
}
