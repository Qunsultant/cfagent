/**
 * Nav config data validation pins (issue #2977).
 *
 * The left-nav data lives in src/client/nav-config.json; the modules in
 * src/client (routes, navConfig, deepLinks, platformAdminConfig) are
 * thin loaders over it. These pins guard the data file's shape directly,
 * so a bad edit fails here with a precise message instead of surfacing
 * as a scattered nav regression. The behavioral pins (route_table,
 * nav_derivation, deep links, left_nav_bar) prove the loaded data still
 * renders the same nav.
 */
import { describe, expect, it } from "vitest";
import navData from "../src/client/nav-config.json";
import { ROUTES } from "../src/client/routes";
import { buildDefaultLeftNavConfig } from "../src/client/navConfig";
import {
  DEEP_LINK_OVERRIDES,
  SURFACE_TAB_DEFS,
} from "../src/client/deepLinks";

const CATEGORIES = ["Execution", "Intelligence", "Playbooks", "Platform", "Billing", "Marketing"];
const BADGE_TYPES = ["pro", "live", "ai", "mcp", "new", "neutral"];

describe("nav-config.json shape (issue #2977)", () => {
  it("routes: ids are sorted ascending and unique", () => {
    const ids = (navData.routes as { id: string }[]).map((r) => r.id);
    // Issue #3116: the absolute count is not pinned here — several lanes add
    // routes and every absolute number became a merge-conflict magnet. The
    // shape (sorted, unique) and the loader-equality pin below are the signal.
    expect(ids.length).toBeGreaterThan(40);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("routes: navOrders are exactly 0..30 across the 31 nav entries", () => {
    const orders = (navData.routes as { navEntry?: { navOrder: number } }[])
      .filter((r) => r.navEntry)
      .map((r) => r.navEntry!.navOrder);
    expect(orders).toHaveLength(31);
    expect([...orders].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 31 }, (_, i) => i),
    );
  });

  it("routes: categories, badge types, nav groups, and icons are valid", () => {
    const ids = new Set((navData.routes as { id: string }[]).map((r) => r.id));
    for (const r of navData.routes as {
      id: string;
      navGroup: string;
      category: string;
      icon: string;
      navEntry?: { badgeType?: string };
    }[]) {
      expect(CATEGORIES).toContain(r.category);
      expect(r.icon).toMatch(/^[A-Za-z]+$/);
      expect(ids.has(r.navGroup)).toBe(true);
      if (r.navEntry?.badgeType) expect(BADGE_TYPES).toContain(r.navEntry.badgeType);
    }
  });

  it("subMenus: 12 groups, every sub-item has id and label", () => {
    const groups = Object.keys(navData.subMenus as Record<string, unknown[]>);
    expect(groups).toHaveLength(12);
    for (const items of Object.values(navData.subMenus as Record<string, { id: string; label: string }[]>)) {
      for (const item of items) {
        expect(item.id).toBeTruthy();
        expect(item.label).toBeTruthy();
      }
    }
  });

  it("hostedIds: 12 ids, all of them routes", () => {
    const ids = new Set((navData.routes as { id: string }[]).map((r) => r.id));
    expect(navData.hostedIds).toHaveLength(12);
    for (const id of navData.hostedIds as string[]) expect(ids.has(id)).toBe(true);
  });

  it("deepLinks: every tab target is a route", () => {
    const ids = new Set((navData.routes as { id: string }[]).map((r) => r.id));
    const entries = Object.entries(navData.deepLinks as Record<string, { tab?: string }>);
    expect(entries.length).toBeGreaterThan(30);
    for (const [, link] of entries) {
      if (link.tab) expect(ids.has(link.tab)).toBe(true);
    }
  });

  it("deepLinkSurfaces: 15 surfaces, unique, pages resolve, values non-empty", () => {
    const ids = new Set((navData.routes as { id: string }[]).map((r) => r.id));
    const surfaces = navData.deepLinkSurfaces as {
      surface: string;
      page: string | null;
      values: string[];
    }[];
    expect(surfaces).toHaveLength(15);
    expect(new Set(surfaces.map((s) => s.surface)).size).toBe(15);
    for (const s of surfaces) {
      if (s.page !== null) expect(ids.has(s.page)).toBe(true);
      expect(s.values.length).toBeGreaterThan(0);
    }
  });

  it("platformAdminSections: one section, 18 items, unique ids", () => {
    const sections = navData.platformAdminSections as {
      id: string;
      items: { id: string; label: string; description: string }[];
    }[];
    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(18);
    expect(new Set(sections[0].items.map((i) => i.id)).size).toBe(18);
    for (const item of sections[0].items) {
      expect(item.label).toBeTruthy();
      expect(item.description).toBeTruthy();
    }
  });
});

describe("nav-config.json loaders (issue #2977)", () => {
  it("loaders re-export the data file unchanged", () => {
    expect(ROUTES).toHaveLength((navData.routes as unknown[]).length);
    expect(Object.keys(DEEP_LINK_OVERRIDES)).toHaveLength(
      Object.keys(navData.deepLinks as Record<string, unknown>).length,
    );
    expect(SURFACE_TAB_DEFS).toHaveLength(15);
    // 5 metadata sections + sandbox menu-only section.
    const built = buildDefaultLeftNavConfig().sections;
    expect(built).toHaveLength(6);
    expect(built.slice(0, 5).map((s) => s.title)).toEqual(
      (navData.sections as { title: string }[]).map((s) => s.title),
    );
  });
});
