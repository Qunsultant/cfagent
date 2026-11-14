/**
 * Query-param router (#1804 S1, issue #1808) — the URL is the source of
 * truth for navigation. The tab lives in `?tab=<id>` (query params, so no
 * Worker fallback is needed for deep links or reloads).
 *
 * Every page's sub-state lives in its own query params, and a URL carries
 * only its own page's params (#3238): when the tab changes, params the
 * destination does not own are dropped — `?tab=order&orderTab=risk`
 * followed by a move to portfolio lands on exactly `?tab=portfolio`,
 * never `?tab=portfolio&orderTab=risk`. Same-tab navigation keeps
 * everything (in-page sub-tab switches write their own param through
 * `useUrlSyncedTabs`, not through here), and deep links set their params
 * explicitly after scoping, so one-shot seeds (`?tab=order&assetClass=`)
 * still arrive intact.
 *
 * Pure functions (parse/build) carry the testable behavior; the window
 * wrappers are thin. Navigation pushes state and dispatches a
 * `routechange` event (pushState fires no event on its own); Chat
 * subscribes to both `popstate` (back/forward) and `routechange`.
 */
import { resolveRouteId, type RouteId } from "./routes";
import { platformAdminSectionFromNavId } from "./navConfig";

/** Tab id carried by a query string; unknown or missing ids fall back to autopilot. */
export function parseTabFromSearch(search: string): RouteId {
  const tab = new URLSearchParams(search).get("tab") ?? "";
  const section = platformAdminSectionFromNavId(tab);
  return resolveRouteId(section ? "platform-admin" : tab);
}

/**
 * Query params owned by specific pages (#3238). A param not listed here
 * is unowned and never survives a tab change; a listed param survives
 * only when the destination tab is one of its owners. `view` is not
 * listed: it is the shared sub-view param, already scoped by
 * `navigateToTab` (dropped unless the destination sets it). One-shot
 * params (`assetClass`, `etrade_auth`, `etrade_connect_error`, the auth
 * outcome) are consumed and stripped by their owners on arrival, so
 * they need no registry entry beyond `assetClass`, which must survive
 * the navigation that carries it to the order page.
 *
 * Owners are the `?tab=<id>` values the owning component renders under
 * (verified against Chat.tsx / ETradeTradingHub / nav-config deep links):
 * `orderTab`/`assetClass` live on the order page; `riskTab` on the Risk
 * Analysis page and inside the order page's risk tab; `reportsTab` on
 * the hub's reports sub-tab; `iaaaTab` and `providerTab` on
 * platform-admin; `run`/`q`
 * (legacy alias) on workflow-runs, and `run` also on the schedules
 * home (#3121 S2, where it deep-links one job's run history);
 * `schedule` on the schedules home (#3121 S2, one schedule);
 * `screenerTab` is the legacy alias the three screener hubs read for
 * `view`; `research`/`discoveryView` on the options hub; `checkoutTab`
 * on checkout.
 */
export const TAB_PARAM_OWNERS: Readonly<Record<string, readonly RouteId[]>> = {
  orderTab: ["order"],
  assetClass: ["order"],
  riskTab: ["risk-analysis", "order"],
  reportsTab: ["reports"],
  iaaaTab: ["platform-admin"],
  // Issue #3978: the data-providers inner tabs (`providerTab`) live on
  // platform-admin, so the param survives navigation to it and drops
  // on the way out, like every other page-owned param (#3238).
  providerTab: ["platform-admin"],
  run: ["workflow-runs", "schedules"],
  q: ["workflow-runs"],
  screenerTab: ["screeners", "options", "stock-hub"],
  research: ["options"],
  discoveryView: ["options"],
  checkoutTab: ["checkout"],
  // Issue #3121 S2: the schedules home's deep links — `schedule=<id>`
  // (one schedule) and `run=<id>` (one job's run history) — are owned
  // by the home, so they survive navigation to it and drop on the way
  // out, like every other page-owned param (#3238).
  schedule: ["schedules"],
};

/** Query string with `tab` set, keeping only the destination's own params. */
export function buildSearchWithTab(currentSearch: string, tab: RouteId): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of [...params.keys()]) {
    if (key === "tab" || key === "view") continue;
    const owners = TAB_PARAM_OWNERS[key];
    if (!owners || !owners.includes(tab)) params.delete(key);
  }
  params.set("tab", tab);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/** Tab id carried by the current URL (autopilot outside a browser). */
export function readTabFromLocation(): RouteId {
  if (typeof window === "undefined") return "autopilot";
  return parseTabFromSearch(window.location.search);
}

/**
 * Inner view id carried by a query string (#1804 S2, issue #2027): the
 * view lives in `?view=<id>`, alongside the page's `?tab=<id>`. Validation
 * is the caller's job (each page owns its view ids); unknown or missing
 * views are null and the caller falls back to its default.
 */
export function parseViewFromSearch(
  search: string,
  isValid: (value: unknown) => boolean,
): string | null {
  const view = new URLSearchParams(search).get("view");
  return view !== null && isValid(view) ? view : null;
}

/** Query string with `view` set, every other param preserved. */
export function buildSearchWithView(currentSearch: string, view: string): string {
  const params = new URLSearchParams(currentSearch);
  params.set("view", view);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export interface LegacyProductRedirect {
  tab: string;
  view?: string;
}

/**
 * Issue #4530 — the redirect for a retired product-domain address, or
 * null when the URL is not one. The caller replaces the URL with the
 * target; a null means "leave the URL alone". The hub is the ONLY place
 * for product-domain URLs: the standalone products page and the
 * platform-admin products / free-runs sections moved into it. Billing,
 * Checkout, Payments, Orders, and every other address are untouched.
 */
export function legacyProductRedirect(search: string): LegacyProductRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const view = params.get("view") ?? "";
  if (tab === "products") {
    if (view === "selling-options") return { tab: "product-hub", view: "selling-options" };
    if (view === "marketing-draft-preview") return { tab: "product-hub", view: "marketing-draft-preview" };
    return { tab: "product-hub", view: "products" };
  }
  if (tab === "platform-admin" && view === "products") {
    return { tab: "product-hub", view: "admin-products" };
  }
  if (tab === "platform-admin" && view === "free-runs") {
    return { tab: "product-hub", view: "free-runs" };
  }
  // The legacy platform-admin:<section> form (parseTabFromSearch maps
  // it to platform-admin, so the tab param itself names the section).
  if (tab === "platform-admin:products") {
    return { tab: "product-hub", view: "admin-products" };
  }
  if (tab === "platform-admin:free-runs") {
    return { tab: "product-hub", view: "free-runs" };
  }
  return null;
}

/**
 * Navigate to a tab: resolve (unknown ids fall back), skip when already
 * there (no duplicate history entries for re-clicking the active item),
 * otherwise pushState and notify subscribers synchronously.
 * `extraParams` (issue #2784: the research surface param) are set on
 * the URL alongside tab/view and take part in the already-there check,
 * so re-clicking a different research sub while on the options host
 * actually navigates instead of no-opping.
 */
export function navigateToTab(tab: string, view?: string, extraParams?: Record<string, string>): RouteId {
  return goToTab(tab, view, extraParams, "push");
}

/**
 * Replace the current URL with a tab (issue #3121 S2): the same
 * resolution, scoping, and already-there check as `navigateToTab`, but
 * `replaceState` instead of `pushState`. For redirects (retired
 * addresses): replacing means back/forward never re-lands on the
 * retired address. Still dispatches `routechange`, so subscribers
 * re-read the URL exactly as they do for a push.
 */
export function replaceToTab(tab: string, view?: string, extraParams?: Record<string, string>): RouteId {
  return goToTab(tab, view, extraParams, "replace");
}

function goToTab(
  tab: string,
  view: string | undefined,
  extraParams: Record<string, string> | undefined,
  mode: "push" | "replace",
): RouteId {
  const section = platformAdminSectionFromNavId(tab);
  const targetTab = section ? "platform-admin" : tab;
  const targetView = view ?? section;

  const next = resolveRouteId(targetTab);
  if (typeof window === "undefined") return next;

  const currentTab = parseTabFromSearch(window.location.search);
  const currentParams = new URLSearchParams(window.location.search);
  const currentView = currentParams.get("view");
  const extrasMatch =
    !extraParams ||
    Object.entries(extraParams).every(([key, value]) => currentParams.get(key) === value);
  if (
    currentTab === next &&
    ((!targetView && !currentView) || currentView === targetView) &&
    extrasMatch
  ) {
    return next;
  }

  let search = buildSearchWithTab(window.location.search, next);
  if (targetView) {
    search = buildSearchWithView(search, targetView);
  } else if (targetTab !== "platform-admin") {
    const params = new URLSearchParams(search);
    params.delete("view");
    const s = params.toString();
    search = s ? `?${s}` : "";
  }
  if (extraParams) {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
    const s = params.toString();
    search = s ? `?${s}` : "";
  }
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (mode === "replace") {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
  window.dispatchEvent(new Event("routechange"));
  return next;
}

/** Subscribe to tab changes from back/forward and from navigateToTab. Returns unsubscribe. */
export function subscribeToRouteChanges(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", callback);
  window.addEventListener("routechange", callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("routechange", callback);
  };
}
