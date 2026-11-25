/** @vitest-environment jsdom */
/**
 * General composed-page gate (issue #4825) — the #4408 invariant,
 * generalized to every template-state route.
 *
 * The #3139/#3140 composition tests proved the pattern for one page
 * each (mount the composed page, count h1s); this gate is the ONE
 * general version: it iterates the register's template-state routes,
 * mounts each page the way its live host mounts it (a hub sub-tab
 * through TradeHub, a standalone route directly under the
 * default "page" chrome), and asserts the composed invariants:
 * exactly one h1; exactly one template shell (`.ui-page-shell` —
 * no nested shell chrome); filled slots in canonical order
 * (contextStrip, KPI ribbon, workspace, action bar, queue rail);
 * exactly one visible sub-tab panel (the active section — sub-tab
 * panels are mutually exclusive); every section inside the
 * template Stack; and no dead layout class the route OWNS in the
 * Stack subtree.
 *
 * The gate never names a single page: the route list comes from the
 * register, and each route's mount comes from the two mount tables
 * below (hub vs standalone — the only two ways the app hosts a
 * template route). A route that later claims `template` state must
 * add its mount to one of the tables in the same PR, or this gate
 * fails with "no mount wired".
 *
 * Sub-tab mutual exclusion is VISIBILITY, not DOM absence: the
 * retain pattern keeps visited panels mounted-hidden (the #1379
 * pattern), so an inactive panel may be present with `hidden` — the
 * invariant is exactly one visible tabpanel.
 *
 * Structural only: jsdom has no layout engine, so true bounding-box
 * assertions are impossible without a browser runner — that stays
 * out of scope.
 *
 * Rendered tabs == registry tabs (issue #6501): the gate also
 * asserts that a route's tab strip shows every registry view, in
 * registry order, and nothing else — against the registry module
 * the page renders its strip from (ROUTE_TABS). The #6501 lone-tab
 * collapse passed this gate with all five Data Hub tabs in the DOM
 * and none of them visible: the panel assertion cannot see a
 * missing or wrong strip, so the strip is asserted here. A tablist
 * with no ROUTE_TABS entry fails the gate ("no registry tabs
 * wired"), the same pattern as "no mount wired".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TradeHub } from "../src/client/TradeHub";
import { ProductHub, PRODUCT_HUB_TAB_OPTIONS } from "../src/client/ProductHub";
import { AuditVaultPage, AUDIT_VAULT_VIEWS, AUDIT_VAULT_VIEW_LABELS } from "../src/client/AuditVaultPage";
import { WorkflowCatalogPage, WORKFLOW_CATALOG_VIEWS, WORKFLOW_CATALOG_VIEW_LABELS } from "../src/client/WorkflowCatalogPage";
import { NavSettingsPage } from "../src/client/NavSettingsPage";
import { OptionsScreenerPage } from "../src/client/OptionsScreenerPage";
import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { DataHubHome } from "../src/client/DataHubHome";
import { ORDER_TICKET_TABS } from "../src/client/OrderTicketPanel";
import { AUTOPILOT_SUB_TABS } from "../src/client/components/AutopilotControlCenter";
import { OPTIONS_HUB_TAB_ITEMS } from "../src/client/OptionsHub";
import { SECURITY_HUB_VIEWS, SECURITY_HUB_VIEW_LABELS } from "../src/client/securityHubView";
import { DATA_HUB_VIEWS, DATA_HUB_VIEW_LABELS } from "../src/client/dataHubView";
import { leftNavConfigIds } from "../src/client/navPresets";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  routeConformance,
  templateRoutes,
  primitiveClasses,
  routeOwnedBespokeClasses,
} from "./template_route_tree";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Hub-hosted template routes: sub-tab + canonical URL, as live. */
const HUB_ROUTES: Record<string, { subTab: string; search: string }> = {
  order: { subTab: "order", search: "/?tab=order" },
  autopilot: { subTab: "autopilot", search: "/?tab=autopilot" },
  options: { subTab: "options", search: "/?tab=options" },
  "risk-analysis": { subTab: "order", search: "/?tab=order&orderTab=risk" },
};

/** Standalone template routes: the page component, as Chat mounts it. */
const STANDALONE_ROUTES: Record<string, React.ComponentType> = {
  "product-hub": ProductHub,
  "audit-vault": AuditVaultPage,
  "workflow-catalog": WorkflowCatalogPage,
  // nav-settings mounts with the live default: every tab visible
  // (alltabs). NavSettingsPage takes its state as props, so the mount
  // supplies them — the page itself fetches nothing.
  "nav-settings": () => (
    <NavSettingsPage
      visibleTabs={Object.fromEntries(
        leftNavConfigIds().map((id) => [id, true]),
      )}
      activePreset="alltabs"
      onToggleTabVisibility={() => {}}
      onApplyPreset={() => {}}
    />
  ),
  "options-screener": () => <OptionsScreenerPage onSelectTab={() => {}} />,
  // security-hub mounts standalone, as Chat mounts it: no signed-in
  // login (defaults), empty-shape fetch stub — the panels render
  // their loading/empty states, never a crash.
  "security-hub": SecurityHubHome,
  // data-hub mounts standalone, as Chat mounts it. The mount URL is
  // pipeline-policy, not the default view: the default
  // data-providers view renders a NESTED Tabs inside
  // DataProvidersPanel, which would double the visible panels —
  // pipeline-policy has no nested tabs (see STANDALONE_SEARCH).
  "data-hub": DataHubHome,
};

/** Standalone routes whose mount needs a deeper URL than `/?tab=<id>`. */
const STANDALONE_SEARCH: Record<string, string> = {
  "data-hub": "/?tab=data-hub&view=pipeline-policy",
};

/** Registry tabs per tabbed template route: the route's view registry
 * (labels, in display order), derived from the same module the page
 * renders its strip from — never a hardcoded copy, so a registry
 * change fails this gate instead of silently drifting. Routes with
 * no tablist (nav-settings, options-screener) have no entry; a
 * tablist rendering on such a route fails the gate.
 *
 * Hub mounts render the panel's strip, not TradeHub's (TradeHub
 * renders no tablist of its own). The order page's strip is the
 * risk-analysis route's strip too — the route IS the order page's
 * risk sub-tab, and the risk panel's own Tabs render inside it.
 * The FIRST tablist in document order is the route's strip; nested
 * tablists live inside panels, never inside it. */
const ROUTE_TABS: Record<string, readonly string[]> = {
  order: ORDER_TICKET_TABS.map((t) => t.label),
  "risk-analysis": ORDER_TICKET_TABS.map((t) => t.label),
  autopilot: AUTOPILOT_SUB_TABS.map((t) => t.label),
  options: OPTIONS_HUB_TAB_ITEMS.map((t) => t.label),
  "product-hub": PRODUCT_HUB_TAB_OPTIONS.map((t) => t.label),
  "audit-vault": AUDIT_VAULT_VIEWS.map((id) => AUDIT_VAULT_VIEW_LABELS[id]),
  "workflow-catalog": WORKFLOW_CATALOG_VIEWS.map(
    (id) => WORKFLOW_CATALOG_VIEW_LABELS[id],
  ),
  "security-hub": SECURITY_HUB_VIEWS.map((id) => SECURITY_HUB_VIEW_LABELS[id]),
  "data-hub": DATA_HUB_VIEWS.map((id) => DATA_HUB_VIEW_LABELS[id]),
};

/** Canonical slot order (PageTemplate renders them in this order). */
const CANONICAL_SLOTS = [
  "contextStrip=",
  "kpiRibbon=",
  "actionBar=",
  "queueRail=",
] as const;

/** Organism root for each slot (the slot's content, when rendered). */
const SLOT_MARKER: Record<string, string> = {
  "contextStrip=": ".ui-context-strip",
  "kpiRibbon=": ".ui-grid",
  "actionBar=": ".ui-action-bar",
  "queueRail=": ".ui-queue-feed",
};

/** Dead-layout-class sets, computed once per run. */
const PRIMITIVE = primitiveClasses();

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

/** Permissive hub stub: empty shapes keep every panel mounting. */
function hubFetch() {
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.startsWith("/api/autopilot/jobs")) return jsonResponse({ jobs: [] });
    if (url === "/api/autopilot") {
      return jsonResponse({
        running: false,
        killSwitch: false,
        limits: {
          maxPositionPct: 10.0,
          cashReservePct: 5.0,
          ordersPerDay: 10,
          drawdownAlertPct: 20.0,
          universe: "Default large caps/ETFs",
          riskProfile: "moderate",
        },
        recentVerdicts: [],
      });
    }
    if (url.startsWith("/api/autopilot/")) return jsonResponse({});
    if (url.startsWith("/api/broker/orders")) return jsonResponse({ trades: [], orders: [] });
    if (url.startsWith("/api/audit")) return jsonResponse({ items: [], entries: [] });
    if (url.startsWith("/api/adaptation/candidates")) return jsonResponse({ candidates: [], evaluations: [], verdicts: [], approvals: [] });
    if (url.startsWith("/api/adaptation/weights")) return jsonResponse({ weights: {}, evaluation: null });
    if (url.startsWith("/api/reports")) return jsonResponse({ reports: [] });
    if (url.startsWith("/api/etrade/oauth/status")) return jsonResponse({ connected: false });
    if (method === "POST" || method === "PUT") return jsonResponse({ success: true });
    return jsonResponse({});
  });
}

const CATALOG_PRODUCT = {
  id: "options:PayPerUse",
  family: "options",
  tier: "PayPerUse",
  canonicalName: "Options Screener",
  servingAgent: "trading",
  priceUSD: 0.05,
  priceSource: "gate",
  priceLabel: "$0.05 per call",
  availability: "purchasable",
  listed: true,
  unlistedReasons: [],
  parityVerdict: "parity",
  parityNotes: [],
  purchasePath: { label: "Pay per call", route: "/api/premium/options-scan", note: "" },
  purchasePathReason: null,
  realVsSimulated: "real (testnet)",
};

/** Standalone stub: the route fixtures, empty shapes elsewhere. */
function standaloneFetch() {
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url === "/api/products/catalog") {
      return jsonResponse({ products: [CATALOG_PRODUCT] });
    }
    if (url.startsWith("/api/audit")) {
      return jsonResponse({
        events: [
          {
            id: "e1",
            type: "test.event",
            agent: "orchestrator",
            payload: { job: 1 },
            created_at: "2026-10-27T09:00:00Z",
            resolvedAspects: null,
          },
        ],
      });
    }
    if (url === "/api/memory") {
      return jsonResponse({
        memories: [
          { key: "test-key", value: "test value", updatedAt: "2026-10-27T09:00:00Z" },
        ],
      });
    }
    if (url.startsWith("/api/workflow-runs")) return jsonResponse({ runs: [] });
    if (url === "/api/job-definitions") return jsonResponse({ definitions: [] });
    if (method === "POST" || method === "PUT") return jsonResponse({ success: true });
    return jsonResponse({});
  });
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let container: HTMLDivElement;
let root: Root | null = null;

async function mountRoute(id: string): Promise<"hub" | "standalone"> {
  const hub = HUB_ROUTES[id];
  if (hub) {
    window.history.pushState(null, "", hub.search);
    vi.stubGlobal("fetch", hubFetch());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ToastProvider>
          <TradeHub activeSubTab={hub.subTab as any} user={{ login: "alice" }} />
        </ToastProvider>,
      );
    });
    await flush();
    return "hub";
  }
  const Component = STANDALONE_ROUTES[id];
  if (!Component) throw new Error(`no mount wired for template route "${id}"`);
  window.history.pushState(null, "", STANDALONE_SEARCH[id] ?? `/?tab=${id}`);
  vi.stubGlobal("fetch", standaloneFetch());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <Component />
      </ToastProvider>,
    );
  });
  await flush();
  return "standalone";
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nextgen_autopilot_running", "false");
  Element.prototype.scrollIntoView = vi.fn() as any;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

describe("general composed-page gate (#4825)", () => {
  const routes = templateRoutes();
  expect(routes.length).toBeGreaterThan(0);

  for (const route of routes) {
    it(`${route.id} composes: one h1, one template shell, slots in order, one visible panel, no dead layout classes`, async () => {
      const { slotNames } = routeConformance(route.file);
      const host = await mountRoute(route.id);

      // Exactly one h1: the host crumb (hub) or the template title
      // (standalone) — never both, never a nested copy.
      const h1s = [...container.querySelectorAll("h1")].map(
        (h) => h.textContent?.trim() ?? "",
      );
      expect(h1s).toHaveLength(1);

      // Exactly one template shell: the template renders one
      // `.ui-page-shell`. A nested template under a retained sub-tab
      // (the order page's risk panel) renders a second Stack but NO
      // second shell — its PageShell collapses to body-only under
      // the host's "tab" chrome (the #3125 composition pattern) —
      // so the shell count, not the Stack count, is the no-doubling
      // invariant. Subtree checks use the FIRST (outermost) Stack.
      const shells = container.querySelectorAll(".ui-page-shell");
      expect(shells).toHaveLength(1);
      const stacks = container.querySelectorAll(
        ".ui-page-shell-sections > .ui-stack",
      );
      expect(stacks.length).toBeGreaterThan(0);
      const stack = stacks[0] as HTMLElement;
      const descendants = Array.from(stack.querySelectorAll("*"));
      const indexOf = (el: Element | null): number =>
        el === null ? -1 : descendants.indexOf(el);

      // Slots in canonical order. The workspace anchor is the first
      // section (or tablist) in the Stack: pre-workspace slots render
      // before it, post-workspace slots after it. A slot whose
      // organism marker is absent is data-dependent (the order quote
      // strip renders nothing without a quote) and is skipped — the
      // source rule already proves the slot is filled. A filled
      // kpiRibbon always renders (its items are counts), so a missing
      // ribbon is a violation. A filled queueRail / actionBar passed
      // as a PageSection (the order queue rail) has no organism
      // marker; its section must be a direct Stack child after the
      // workspace anchor.
      const anchor =
        stack.querySelector("section") ?? stack.querySelector('[role="tablist"]');
      const anchorIdx = indexOf(anchor);
      const found: { slot: string; idx: number }[] = [];
      const violations: string[] = [];
      for (const slot of CANONICAL_SLOTS) {
        if (!slotNames.includes(slot)) continue;
        const marker = stack.querySelector(SLOT_MARKER[slot]);
        if (marker) {
          found.push({ slot, idx: indexOf(marker) });
          continue;
        }
        if (slot === "contextStrip=") continue;
        if (slot === "kpiRibbon=") {
          violations.push(`${route.id}: kpiRibbon filled but no ribbon rendered`);
          continue;
        }
        // queueRail / actionBar as a PageSection: a direct-child
        // section after the workspace anchor.
        const directSections = Array.from(
          stack.querySelectorAll(":scope > section"),
        );
        const after = directSections.filter(
          (s) => anchorIdx === -1 || indexOf(s) > anchorIdx,
        );
        if (after.length === 0) {
          violations.push(
            `${route.id}: ${slot} filled but no slot section rendered after the workspace`,
          );
        }
      }
      for (let i = 1; i < found.length; i++) {
        if (
          CANONICAL_SLOTS.indexOf(found[i].slot as (typeof CANONICAL_SLOTS)[number]) <=
          CANONICAL_SLOTS.indexOf(found[i - 1].slot as (typeof CANONICAL_SLOTS)[number])
        ) {
          violations.push(
            `${route.id}: slots out of canonical order (${found.map((f) => f.slot).join(", ")})`,
          );
        }
      }
      for (const { slot, idx } of found) {
        if (anchorIdx === -1) continue;
        const before = slot === "contextStrip=" || slot === "kpiRibbon=";
        if (before && idx >= anchorIdx) {
          violations.push(`${route.id}: ${slot} rendered after the workspace`);
        }
        if (!before && idx <= anchorIdx) {
          violations.push(`${route.id}: ${slot} rendered before the workspace`);
        }
      }
      expect(violations).toEqual([]);

      // Exactly one visible sub-tab panel, when the page has tabs —
      // the active section. Inactive panels are hidden (retain) or
      // absent — either way only the active one is visible. (The
      // queue rail / context strip are slots, not tab sections, so
      // they do not count here.)
      if (container.querySelector('[role="tablist"]')) {
        const visible = container.querySelectorAll(
          '[role="tabpanel"]:not([hidden])',
        );
        expect(visible).toHaveLength(1);
      }

      // Rendered tabs == registry tabs (#6501): the route's tab strip
      // must show every registry view, in registry order, and nothing
      // else. The #6501 lone-tab collapse passed this gate with all
      // five Data Hub tabs in the DOM and none of them visible — the
      // panel assertion cannot see a missing or wrong strip. A
      // tablist with no ROUTE_TABS entry fails with "no registry tabs
      // wired". Labels come from the label span (`.ui-tab-label` /
      // `.capability-tab-label`), not the button text — icons and
      // badges ride on the button too.
      const tablist = container.querySelector('[role="tablist"]');
      if (tablist) {
        const expected = ROUTE_TABS[route.id];
        expect(
          expected,
          `${route.id}: tablist rendered but no registry tabs wired`,
        ).toBeDefined();
        const rendered = [...tablist.querySelectorAll('[role="tab"]')].map(
          (tab) =>
            tab.querySelector(".ui-tab-label, .capability-tab-label")
              ?.textContent?.trim() ?? tab.textContent?.trim() ?? "",
        );
        expect(rendered).toEqual([...(expected as readonly string[])]);
      }

      // Every section lives inside the template. Standalone pages are
      // the whole mount, so every section must be inside the outermost
      // Stack; hub pages share the mount with hub chrome (the OAuth
      // banner section), so only the sections inside the template's
      // own sections wrapper must be inside the Stack.
      const sections = Array.from(container.querySelectorAll("section"));
      const inner = stack.parentElement as HTMLElement;
      for (const section of sections) {
        if (host === "standalone") {
          expect(stack.contains(section)).toBe(true);
        } else if (inner.contains(section)) {
          expect(stack.contains(section)).toBe(true);
        }
      }

      // No dead layout class the route OWNS in the Stack subtree:
      // a class defined in a bespoke sheet, rendered by the route's
      // own files (its page plus dedicated components), and NOT a
      // class the `ui/` primitives render by design (the Tabs
      // primitive's `selected`, Card's `elevated` / `highlight`).
      // Classes from shared components (CapabilityNavBar, used by
      // eight hubs) and hub chrome are not the route's — their
      // migration is separate burn-down work, not this gate's
      // business. The S-U1 source gate owns per-file bespoke; this
      // check is the only one that sees a dedicated component's
      // classes (a component is not a surface).
      const owned = routeOwnedBespokeClasses(route.file);
      const dead: string[] = [];
      for (const el of [stack, ...descendants]) {
        for (const cls of Array.from(el.classList)) {
          if (owned.has(cls) && !PRIMITIVE.has(cls)) dead.push(cls);
        }
      }
      expect([...new Set(dead)].sort()).toEqual([]);
    });
  }
});
