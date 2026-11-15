/**
 * Issue #4585 — the SecurityHub home: one address, sub-routes, and the
 * retirement of the duplicate addresses.
 *
 * Home: `?tab=security-hub`. Sub-route scheme, following the app's existing
 * `?tab=` + `?view=` deep-link pattern (`src/client/router.ts`
 * `parseViewFromSearch`):
 * `?tab=security-hub&view=iaaa-admin|users|admin-access|profile|pdp`.
 *
 * - `view=iaaa-admin` (default): read-only memberships, genesis & audit
 *   (`IaaaAdminPanel`) — moved here from Platform Admin.
 * - `view=users`: user profiles, tenant memberships & account linkage
 *   (`UserAdminPanel`) — moved here from Platform Admin.
 * - `view=admin-access`: request admin access from the platform owner
 *   (`AdminAccessSection`) — moved here from Platform Admin, with its
 *   request state.
 * - `view=profile`: the signed-in user's profile (`ProfileSection`,
 *   display name + phone) — surfaced here; it was mounted only in the
 *   onboarding screen before.
 * - `view=pdp`: the Policy Decision Point's live state (`PdpPanel`,
 *   issue #4651) — active snapshot + source, policy-source resolution,
 *   and the frozen obligations, read-only.
 *
 * Retired addresses (each maps to the home):
 * - `?tab=platform-admin&view=iaaa-admin` → `?tab=security-hub&view=iaaa-admin`.
 * - `?tab=platform-admin&view=users` → `?tab=security-hub&view=users`.
 * - `?tab=platform-admin&view=admin-access` → `?tab=security-hub&view=admin-access`.
 *
 * This module is pure: URLSearchParams in, values out. No window, no
 * fetch, no Cloudflare — the same hexagonal shape as the S1 primitives
 * (`src/services/consolidatedScheduling.ts`). The shell (`Chat.tsx`)
 * applies `legacyPlatformAdminHubRedirect` with a replace (never a push,
 * so back/forward never re-lands on a retired address).
 */

/** The one SecurityHub home tab id. */
export const SECURITY_HUB_TAB = "security-hub";

/** The consolidated home's views. */
export type SecurityHubView = "iaaa-admin" | "users" | "admin-access" | "profile" | "pdp";

export const SECURITY_HUB_VIEWS: readonly SecurityHubView[] = [
  "iaaa-admin",
  "users",
  "admin-access",
  "profile",
  "pdp",
];

export const SECURITY_HUB_VIEW_LABELS: Record<SecurityHubView, string> = {
  "iaaa-admin": "IAAA Admin",
  users: "Users",
  "admin-access": "Admin Access",
  profile: "Profile",
  pdp: "PDP",
};

export function isSecurityHubView(value: unknown): value is SecurityHubView {
  return (
    typeof value === "string" &&
    (SECURITY_HUB_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * Canonicalize a raw `?view=` value: an unknown or missing view falls
 * back to `iaaa-admin`. Never throws, never returns an invalid view.
 */
export function normalizeSecurityHubView(value: unknown): SecurityHubView {
  if (isSecurityHubView(value)) return value;
  return "iaaa-admin";
}

export interface SecurityHubDeepLink {
  view: SecurityHubView;
}

/** Parse the home's deep link out of a query string. */
export function parseSecurityHubDeepLink(search: string): SecurityHubDeepLink {
  const params = new URLSearchParams(search);
  return {
    view: normalizeSecurityHubView(params.get("view")),
  };
}
