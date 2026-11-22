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
 * (verified against Chat.tsx / TradeHub / nav-config deep links):
 * `orderTab`/`assetClass` live on the order page; `riskTab` on the Risk
 * Analysis page and inside the order page's risk tab; `reportsTab` on
 * the hub's reports sub-tab; `iaaaTab` and `providerTab` on
 * platform-admin; `run`/`q`
 * (legacy alias) on workflow-runs, and `run` also on the schedules
 * home (#3121 S2, where it deep-links one job's run history);
 * `schedule` on the schedules home (#3121 S2, one schedule);
 * `screenerTab` is the legacy alias the three screener hubs read for
 * `view`; `research`/`discoveryView` on the options hub; `checkoutTab`
 * on checkout. Issue #4576 adds the two nested-panel params (`flowsTab`,
 * `researchTab`) and records the schedules home's `section`:
 * `?tab=schedules&section=goals|queue` is that page's own inner address
 * (read by `scheduleSections.ts`, written by the panel's own hooks).
 * Issue #4629 (S4 of #4625) registers it, scoped to ["schedules"]:
 * owning it preserves the drop-on-tab-change behavior (a `section`
 * value never survives a move off the schedules home) while making the
 * param explicit in the registry, so the section surfaces are
 * addressable and the registry pin covers it.
 */
export const TAB_PARAM_OWNERS: Readonly<Record<string, readonly RouteId[]>> = {
  orderTab: ["order"],
  assetClass: ["order"],
  riskTab: ["order"],
  reportsTab: ["reports"],
  // #6164 — the IAAA Admin panel lives under security-hub now
  // (SecurityHubHome, view iaaa-admin), so its inner-tab params are
  // owned by security-hub. They were owned by ["platform-admin"]:
  // every navigateToTab("security-hub", …) dropped them, so a
  // bookmarked ?iaaaTab=members landed on the default tab instead.
  iaaaTab: ["security-hub"],
  iaaaSection: ["security-hub"],
  // Issue #3978: the data-providers inner tabs (`providerTab`) live on
  // platform-admin, so the param survives navigation to it and drops
  // on the way out, like every other page-owned param (#3238).
  providerTab: ["platform-admin"],
  run: ["workflow-runs", "schedules"],
  q: ["workflow-runs"],
  screenerTab: ["options", "stock-hub"],
  research: ["options"],
  discoveryView: ["options"],
  checkoutTab: ["checkout"],
  // Issue #4576: the nested hub panels get their own params, so an inner
  // sub-tab never overwrites the hub tab it is nested inside. `flowsTab`
  // is OptionsFlowsHub's tab set (host: the options hub's `view=options-flows`);
  // `researchTab` is MarketDataResearchHub's (host: `?tab=stock-hub&view=research`).
  // Issue #4626: both standalone hosts are retired — the flows and research
  // addresses redirect onto those nested homes, so the retired ids no
  // longer own their param.
  flowsTab: ["options"],
  researchTab: ["stock-hub"],
  // Issue #3121 S2: the schedules home's deep links — `schedule=<id>`
  // (one schedule) and `run=<id>` (one job's run history) — are owned
  // by the home, so they survive navigation to it and drop on the way
  // out, like every other page-owned param (#3238).
  schedule: ["schedules"],
  // Issue #4689: the Admin Products section's nested `adminTab` param
  // (products / create-product / create-version) is owned by the
  // product hub, host of the admin-products view.
  adminTab: ["product-hub"],
  // Issue #4629 (S4 of #4625): the schedules home's section param —
  // `?tab=schedules&view=goals&section=add`,
  // `?tab=schedules&view=queue&section=cancel`, and the rest of the
  // goals/queue section sets. Owned scoped to ["schedules"], so it
  // survives navigation to the home and drops on the way out, like
  // every other page-owned param (#3238).
  section: ["schedules"],
  // Issue 4682: the Marketing Hub's nested section params — one per
  // section, following the #4576 flowsTab/researchTab precedent, so an
  // inner sub-tab never overwrites the hub tab it is nested inside.
  // `adsTab` is AdsTab's tab set (host: the hub's `view=ads`);
  // `referralsTab` is ReferralsTab's (host: `view=referrals`);
  // `socialTab` is SocialPostingPanel's (host: `view=social`).
  adsTab: ["marketing-hub"],
  referralsTab: ["marketing-hub"],
  socialTab: ["marketing-hub"],
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
  /** Extra query params the target address carries, so a retired deep
   *  link keeps its destination's state. */
  params?: Record<string, string>;
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
    // Issue #4582 — Marketing draft preview is a hub tab of its own now,
    // so the retired address maps straight to it (no nested param).
    if (view === "selling-options") return { tab: "product-hub", view: "selling-options" };
    if (view === "marketing-draft-preview") {
      return { tab: "product-hub", view: "marketing-draft-preview" };
    }
    return { tab: "product-hub", view: "products" };
  }
  if (tab === "product-hub" && view === "products") {
    // Issue #4582 — the nested `productTab` mechanism is gone. A
    // bookmarked nested address routes to the hub tab its sub-tab
    // became; any other stale value falls back to the Products tab
    // (the param is stripped either way).
    const productTab = params.get("productTab") ?? "";
    if (!productTab) return null;
    if (productTab === "marketing-draft-preview") {
      return { tab: "product-hub", view: "marketing-draft-preview" };
    }
    if (productTab === "selling-options") {
      return { tab: "product-hub", view: "selling-options" };
    }
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
 * Issue #4575 — the redirect for the retired audit / NLQ addresses, or
 * null when the URL is not one. Audit and NLQ are now the two views of one
 * "Audit & Vault" menu (`?tab=audit-vault&view=audit|nlq`), so the old
 * top-level addresses keep landing on the same content instead of 404ing
 * or falling back to the default tab. The caller replaces the URL (so
 * back/forward never re-lands on the retired address), like the queues and
 * product-domain retirements before it.
 */
export function legacyAuditVaultRedirect(search: string): LegacyProductRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  if (tab === "audit") return { tab: "audit-vault", view: "audit" };
  if (tab === "nlq") return { tab: "audit-vault", view: "nlq" };
  return null;
}

/**
 * Issue #4585 — the redirect for a retired Platform Admin section address,
 * or null when the URL is not one. Six sections moved out of Platform Admin
 * into the DataHub (`?tab=data-hub`) and SecurityHub (`?tab=security-hub`)
 * hubs, so their old `?tab=platform-admin&view=<section>` addresses (and the
 * legacy `?tab=platform-admin:<section>` form) keep landing on the same
 * content instead of falling back to the Platform Admin default tab. The
 * caller replaces the URL (so back/forward never re-lands on the retired
 * address), like the queues, product-domain, and audit-vault retirements
 * before it.
 */
export function legacyPlatformAdminHubRedirect(
  search: string,
): LegacyProductRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const view = params.get("view") ?? "";
  const section =
    tab === "platform-admin"
      ? view
      : tab.startsWith("platform-admin:")
        ? tab.slice("platform-admin:".length)
        : "";
  if (section === "data-providers" || section === "data-lifecycle" || section === "downloads") {
    return { tab: "data-hub", view: section };
  }
  if (section === "iaaa-admin" || section === "users" || section === "admin-access") {
    // #6164 — carry the IAAA inner-tab state through the redirect:
    // a bookmarked ?tab=platform-admin&view=iaaa-admin&iaaaTab=members
    // used to land on the hub's default tab (the redirect returned
    // tab+view only). The params ride only on the iaaa-admin view —
    // users/admin-access have no inner tabs.
    if (section !== "iaaa-admin") return { tab: "security-hub", view: section };
    const carried: Record<string, string> = {};
    const iaaaTab = params.get("iaaaTab");
    const iaaaSection = params.get("iaaaSection");
    if (iaaaTab) carried.iaaaTab = iaaaTab;
    if (iaaaSection) carried.iaaaSection = iaaaSection;
    return Object.keys(carried).length > 0
      ? { tab: "security-hub", view: section, params: carried }
      : { tab: "security-hub", view: section };
  }
  return null;
}

/**
 * Issue #4626 (S1 of #4625) — the redirect for the five retired
 * dual-homed addresses, decided 2026-11-15 09:28 EST. One rule: a
 * surface lives where its workflow lives, so the standalone address
 * folds onto the nested home and the nested param carries the inner
 * view through (`flowsTab`, `researchTab`, `riskTab`, `reportsTab`).
 * Runs after legacyPlatformAdminHubRedirect in Chat.tsx applyRoute,
 * before the tab is adopted.
 * `?tab=screeners&view=schedules` is NOT claimed here — it stays
 * owned by legacySchedulesRedirect, which runs first.
 */
export function legacyDualHomeRedirect(search: string): LegacyProductRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const view = params.get("view") ?? "";
  if (tab === "screeners") {
    if (view === "schedules") return null;
    const assetViews = ["forex", "futures", "commodities", "bonds"];
    const assetView = view || params.get("screenerTab") || "";
    if (assetViews.includes(assetView)) return { tab: "assets-hub", view: assetView };
    if (view === "reports") {
      const reportsTab = params.get("reportsTab") ?? "";
      return reportsTab ? { tab: "reports", params: { reportsTab } } : { tab: "reports" };
    }
    if (view === "goal-screen") return { tab: "goal-screen" };
    if (view === "ooda") return { tab: "options-screener", view: "ooda" };
    if (view === "review") return { tab: "review" };
    if (view === "track-record") return { tab: "track-record" };
    return { tab: "assets-hub" };
  }
  if (tab === "research") {
    const researchTab = params.get("researchTab") ?? "";
    return researchTab
      ? { tab: "stock-hub", view: "research", params: { researchTab } }
      : { tab: "stock-hub", view: "research" };
  }
  if (tab === "options-flows") {
    const flowsTab = params.get("flowsTab") ?? "";
    return flowsTab
      ? { tab: "options", view: "options-flows", params: { flowsTab } }
      : { tab: "options", view: "options-flows" };
  }
  if (tab === "risk-analysis") {
    const riskTab = params.get("riskTab") ?? "";
    return riskTab
      ? { tab: "order", params: { orderTab: "risk", riskTab } }
      : { tab: "order", params: { orderTab: "risk" } };
  }
  if (tab === "approvals") {
    return { tab: "order", params: { orderTab: "approvals" } };
  }
  return null;
}

/**
 * Issue 4682 — the redirect for the three retired standalone marketing
 * addresses, decided 2026-11-15 12:50 EST. One rule, the S1 rule: a
 * surface lives where its workflow lives, so each standalone address
 * folds onto its Marketing Hub section and the nested param carries
 * the inner view through (`adsTab`, `referralsTab`, `socialTab`).
 * The old standalone form carried the inner tab in `view`
 * (`?tab=ads&view=submit`); that maps onto the nested param too, so
 * old bookmarks keep landing on the same inner tab. An unknown inner
 * value falls back to the section default with no nested param.
 * Runs after legacyDualHomeRedirect in Chat.tsx applyRoute, before
 * the tab is adopted.
 */
export function legacyMarketingHubRedirect(search: string): LegacyProductRedirect | null {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "";
  const view = params.get("view") ?? "";
  if (tab === "ads") {
    const adsTab = params.get("adsTab") ?? "";
    if (adsTab === "offers" || adsTab === "submit") {
      return { tab: "marketing-hub", view: "ads", params: { adsTab } };
    }
    if (view === "offers" || view === "submit") {
      return { tab: "marketing-hub", view: "ads", params: { adsTab: view } };
    }
    return { tab: "marketing-hub", view: "ads" };
  }
  if (tab === "referrals") {
    const referralsTab = params.get("referralsTab") ?? "";
    if (
      referralsTab === "share" ||
      referralsTab === "activity" ||
      referralsTab === "links" ||
      referralsTab === "community"
    ) {
      return { tab: "marketing-hub", view: "referrals", params: { referralsTab } };
    }
    if (
      view === "share" ||
      view === "activity" ||
      view === "links" ||
      view === "community"
    ) {
      return { tab: "marketing-hub", view: "referrals", params: { referralsTab: view } };
    }
    return { tab: "marketing-hub", view: "referrals" };
  }
  if (tab === "social") {
    const socialTab = params.get("socialTab") ?? "";
    if (
      socialTab === "brief" ||
      socialTab === "goal" ||
      socialTab === "approvals" ||
      socialTab === "posts" ||
      socialTab === "tokens"
    ) {
      return { tab: "marketing-hub", view: "social", params: { socialTab } };
    }
    if (
      view === "brief" ||
      view === "goal" ||
      view === "approvals" ||
      view === "posts" ||
      view === "tokens"
    ) {
      return { tab: "marketing-hub", view: "social", params: { socialTab: view } };
    }
    return { tab: "marketing-hub", view: "social" };
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
