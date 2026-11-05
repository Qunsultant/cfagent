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
 * the hub's reports sub-tab; `iaaaTab` on platform-admin; `run`/`q`
 * (legacy alias) on workflow-runs; `screenerTab` is the legacy alias
 * the three screener hubs read for `view`; `research`/`discoveryView`
 * on the options hub; `checkoutTab` on checkout.
 */
export const TAB_PARAM_OWNERS: Readonly<Record<string, readonly RouteId[]>> = {
  orderTab: ["order"],
  assetClass: ["order"],
  riskTab: ["risk-analysis", "order"],
  reportsTab: ["reports"],
  iaaaTab: ["platform-admin"],
  run: ["workflow-runs"],
  q: ["workflow-runs"],
  screenerTab: ["screeners", "options", "stock-hub"],
  research: ["options"],
  discoveryView: ["options"],
  checkoutTab: ["checkout"],
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
  window.history.pushState(null, "", url);
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
