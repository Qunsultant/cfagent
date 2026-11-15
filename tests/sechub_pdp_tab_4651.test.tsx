/** @vitest-environment jsdom */
/**
 * Issue #4651 — SecHub PDP tab: Policy Decision Point state in
 * SecurityHub (`?tab=security-hub&view=pdp`).
 *
 * TDD Red first: the `pdp` view, its nav/deep-link entries, the hub
 * TabPanel, and the PdpPanel's live-state rendering (snapshot +
 * source, policy-source resolution incl. the invalid-switch warning,
 * read-only obligations) do not exist yet — every test below fails
 * until the slice lands.
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

import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { PdpPanel } from "../src/client/PdpPanel";
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
import { fetchActivePolicy } from "../src/client/policyProposalsApi";
import { fetchPdpState } from "../src/client/pdpApi";

vi.mock("../src/client/policyProposalsApi", () => ({
  fetchActivePolicy: vi.fn(),
}));
vi.mock("../src/client/pdpApi", () => ({
  fetchPdpState: vi.fn(),
}));

const mockedFetchActivePolicy = vi.mocked(fetchActivePolicy);
const mockedFetchPdpState = vi.mocked(fetchPdpState);

const ACTIVE = {
  version: "iaaa-authorization-1",
  permissions: ["task:read", "task:cancel", "audit:read"],
  roleGrants: {
    "platform-admin": ["audit:read"],
    member: ["task:read", "task:cancel"],
  },
};

const PDP_STATE = {
  policySource: { source: "code" as const, invalid: false },
  obligations: [
    {
      permission: "role:assign",
      obligations: ["step-up", "audit-before-allow"],
      advice: [
        {
          kind: "audit-notice",
          message: "A role:assign decision is audited before it takes effect.",
        },
      ],
    },
    {
      permission: "membership:revoke",
      obligations: ["audit-before-allow"],
      advice: [
        {
          kind: "audit-notice",
          message: "A membership:revoke decision is audited before it takes effect.",
        },
      ],
    },
    {
      permission: "audit:export",
      obligations: ["audit-before-allow"],
      advice: [
        {
          kind: "audit-notice",
          message: "An audit:export decision is audited before it takes effect.",
        },
      ],
    },
  ],
  coverage: [
    {
      permission: "role:assign",
      status: "enforced" as const,
      enforcementPoints: ["membership grant", "role-grants grant", "permission deny/clear"],
    },
    {
      permission: "membership:revoke",
      status: "enforced" as const,
      enforcementPoints: ["offboard/deactivate"],
    },
    {
      permission: "audit:export",
      status: "residual" as const,
      enforcementPoints: [],
    },
  ],
};

describe("4651 view: pdp joins the SecurityHub views (#4651)", () => {
  it("SECURITY_HUB_VIEWS lists the eight security views, in order, PDP fifth (#4658 adds pap last)", () => {
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
    expect(SECURITY_HUB_VIEW_LABELS["pdp"]).toBe("PDP");
  });

  it("normalize/parse accept pdp and still fall back to iaaa-admin for unknown views", () => {
    expect(normalizeSecurityHubView("pdp")).toBe("pdp");
    expect(normalizeSecurityHubView("bogus")).toBe("iaaa-admin");
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=pdp")).toEqual({
      view: "pdp",
    });
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=nope")).toEqual({
      view: "iaaa-admin",
    });
  });
});

describe("4651 nav: PDP has a sub-menu entry, deep link, and surface value (#4651)", () => {
  it("the SecurityHub item has eight sub-items, PDP fifth, each with a resolvable icon (#4658 adds pap last)", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "security-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(8);
    const sub = item!.subItems![4];
    expect(sub.id).toBe("pdp");
    expect(sub.label).toBe("PDP");
    expect(sub.description).toBeTruthy();
    expect(sub.icon).toBeTruthy();
    expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
  });

  it("pdp deep-links to ?tab=security-hub&view=pdp and is a listed surface value", () => {
    expect(deepLinkForNavNode("security-hub", "pdp")).toEqual({
      tab: "security-hub",
      view: "pdp",
    });
    expect(deepLinkHrefForNavNode("security-hub", "pdp")).toBe(
      "?tab=security-hub&view=pdp",
    );
    expect(DEEP_LINK_OVERRIDES["security-hub:pdp"]).toEqual({
      tab: "security-hub",
      view: "pdp",
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

describe("4651 hub: SecurityHub renders seven tabs and mounts the PDP panel (#4651)", () => {
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

  it("the PDP tab mounts the PDP panel and the hub shows eight tabs (#4658 adds the PAP tab)", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
    mockedFetchPdpState.mockResolvedValue(PDP_STATE);
    window.history.pushState(null, "", "/?tab=security-hub&view=pdp");
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
    // The real PdpPanel mounts under the PDP tab and renders live state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("iaaa-authorization-1");
    expect(container.textContent).toContain("role:assign");
  });
});

describe("4651 panel: PdpPanel renders live PDP state (#4651)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPanel() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PdpPanel />);
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

  it("shows the live active snapshot, its source, and the role grants", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
    mockedFetchPdpState.mockResolvedValue(PDP_STATE);
    await renderPanel();
    expect(container.textContent).toContain("iaaa-authorization-1");
    expect(container.textContent).toContain("compiled");
    expect(container.textContent).toContain("platform-admin");
    expect(container.textContent).toContain("audit:read");
    expect(container.textContent).toContain("member");
  });

  it("shows the PAP-promoted source when the active snapshot was promoted", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "pap-promoted" });
    mockedFetchPdpState.mockResolvedValue(PDP_STATE);
    await renderPanel();
    expect(container.textContent).toContain("pap-promoted");
  });

  it("shows the resolved policy source and warns when the switch is invalid", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
    mockedFetchPdpState.mockResolvedValue({
      ...PDP_STATE,
      policySource: { source: "code" as const, invalid: true },
    });
    await renderPanel();
    expect(container.textContent).toContain("code");
    expect(container.textContent).toMatch(/invalid/i);
    expect(container.textContent).toMatch(/fail(ed)? closed/i);
  });

  it("shows the snapshot policy source when the switch resolves to a snapshot", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
    mockedFetchPdpState.mockResolvedValue({
      ...PDP_STATE,
      policySource: { source: "snapshot" as const, invalid: false },
    });
    await renderPanel();
    expect(container.textContent).toContain("snapshot");
  });

  it("shows obligations read-only with live coverage, and no edit control", async () => {
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
    mockedFetchPdpState.mockResolvedValue(PDP_STATE);
    await renderPanel();
    expect(container.textContent).toContain("role:assign");
    expect(container.textContent).toContain("step-up");
    expect(container.textContent).toContain("audit-before-allow");
    expect(container.textContent).toContain("membership:revoke");
    expect(container.textContent).toContain("audit:export");
    expect(container.textContent).toMatch(/residual/i);
    expect(container.textContent).toMatch(/read-only/i);
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("renders an honest empty state instead of invented data when loading fails", async () => {
    mockedFetchActivePolicy.mockRejectedValue(
      new Error("Forbidden: policy administration requires platform-admin."),
    );
    mockedFetchPdpState.mockRejectedValue(
      new Error("Forbidden: policy administration requires platform-admin."),
    );
    await renderPanel();
    expect(container.textContent).toMatch(/platform admin/i);
    expect(container.textContent).not.toContain("iaaa-authorization-1");
    expect(container.textContent).not.toContain("role:assign");
  });
});
