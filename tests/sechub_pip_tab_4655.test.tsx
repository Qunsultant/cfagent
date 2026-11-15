/** @vitest-environment jsdom */
/**
 * Issue #4655 — SecHub PIP tab: attribute provider state in
 * SecurityHub (`?tab=security-hub&view=pip`).
 *
 * TDD Red first: the `pip` view, its nav/deep-link entries, the hub
 * TabPanel, and the PipPanel's live-state rendering (attribute
 * schema, sources, the caller's own memberships + denials, honest
 * empty states) do not exist yet — every test below fails until the
 * slice lands.
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
vi.mock("../src/client/PepPanel", () => ({
  PepPanel: () => <div data-testid="pep-panel">pep</div>,
}));

import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { PipPanel } from "../src/client/PipPanel";
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
import { fetchPipState } from "../src/client/pipApi";

vi.mock("../src/client/pipApi", () => ({
  fetchPipState: vi.fn(),
}));

const mockedFetchPipState = vi.mocked(fetchPipState);

const PIP_STATE = {
  schema: {
    membership: {
      fields: [
        "membershipId",
        "internalUserId",
        "tenantId",
        "workspaceId",
        "roleBindings",
        "createdBy",
        "createdAtMs",
        "revokedAtMs",
        "email",
      ],
    },
    roleBinding: {
      fields: ["role", "scope", "workspaceId", "resourceId", "grantedBy", "expiresAtMs"],
    },
    permissionDenial: {
      fields: ["denialId", "internalUserId", "tenantId", "permission", "deniedBy", "deniedAtMs"],
    },
  },
  sources: [
    {
      id: "memberships",
      name: "Membership store",
      via: "membershipStoreToAttributeProvider",
      available: true,
    },
    {
      id: "denials",
      name: "KV denial store",
      via: "createKvPermissionDenialStore",
      available: true,
    },
  ],
  attributes: {
    memberships: [
      {
        membershipId: "mem-1",
        internalUserId: "v1:user000000000000000000000000000000000000001",
        tenantId: "primary",
        roleBindings: [
          { role: "platform-admin", scope: "platform", grantedBy: "test-seed" },
        ],
        createdBy: "test-seed",
        createdAtMs: 1763000000000,
      },
    ],
    denials: [
      {
        denialId: "den-1",
        internalUserId: "v1:user000000000000000000000000000000000000001",
        tenantId: "primary",
        permission: "integration:connect",
        deniedBy: "v1:admin00000000000000000000000000000000000001",
        deniedAtMs: 1763000001000,
      },
    ],
    denialsAvailable: true,
  },
};

describe("4655 view: pip joins the SecurityHub views (#4655)", () => {
  it("SECURITY_HUB_VIEWS lists the eight security views, in order, PIP seventh (#4658 adds pap last)", () => {
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
    expect(SECURITY_HUB_VIEW_LABELS["pip"]).toBe("PIP");
  });

  it("normalize/parse accept pip and still fall back to iaaa-admin for unknown views", () => {
    expect(normalizeSecurityHubView("pip")).toBe("pip");
    expect(normalizeSecurityHubView("bogus")).toBe("iaaa-admin");
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=pip")).toEqual({
      view: "pip",
    });
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=nope")).toEqual({
      view: "iaaa-admin",
    });
  });
});

describe("4655 nav: PIP has a sub-menu entry, deep link, and surface value (#4655)", () => {
  it("the SecurityHub item has eight sub-items, PIP seventh, each with a resolvable icon (#4658 adds pap last)", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "security-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(8);
    const sub = item!.subItems![6];
    expect(sub.id).toBe("pip");
    expect(sub.label).toBe("PIP");
    expect(sub.description).toBeTruthy();
    expect(sub.icon).toBeTruthy();
    expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
  });

  it("pip deep-links to ?tab=security-hub&view=pip and is a listed surface value", () => {
    expect(deepLinkForNavNode("security-hub", "pip")).toEqual({
      tab: "security-hub",
      view: "pip",
    });
    expect(deepLinkHrefForNavNode("security-hub", "pip")).toBe(
      "?tab=security-hub&view=pip",
    );
    expect(DEEP_LINK_OVERRIDES["security-hub:pip"]).toEqual({
      tab: "security-hub",
      view: "pip",
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

describe("4655 hub: SecurityHub renders seven tabs and mounts the PIP panel (#4655)", () => {
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

  it("the PIP tab mounts the PIP panel and the hub shows eight tabs (#4658 adds the PAP tab)", async () => {
    mockedFetchPipState.mockResolvedValue(PIP_STATE);
    window.history.pushState(null, "", "/?tab=security-hub&view=pip");
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
    // The real PipPanel mounts under the PIP tab and renders live state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("platform-admin");
    expect(container.textContent).toContain("integration:connect");
  });
});

describe("4655 panel: PipPanel renders live PIP state (#4655)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPanel() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PipPanel />);
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

  it("shows the attribute schema from the live provider interfaces", async () => {
    mockedFetchPipState.mockResolvedValue(PIP_STATE);
    await renderPanel();
    expect(container.textContent).toMatch(/attribute schema/i);
    for (const field of ["membershipId", "roleBindings", "denialId", "deniedBy", "grantedBy"]) {
      expect(container.textContent).toContain(field);
    }
  });

  it("shows each attribute source and the adapter that resolves it", async () => {
    mockedFetchPipState.mockResolvedValue(PIP_STATE);
    await renderPanel();
    expect(container.textContent).toMatch(/attribute sources/i);
    expect(container.textContent).toContain("Membership store");
    expect(container.textContent).toContain("KV denial store");
    expect(container.textContent).toContain("membershipStoreToAttributeProvider");
    expect(container.textContent).toContain("createKvPermissionDenialStore");
  });

  it("shows the caller's own memberships and denials", async () => {
    mockedFetchPipState.mockResolvedValue(PIP_STATE);
    await renderPanel();
    expect(container.textContent).toMatch(/your attributes/i);
    expect(container.textContent).toContain("primary");
    expect(container.textContent).toContain("platform-admin");
    expect(container.textContent).toContain("integration:connect");
    expect(container.textContent).toContain("den-1");
  });

  it("renders honest empty states instead of invented data when the caller has no memberships or denials", async () => {
    mockedFetchPipState.mockResolvedValue({
      ...PIP_STATE,
      attributes: { memberships: [], denials: [], denialsAvailable: true },
    });
    await renderPanel();
    expect(container.textContent).toMatch(/no memberships/i);
    expect(container.textContent).toMatch(/no .*denials/i);
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("renders an honest empty state instead of invented data when loading fails", async () => {
    mockedFetchPipState.mockRejectedValue(
      new Error("Failed to load PIP state."),
    );
    await renderPanel();
    expect(container.textContent).toMatch(/could not be loaded/i);
    expect(container.textContent).not.toContain("platform-admin");
    expect(container.textContent).not.toContain("integration:connect");
  });

  it("has no control that reads another user's attributes", async () => {
    mockedFetchPipState.mockResolvedValue(PIP_STATE);
    await renderPanel();
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/other user/i);
  });
});
