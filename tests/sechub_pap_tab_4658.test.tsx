/** @vitest-environment jsdom */
/**
 * Issue 4658 — SecHub PAP tab: policy administration in SecurityHub
 * (`?tab=security-hub&view=pap`).
 *
 * TDD Red first: the `pap` view, its nav/deep-link entries, the hub
 * TabPanel mounting the existing PolicyProposalsPanel (moved off the
 * IAAA Admin Overview, not duplicated), and the panel's live-state
 * rendering (active snapshot + source, proposal list,
 * propose/preview/approve/reject/promote controls) do not exist yet —
 * every test below fails until the slice lands. No new endpoint: the
 * panel keeps using the issue 2838 proposal endpoints, mocked here
 * at the policyProposalsApi boundary.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
vi.mock("../src/client/PipPanel", () => ({
  PipPanel: () => <div data-testid="pip-panel">pip</div>,
}));

import { SecurityHubHome } from "../src/client/SecurityHubHome";
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
import {
  fetchActivePolicy,
  fetchPolicyProposals,
} from "../src/client/policyProposalsApi";

vi.mock("../src/client/policyProposalsApi", () => ({
  fetchPolicyProposals: vi.fn(),
  fetchActivePolicy: vi.fn(),
  previewPolicy: vi.fn(),
  proposePolicy: vi.fn(),
  approvePolicyProposal: vi.fn(),
  rejectPolicyProposal: vi.fn(),
  promotePolicyProposal: vi.fn(),
  fmtPolicyTime: vi.fn((ms: number) => `time-${ms}`),
}));

const mockedFetchPolicyProposals = vi.mocked(fetchPolicyProposals);
const mockedFetchActivePolicy = vi.mocked(fetchActivePolicy);

const ACTIVE = {
  version: "iaaa-authorization-1",
  permissions: ["task:read", "task:cancel"],
  roleGrants: {
    "platform-admin": ["audit:read"],
    member: ["task:read", "task:cancel"],
  },
};

const PROPOSALS = [
  {
    proposalId: "prop-1",
    status: "proposed" as const,
    proposer: "admin-1",
    proposedSnapshot: ACTIVE,
    beforeRef: "iaaa-authorization-1:aaaa",
    afterRef: "iaaa-authorization-1:bbbb",
    tenantScope: "platform",
    correlationId: "corr-1",
    createdAtMs: 1000,
  },
  {
    proposalId: "prop-2",
    status: "approved" as const,
    proposer: "admin-1",
    approver: "admin-2",
    proposedSnapshot: ACTIVE,
    beforeRef: "iaaa-authorization-1:bbbb",
    afterRef: "iaaa-authorization-1:cccc",
    tenantScope: "platform",
    correlationId: "corr-2",
    createdAtMs: 2000,
  },
];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
}

describe("4658 view: pap joins the SecurityHub views (#4658)", () => {
  it("SECURITY_HUB_VIEWS lists the eight security views, in order, PAP last", () => {
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
    expect(SECURITY_HUB_VIEW_LABELS["pap"]).toBe("PAP");
  });

  it("normalize/parse accept pap and still fall back to iaaa-admin for unknown views", () => {
    expect(normalizeSecurityHubView("pap")).toBe("pap");
    expect(normalizeSecurityHubView("bogus")).toBe("iaaa-admin");
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=pap")).toEqual({
      view: "pap",
    });
    expect(parseSecurityHubDeepLink("?tab=security-hub&view=nope")).toEqual({
      view: "iaaa-admin",
    });
  });
});

describe("4658 nav: PAP has a sub-menu entry, deep link, and surface value (#4658)", () => {
  it("the SecurityHub item has eight sub-items, PAP last, each with a resolvable icon", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "security-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(8);
    const sub = item!.subItems![7];
    expect(sub.id).toBe("pap");
    expect(sub.label).toBe("PAP");
    expect(sub.description).toBeTruthy();
    expect(sub.icon).toBeTruthy();
    expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
  });

  it("pap deep-links to ?tab=security-hub&view=pap and is a listed surface value", () => {
    expect(deepLinkForNavNode("security-hub", "pap")).toEqual({
      tab: "security-hub",
      view: "pap",
    });
    expect(deepLinkHrefForNavNode("security-hub", "pap")).toBe(
      "?tab=security-hub&view=pap",
    );
    expect(DEEP_LINK_OVERRIDES["security-hub:pap"]).toEqual({
      tab: "security-hub",
      view: "pap",
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

describe("4658 hub: SecurityHub renders eight tabs and mounts the PAP panel (#4658)", () => {
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
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mockedFetchPolicyProposals.mockResolvedValue(PROPOSALS);
    mockedFetchActivePolicy.mockResolvedValue({ active: ACTIVE, source: "compiled" });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("the PAP tab mounts the real proposals panel and the hub shows eight tabs", async () => {
    window.history.pushState(null, "", "/?tab=security-hub&view=pap");
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
    // The real PolicyProposalsPanel mounts under the PAP tab and renders live state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Propose a policy change");
    expect(text).toContain("Active source: compiled");
    expect(text).toContain("The frozen obligation policy is not editable here");
    expect(text).toContain("prop-1");
    expect(text).toContain("prop-2");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((b) => b.includes("Preview impact"))).toBe(true);
    expect(buttons.some((b) => b.includes("Propose change"))).toBe(true);
    expect(buttons.some((b) => b.includes("Approve"))).toBe(true);
    expect(buttons.some((b) => b.includes("Reject"))).toBe(true);
    expect(buttons.some((b) => b.includes("Promote"))).toBe(true);
  });

  it("renders an honest empty state instead of invented proposals when none exist", async () => {
    mockedFetchPolicyProposals.mockResolvedValue([]);
    window.history.pushState(null, "", "/?tab=security-hub&view=pap");
    await render(
      <ToastProvider>
        <SecurityHubHome userLogin="tester" />
      </ToastProvider>,
    );
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("No policy proposals");
    expect(text).not.toContain("prop-1");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((b) => b.includes("Approve"))).toBe(false);
    expect(buttons.some((b) => b.includes("Reject"))).toBe(false);
    expect(buttons.some((b) => b.includes("Promote"))).toBe(false);
  });

  it("renders an honest error instead of invented rows when loading fails", async () => {
    mockedFetchPolicyProposals.mockRejectedValue(
      new Error("Failed to load policy proposals."),
    );
    window.history.pushState(null, "", "/?tab=security-hub&view=pap");
    await render(
      <ToastProvider>
        <SecurityHubHome userLogin="tester" />
      </ToastProvider>,
    );
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Failed to load policy proposals.");
    expect(text).not.toContain("task:cancel");
    expect(text).not.toContain("prop-1");
  });
});

describe("4658 move: the panel mounts exactly once, on the PAP tab (#4658)", () => {
  it("IAAA Admin Overview no longer mounts PolicyProposalsPanel", () => {
    const overview = read("src/client/IaaaAdminPanel.tsx");
    expect(overview).not.toContain("<PolicyProposalsPanel");
    expect(overview).not.toContain('from "./PolicyProposalsPanel"');
  });

  it("SecurityHubHome mounts PolicyProposalsPanel exactly once, on the pap TabPanel", () => {
    const home = read("src/client/SecurityHubHome.tsx");
    expect(home).toContain('tabId="pap"');
    expect(home).toContain("<PolicyProposalsPanel />");
    expect(home.split("<PolicyProposalsPanel").length - 1).toBe(1);
  });
});
