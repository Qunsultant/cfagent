/**
 * IA cleanup (#2174, epic #2150 slice 3): nav labels, crumbs, and page
 * titles must not collide — a user cannot tell two routes apart when
 * they share a nav label or a breadcrumb.
 *
 * Current-state findings (verified against main, not the issue's 8414089
 * audit): the label collisions from that audit are already gone — the
 * six legacy/alias ids (trading, orders, scanner, reports, schedules,
 * options) carry no navEntry, so only one nav label each remains. The
 * two crumb collisions that survive are the alias ids sharing their
 * target's page, which is correct, not a defect: a crumb names the
 * rendered page, and mapTabToTradingSubTab sends orders → order and
 * trading → autopilot. They are pinned equal to the target's crumb
 * explicitly below, never silently allowed.
 *
 * Reconciled renames pinned here (display-only, route ids stable):
 *  - audit "AI Transparency" → "Audit Vault" (the page IS the vault;
 *    the title stays the fuller "System Audit & Memory Vault").
 *  - docs "Docs and Reports" → "Docs & Reports" (label, h2, and crumb
 *    now agree; the "&" form matches the rest of the table).
 *  - nlq "Records & Ledger Explorer" → "Records NLQ" (the old label
 *    collided conceptually with the separate Ledger page).
 *  - options-flows "Hedging (F&O)" → "Options Flows" (the page is flow
 *    analysis — sweeps, blocks, prints — not hedging); crumb
 *    "Options Flow" → "Options Flows" to match.
 *  - payments "Billing & Accounts" → "Payments" (id, crumb, and title
 *    all say Payments; the title keeps its DID scope suffix).
 *  - screeners "Screening" → "Screeners" (noun agreement with the
 *    crumb and the hub title).
 *  - social title "Social posting" → "Social Posting" (case agreement
 *    with the nav label).
 *
 * Deliberately kept drift (label is the long form, crumb/title the
 * short form, same root): Autopilot Control, Fast Order Ticket, Order
 * History Ledger, Email & Slack Agents, Portfolio & Holdings,
 * Referrals & Earn, Revenue Analytics, Voice Trading Desk,
 * Workflows & FAQ, Sponsored Marketplace, Research & Dual Feed,
 * Developer & MCP, Payment Assurance (title adds "Workflow").
 * Nav-group taxonomy decision: options-flows keeps its own group —
 * flow/sweep analysis is execution intel, not screening, so folding it
 * under "screeners" would mislead; the five hub children share
 * "screeners" because they are views of the one screening hub.
 * Chat has no PageShell title by design (conversational surface with
 * its own header); nav label and crumb agree on "Copilot Ideas".
 */
import { describe, it, expect } from "vitest";
import { ROUTES, hasNavEntry, getRoute } from "../src/client/routes";

const navRoutes = ROUTES.filter(hasNavEntry);

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes].sort();
}

describe("IA: labels, crumbs, shortLabels are collision-free (#2174)", () => {
  it("gives every nav entry a unique label", () => {
    expect(duplicates(navRoutes.map((r) => r.navEntry.label))).toEqual([]);
  });

  it("gives every nav entry a unique shortLabel", () => {
    expect(duplicates(navRoutes.map((r) => r.navEntry.shortLabel))).toEqual([]);
  });

  it("gives every non-alias route a unique crumb", () => {
    const crumbs = ROUTES.filter((r) => r.id !== "orders" && r.id !== "trading").map(
      (r) => r.crumb,
    );
    expect(duplicates(crumbs)).toEqual([]);
  });

  it("pins the alias crumbs to their target page's crumb (justified, #2174)", () => {
    // orders lands on the order sub-tab, trading on the autopilot
    // sub-tab (mapTabToTradingSubTab); the crumb names the rendered
    // page, so sharing the target's crumb is correct. If either page's
    // crumb changes, this pin forces the alias decision to be revisited.
    expect(getRoute("orders")!.crumb).toBe(getRoute("order")!.crumb);
    expect(getRoute("orders")!.crumb).toBe("Order Ticket");
    expect(getRoute("trading")!.crumb).toBe(getRoute("autopilot")!.crumb);
    expect(getRoute("trading")!.crumb).toBe("Autopilot");
  });

  it("pins the reconciled renames", () => {
    const byId = new Map(ROUTES.map((r) => [r.id, r]));
    expect(byId.get("audit")!.navEntry!.label).toBe("Audit Vault");
    expect(byId.get("docs")!.navEntry!.label).toBe("Docs & Reports");
    expect(byId.get("docs")!.crumb).toBe("Docs & Reports");
    expect(byId.get("nlq")!.navEntry!.label).toBe("Records NLQ");
    expect(byId.get("options-flows")!.navEntry!.label).toBe("Options Flows");
    expect(byId.get("options-flows")!.navEntry!.shortLabel).toBe("Flows");
    expect(byId.get("options-flows")!.crumb).toBe("Options Flows");
    expect(byId.get("payments")!.navEntry!.label).toBe("Payments");
    expect(byId.get("payments")!.navEntry!.shortLabel).toBe("Payments");
    expect(byId.get("screeners")!.navEntry!.label).toBe("Stock Screener");
    expect(byId.get("screeners")!.navEntry!.shortLabel).toBe("Stocks");
  });

  it("pins the nav-group taxonomy decision", () => {
    const byId = new Map(ROUTES.map((r) => [r.id, r]));
    // Hub children share the screeners group; options-flows deliberately
    // keeps its own — flow analysis is not screening.
    expect(byId.get("options")!.navGroup).toBe("options-screener");
    expect(byId.get("scanner")!.navGroup).toBe("options-screener");
    expect(byId.get("options-flows")!.navGroup).toBe("options-screener");
    expect(byId.get("reports")!.navGroup).toBe("workflow-runs");
    expect(byId.get("schedules")!.navGroup).toBe("platform-admin");
    expect(byId.get("screeners")!.navGroup).toBe("screeners");
  });
});
