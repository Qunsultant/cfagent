/**
 * Query-param router (#1804 S1, issue #1808) — the URL is the source of
 * truth for navigation. The tab lives in `?tab=<id>` (query params, so no
 * Worker fallback is needed for deep links or reloads). All other query
 * params pass through untouched — notably the screening hub's own
 * `?screenerTab=`, which keeps working exactly as before.
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

/** Query string with `tab` set, every other param preserved. */
export function buildSearchWithTab(currentSearch: string, tab: RouteId): string {
  const params = new URLSearchParams(currentSearch);
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
 */
export function navigateToTab(tab: string, view?: string): RouteId {
  const section = platformAdminSectionFromNavId(tab);
  const targetTab = section ? "platform-admin" : tab;
  const targetView = view ?? section;

  const next = resolveRouteId(targetTab);
  if (typeof window === "undefined") return next;

  const currentTab = parseTabFromSearch(window.location.search);
  const currentView = new URLSearchParams(window.location.search).get("view");
  if (currentTab === next && ((!targetView && !currentView) || currentView === targetView)) {
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
