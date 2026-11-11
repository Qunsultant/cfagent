/** @vitest-environment jsdom */
/**
 * Issue #3978: Data Providers multi-tab view — overview + per-provider
 * tabs + Add provider tab, URL-synced through `?providerTab=`.
 *
 * Harness follows the established panel tests (data_providers_panel_e4):
 * the REAL apiFetch is driven against a stubbed global fetch; the
 * component renders with react-dom/client in jsdom. Tab switching is
 * the shared Tabs primitive + useUrlSyncedTabs behavior, asserted
 * end to end: the strip, the deep link, the unknown-value fallback,
 * back/forward adoption via the route subscription, and the moved
 * register form.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import type { CapabilityRouteView, DataProviderView } from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ETRADE: DataProviderView = {
  id: "etrade",
  adapterKind: "etrade-rest",
  lifecycleState: "enabled",
  enabled: true,
  precedence: 1,
  credentialRef: "sessionstore:etrade:token",
  config: { displayName: "E*TRADE" },
  createdAt: "2026-10-23T09:00:00.000Z",
  updatedAt: "2026-10-23T10:30:00.000Z",
  declaredCapabilities: ["quotes", "optionsChains"],
  verification: {
    verifiedAt: "2026-10-23T10:30:00.000Z",
    summary: "E*TRADE adapter status ok; conformance kit passed.",
    verifiedBy: "admin_trader",
  },
  serving: true,
};

const YAHOO: DataProviderView = {
  id: "yahoo",
  adapterKind: "yahoo",
  lifecycleState: "configured",
  enabled: false,
  precedence: 2,
  credentialRef: "env:YAHOO_API_KEY",
  config: {},
  createdAt: "2026-10-23T09:05:00.000Z",
  updatedAt: "2026-10-23T09:05:00.000Z",
  declaredCapabilities: ["quotes"],
  verification: null,
  serving: false,
};

const ROUTES: CapabilityRouteView[] = [
  {
    capability: "quotes",
    primaryProviderId: "etrade",
    gapFillProviderId: "yahoo",
    resolves: true,
    resolvedPrimaryId: "etrade",
    resolvedGapFillId: "yahoo",
  },
];

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

function installFetch(providers: DataProviderView[], listStatus = 200) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.includes("/api/etrade/oauth/status")) {
      return Response.json({ authenticated: false, tokenScopes: null }, { status: 200 });
    }
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/data-providers")) {
      return Response.json({ providers, routes: ROUTES }, { status: listStatus });
    }
    if (method === "POST" && url.includes("/api/data-providers/")) {
      return Response.json({ provider: {} }, { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 800)}`);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ToastProvider, null, React.createElement(DataProvidersPanel)));
  });
  await flush(60);
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

function tabLabels(): string[] {
  return tabButtons().map((b) => b.textContent ?? "");
}

function selectedTabLabel(): string | null {
  const selected = container.querySelector('[role="tab"][aria-selected="true"]');
  return selected?.textContent ?? null;
}

function tableHeaders(): string[] {
  const table = container.querySelector("table.dpp-table");
  if (!table) return [];
  return Array.from(table.querySelectorAll("th")).map((th) => th.textContent?.trim() ?? "");
}

async function clickTab(label: string) {
  const btn = tabButtons().find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`No tab "${label}". Tabs: ${tabLabels().join(", ")}`);
  await act(async () => {
    btn.click();
  });
  await flush(60);
}

async function setInputValue(id: string, value: string) {
  const input = container.querySelector(`#${CSS.escape(id)}`) as HTMLInputElement | null;
  if (!input) throw new Error(`No input #${id}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(20);
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Panel tabs are URL-synced, so a tab click in one test writes
  // ?providerTab= into the shared jsdom URL and would leak into the
  // next test's initial tab. Every test starts from a clean URL,
  // unless it sets a deep link on purpose before rendering.
  window.history.replaceState(null, "", "/");
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

describe("DataProvidersPanel tabs (issue #3978)", () => {
  it("renders Overview + one tab per provider + Add, starting on Overview", async () => {
    installFetch([ETRADE, YAHOO]);
    await renderPanel();
    await waitForText("E*TRADE");

    expect(tabLabels()).toEqual(["Overview", "E*TRADE", "yahoo", "Add provider"]);
    expect(selectedTabLabel()).toBe("Overview");
    // Overview: the summary columns only, one row per provider.
    expect(tableHeaders()).toEqual(["Provider", "Lifecycle & State", "Health & Telemetry"]);
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(2);
  });

  it("the overview provider name is a deep link to that provider's tab", async () => {
    installFetch([ETRADE, YAHOO]);
    await renderPanel();
    await waitForText("E*TRADE");

    const link = container.querySelector("a.ui-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("E*TRADE");
    expect(link?.getAttribute("href")).toBe(
      "/?tab=platform-admin&view=data-providers&providerTab=etrade",
    );

    await act(async () => {
      link!.click();
    });
    await flush(60);
    expect(selectedTabLabel()).toBe("E*TRADE");
    expect(window.location.search).toContain("providerTab=etrade");
    // The provider tab shows the full detail table, one row.
    expect(tableHeaders()).toEqual([
      "Provider",
      "Lifecycle & State",
      "Health & Telemetry",
      "Feed Jobs",
      "Enrich Jobs",
      "Analyze Jobs",
      "Generate Jobs",
      "Deliver Jobs",
      "Pipeline",
      "Capabilities & Routes",
      "Connectivity & Session",
      "Actions",
    ]);
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(1);
    expect(container.textContent).toContain("Gap-fill: yahoo");
  });

  it("a ?providerTab= deep link opens that provider's tab on load", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=platform-admin&view=data-providers&providerTab=yahoo",
    );
    installFetch([ETRADE, YAHOO]);
    await renderPanel();
    await waitForText("yahoo");

    expect(selectedTabLabel()).toBe("yahoo");
    expect(tableHeaders()).toContain("Capabilities & Routes");
    expect(container.querySelector('[data-provider-id="yahoo"]')).not.toBeNull();
  });

  it("an unknown ?providerTab= falls back to Overview, never a broken tab", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=platform-admin&view=data-providers&providerTab=nope",
    );
    installFetch([ETRADE, YAHOO]);
    await renderPanel();
    await waitForText("E*TRADE");

    expect(selectedTabLabel()).toBe("Overview");
    expect(tableHeaders()).toEqual(["Provider", "Lifecycle & State", "Health & Telemetry"]);
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(2);
  });

  it("back/forward adopts the URL: a popstate to Overview, then back to the provider tab", async () => {
    installFetch([ETRADE, YAHOO]);
    await renderPanel();
    await waitForText("E*TRADE");
    await clickTab("yahoo");
    expect(selectedTabLabel()).toBe("yahoo");
    expect(window.location.search).toContain("providerTab=yahoo");

    // Back: the URL loses the param; the subscription re-reads it.
    window.history.replaceState(null, "", "/?tab=platform-admin&view=data-providers");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush(60);
    expect(selectedTabLabel()).toBe("Overview");

    // Forward: the URL regains the param; the tab follows.
    window.history.replaceState(
      null,
      "",
      "/?tab=platform-admin&view=data-providers&providerTab=yahoo",
    );
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush(60);
    expect(selectedTabLabel()).toBe("yahoo");
  });

  it("the Add tab holds the register form, and registering still POSTs and re-fetches", async () => {
    const calls = installFetch([]);
    await renderPanel();
    await waitForText("No data providers configured");

    // The form is not on the overview.
    expect(container.querySelector("#dpp-register-id")).toBeNull();
    await clickTab("Add provider");
    expect(container.querySelector("#dpp-register-id")).not.toBeNull();

    await setInputValue("dpp-register-id", "alpaca");
    await setInputValue("dpp-register-precedence", "3");
    const registerBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Register provider",
    ) as HTMLButtonElement;
    await act(async () => {
      registerBtn.click();
    });
    await flush(60);

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/data-providers/alpaca/register");
    expect(post?.body).toEqual({ precedence: 3 });
    expect(calls[calls.length - 1]).toMatchObject({ method: "GET", url: "/api/data-providers" });
  });

  it("when signed out the Add tab shows the sign-in state, not the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/etrade/oauth/status")) {
          return Response.json({ authenticated: false, tokenScopes: null }, { status: 200 });
        }
        if (url.endsWith("/api/data-providers")) {
          return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
        }
        throw new Error(`unstubbed fetch: ${url}`);
      }),
    );
    await renderPanel();
    await waitForText("Sign-in required");
    await clickTab("Add provider");
    expect(container.textContent).toContain("Sign-in required");
    expect(container.querySelector("#dpp-register-id")).toBeNull();
  });
});
