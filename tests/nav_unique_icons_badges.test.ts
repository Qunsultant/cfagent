/**
 * Left-nav identity contract: every item is individually recognizable.
 *
 * Pins (owner request, 2026-10-29):
 *  - all 28 nav entries carry an icon and a badge (27 since #2596
 *    added the options-screener tab with its own icon key and badge;
 *    26 since #2469 added the agents tab);
 *  - no two nav entries share an icon (route key AND resolved component);
 *  - no two nav entries share a badge label (case-insensitive);
 *  - every badge carries a badge type, so the tone is deliberate rather
 *    than falling back by accident.
 *
 * Non-nav alias ids (trading, orders, scanner, reports, schedules,
 * options) keep their inline icons; they never render as nav items, so
 * they are outside this contract.
 */
import { describe, it, expect } from "vitest";
import { ROUTES, hasNavEntry } from "../src/client/routes";
import { NAVIGATION_ITEMS } from "../src/client/components/NavigationMenu";

const navRoutes = ROUTES.filter(hasNavEntry);
const NAV_COUNT = 28;

describe("left-nav unique icons and badges", () => {
  it("has the full 28-item nav", () => {
    expect(navRoutes).toHaveLength(NAV_COUNT);
    expect(NAVIGATION_ITEMS).toHaveLength(NAV_COUNT);
  });

  it("gives every item its own icon key in the route table", () => {
    const icons = navRoutes.map((r) => r.icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const icon of icons) expect(icon.length).toBeGreaterThan(0);
  });

  it("resolves every icon key to a distinct component", () => {
    const resolved = NAVIGATION_ITEMS.map((i) => i.icon);
    expect(new Set(resolved).size).toBe(resolved.length);
    for (const icon of resolved) expect(typeof icon).toBe("function");
  });

  it("gives every item a non-empty, unique badge", () => {
    const badges = navRoutes.map((r) => (r.navEntry.badge ?? "").trim());
    expect(badges.every((b) => b.length > 0)).toBe(true);

    const normalized = badges.map((b) => b.toLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("declares a badge type for every badge", () => {
    for (const r of navRoutes) {
      expect(r.navEntry.badgeType, `${r.id} is missing a badgeType`).toBeDefined();
    }
  });

  it("keeps the per-item pairs stable (regression pin)", () => {
    const byId = new Map(navRoutes.map((r) => [r.id, r]));
    expect(byId.get("autopilot")!.navEntry.badge).toBe("LIVE");
    expect(byId.get("docs")!.navEntry.badge).toBe("PDF");
    expect(byId.get("search")!.navEntry.badge).toBe("Hub");
    expect(byId.get("checkout")!.navEntry.badge).toBe("Testnet");
    expect(byId.get("docs")!.icon).toBe("Docs");
    expect(byId.get("search")!.icon).toBe("Search");
    expect(byId.get("options-screener")!.icon).toBe("Options");
    expect(byId.get("options-flows")!.icon).toBe("Flows");
    expect(byId.get("options-screener")!.navEntry.badge).toBe("Options");
    expect(byId.get("platform-admin")!.icon).toBe("Settings");
    expect(byId.get("platform-admin")!.navEntry.badge).toBe("Admin");
  });
});
