/** @vitest-environment jsdom */
/**
 * #6164 (parent #945) — Security Hub / IAAA Admin coherent fix, client side.
 *
 * Governing rule: CONSISTENT INFORMATION EVERYWHERE. The client renders
 * what the server resolved (login beside id); it never invents a login.
 * A user with no alias reads "not recorded", never a fabricated login.
 *
 * Covers: the identity rendering helpers, the F1 live-roles filter
 * (revoked/expired memberships excluded from "Your roles", visible with
 * dates in a Membership status line), the F2 audit Actor column, the F11
 * subtitle correction, the F13 loading state (visible text + skeleton,
 * never a bare Spinner), the router ownership move (iaaaTab lives on
 * security-hub now), and the nav-config deep-link defs for the inner tabs.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  formatIdentityText,
  formatPrincipalText,
  isInternalUserId,
} from "../src/client/identityDisplay";
import {
  liveRoles,
  membershipStatus,
  formatMembershipStatus,
  type AdminMembershipView,
} from "../src/client/iaaaAdminApi";
import { TAB_PARAM_OWNERS, legacyPlatformAdminHubRedirect, buildSearchWithTab } from "../src/client/router";
import navConfigData from "../src/client/nav-config.json";
import { IaaaAdminPanel } from "../src/client/IaaaAdminPanel";
import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1792660000000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const REVOKED_MS = 1792760000000; // 2026-10-23

function membership(overrides: Partial<AdminMembershipView> & { internalUserId: string }): AdminMembershipView {
  return {
    membershipId: `m-${overrides.internalUserId.slice(0, 8)}`,
    internalUserId: overrides.internalUserId,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
    ...overrides,
  };
}

describe("identityDisplay", () => {
  it("formats login + id, and 'not recorded' when no alias exists", () => {
    expect(formatIdentityText("OpenAIMP", ADMIN_ID)).toBe(`OpenAIMP (${ADMIN_ID})`);
    expect(formatIdentityText(null, ADMIN_ID)).toBe(`not recorded (${ADMIN_ID})`);
    expect(formatIdentityText(undefined, ADMIN_ID)).toBe(`not recorded (${ADMIN_ID})`);
  });

  it("passes system principals through verbatim, formats ids", () => {
    expect(formatPrincipalText(null, "system:bootstrap")).toBe("system:bootstrap");
    expect(formatPrincipalText("OpenAIMP", ADMIN_ID)).toBe(`OpenAIMP (${ADMIN_ID})`);
    expect(formatPrincipalText(null, ADMIN_ID)).toBe(`not recorded (${ADMIN_ID})`);
    expect(formatPrincipalText(null, "https://github.com:82253453")).toBe(
      "https://github.com:82253453",
    );
  });

  it("recognizes UUID and v1: ids, nothing else", () => {
    expect(isInternalUserId(ADMIN_ID)).toBe(true);
    expect(isInternalUserId("v1:289a639c644816a2aa087d5f3c37ce5e46f169727ad4d79b4189e0a3fb0c28c2")).toBe(true);
    expect(isInternalUserId("system:bootstrap")).toBe(false);
    expect(isInternalUserId("OpenAIMP")).toBe(false);
    expect(isInternalUserId("https://github.com:82253453")).toBe(false);
  });
});

describe("F1 live-roles filter", () => {
  it("excludes revoked memberships and expired bindings from live roles", () => {
    const revoked = membership({
      internalUserId: ADMIN_ID,
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      revokedAtMs: REVOKED_MS,
    });
    const expired = membership({
      internalUserId: USER_ID,
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap", expiresAtMs: NOW - 1 },
      ],
    });
    const live = membership({ internalUserId: USER_ID });
    expect(liveRoles([revoked, expired, live], NOW)).toEqual(["tenant-admin (tenant)"]);
    expect(liveRoles([revoked, expired], NOW)).toEqual([]);
  });

  it("classifies revoked / expired / active with dates", () => {
    const revoked = membership({ internalUserId: ADMIN_ID, revokedAtMs: REVOKED_MS });
    expect(membershipStatus(revoked, NOW)).toEqual({ kind: "revoked", atMs: REVOKED_MS });
    expect(formatMembershipStatus(membershipStatus(revoked, NOW))).toBe(
      `Revoked ${new Date(REVOKED_MS).toLocaleDateString()}`,
    );
    const expired = membership({
      internalUserId: USER_ID,
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap", expiresAtMs: NOW - 1000 },
        { role: "member", scope: "tenant", grantedBy: "system:bootstrap", expiresAtMs: NOW - 500 },
      ],
    });
    expect(membershipStatus(expired, NOW)).toEqual({ kind: "expired", atMs: NOW - 500 });
    expect(membershipStatus(membership({ internalUserId: USER_ID }), NOW)).toEqual({
      kind: "active",
    });
  });

  it("a membership with one live and one expired binding is active with only the live role", () => {
    const mixed = membership({
      internalUserId: USER_ID,
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap", expiresAtMs: NOW - 1 },
        { role: "member", scope: "tenant", grantedBy: "system:bootstrap" },
      ],
    });
    expect(membershipStatus(mixed, NOW)).toEqual({ kind: "active" });
    expect(liveRoles([mixed], NOW)).toEqual(["member (tenant)"]);
  });
});

describe("router ownership (A3)", () => {
  it("iaaaTab is owned by security-hub, not the retired platform-admin tab", () => {
    expect(TAB_PARAM_OWNERS.iaaaTab).toContain("security-hub");
    expect(TAB_PARAM_OWNERS.iaaaTab).not.toContain("platform-admin");
  });

  it("iaaaSection is owned by security-hub", () => {
    expect(TAB_PARAM_OWNERS.iaaaSection).toContain("security-hub");
  });

  it("navigating to security-hub preserves the inner-tab params", () => {
    const search = buildSearchWithTab(
      "?tab=security-hub&view=iaaa-admin&iaaaTab=members&iaaaSection=role-grants",
      "security-hub",
    );
    expect(search).toContain("iaaaTab=members");
    expect(search).toContain("iaaaSection=role-grants");
  });

  it("the retired platform-admin deep link carries the inner-tab state through the redirect", () => {
    expect(
      legacyPlatformAdminHubRedirect(
        "?tab=platform-admin&view=iaaa-admin&iaaaTab=members&iaaaSection=role-grants",
      ),
    ).toEqual({
      tab: "security-hub",
      view: "iaaa-admin",
      params: { iaaaTab: "members", iaaaSection: "role-grants" },
    });
    expect(
      legacyPlatformAdminHubRedirect("?tab=platform-admin&view=iaaa-admin"),
    ).toEqual({ tab: "security-hub", view: "iaaa-admin" });
    // Inner-tab params are meaningless on the users/admin-access views.
    expect(
      legacyPlatformAdminHubRedirect("?tab=platform-admin&view=users&iaaaTab=members"),
    ).toEqual({ tab: "security-hub", view: "users" });
  });
});

describe("nav-config deep-link defs (A3)", () => {
  const surfaces = (navConfigData as any).deepLinkSurfaces as Array<{
    surface: string;
    page: string;
    pageView?: string;
    param: string;
    values: string[];
  }>;

  it("declares the iaaaTab inner tabs under the iaaa-admin view", () => {
    const def = surfaces.find((d) => d.param === "iaaaTab");
    expect(def).toBeDefined();
    expect(def!.page).toBe("security-hub");
    expect(def!.pageView).toBe("iaaa-admin");
    expect(def!.values).toEqual(["overview", "members", "api", "mcp", "iaaa", "correlations"]);
  });

  it("declares the iaaaSection inner tabs under the iaaa-admin view", () => {
    const def = surfaces.find((d) => d.param === "iaaaSection");
    expect(def).toBeDefined();
    expect(def!.page).toBe("security-hub");
    expect(def!.pageView).toBe("iaaa-admin");
    expect(def!.values).toEqual([
      "summary",
      "service-user",
      "service-tokens",
      "role-grants",
      "bootstrap-proposals",
      "logged-in-users",
      "deactivate",
      "access-requests",
      "audit-events",
    ]);
  });

  it("no security-hub submenu still carries the false 'Read-only' subtitle (F11)", () => {
    const submenus = (navConfigData as any).subMenus?.["security-hub"] as Array<{
      shortLabel?: string;
      description?: string;
    }>;
    expect(submenus).toBeDefined();
    for (const item of submenus) {
      expect(item.shortLabel ?? "").not.toContain("Read-only memberships");
      expect(item.description ?? "").not.toContain("Read-only memberships");
    }
  });
});

// --- Panel render harness (mirrors iaaa_admin_content_4839.test.tsx) ---

const OVERVIEW = {
  tenantId: "primary",
  callerInternalUserId: ADMIN_ID,
  memberships: [
    {
      membershipId: "m-admin",
      internalUserId: ADMIN_ID,
      login: "OpenAIMP",
      tenantId: "primary",
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      createdBy: "system:bootstrap-genesis",
      createdAtMs: NOW - 1000,
      revokedAtMs: REVOKED_MS,
    },
    {
      membershipId: "m-user",
      internalUserId: USER_ID,
      login: "member-user",
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
      createdBy: "system:bootstrap",
      createdAtMs: NOW - 1000,
    },
  ],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [
    {
      id: "evt-1",
      timestamp: NOW,
      type: "auth.login",
      actorPrincipalId: USER_ID,
      actorLogin: "member-user",
      initiatingPrincipalId: ADMIN_ID,
      initiatingLogin: "OpenAIMP",
      action: "auth.login",
      decision: "allow",
      outcome: "succeeded",
      correlationId: "corr-1",
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement;
let overviewOverride: Record<string, unknown> | null = null;
let fetchImpl: ((input: any, init?: any) => Promise<Response>) | null = null;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      if (fetchImpl) return fetchImpl(input, init);
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.includes("/api/iaaa/access-requests")) {
        return new Response(JSON.stringify({ requests: [] }), { status: 200 });
      }
      if (url.includes("/api/iaaa/memberships")) {
        return new Response(JSON.stringify({ memberships: [] }), { status: 200 });
      }
      if (url.includes("/api/iaaa/role-grants")) {
        return new Response(JSON.stringify({ grants: [] }), { status: 200 });
      }
      if (url.includes("/api/iaaa/logged-in-users")) {
        return new Response(
          JSON.stringify({
            users: [],
            coverage: {
              loginCountBasis: "retained audit events",
              loginCountNote: "Login counts cover retained audit events only.",
              lastSeenNote: "Last seen is the last recorded activity.",
              firstSeenNote: "First seen is the first recorded activity.",
            },
            scope: "tenant",
            tenantId: "primary",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/iaaa/bootstrap-proposals/current")) {
        return new Response(
          JSON.stringify({ entries: [], resolvedInternalUserIds: [], unresolvedEntries: [], divergence: [] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/iaaa/bootstrap-proposals")) {
        return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
      }
      if (url.includes("/api/admin/service-user/status")) {
        return new Response(
          JSON.stringify({ serviceUser: "svc-background", serviceInternalUserId: "v1:abc", platform: null, tenants: [] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/iaaa/quota-usage")) {
        return new Response(JSON.stringify({ scope: "tenant", userLogin: "someone", tenantPartition: "primary", usage: {}, overrides: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(overviewOverride ?? OVERVIEW), { status: 200 });
    }),
  );
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<IaaaAdminPanel />);
  });
  await act(async () => {});
}

function sectionPanel(sectionId: string): Element | null {
  return container.querySelector(`#iaaa-admin-overview-panel-${sectionId}`);
}

function rolesLineText(): string {
  const label = Array.from(container.querySelectorAll(".ui-label")).find(
    (el) => el.textContent === "Your roles",
  );
  return label?.parentElement?.textContent ?? "";
}

function statusLineText(): string {
  const label = Array.from(container.querySelectorAll(".ui-label")).find(
    (el) => el.textContent === "Membership status",
  );
  return label?.parentElement?.textContent ?? "";
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  overviewOverride = null;
  fetchImpl = null;
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("IaaaAdminPanel render (#6164)", () => {
  it("F1 — 'Your roles' lists live roles only; the revoked membership is named with its date", async () => {
    await renderPanel();
    const roles = rolesLineText();
    expect(roles).toContain("tenant-admin (tenant)");
    expect(roles).not.toContain("platform-admin");
    const status = statusLineText();
    expect(status).toContain("Revoked");
    expect(status).toContain(new Date(REVOKED_MS).toLocaleDateString());
  });

  it("F2 — the audit-events table has an Actor column showing the resolved login", async () => {
    await renderPanel();
    const sectionTabs = container.querySelector('[aria-label="IAAA admin overview sections"]');
    const auditTab = Array.from(sectionTabs?.querySelectorAll('[role="tab"]') ?? []).find(
      (t) => t.textContent === "Audit events",
    ) as HTMLButtonElement | undefined;
    expect(auditTab).toBeDefined();
    await act(async () => {
      auditTab!.click();
    });
    await act(async () => {});
    const section = sectionPanel("audit-events");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Actor");
    expect(section!.textContent).toContain("member-user");
  });

  it("F13 — while loading, the panel shows visible loading text, not a bare spinner", async () => {
    fetchImpl = () => new Promise<Response>(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<IaaaAdminPanel />);
    });
    await act(async () => {});
    expect(container.textContent).toContain("Loading IAAA admin");
  });
});

describe("SecurityHubHome render (#6164)", () => {
  it("F11 — the IAAA Admin card no longer claims the page is read-only", async () => {
    window.history.pushState(null, "", "/?tab=security-hub&view=iaaa-admin");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ToastProvider>
          <SecurityHubHome userLogin="tester" user={{ login: "tester", name: "Tester", avatar: "" }} />
        </ToastProvider>,
      );
    });
    await act(async () => {});
    expect(container.textContent).not.toContain("Read-only memberships");
    expect(container.textContent).toContain("Memberships, genesis & audit");
  });

  it("F12 — the Profile view with no login shows a signed-out empty state, not an empty Card", async () => {
    window.history.pushState(null, "", "/?tab=security-hub&view=profile");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ToastProvider>
          <SecurityHubHome />
        </ToastProvider>,
      );
    });
    await act(async () => {});
    expect(container.textContent).toContain("Not signed in");
  });
});
