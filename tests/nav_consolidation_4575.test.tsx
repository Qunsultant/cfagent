/** @vitest-environment jsdom */
/**
 * Issue #4575 — nav consolidation round 2.
 *
 * Composition + data pins for the four moves:
 *  1. the Workflows menu loses its "Workflow Runs" entry (the Schedules
 *     "Run ledger" is the one home; the `?tab=workflow-runs` address still
 *     folds onto it through legacySchedulesRedirect);
 *  2. every Workflow Catalog section becomes its own URL-synced sub-tab
 *     (`?tab=workflow-catalog&view=workflows|define`);
 *  3. audit + NLQ become the two sub-tabs of one "Audit & Vault" menu
 *     (`?tab=audit-vault&view=audit|nlq`), and the retired addresses
 *     redirect onto those views;
 *  4. Platform Admin drops the free-runs/products sections the product hub
 *     already owns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import navData from "../src/client/nav-config.json";
import { legacyAuditVaultRedirect, legacyProductRedirect } from "../src/client/router";
import { legacySchedulesRedirect } from "../src/client/schedulesHomeView";
import { AuditVaultPage } from "../src/client/AuditVaultPage";
import { WorkflowCatalogPage } from "../src/client/WorkflowCatalogPage";
import { DEFAULT_LEFT_NAV_CONFIG, SUB_MENU_CONFIGS } from "../src/client/navConfig";
import { PLATFORM_ADMIN_TABS } from "../src/client/PlatformAdminPage";
import { DEFAULT_PLATFORM_ADMIN_CONFIG } from "../src/client/platformAdminConfig";
import { DEEP_LINK_OVERRIDES, SURFACE_TAB_DEFS, SURFACE_TAB_CATALOG } from "../src/client/deepLinks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routes = navData.routes as { id: string; navEntry?: { navOrder: number } }[];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ events: [], memories: [], tables: [] })),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode) {
  await act(async () => {
    root = createRoot(container);
    root.render(<>{node}</>);
  });
}

// --------------------------------------------------------------------------
// 1. The Workflows menu
// --------------------------------------------------------------------------
describe("Workflows menu (#4575)", () => {
  it("has no Workflow Runs entry; the Schedules ledger is the one home", () => {
    const ids = SUB_MENU_CONFIGS["workflow-runs"].map((s) => s.id);
    expect(ids).not.toContain("workflow-runs");
    expect(ids).toEqual(["docs", "workflows", "workflow-catalog", "reports", "review", "track-record"]);
    // The host route stays — removing it would delete the whole menu.
    expect(routes.map((r) => r.id)).toContain("workflow-runs");
    const ledger = SUB_MENU_CONFIGS.schedules.map((s) => s.id);
    expect(ledger).toContain("runs");
  });

  it("keeps old ?tab=workflow-runs links landing on the ledger with the workflow filter", () => {
    expect(legacySchedulesRedirect("?tab=workflow-runs")).toEqual({
      tab: "schedules",
      view: "runs",
      params: { kind: "workflow" },
    });
  });
});

// --------------------------------------------------------------------------
// 2. Workflow Catalog sub-tabs
// --------------------------------------------------------------------------
describe("Workflow Catalog sub-tabs (#4575)", () => {
  it("publishes one deep link and one surface value per section", () => {
    expect(DEEP_LINK_OVERRIDES["workflow-catalog:workflows"]).toEqual({
      tab: "workflow-catalog",
      view: "workflows",
    });
    expect(DEEP_LINK_OVERRIDES["workflow-catalog:define"]).toEqual({
      tab: "workflow-catalog",
      view: "define",
    });
    const surface = SURFACE_TAB_DEFS.find((s) => s.surface === "workflow-catalog");
    expect(surface?.values).toEqual(["workflows", "define"]);
    expect(
      SURFACE_TAB_CATALOG.filter((e) => e.surface === "workflow-catalog").map((e) => e.value),
    ).toEqual(["workflows", "define"]);
    expect(SUB_MENU_CONFIGS["workflow-catalog"].map((s) => s.id)).toEqual(["workflows", "define"]);
  });

  it("renders exactly the section its view names — workflows", async () => {
    window.history.pushState({}, "", "/?tab=workflow-catalog&view=workflows");
    await mount(<WorkflowCatalogPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("Declared once in the workflow registry");
    expect(text).not.toContain("A definition is a validated spec");
  });

  it("renders exactly the section its view names — define", async () => {
    window.history.pushState({}, "", "/?tab=workflow-catalog&view=define");
    await mount(<WorkflowCatalogPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("A definition is a validated spec");
    expect(text).not.toContain("Declared once in the workflow registry");
  });
});

// --------------------------------------------------------------------------
// 3. Audit & Vault
// --------------------------------------------------------------------------
describe("Audit & Vault menu (#4575)", () => {
  it("is one nav host with the two former top-level entries as sub-tabs", () => {
    const ids = routes.map((r) => r.id);
    expect(ids).toContain("audit-vault");
    expect(ids).not.toContain("audit");
    expect(ids).not.toContain("nlq");
    expect(SUB_MENU_CONFIGS["audit-vault"].map((s) => s.id)).toEqual(["audit", "nlq"]);
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    const host = platform?.items.find((i) => i.id === "audit-vault");
    expect(host?.subItems?.map((s) => s.id)).toEqual(["audit", "nlq"]);
  });

  it("publishes a deep link and a surface value per view", () => {
    expect(DEEP_LINK_OVERRIDES["audit-vault:audit"]).toEqual({ tab: "audit-vault", view: "audit" });
    expect(DEEP_LINK_OVERRIDES["audit-vault:nlq"]).toEqual({ tab: "audit-vault", view: "nlq" });
    const surface = SURFACE_TAB_DEFS.find((s) => s.surface === "audit-vault");
    expect(surface?.values).toEqual(["audit", "nlq"]);
    expect(
      SURFACE_TAB_CATALOG.filter((e) => e.surface === "audit-vault").map((e) => e.value),
    ).toEqual(["audit", "nlq"]);
  });

  it("redirects both retired addresses onto the matching view", () => {
    expect(legacyAuditVaultRedirect("?tab=audit")).toEqual({ tab: "audit-vault", view: "audit" });
    expect(legacyAuditVaultRedirect("?tab=nlq")).toEqual({ tab: "audit-vault", view: "nlq" });
    expect(legacyAuditVaultRedirect("?tab=order&orderTab=stock")).toBeNull();
  });

  it("renders the audit view's two sections only", async () => {
    window.history.pushState({}, "", "/?tab=audit-vault&view=audit");
    await mount(<AuditVaultPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("Persistent Memory Vault");
    expect(text).toContain("Real-time Event Log");
    expect(text).not.toContain("RECORD EXPLORER");
  });

  it("renders the NLQ view's query + explorer only", async () => {
    window.history.pushState({}, "", "/?tab=audit-vault&view=nlq");
    await mount(<AuditVaultPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("RECORD EXPLORER");
    expect(text).toContain("Ask in Chat");
    expect(text).not.toContain("Persistent Memory Vault");
  });

  it("defaults to the audit view when the URL names no view", async () => {
    window.history.pushState({}, "", "/?tab=audit-vault");
    await mount(<AuditVaultPage />);
    expect(container.textContent ?? "").toContain("Persistent Memory Vault");
  });
});

// --------------------------------------------------------------------------
// 4. Platform Admin dedup
// --------------------------------------------------------------------------
describe("Platform Admin dedup (#4575)", () => {
  it("holds 8 sections: no free-runs, no products, no moved hub sections (#4585), plus nav-config (#6151 S4)", () => {
    const configIds = DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items.map((i) => i.id);
    expect(configIds).toHaveLength(8);
    expect(configIds).not.toContain("free-runs");
    expect(configIds).not.toContain("products");
    // Issue #4585 moved six sections into the DataHub and SecurityHub hubs.
    for (const id of ["data-providers", "data-lifecycle", "downloads", "iaaa-admin", "users", "admin-access"]) {
      expect(configIds).not.toContain(id);
    }
    const tabIds = PLATFORM_ADMIN_TABS.map((t) => t.id);
    expect(tabIds).toHaveLength(8);
    expect(tabIds).not.toContain("free-runs");
    expect(tabIds).not.toContain("products");
  });

  it("leaves both views with the product hub, which the redirects still reach", () => {
    const hub = SUB_MENU_CONFIGS["product-hub"].map((s) => s.id);
    expect(hub).toContain("admin-products");
    expect(hub).toContain("free-runs");
    expect(legacyProductRedirect("?tab=platform-admin&view=free-runs")).toEqual({
      tab: "product-hub",
      view: "free-runs",
    });
    expect(legacyProductRedirect("?tab=platform-admin&view=products")).toEqual({
      tab: "product-hub",
      view: "admin-products",
    });
  });
});
