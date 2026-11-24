import { ROUTES, hasNavEntry, getNavGroup, type RouteCategory, type RouteBadgeType, type NavEntryMeta } from "./routes";
import { PLATFORM_ADMIN_NAV_ITEMS } from "./platformAdminConfig";
import navConfigData from "./nav-config.json";

export interface NavSubMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  icon?: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description?: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  category: RouteCategory;
  icon: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavSectionConfig {
  id: string;
  title: string;
  category: RouteCategory;
  items: NavMenuItemConfig[];
}

export interface LeftNavConfig {
  sections: NavSectionConfig[];
}

/**
 * Sub-menu configuration map for navigation items that contain sub-menus.
 */
export const SUB_MENU_CONFIGS: Record<string, NavSubMenuItemConfig[]> =
  navConfigData.subMenus as unknown as Record<string, NavSubMenuItemConfig[]>;

const SECTION_METADATA: { category: RouteCategory; title: string; id: string }[] =
  navConfigData.sections as unknown as { category: RouteCategory; title: string; id: string }[];

/** Id of the left-nav item that hosts the Platform Admin sub-menu. */
export const PLATFORM_ADMIN_NAV_ID = "platform-admin";

/** Id of the left-nav item that links the demo checkout sandbox page. */
export const SANDBOX_NAV_ID = "sandbox-checkout";

/**
 * Returns the page path for sandbox nav ids, undefined for everything else.
 */
export function sandboxNavHrefFromNavId(id: string): string | undefined {
  return id === SANDBOX_NAV_ID ? "/checkout/sandbox" : undefined;
}

/** Items whose primary navigation home is inside a sub-menu, so they do not repeat as top-level main items */
const SUB_MENU_HOSTED_IDS = new Set<string>(
  navConfigData.hostedIds as unknown as string[],
);

export function buildDefaultLeftNavConfig(): LeftNavConfig {
  const navRoutes = ROUTES.filter(hasNavEntry).sort(
    (a, b) => a.navEntry.navOrder - b.navEntry.navOrder
  );

  const sections: NavSectionConfig[] = SECTION_METADATA.map((sec) => {
    const items: NavMenuItemConfig[] = navRoutes
      .filter((r) => r.category === sec.category && !SUB_MENU_HOSTED_IDS.has(r.id))
      .map((r) => {
        const meta: NavEntryMeta = r.navEntry;
        const subItems = SUB_MENU_CONFIGS[r.id];
        return {
          id: r.id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          category: r.category,
          icon: r.icon,
          badge: meta.badge,
          badgeType: meta.badgeType,
          description: r.description,
          ...(subItems ? { subItems } : {}),
        };
      });

    // Add Goal Screen to Intelligence section directly under Options Screener and above Chat
    if (sec.id === "section-intelligence") {
      const chatIndex = items.findIndex((i) => i.id === "chat");
      const insertAt = chatIndex !== -1 ? chatIndex : 2;
      items.splice(insertAt, 0, {
        id: "goal-screen",
        label: "Goal Screen",
        shortLabel: "Goal",
        category: "Intelligence",
        icon: "Goal",
        badge: "Goal",
        badgeType: "ai",
        description: "Goal-driven screening flow with AI-orchestrated criteria",
      }, {
        id: "ooda",
        label: "OODA",
        shortLabel: "OODA",
        category: "Intelligence",
        icon: "Research",
        badge: "OODA",
        badgeType: "ai",
        description: "Nightly OODA options research runs, stage detail, and track record",
      });
    }

    // Add Platform Admin to Platform section
    if (sec.id === "section-platform") {
      items.unshift({
        id: PLATFORM_ADMIN_NAV_ID,
        label: "Platform Admin",
        shortLabel: "Admin",
        category: "Platform",
        icon: "Settings",
        badge: "Admin",
        badgeType: "pro",
        description: "Ads, tasks, keys, providers & IAAA",
        subItems: PLATFORM_ADMIN_NAV_ITEMS,
      });

      // Issue #2974: insert Schedules before the Workflows item, whose
      // id is "workflow-runs" (its label is "Workflows"). The "workflows"
      // id is the FAQ page, a Workflows sub-menu entry — it never sits
      // in Platform items, so looking it up always fell through to the
      // end and Schedules landed last. Retargeting the lookup is what
      // yields the Platform Admin, Schedules, Workflows order.
      const workflowsIndex = items.findIndex((i) => i.id === "workflow-runs");
      const insertAt = workflowsIndex !== -1 ? workflowsIndex : items.length;
      items.splice(insertAt, 0, {
        id: "schedules",
        label: "Schedules",
        shortLabel: "Schedules",
        category: "Platform",
        icon: "Schedules",
        badge: "Cron",
        badgeType: "neutral",
        description: "The one scheduling surface for screening runs — create, pause, and inspect scheduled jobs",
        // Issue #4561: one sub-menu entry per home view, from
        // nav-config.json — the same attach-by-id idiom as the
        // route-derived items above.
        subItems: SUB_MENU_CONFIGS.schedules,
      });
    }

    // Billing menus (issue #2968): the section holds three menu
    // parents, not six top-level pages — the pages live as submenus
    // (their routes are sub-menu-hosted above, so they do not repeat
    // as top-level items). The "billing" parent shares its id with
    // the Billing page route, like "workflow-runs" does today: the
    // parent click toggles and lands on the Billing page.
    if (sec.id === "section-billing") {
      items.splice(
        0,
        items.length,
        {
          id: "orders",
          label: "Orders",
          shortLabel: "Orders",
          category: "Billing",
          icon: "Order",
          description: "Checkout and the order history ledger",
          subItems: SUB_MENU_CONFIGS.orders,
        },
        {
          id: "billing",
          label: "Billing",
          shortLabel: "Billing",
          category: "Billing",
          icon: "Billing",
          description: "Billing servicing and revenue analytics",
          subItems: SUB_MENU_CONFIGS.billing,
        },
        {
          id: "payments",
          label: "Payments",
          shortLabel: "Payments",
          category: "Billing",
          icon: "Payments",
          description: "Payments and payment assurance",
          subItems: SUB_MENU_CONFIGS.payments,
        },
      );
    }

    return {
      id: sec.id,
      title: sec.title,
      category: sec.category,
      items,
    };
  });

  // Dedicated Sandbox section
  sections.push({
    id: "section-sandbox",
    title: "SANDBOX",
    category: "Platform",
    items: [
      {
        id: "sandbox",
        label: "Sandbox",
        shortLabel: "Sandbox",
        category: "Platform",
        icon: "Sandbox",
        description: "Payment assurance and demo checkout sandbox",
        subItems: SUB_MENU_CONFIGS.sandbox,
      },
    ],
  });

  return { sections };
}

/** Sub-item ids are `platform-admin:<section>`; the nav shell routes them to the drawer or tab view. */
export function platformAdminSectionFromNavId(id: string): string | undefined {
  if (id === PLATFORM_ADMIN_NAV_ID) return "ads";
  const prefix = `${PLATFORM_ADMIN_NAV_ID}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

/**
 * The four personas the nav-availability endpoint classifies
 * (#6151 S1, part 6). Admins see the entire menu; paid/non-paid
 * differ by the resolved tier fact.
 */
export type NavPersona = "platform-admin" | "tenant-admin" | "paid" | "non-paid";

/**
 * Persona defaults, externalized in the nav config data
 * (nav-config.json `personaDefaults`: persona → preset key, never
 * a map — the maps live in navPresets.ts, so no preset data is
 * duplicated). A saved preset overrides the default (S3); a
 * per-user allow-list caps it (S4). S1's four defaults are all
 * alltabs-equivalent, so the change is behavior-preserving on day one.
 */
const PERSONA_DEFAULTS = navConfigData.personaDefaults as unknown as Record<
  NavPersona,
  string
>;

export function personaDefaultPresetKey(persona: NavPersona): string {
  const key = PERSONA_DEFAULTS?.[persona];
  return typeof key === "string" && key.length > 0 ? key : "alltabs";
}

/**
 * The built-in preset keys (#6151 S1: the endpoint's
 * `availablePresets`). The keys live here, in the nav config data —
 * never a second literal in server code. The client owns the preset
 * MAPS (NAV_TAB_PRESETS); this list is the keys only, and the
 * endpoint test pins it equal to Object.keys(NAV_TAB_PRESETS), so
 * the two can never drift. Saved-preset ids join the list in S3.
 */
export function builtinPresetKeys(): string[] {
  const keys = navConfigData.presetKeys as unknown;
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

/**
 * #6151 S2 — the product→menu mapping (part 3), externalized in
 * the nav config data (nav-config.json `productMenuMapping`).
 *
 * One entry per product: the product id (as the product catalog
 * records it — subscription products are `prod-sub-<plan-name-slug>`
 * via subscriptionProductIdForName; per-run products are
 * `prod-per-run-<family>`) and the nav ids that product's
 * subscription enables (top-level ids and/or `<parentId>:<subId>`
 * sub-item keys from S1). A nav id in the mapping is product-gated:
 * the endpoint shows it only while the caller holds an active
 * subscription for a product that enables it; a nav id in NO entry
 * is governed by the persona default alone. A product with no entry
 * enables nothing. Admin allow-lists (S4) narrow on top; they never
 * widen beyond the entitlement.
 *
 * The mapping ships EMPTY: products are operator data (plans are
 * created through Admin Products; no subscription-product id is
 * fixed in code), so no entry can be written without inventing a
 * product. Operators add entries as products are created; the
 * endpoint + pins prove the mechanism with the mapping injected.
 * Per-run products (`prod-per-run-*`) have no subscription rows,
 * so mapping one can never enable its menus — do not add them.
 */
export interface ProductMenuMappingEntry {
  productId: string;
  navIds: string[];
}

/**
 * Normalize raw mapping data into validated entries. Unknown nav
 * ids are dropped (they name no menu); an entry left with no nav
 * ids is dropped; duplicate product ids merge (nav-id union).
 * Pure — the endpoint test pins the filtering through this
 * function, and productMenuMapping() below is this over the
 * shipped config.
 */
export function normalizeProductMenuMapping(
  raw: unknown,
): ProductMenuMappingEntry[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(enumerateNavAvailabilityIds());
  const byProduct = new Map<string, Set<string>>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const productId = (entry as { productId?: unknown }).productId;
    const navIds = (entry as { navIds?: unknown }).navIds;
    if (typeof productId !== "string" || productId.trim().length === 0) continue;
    if (!Array.isArray(navIds)) continue;
    const kept = navIds.filter(
      (id): id is string => typeof id === "string" && known.has(id),
    );
    if (kept.length === 0) continue;
    const set = byProduct.get(productId) ?? new Set<string>();
    for (const id of kept) set.add(id);
    byProduct.set(productId, set);
  }
  return [...byProduct.entries()].map(([productId, navIds]) => ({
    productId,
    navIds: [...navIds],
  }));
}

/** The shipped product→menu mapping, normalized. */
export function productMenuMapping(): ProductMenuMappingEntry[] {
  return normalizeProductMenuMapping(
    (navConfigData as { productMenuMapping?: unknown }).productMenuMapping,
  );
}

/**
 * The availability key for a sub-item of a nav parent. Most sub
 * items carry a bare id (`data-providers` under `data-hub`), so the
 * key is `<parentId>:<subId>`; a sub item whose id is already
 * qualified (`platform-admin:ads` — PLATFORM_ADMIN_NAV_ITEMS
 * prefixes its ids) keeps its id as-is, so the key never
 * double-prefixes. One derivation, shared by the server enumeration
 * and the client's sub-item consults.
 */
export function navSubItemAvailabilityKey(parentId: string, subId: string): string {
  return subId.startsWith(`${parentId}:`) ? subId : `${parentId}:${subId}`;
}

/**
 * Every nav id the availability map covers, in config order: each
 * top-level id, then each of its sub-items as `<parentId>:<subId>`
 * (the #6151 S1 sub-item key format — the one format #6147 item 10's
 * settings UI edits). The server endpoint and the client both
 * enumerate from this one function, so the two can never drift: the
 * endpoint's visibleTabs covers exactly these ids, and the client's
 * merge consults exactly these sub-item keys.
 */
export function enumerateNavAvailabilityIds(): string[] {
  const ids: string[] = [];
  for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
    for (const item of section.items) {
      ids.push(item.id);
      for (const sub of item.subItems ?? []) {
        ids.push(navSubItemAvailabilityKey(item.id, sub.id));
      }
    }
  }
  return ids;
}

export const DEFAULT_LEFT_NAV_CONFIG: LeftNavConfig = buildDefaultLeftNavConfig();

/**
 * Find a menu item within a LeftNavConfig by id.
 */
export function findNavItemConfig(
  config: LeftNavConfig,
  id: string
): NavMenuItemConfig | undefined {
  for (const section of config.sections) {
    for (const item of section.items) {
      if (item.id === id) return item;
      if (item.subItems) {
        for (const sub of item.subItems) {
          if (sub.id === id) {
            return {
              id: sub.id,
              label: sub.label,
              shortLabel: sub.shortLabel,
              category: section.category,
              icon: sub.icon || item.icon,
              badge: sub.badge,
              badgeType: sub.badgeType,
              description: sub.description || "",
            };
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Check if a menu item or any of its sub-items matches the current active tab.
 */
export function isNavItemOrSubItemActive(
  item: NavMenuItemConfig,
  currentTab: string
): boolean {
  if (item.id === currentTab) return true;
  if (item.id === "goal-screen") {
    if (typeof window !== "undefined") {
      const view = new URLSearchParams(window.location.search).get("view");
      return currentTab === "screeners" && view === "goal-screen";
    }
    return false;
  }
  if (item.id === "schedules") {
    // Issue #3121 S2: the schedules item is active exactly when the
    // schedules home is open. The old dual address
    // (`?tab=screeners&view=schedules`, and `view=schemas` with it)
    // is retired — that URL now redirects to `?tab=schedules`, so no
    // screeners address may activate this item anymore.
    return currentTab === "schedules";
  }
  if (getNavGroup(currentTab) === item.id) return true;
  if (item.subItems) {
    return item.subItems.some((sub) => {
      if (sub.id === currentTab) return true;
      if (getNavGroup(currentTab) === sub.id) return true;
      if (typeof window !== "undefined") {
        const view = new URLSearchParams(window.location.search).get("view");
        // Issue #4530: the Product Hub's sub-menu items are views of
        // the hub tab, like the stock-hub precedent above. Issue #4575
        // adds the Audit & Vault host: its two entries are the audit
        // and nlq views of `?tab=audit-vault`. Issue #4638 adds the
        // Billing page the same way: its sub-menu items are the
        // section tabs of `?tab=billing&view=<id>`. Issue 4682 adds
        // the Marketing Hub the same way: its three entries are the
        // referrals, ads, and social views of `?tab=marketing-hub`.
        // #6147 S2 (#4681) adds Assets Hub the same way: its six
        // entries are the forex, futures, commodities, bonds,
        // registry, and binding views of `?tab=assets-hub`.
        if (
          (currentTab === "screeners" ||
            currentTab === "stock-hub" ||
            currentTab === "product-hub" ||
            currentTab === "audit-vault" ||
            currentTab === "marketing-hub" ||
            currentTab === "observability" ||
            currentTab === "assets-hub" ||
            currentTab === "billing") &&
          view === sub.id
        )
          return true;
      }
      return false;
    });
  }
  return false;
}
