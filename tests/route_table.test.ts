/**
 * Route table contract (#1804 S1, issue #1808): the table is the single
 * source of truth for navigation, so its shape is pinned — 33 entries
 * (27 nav entries + 6 alias ids; the agents tab was added by #2469,
 * Agent Mesh S20/G9, appended at navOrder 25 so no existing item
 * moves; the options-screener tab was added by #2596, appended at
 * navOrder 26 so no existing item moves), sorted ids, complete metadata, alias
 * groups resolving to real nav entries, and derived defaults.
 * (#2137 rebuild: checkout added at navOrder 24; search restored at
 * navOrder 23 — the old branch's search-for-checkout swap at order 23
 * is NOT carried, since main ships the Search Hub tab.)
 */
import { describe, it, expect } from "vitest";
import {
  ROUTES,
  DEFAULT_VISIBLE_NAV_TABS,
  getRoute,
  resolveRouteId,
  getCrumb,
  getNavGroup,
  hasNavEntry,
} from "../src/client/routes";

const EXPECTED_IDS = [
  "ads",
  "agents",
  "approvals",
  "audit",
  "autopilot",
  "chat",
  "checkout",
  "docs",
  "endpoints",
  "ledger",
  "nlq",
  "omnichannel",
  "options",
  "options-flows",
  "options-screener",
  "order",
  "orders",
  "payment-assurance",
  "payments",
  "portfolio",
  "referrals",
  "reports",
  "research",
  "revenue",
  "scanner",
  "schedules",
  "screeners",
  "search",
  "social",
  "trading",
  "voice",
  "workflow-runs",
  "workflows",
];

const ALIAS_IDS = ["options", "orders", "reports", "scanner", "schedules", "trading"];

describe("route table", () => {
  it("has exactly the 33 tab ids, sorted and unique", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(ids).toEqual(EXPECTED_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("every entry carries complete metadata", () => {
    for (const r of ROUTES) {
      expect(r.id.length).toBeGreaterThan(0);
      expect(r.navGroup.length).toBeGreaterThan(0);
      expect(r.crumb.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.icon.length).toBeGreaterThan(0);
      expect(["Execution", "Intelligence", "Playbooks", "Platform"]).toContain(r.category);
    }
  });

  it("every navGroup resolves to a real nav entry", () => {
    for (const r of ROUTES) {
      const group = getRoute(r.navGroup);
      expect(group).toBeDefined();
      expect(hasNavEntry(group!)).toBe(true);
    }
  });

  it("has exactly 27 nav entries with unique 0..26 display order", () => {
    const nav = ROUTES.filter(hasNavEntry);
    expect(nav).toHaveLength(27);
    const orders = nav.map((r) => r.navEntry.navOrder).sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 27 }, (_, i) => i));
    for (const r of nav) {
      expect(r.navEntry.label.length).toBeGreaterThan(0);
      expect(r.navEntry.shortLabel.length).toBeGreaterThan(0);
      expect(r.navEntry.defaultVisible).toBe(true);
    }
  });

  it("alias ids carry no nav entry", () => {
    expect(ALIAS_IDS).toHaveLength(6);
    for (const id of ALIAS_IDS) {
      expect(hasNavEntry(getRoute(id)!)).toBe(false);
    }
  });

  it("derives visibility defaults: the 27 nav entries, all visible", () => {
    const navIds = ROUTES.filter(hasNavEntry).map((r) => r.id).sort();
    expect(Object.keys(DEFAULT_VISIBLE_NAV_TABS).sort()).toEqual(navIds);
    expect(Object.values(DEFAULT_VISIBLE_NAV_TABS).every((v) => v === true)).toBe(true);
  });

  it("resolves unknown tab ids to autopilot", () => {
    expect(resolveRouteId("social")).toBe("social");
    expect(resolveRouteId("bogus")).toBe("autopilot");
    expect(resolveRouteId("")).toBe("autopilot");
  });

  it("crumbs match the historical breadcrumb labels", () => {
    expect(getCrumb("autopilot")).toBe("Autopilot");
    expect(getCrumb("trading")).toBe("Autopilot");
    expect(getCrumb("order")).toBe("Order Ticket");
    expect(getCrumb("orders")).toBe("Order Ticket");
    expect(getCrumb("screeners")).toBe("Screeners");
    expect(getCrumb("scanner")).toBe("Strategy/Symbol Scanner");
    expect(getCrumb("reports")).toBe("Reports");
    expect(getCrumb("docs")).toBe("Docs & Reports");
    expect(getCrumb("schedules")).toBe("Schedules");
    expect(getCrumb("options")).toBe("Options");
    expect(getCrumb("social")).toBe("Social");
    expect(getCrumb("bogus")).toBe("Revenue");
  });

  it("nav groups match the historical active-state groups", () => {
    expect(getNavGroup("autopilot")).toBe("autopilot");
    expect(getNavGroup("trading")).toBe("autopilot");
    expect(getNavGroup("order")).toBe("order");
    expect(getNavGroup("orders")).toBe("order");
    expect(getNavGroup("screeners")).toBe("screeners");
    expect(getNavGroup("scanner")).toBe("screeners");
    expect(getNavGroup("reports")).toBe("screeners");
    expect(getNavGroup("docs")).toBe("docs");
    expect(getNavGroup("schedules")).toBe("screeners");
    expect(getNavGroup("options")).toBe("screeners");
    expect(getNavGroup("bogus")).toBe("autopilot");
  });
});
