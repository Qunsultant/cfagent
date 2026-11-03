/**
 * Route table contract (#1804 S1, issue #1808): the table is the single
 * source of truth for navigation, so its shape is pinned — 38 entries
 * (31 nav entries + 6 alias ids; the agents tab was added by #2469,
 * Agent Mesh S20/G9, appended at navOrder 25 so no existing item
 * moves; the options-screener tab was added by #2596, appended at
 * navOrder 26 so no existing item moves; the platform-admin tab was added at navOrder 27 so no existing item moves; the products tab was added by #2695, appended at navOrder 28 so no existing item moves; the billing tab was added by #2740, appended at navOrder 29 so no existing item moves), sorted ids, complete metadata, alias
 * groups resolving to real nav entries, and derived defaults.
 * (#2954: the assets-hub tab was added, appended at navOrder 30 so no
 * existing item moves.)
 * (#2973: the queues tab was added, appended at navOrder 31 so no
 * existing item moves.)
 * (#2970: goal-screen, review, and track-record routes added — own
 * pages with no nav entries, so the nav-entry count stays 31.)
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
  "assets-hub",
  "audit",
  "autopilot",
  "billing",
  "chat",
  "checkout",
  "docs",
  "endpoints",
  "goal-screen",
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
  "platform-admin",
  "portfolio",
  "products",
  "queues",
  "referrals",
  "reports",
  "research",
  "revenue",
  "review",
  "scanner",
  "schedules",
  "screeners",
  "search",
  "social",
  "stock-hub",
  "track-record",
  "trading",
  "voice",
  "workflow-runs",
  "workflows",
];

const ALIAS_IDS = ["options", "orders", "reports", "scanner", "schedules", "trading"];

describe("route table", () => {
  it("has exactly the 42 tab ids, sorted and unique", () => {
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
      expect(["Execution", "Intelligence", "Playbooks", "Platform", "Billing", "Marketing"]).toContain(r.category);
    }
  });

  it("every navGroup resolves to a real nav entry, except host routes grouping under themselves", () => {
    for (const r of ROUTES) {
      const group = getRoute(r.navGroup);
      expect(group).toBeDefined();
      // Issue #2896: a host route with no nav entry may group under
      // itself (screeners); its tabs are reached through their
      // capability menus. Every other navGroup must resolve to a
      // real nav entry.
      if (!hasNavEntry(r) && r.navGroup === r.id) {
        expect(group).toBeDefined();
      } else {
        expect(hasNavEntry(group!)).toBe(true);
      }
    }
  });

  it("has exactly 32 nav entries with unique 0..31 display order", () => {
    const nav = ROUTES.filter(hasNavEntry);
    expect(nav).toHaveLength(32);
    const orders = nav.map((r) => r.navEntry.navOrder).sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 32 }, (_, i) => i));
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

  it("derives visibility defaults: the 32 nav entries, all visible", () => {
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
    expect(getCrumb("stock-hub")).toBe("Stock Hub");
    expect(getCrumb("scanner")).toBe("Strategy/Symbol Scanner");
    expect(getCrumb("reports")).toBe("Reports");
    expect(getCrumb("docs")).toBe("Docs & Reports");
    // Issue #2970: the own pages' crumbs.
    expect(getCrumb("goal-screen")).toBe("Goal Screen");
    expect(getCrumb("review")).toBe("Proposal Review");
    expect(getCrumb("track-record")).toBe("Track Record");
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
    expect(getNavGroup("stock-hub")).toBe("stock-hub");
    expect(getNavGroup("scanner")).toBe("options-screener");
    expect(getNavGroup("reports")).toBe("workflow-runs");
    expect(getNavGroup("docs")).toBe("workflow-runs");
    // Issue #2957: schedules is its own nav group (was platform-admin
    // via the #2709 follow-up).
    expect(getNavGroup("schedules")).toBe("schedules");
    // Issue #2970: the own pages — goal-screen groups under itself
    // (host-route exception), review/track-record under workflow-runs.
    expect(getNavGroup("goal-screen")).toBe("goal-screen");
    expect(getNavGroup("review")).toBe("workflow-runs");
    expect(getNavGroup("track-record")).toBe("workflow-runs");
    expect(getNavGroup("options")).toBe("options-screener");
    expect(getNavGroup("bogus")).toBe("autopilot");
  });
});
