/**
 * Platform Admin menu configuration (issue #2624).
 *
 * Follows the externalized-menu idiom established by the configurable
 * LeftNavBar (#2529, `src/client/navConfig.ts`): the menu is data —
 * sections → items with id, label, description and an optional icon —
 * so an operator can add, reorder or relabel an administration surface
 * without editing the panel component. The panel consumes this config
 * and stays layout-only.
 *
 * The items are exactly the ones that used to sit at the bottom of the
 * settings dropdown: from "Ads & Partner Banners" through "Request
 * admin access".
 */

import navConfigData from "./nav-config.json";

export type PlatformAdminSectionId =
  | "ads"
  | "background-tasks"
  | "scheduled-goals"
  | "jobs"
  | "provenance"
  | "api-keys"
  | "tenants"
  | "channels"
  | "data-providers"
  | "accounts"
  | "free-runs"
  | "products"
  | "iaaa-admin"
  | "users"
  | "data-lifecycle"
  | "engine-tuning"
  | "downloads"
  | "admin-access";

export interface PlatformAdminMenuItemConfig {
  id: PlatformAdminSectionId;
  label: string;
  description: string;
  icon?: string;
}

export interface PlatformAdminSectionConfig {
  id: string;
  title: string;
  items: PlatformAdminMenuItemConfig[];
}

export interface PlatformAdminConfig {
  sections: PlatformAdminSectionConfig[];
}

export const DEFAULT_PLATFORM_ADMIN_CONFIG: PlatformAdminConfig = {
  sections:
    navConfigData.platformAdminSections as unknown as PlatformAdminSectionConfig[],
};

/**
 * The same items as left-nav sub-entries (issue #2624 follow-up): the nav
 * item id prefixes the section id, so the shell can open the drawer at the
 * selected section without inventing a route per admin surface.
 */
export const PLATFORM_ADMIN_NAV_ITEMS: Array<{
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  icon?: string;
}> = DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items.map((item) => ({
  id: `platform-admin:${item.id}`,
  label: item.label,
  shortLabel: item.description,
  description: item.description,
  icon: item.icon,
}));

/** Flatten a config's sections into one ordered item list (one section today). */
export function platformAdminItems(
  config: PlatformAdminConfig = DEFAULT_PLATFORM_ADMIN_CONFIG,
): PlatformAdminMenuItemConfig[] {
  return config.sections.flatMap((section) => section.items);
}

/** The panel title comes from the config, so a custom config renames the menu. */
export function platformAdminTitle(
  config: PlatformAdminConfig = DEFAULT_PLATFORM_ADMIN_CONFIG,
): string {
  return config.sections[0]?.title ?? "Platform Admin";
}
