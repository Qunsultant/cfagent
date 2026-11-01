/** @vitest-environment jsdom */
/**
 * Issue #1180 (E4 of epic #1116): Data Providers admin panel — the
 * Settings surface over the E3 lifecycle API (issue #1170,
 * src/agents/routes/dataProviders.ts).
 *
 * Harness follows the established panel tests (agentic_wallet_panel /
 * api-keys idiom): the REAL apiFetch is driven against a stubbed
 * global fetch; the component renders with react-dom/client in jsdom.
 *
 * Pins:
 *  - rendering is field-for-field from the API response: the panel
 *    computes no servability of its own — state, enabled, credential
 *    reference, precedence, verification evidence, declared
 *    capabilities, and the per-capability routes view all render
 *    exactly as served;
 *  - honest states: explicit empty state (never placeholder rows),
 *    the server's error message verbatim on failure, and a distinct
 *    sign-in-required state on 401;
 *  - action wiring: each action POSTs the exact E3 URL (+ JSON body
 *    for configure/register) and then re-fetches the list;
 *  - the affordance matrix matches the lifecycle map the E3 service
 *    enforces (register/configure/verify/enable/disable/deprovision
 *    legality, including disabled→enable only with verification
 *    evidence), and deprovision needs its confirm step before any
 *    POST is issued.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataProvidersPanel } from "../src/client/DataProvidersPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  providerActions,
  providerDisplayName,
  type CapabilityRouteView,
  type DataProviderView,
} from "../src/client/dataProvidersApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures typed against the client view of the real E3 response
// (providerView in src/agents/routes/dataProviders.ts) so a backend
// shape change breaks these tests on purpose.
const VERIFICATION = {
  verifiedAt: "2026-10-23T10:30:00.000Z",
  summary: "E*TRADE adapter status ok; conformance kit passed.",
  verifiedBy: "admin_trader",
};

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
  verification: VERIFICATION,
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
  {
    capability: "optionsChains",
    primaryProviderId: "etrade",
    gapFillProviderId: null,
    resolves: false,
    resolvedPrimaryId: null,
    resolvedGapFillId: null,
    error: "provider etrade is not enabled for optionsChains",
  },
];

function providerInState(
  state: string,
  verification: DataProviderView["verification"] = null
): DataProviderView {
  return {
    ...YAHOO,
    id: "nasdaq",
    adapterKind: "nasdaq",
    lifecycleState: state,
    enabled: state === "enabled",
    verification,
  };
}

// Fetch stub -----------------------------------------------------------------

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface StubOptions {
  list?: { providers: DataProviderView[]; routes: CapabilityRouteView[] };
  listStatus?: number;
  listBody?: unknown;
  /** Raw (non-JSON) body, e.g. an edge error page (issue #2624 fix-up). */
  listRawBody?: string;
  actionStatus?: number;
  actionBody?: unknown;
}

function installFetch(opts: StubOptions) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/data-providers")) {
      if (opts.listRawBody !== undefined) {
        return new Response(opts.listRawBody, {
          status: opts.listStatus ?? 200,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json(opts.listBody ?? opts.list ?? { providers: [], routes: [] }, {
        status: opts.listStatus ?? 200,
      });
    }
    if (method === "POST" && url.includes("/api/data-providers/")) {
      return Response.json(opts.actionBody ?? { provider: {} }, {
        status: opts.actionStatus ?? 200,
      });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

// DOM helpers ----------------------------------------------------------------

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

function providerItem(id: string): Element {
  const item = container.querySelector(`[data-provider-id="${id}"]`);
  if (!item) throw new Error(`No provider item rendered for "${id}". Panel: ${container.textContent?.slice(0, 500)}`);
  return item;
}

function buttonWithText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  );
  if (!btn) {
    throw new Error(`No button "${text}". Buttons: ${[...scope.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(", ")}`);
  }
  return btn as HTMLButtonElement;
}

async function click(scope: ParentNode, text: string) {
  const btn = buttonWithText(scope, text);
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

// Affordance matrix (pure helper, mirrors the E3 lifecycle map) ---------------

describe("providerActions affordance matrix (issue #1180, map from #1170)", () => {
  it("offers exactly the legal actions per lifecycle state", () => {
    expect(providerActions(providerInState("registered"))).toEqual(["configure", "deprovision"]);
    expect(providerActions(providerInState("configured"))).toEqual(["configure", "verify", "deprovision"]);
    expect(providerActions(providerInState("verified", VERIFICATION))).toEqual(["enable", "deprovision"]);
    expect(providerActions(providerInState("enabled", VERIFICATION))).toEqual(["disable", "deprovision"]);
    expect(providerActions(providerInState("deprovisioned"))).toEqual([]);
  });

  it("offers enable from disabled only with verification evidence on the record", () => {
    expect(providerActions(providerInState("disabled", VERIFICATION))).toEqual(["enable", "deprovision"]);
    expect(providerActions(providerInState("disabled", null))).toEqual(["deprovision"]);
  });

  it("display name comes from config.displayName when present, else the id", () => {
    expect(providerDisplayName(ETRADE)).toBe("E*TRADE");
    expect(providerDisplayName(YAHOO)).toBe("yahoo");
  });
});

// Rendering -------------------------------------------------------------------

describe("DataProvidersPanel rendering (issue #1180)", () => {
  it("renders each provider field-for-field from the API response, incl. routes", async () => {
    installFetch({ list: { providers: [ETRADE, YAHOO], routes: ROUTES } });
    await renderPanel();
    await waitForText("E*TRADE");

    const etrade = providerItem("etrade");
    const etext = etrade.textContent || "";
    expect(etext).toContain("E*TRADE");
    expect(etext).toContain("etrade");
    expect(etext).toContain("etrade-rest");
    expect(etext).toContain("enabled");
    expect(etext).toContain("Enabled");
    expect(etext).toContain("sessionstore:etrade:token");
    expect(etext).toContain("Precedence: 1");
    expect(etext).toContain("quotes");
    expect(etext).toContain("optionsChains");
    expect(etext).toContain("E*TRADE adapter status ok; conformance kit passed.");
    expect(etext).toContain("admin_trader");
    expect(etext).toContain("Serving: Yes");
    // Routes involving etrade: capability, primary/gap-fill, resolves.
    expect(etext).toContain("quotes");
    expect(etext).toContain("Primary: etrade");
    expect(etext).toContain("Gap-fill: yahoo");
    expect(etext).toContain("Resolves: Yes");
    expect(etext).toContain("Resolves: No");
    expect(etext).toContain("provider etrade is not enabled for optionsChains");

    const yahoo = providerItem("yahoo");
    const ytext = yahoo.textContent || "";
    expect(ytext).toContain("yahoo");
    expect(ytext).toContain("configured");
    expect(ytext).toContain("Disabled");
    expect(ytext).toContain("env:YAHOO_API_KEY");
    expect(ytext).toContain("Precedence: 2");
    expect(ytext).toContain("Not verified");
    expect(ytext).toContain("Serving: No");
    expect(ytext).toContain("Gap-fill: yahoo");
  });

  it("renders the explicit empty state — and no rows — when no providers exist", async () => {
    installFetch({ list: { providers: [], routes: [] } });
    await renderPanel();
    await waitForText("No data providers configured");
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(0);
  });

  it("renders the server's error message verbatim when the list fetch fails", async () => {
    installFetch({ listStatus: 500, listBody: { error: "provider store unavailable" } });
    await renderPanel();
    await waitForText("provider store unavailable");
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(0);
  });

  it("names a non-JSON 500 instead of showing a bare status (#2624 fix-up)", async () => {
    // An edge/error-boundary page carries no JSON body; before this fix the
    // panel could only say "Request failed (500)", which is undiagnosable.
    installFetch({ listStatus: 500, listRawBody: "<html>500 Internal Server Error</html>" });
    await renderPanel();
    await waitForText("Request failed (500)");
    expect(container.textContent).toContain("HTML error page from the edge");
  });

  it("renders a sign-in-required state — not a generic failure — on 401", async () => {
    installFetch({ listStatus: 401, listBody: { error: "Unauthorized: Please log in." } });
    await renderPanel();
    await waitForText("Sign-in required");
    expect(container.textContent).not.toContain("No data providers configured");
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(0);
  });
});

// Affordances rendered ---------------------------------------------------------

describe("DataProvidersPanel affordances (issue #1180)", () => {
  it("renders only the legal action buttons for each provider's state", async () => {
    const providers = [
      providerInState("registered"),
      { ...providerInState("configured"), id: "cfgd" },
      { ...providerInState("verified", VERIFICATION), id: "verf" },
      { ...providerInState("enabled", VERIFICATION), id: "enbd" },
      { ...providerInState("disabled", VERIFICATION), id: "dsbv" },
      { ...providerInState("disabled", null), id: "dsbn" },
      { ...providerInState("deprovisioned"), id: "depr" },
    ];
    installFetch({ list: { providers, routes: [] } });
    await renderPanel();
    await waitForText("nasdaq");

    const labels = (id: string) =>
      [...providerItem(id).querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels("nasdaq")).toEqual(["Configure", "Deprovision"]);
    expect(labels("cfgd")).toEqual(["Configure", "Verify", "Deprovision"]);
    expect(labels("verf")).toEqual(["Enable", "Deprovision"]);
    expect(labels("enbd")).toEqual(["Disable", "Deprovision"]);
    expect(labels("dsbv")).toEqual(["Enable", "Deprovision"]);
    expect(labels("dsbn")).toEqual(["Deprovision"]);
    expect(labels("depr")).toEqual([]);
  });
});

// Action wiring -----------------------------------------------------------------

describe("DataProvidersPanel action wiring (issue #1180)", () => {
  it("Verify POSTs the exact E3 URL and then re-fetches the list", async () => {
    const calls = installFetch({ list: { providers: [YAHOO], routes: [] } });
    await renderPanel();
    await waitForText("yahoo");

    await click(providerItem("yahoo"), "Verify");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/data-providers",
      "POST /api/data-providers/yahoo/verify",
      "GET /api/data-providers",
    ]);
  });

  it("Enable and Disable POST their action URLs and re-fetch", async () => {
    const verified = providerInState("verified", VERIFICATION);
    const calls = installFetch({ list: { providers: [verified, ETRADE], routes: [] } });
    await renderPanel();
    await waitForText("E*TRADE");

    await click(providerItem("nasdaq"), "Enable");
    await click(providerItem("etrade"), "Disable");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/data-providers",
      "POST /api/data-providers/nasdaq/enable",
      "GET /api/data-providers",
      "POST /api/data-providers/etrade/disable",
      "GET /api/data-providers",
    ]);
  });

  it("Deprovision requires the confirm step — no POST on the first click", async () => {
    const calls = installFetch({ list: { providers: [ETRADE], routes: [] } });
    await renderPanel();
    await waitForText("E*TRADE");

    await click(providerItem("etrade"), "Deprovision");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(providerItem("etrade").textContent).toContain("Confirm deprovision");

    await click(providerItem("etrade"), "Confirm deprovision");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/data-providers",
      "POST /api/data-providers/etrade/deprovision",
      "GET /api/data-providers",
    ]);
  });

  it("Configure submits credentialRef + displayName as the POST body, then re-fetches", async () => {
    const calls = installFetch({ list: { providers: [YAHOO], routes: [] } });
    await renderPanel();
    await waitForText("yahoo");

    await click(providerItem("yahoo"), "Configure");
    await setInputValue("dpp-configure-credential-ref", "env:YAHOO_API_KEY");
    await setInputValue("dpp-configure-display-name", "Yahoo Finance");
    await click(providerItem("yahoo"), "Save configuration");

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/data-providers/yahoo/configure");
    expect(post?.body).toEqual({
      credentialRef: "env:YAHOO_API_KEY",
      displayName: "Yahoo Finance",
    });
    expect(calls[calls.length - 1]).toMatchObject({ method: "GET", url: "/api/data-providers" });
  });

  it("Register POSTs to the new id's register URL with the precedence body, then re-fetches", async () => {
    const calls = installFetch({ list: { providers: [], routes: [] } });
    await renderPanel();
    await waitForText("No data providers configured");

    await setInputValue("dpp-register-id", "alpaca");
    await setInputValue("dpp-register-precedence", "3");
    await click(container, "Register provider");

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/data-providers/alpaca/register");
    expect(post?.body).toEqual({ precedence: 3 });
    expect(calls[calls.length - 1]).toMatchObject({ method: "GET", url: "/api/data-providers" });
  });

  it("a failed action shows the server's message verbatim and keeps the list", async () => {
    installFetch({
      list: { providers: [YAHOO], routes: [] },
      actionStatus: 409,
      actionBody: {
        error: 'Verification failed for provider "yahoo": no adapter is registered for provider "yahoo" in this build.',
        code: "verification_failed",
      },
    });
    await renderPanel();
    await waitForText("yahoo");

    await click(providerItem("yahoo"), "Verify");
    await waitForText('Verification failed for provider "yahoo"');
    // The list was not blown away by the failure.
    expect(providerItem("yahoo").textContent).toContain("configured");
  });
});
