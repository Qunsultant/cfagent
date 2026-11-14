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
        // the hub tab, like the stock-hub precedent above.
        if (
          (currentTab === "screeners" ||
            currentTab === "stock-hub" ||
            currentTab === "product-hub") &&
          view === sub.id
        )
          return true;
      }
      return false;
    });
  }
  return false;
}
