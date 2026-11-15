/** @vitest-environment jsdom */
/**
 * Issue #4629 (S4 of #4625): distinct URLs for the four unlisted
 * surfaces — Search Hub, Payment Assurance, Chat copilot sub-views,
 * and the Schedules sections.
 *
 * Each surface gets a surface-tab definition (deepLinkSurfaces), and
 * the hub surfaces get left-nav sub-menu entries + deep-link keys, so
 * every inner tab has its own distinct, shareable URL. The chat
 * surface is generated from the copilot registry at runtime (a new
 * registration gets its URL automatically); the schedules sections
 * are owned by the `section` param, scoped to the schedules home.
 *
 * The risk inner tabs are already covered (out of scope here, issue
 * body): the risk-analysis surface exists, `riskTab` is owned by the
 * order page, and the retired risk address carries the param through
 * — the last describe pins that so a future slice cannot silently
 * drop it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import navData from "../src/client/nav-config.json";
import { buildSearchWithTab, TAB_PARAM_OWNERS } from "../src/client/router";
import {
  buildSurfaceTabCatalog,
  chatSurfaceTabDef,
  deepLinkForNavNode,
  getSurfaceTabDefs,
  SURFACE_TAB_DEFS,
  surfaceTabHref,
} from "../src/client/deepLinks";
import {
  getRegisteredCopilots,
  registerCopilot,
} from "../src/client/chat/copilotRegistry";
import { SearchHub } from "../src/client/search/SearchHub";
import { PaymentWorkflowAssurance } from "../src/client/PaymentWorkflowAssurance";
import { ScheduledGoalsPanel } from "../src/client/ScheduledGoalsPanel";
import { AdminQueueWipePanel } from "../src/client/AdminQueueWipePanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const surfaces = navData.deepLinkSurfaces as {
  surface: string;
  page: string | null;
  pageView?: string;
  param: string;
  values: string[];
}[];

function surface(name: string) {
  const found = surfaces.find((s) => s.surface === name);
  if (!found) throw new Error(`surface ${name} missing`);
  return found;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  if (container && container.parentNode) container.parentNode.removeChild(container);
  root = null;
  container = null;
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function visiblePanel(id: string): Element | null {
  const panel = container?.querySelector(`#${id}`) ?? null;
  if (panel && panel.hasAttribute("hidden")) return null;
  return panel;
}

function activeTabLabel(): string | null {
  const active = container?.querySelector('[aria-selected="true"]');
  return active?.textContent?.trim() ?? null;
}

describe("Search Hub surface (#4629)", () => {
  it("catalogs the nine search tabs as a surface", () => {
    expect(surface("search")).toMatchObject({
      page: "search",
      param: "view",
      values: [
        "nlq",
        "search-agent",
        "ai-search-agent",
        "semantic-search",
        "memory",
        "knowledge",
        "tools",
        "mas-search",
        "corpus",
      ],
    });
    // The static defs stay the JSON list; the chat surface is the only
    // runtime addition (see the chat describe below).
    expect(SURFACE_TAB_DEFS.find((d) => d.surface === "search")).toBeDefined();
    expect(surfaceTabHref(SURFACE_TAB_DEFS.find((d) => d.surface === "search")!, "memory")).toBe(
      "?tab=search&view=memory",
    );
  });

  it("gives the hub a sub-menu entry per tab, each resolving to its own URL", () => {
    const items = (navData.subMenus as Record<string, { id: string; label: string }[]>).search;
    expect(items.map((i) => i.id)).toEqual([
      "nlq",
      "search-agent",
      "ai-search-agent",
      "semantic-search",
      "memory",
      "knowledge",
      "tools",
      "mas-search",
      "corpus",
    ]);
    for (const id of items.map((i) => i.id)) {
      expect(deepLinkForNavNode("search", id)).toEqual({ tab: "search", view: id });
    }
  });

  it("fresh load of ?tab=search&view=memory lands on Memory, not NLQ", async () => {
    window.history.replaceState(null, "", "/?tab=search&view=memory");
    await act(async () => {
      root?.render(<SearchHub />);
    });
    expect(visiblePanel("search-tabpanel-memory")).not.toBeNull();
    expect(visiblePanel("search-tabpanel-nlq")).toBeNull();
    expect(activeTabLabel()).toContain("Memory");
  });

  it("bare ?tab=search still lands on NLQ (the default)", async () => {
    window.history.replaceState(null, "", "/?tab=search");
    await act(async () => {
      root?.render(<SearchHub />);
    });
    expect(visiblePanel("search-tabpanel-nlq")).not.toBeNull();
    expect(visiblePanel("search-tabpanel-memory")).toBeNull();
  });
});

describe("Payment Assurance surface (#4629)", () => {
  it("catalogs the four assurance tabs as a surface", () => {
    expect(surface("payment-assurance")).toMatchObject({
      page: "payment-assurance",
      param: "view",
      values: ["simulation", "live", "prices", "operators"],
    });
    expect(
      surfaceTabHref(SURFACE_TAB_DEFS.find((d) => d.surface === "payment-assurance")!, "operators"),
    ).toBe("?tab=payment-assurance&view=operators");
  });

  // The four sub-menu entries below are catalog data: Payment
  // Assurance is itself a sub-menu entry of Payments, and LeftNavBar
  // renders one sub-item level, so they never render as left-nav
  // nodes. The page's own tab bar is the navigation; the entries exist
  // so the tabs are addressable through the deep-link keys.
  it("gives the page a sub-menu entry per tab, each resolving to its own URL", () => {
    const items = (navData.subMenus as Record<string, { id: string; label: string }[]>)[
      "payment-assurance"
    ];
    expect(items.map((i) => i.id)).toEqual(["simulation", "live", "prices", "operators"]);
    expect(items.map((i) => i.label)).toEqual([
      "Simulator & Presets",
      "Live Workflow",
      "Store Prices",
      "Store Operators",
    ]);
    for (const id of items.map((i) => i.id)) {
      expect(deepLinkForNavNode("payment-assurance", id)).toEqual({
        tab: "payment-assurance",
        view: id,
      });
    }
  });

  it("fresh load of ?tab=payment-assurance&view=operators lands on Store Operators", async () => {
    window.history.replaceState(null, "", "/?tab=payment-assurance&view=operators");
    await act(async () => {
      root?.render(<PaymentWorkflowAssurance />);
    });
    const tab = container?.querySelector("#payment-assurance-tab-operators");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(visiblePanel("payment-assurance-panel-operators")).not.toBeNull();
    expect(visiblePanel("payment-assurance-panel-simulation")).toBeNull();
  });

  it("bare ?tab=payment-assurance still lands on simulation (the default)", async () => {
    window.history.replaceState(null, "", "/?tab=payment-assurance");
    await act(async () => {
      root?.render(<PaymentWorkflowAssurance />);
    });
    const tab = container?.querySelector("#payment-assurance-tab-simulation");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(visiblePanel("payment-assurance-panel-simulation")).not.toBeNull();
  });
});

describe("Chat copilot surface, generated from the registry (#4629)", () => {
  it("reads its values from the registry, not a static list", () => {
    const def = chatSurfaceTabDef();
    expect(def).toMatchObject({ surface: "chat", page: "chat", param: "view" });
    expect(def.values).toEqual(getRegisteredCopilots().map((c) => c.id));
    expect(def.values).toEqual(["general", "options", "stock", "biz"]);
    // The static JSON defs stay JSON-verbatim: chat is runtime-only.
    expect(SURFACE_TAB_DEFS.find((d) => d.surface === "chat")).toBeUndefined();
    expect(getSurfaceTabDefs().find((d) => d.surface === "chat")).toBeDefined();
  });

  it("mints one catalog entry per copilot, each with its own href", () => {
    const entries = buildSurfaceTabCatalog().filter((e) => e.surface === "chat");
    expect(entries.map((e) => e.value)).toEqual(["general", "options", "stock", "biz"]);
    for (const entry of entries) {
      expect(entry.key).toBe(`chat:view:${entry.value}`);
      expect(entry.href).toBe(`?tab=chat&view=${entry.value}`);
    }
  });

  it("a new registration gets its URL automatically, and unregisters cleanly", () => {
    const unregister = registerCopilot({
      id: "test-copilot",
      label: "Test Copilot",
      tooltip: {
        eyebrow: "Test",
        title: "Test Copilot",
        description: "A registration added by the S4 pin test.",
      },
      mode: "chat",
    });
    try {
      const entries = buildSurfaceTabCatalog().filter((e) => e.surface === "chat");
      expect(entries.map((e) => e.value)).toContain("test-copilot");
      const entry = entries.find((e) => e.value === "test-copilot")!;
      expect(entry.href).toBe("?tab=chat&view=test-copilot");
      expect(chatSurfaceTabDef().values).toContain("test-copilot");
    } finally {
      unregister();
    }
    expect(buildSurfaceTabCatalog().filter((e) => e.surface === "chat").map((e) => e.value)).not.toContain(
      "test-copilot",
    );
    expect(chatSurfaceTabDef().values).not.toContain("test-copilot");
  });
});

describe("Schedules sections (#4629)", () => {
  it("owns the section param, scoped to the schedules home", () => {
    expect(TAB_PARAM_OWNERS.section).toEqual(["schedules"]);
    expect(buildSearchWithTab("?tab=schedules&view=goals&section=add", "schedules")).toBe(
      "?tab=schedules&view=goals&section=add",
    );
    // A tab change drops `section` (schedules-owned) while `view` — the
    // shared sub-view param — is carried to the new tab.
    expect(buildSearchWithTab("?tab=schedules&view=goals&section=add", "portfolio")).toBe(
      "?tab=portfolio&view=goals",
    );
  });

  it("catalogs the goals sections under their view", () => {
    expect(surface("schedules-goals")).toMatchObject({
      page: "schedules",
      pageView: "goals",
      param: "section",
      values: ["goals", "add", "resources", "seed", "ticks", "runs"],
    });
    expect(surfaceTabHref(SURFACE_TAB_DEFS.find((d) => d.surface === "schedules-goals")!, "add")).toBe(
      "?tab=schedules&view=goals&section=add",
    );
  });

  it("catalogs the queue sections under their view", () => {
    expect(surface("schedules-queue")).toMatchObject({
      page: "schedules",
      pageView: "queue",
      param: "section",
      values: ["queue", "cancel", "wipe", "recreate"],
    });
    expect(surfaceTabHref(SURFACE_TAB_DEFS.find((d) => d.surface === "schedules-queue")!, "wipe")).toBe(
      "?tab=schedules&view=queue&section=wipe",
    );
  });

  it("fresh load of the goals ticks section lands on Ticks, not Goals", async () => {
    (globalThis as any).fetch = vi.fn(async (path: string) => {
      if (path === "/api/schedule/goals") return jsonResponse({ ok: true, goals: [] });
      if (path.startsWith("/api/schedule/ticks")) return jsonResponse({ ok: true, ticks: [] });
      if (path === "/api/schedule/operations")
        return jsonResponse({ ok: true, operations: [] });
      if (path.startsWith("/api/ledger/runs")) return jsonResponse({ ok: true, runs: [] });
      return jsonResponse({ ok: false, error: "not found" }, 404);
    });
    window.history.replaceState(null, "", "/?tab=schedules&view=goals&section=ticks");
    await act(async () => {
      root?.render(<ScheduledGoalsPanel />);
    });
    await act(async () => {});
    expect(visiblePanel("schedules-goals-panel-ticks")).not.toBeNull();
    expect(visiblePanel("schedules-goals-panel-goals")).toBeNull();
    const tab = container?.querySelector("#schedules-goals-tab-ticks");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
  });

  it("fresh load of the queue wipe section lands on Wipe, not the dump", async () => {
    (globalThis as any).fetch = vi.fn(async () => jsonResponse({ ok: false, error: "not found" }, 404));
    window.history.replaceState(null, "", "/?tab=schedules&view=queue&section=wipe");
    await act(async () => {
      root?.render(<AdminQueueWipePanel />);
    });
    await act(async () => {});
    expect(visiblePanel("schedules-queue-panel-wipe")).not.toBeNull();
    expect(visiblePanel("schedules-queue-panel-queue")).toBeNull();
    const tab = container?.querySelector("#schedules-queue-tab-wipe");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Risk inner tabs are already addressable (out of scope, pinned here)", () => {
  it("the risk-analysis surface already catalogs the four inner tabs", () => {
    expect(surface("risk-analysis")).toMatchObject({
      page: null,
      param: "riskTab",
      values: ["anatomy", "playbook", "scenarios", "ai"],
    });
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "risk-analysis")!;
    expect(surfaceTabHref(def, "playbook", "order")).toBe("?tab=order&riskTab=playbook");
  });

  it("the panel reads riskTab from the URL, and the param is owned by order", () => {
    const src = read("src/client/RiskAnalysisPanel.tsx");
    expect(src).toContain('param: "riskTab"');
    expect(TAB_PARAM_OWNERS.riskTab).toEqual(["order"]);
    expect(buildSearchWithTab("?tab=order&orderTab=risk&riskTab=playbook", "portfolio")).toBe(
      "?tab=portfolio",
    );
  });
});
