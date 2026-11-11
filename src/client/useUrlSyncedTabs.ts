import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeToRouteChanges } from "./router";

/**
 * Shared URL-synced-tabs behavior (#1804 S2, issue #2027): one behavior
 * for every tabbed surface, consumed by both the `Tabs` primitive and
 * `CapabilityNavBar` — the #1379 ScreenersHub pattern, generalized.
 *
 * - Read order: query `param`, query `aliases` in order (legacy params
 *   such as `screenerTab`, read-only), bare hash, hash `param`, hash
 *   `aliases` — mirroring ScreenersHub's `parseScreenerTabFromUrl`.
 * - Write: only `param` is ever written (aliases stay read-only, so a
 *   legacy param migrates to the canonical one on first change).
 * - Retention: every visited tab joins `visitedTabs`; panels render
 *   mounted-hidden for visited tabs (see `TabPanel retain` mode) so
 *   in-flight and finished work survives tab switches.
 * - Back/forward and left-nav navigation: a route subscription re-reads
 *   the URL and adopts it, covering both popstate and the "routechange"
 *   event navigateToTab dispatches after pushState (issue 2896: a
 *   popstate-only listener missed left-nav view changes entirely, so
 *   the URL moved but the tab stayed). A URL that names no tab adopts
 *   the default (issue #3978: back to the bare URL returns to the
 *   default tab instead of keeping the previous URL's tab).
 */
export interface UseUrlSyncedTabsOptions<T extends string> {
  /** Canonical query param, e.g. "view". */
  param: string;
  /** Legacy params, read in order, never written. */
  aliases?: string[];
  isValid: (value: unknown) => value is T;
  defaultTab: T;
  /** Prop override (e.g. a parent driving the tab): takes precedence at
   *  mount and is adopted whenever it changes — mirroring the hub's
   *  original mount effect, so a parent redirect always wins. */
  initialTab?: T | null;
  onTabChange?: (tab: T) => void;
}

export interface UseUrlSyncedTabsResult<T extends string> {
  activeTab: T;
  visitedTabs: ReadonlySet<T>;
  handleTabChange: (tab: string) => void;
}

function readTabFromHref<T extends string>(
  href: string,
  param: string,
  aliases: string[],
  isValid: (value: unknown) => value is T,
): T | null {
  try {
    const url = new URL(href, "http://localhost");
    const query = url.searchParams.get(param);
    if (query !== null && isValid(query)) return query;
    for (const alias of aliases) {
      const value = url.searchParams.get(alias);
      if (value !== null && isValid(value)) return value;
    }
    const hash = url.hash.replace(/^#/, "");
    if (hash) {
      if (isValid(hash)) return hash;
      const hashParams = new URLSearchParams(hash);
      const hashValue = hashParams.get(param);
      if (hashValue !== null && isValid(hashValue)) return hashValue;
      for (const alias of aliases) {
        const value = hashParams.get(alias);
        if (value !== null && isValid(value)) return value;
      }
    }
  } catch {
    // Malformed URL, ignore
  }
  return null;
}

export function useUrlSyncedTabs<T extends string>(
  options: UseUrlSyncedTabsOptions<T>,
): UseUrlSyncedTabsResult<T> {
  const { param, aliases = [], isValid, defaultTab, initialTab = null, onTabChange } = options;
  const aliasKey = aliases.join(",");
  const readFromLocation = useCallback((): T | null => {
    if (typeof window === "undefined") return null;
    return readTabFromHref(window.location.href, param, aliases, isValid);
  }, [param, aliasKey]);

  const initialResolvedTab = useMemo<T>(() => {
    if (initialTab && isValid(initialTab)) return initialTab;
    const fromUrl = readFromLocation();
    if (fromUrl) return fromUrl;
    return defaultTab;
  }, [readFromLocation]);

  const [activeTab, setActiveTab] = useState<T>(initialResolvedTab);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<T>>(
    () => new Set([initialResolvedTab]),
  );

  // Adopt the prop only when it CHANGES — never on tab clicks. (An effect
  // keyed on activeTab would fight every user tab change by resetting to
  // the prop; the original hub effect was keyed on the prop alone.)
  const prevInitialTabRef = useRef<T | null>(initialTab);
  useEffect(() => {
    if (
      initialTab &&
      isValid(initialTab) &&
      initialTab !== prevInitialTabRef.current
    ) {
      prevInitialTabRef.current = initialTab;
      setActiveTab(initialTab);
      setVisitedTabs((prev) => new Set(prev).add(initialTab));
    }
  }, [initialTab, isValid]);

  const handleTabChange = useCallback(
    (newTabId: string) => {
      if (!isValid(newTabId)) return;
      setActiveTab(newTabId);
      setVisitedTabs((prev) => new Set(prev).add(newTabId));
      onTabChange?.(newTabId);

      if (typeof window !== "undefined" && window.history) {
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.get(param) !== newTabId) {
            url.searchParams.set(param, newTabId);
            window.history.pushState(null, "", url.toString());
          }
        } catch {
          // Safe fallback for environments with restricted history
        }
      }
    },
    [isValid, onTabChange, param],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleRouteSync = () => {
      const tabFromUrl = readFromLocation();
      if (tabFromUrl && tabFromUrl !== activeTab) {
        setActiveTab(tabFromUrl);
        setVisitedTabs((prev) => new Set(prev).add(tabFromUrl));
        onTabChange?.(tabFromUrl);
      } else if (!tabFromUrl && activeTab !== defaultTab) {
        // #3978: back/forward to a URL that names no tab (the param
        // was never written, or was dropped by a tab change) adopts
        // the default — the tab the bare URL addresses — instead of
        // keeping the tab the previous URL named.
        setActiveTab(defaultTab);
        setVisitedTabs((prev) => new Set(prev).add(defaultTab));
        onTabChange?.(defaultTab);
      }
    };
    // popstate alone misses navigateToTab: it pushStates and dispatches
    // "routechange" instead, so a left-nav view change never reached the
    // hub (URL moved, tab stayed). subscribeToRouteChanges covers both.
    return subscribeToRouteChanges(handleRouteSync);
  }, [activeTab, defaultTab, onTabChange, readFromLocation]);

  return { activeTab, visitedTabs, handleTabChange };
}
