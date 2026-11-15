/** @vitest-environment jsdom */
/**
 * Issue #4653 — SecHub PEP tab: route PEP gates and enforcement state
 * in SecurityHub (`?tab=security-hub&view=pep`).
 *
 * TDD Red first: the `pep` view, its nav/deep-link entries, the hub
 * TabPanel, and the PepPanel's live-state rendering (gate inventory,
 * enforcement state, honest empty state for recent decisions) do not
 * exist yet — every test below fails until the slice lands.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/IaaaAdminPanel", () => ({
  IaaaAdminPanel: () => <div data-testid="iaaa-admin-panel">iaaa admin</div>,
}));
vi.mock("../src/client/UserAdminPanel", () => ({
  UserAdminPanel: () => <div data-testid="users-panel">users</div>,
}));
vi.mock("../src/client/PlatformAdminPanel", () => ({
  AdminAccessSection: () => <div data-testid="admin-access-section">admin access</div>,
}));
vi.mock("../src/client/ProfileSection", () => ({
  ProfileSection: () => <div data-testid="profile-section">profile</div>,
}));
vi.mock("../src/client/PdpPanel", () => ({
  PdpPanel: () => <div data-testid="pdp-panel">pdp</div>,
}));

import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { PepPanel } from "../src/client/PepPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  SECURITY_HUB_VIEWS,
  SECURITY_HUB_VIEW_LABELS,
  normalizeSecurityHubView,
  parseSecurityHubDeepLink,
} from "../src/client/securityHubView";
import {
  DEFAULT_LEFT_NAV_CONFIG,
} from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  DEEP_LINK_OVERRIDES,
  SURFACE_TAB_DEFS,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import { fetchPepState } from "../src/client/pepApi";

vi.mock("../src/client/pepApi", () => ({
  fetchPepState: vi.fn(),
}));

const mockedFetchPepState = vi.mocked(fetchPepState);

const PEP_STATE = {
  enforcement: {
    pdpEnabled: true,
    enforced: true,
    graceExpired: false,
    sessionKind: "wired" as const,
    legacyGraceWindowSeconds: 604800,
  },
  gates: [
    {
      route: "/auth/etrade/start",
      method: "GET" as const,
      permission: "integration:connect",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/auth.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/api/etrade/oauth/start",
      method: "GET" as const,
      permission: "integration:connect",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/auth.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/api/etrade/oauth/verifier",
      method: "POST" as const,
      permission: "integration:connect",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/auth.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/auth/public/start",
      method: "GET" as const,
      permission: "integration:connect",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/auth.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/api/public/connect",
      method: "POST" as const,
      permission: "integration:connect",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/auth.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/api/schedule/goals/approvals/:id/(approve|reject)",
      method: "POST" as const,
      permission: "action:approve",
      gateway: "evaluateRoutePep" as const,
      source: "src/server/routes/trading.ts",
      denied: "403 legacy_pdp_grace_expired when grace expired, else 403 authorization denied",
    },
    {
      route: "/api/schedules/webhook/followup",
      method: "POST" as const,
      permission: "task:create",
      gateway: "evaluateAgentSchedulePdp" as const,
      source: "src/agents/routes/schedules.ts",
      denied: "403 — this webhook caller is not authorized to mint a schedule follow-up",
    },
    {
      route: "/api/schedules/approvals/:id/(approve|reject)",
      method: "POST" as const,
      permission: "action:approve",
      gateway: "evaluateAgentSchedulePdp" as const,
      source: "src/agents/routes/schedules.ts",
      denied: "403 — approval denied by policy",
    },
  ],
  decisions: null,
  decisionsAvailable: false,
};

describe("4653 view: pep joins the SecurityHub views (#4653)", () => {
  it("SECURITY_HUB_VIEWS lists the eight security views, in order, PEP sixth (#4658 adds pap last)", () => {
    expect([...SECURITY_HUB_VIEWS]).toEqual([
      "iaaa-admin",
      "users",
      "admin-access",
      "profile",
      "pdp",
      "pep",
      "pip",
      "pap",
    ]);
    expect(SECURITY_HUB_VIEW_LABELS["pep"]).toBe("PEP");
  });

  it("normalize/parse accept pep and still fall back to iaaa-admin for unknown views", () => {
    expect(normalizeSecurityHubView("pep")).toBe("pep");
    expect(normalizeSecurityHubView("bogus")).toBe("iaaa-admin");
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=pep")).toEqual({
      view: "pep",
    });
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=nope")).toEqual({
      view: "iaaa-admin",
    });
  });
});

describe("4653 nav: PEP has a sub-menu entry, deep link, and surface value (#4653)", () => {
  it("the SecurityHub item has eight sub-items, PEP sixth, each with a resolvable icon (#4658 adds pap last)", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "security-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(8);
    const sub = item!.subItems![5];
    expect(sub.id).toBe("pep");
    expect(sub.label).toBe("PEP");
    expect(sub.description).toBeTruthy();
    expect(sub.icon).toBeTruthy();
    expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
  });

  it("pep deep-links to ?tab=security-hub&view=pep and is a listed surface value", () => {
    expect(deepLinkForNavNode("security-hub", "pep")).toEqual({
      tab: "security-hub",
      view: "pep",
    });
    expect(deepLinkHrefForNavNode("security-hub", "pep")).toBe(
      "?tab=security-hub&view=pep",
    );
    expect(DEEP_LINK_OVERRIDES["security-hub:pep"]).toEqual({
      tab: "security-hub",
      view: "pep",
    });
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "security-hub");
    expect(surface).toBeDefined();
    expect([...surface!.values]).toEqual([
      "iaaa-admin",
      "users",
      "admin-access",
      "profile",
      "pdp",
      "pep",
      "pip",
      "pap",
    ]);
  });
});

describe("4653 hub: SecurityHub renders seven tabs and mounts the PEP panel (#4653)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
  }

  async function settle(times = 4) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("the PEP tab mounts the PEP panel and the hub shows eight tabs (#4658 adds the PAP tab)", async () => {
    mockedFetchPepState.mockResolvedValue(PEP_STATE);
    window.history.pushState(null, "", "/?tab=security-hub&view=pep");
    await render(
      <ToastProvider>
        <SecurityHubHome userLogin="tester" />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(["IAAA Admin", "Users", "Admin Access", "Profile", "PDP", "PEP", "PIP", "PAP"]);
    // The real PepPanel mounts under the PEP tab and renders live state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("integration:connect");
    expect(container.textContent).toContain("/auth/etrade/start");
  });
});

describe("4653 panel: PepPanel renders live PEP state (#4653)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPanel() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PepPanel />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
  });

  it("shows the live enforcement state for the caller's session", async () => {
    mockedFetchPepState.mockResolvedValue(PEP_STATE);
    await renderPanel();
    expect(container.textContent).toMatch(/enforcement on/i);
    expect(container.textContent).toContain("wired");
    expect(container.textContent).toMatch(/grace/i);
    expect(container.textContent).toMatch(/not expired/i);
  });

  it("shows enforcement off when the PDP flag is off", async () => {
    mockedFetchPepState.mockResolvedValue({
      ...PEP_STATE,
      enforcement: {
        pdpEnabled: false,
        enforced: false,
        graceExpired: false,
        sessionKind: "wired" as const,
        legacyGraceWindowSeconds: 604800,
      },
    });
    await renderPanel();
    expect(container.textContent).toMatch(/enforcement off/i);
    expect(container.textContent).not.toMatch(/enforcement on/i);
  });

  it("lists every gated route with its permission and gateway", async () => {
    mockedFetchPepState.mockResolvedValue(PEP_STATE);
    await renderPanel();
    for (const route of [
      "/auth/etrade/start",
      "/api/etrade/oauth/start",
      "/api/etrade/oauth/verifier",
      "/auth/public/start",
      "/api/public/connect",
      "/api/schedule/goals/approvals/:id/(approve|reject)",
      "/api/schedules/webhook/followup",
      "/api/schedules/approvals/:id/(approve|reject)",
    ]) {
      expect(container.textContent).toContain(route);
    }
    expect(container.textContent).toContain("integration:connect");
    expect(container.textContent).toContain("action:approve");
    expect(container.textContent).toContain("task:create");
    expect(container.textContent).toContain("evaluateRoutePep");
    expect(container.textContent).toContain("evaluateAgentSchedulePdp");
  });

  it("renders an honest empty state for recent decisions — never invented rows", async () => {
    mockedFetchPepState.mockResolvedValue(PEP_STATE);
    await renderPanel();
    expect(container.textContent).toMatch(/recent PEP decisions/i);
    expect(container.textContent).toMatch(/no .*record/i);
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("renders an honest empty state instead of invented data when loading fails", async () => {
    mockedFetchPepState.mockRejectedValue(
      new Error("Forbidden: policy state requires platform-admin."),
    );
    await renderPanel();
    expect(container.textContent).toMatch(/platform admin/i);
    expect(container.textContent).not.toContain("/auth/etrade/start");
    expect(container.textContent).not.toContain("integration:connect");
  });
});
