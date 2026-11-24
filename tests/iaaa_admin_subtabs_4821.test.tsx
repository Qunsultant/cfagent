/** @vitest-environment jsdom */
/**
 * #4821 — every stacked Overview section becomes its own sub-tab of
 * iaaa-admin (re-filed from #4680).
 *
 * Harness mirrors iaaa_admin_tabs.test.tsx: the REAL apiFetch is driven
 * against a stubbed global fetch, components render with
 * react-dom/client in jsdom. The Overview tab gains a second tab bar
 * (param `iaaaSection`, default `summary`); each section's panel mounts
 * only while its sub-tab is active (TabPanel default unmount).
 *
 * Red first (§7): these tests fail on the stacked Overview — the
 * section bar, the section param, and the lazy access-requests load do
 * not exist yet.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IaaaAdminPanel } from "../src/client/IaaaAdminPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OVERVIEW = {
  tenantId: "primary",
  callerInternalUserId: "11111111-1111-4111-8111-111111111111",
  memberships: [
    {
      membershipId: "m-1",
      internalUserId: "11111111-1111-4111-8111-111111111111",
      tenantId: "primary",
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      createdBy: "system:bootstrap-genesis",
      createdAtMs: 1792660000000,
    },
  ],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [
    {
      id: "evt-1",
      timestamp: 1792660000000,
      type: "auth.login",
      actorPrincipalId: "11111111-1111-4111-8111-111111111111",
      initiatingPrincipalId: "11111111-1111-4111-8111-111111111111",
      action: "auth.login",
      decision: "allow",
      outcome: "succeeded",
      correlationId: "corr-1",
    },
  ],
};

const SECTION_LABELS = [
  "Summary",
  "Service user",
  "Service tokens",
  "Role grants",
  "Bootstrap proposals",
  "Logged-in users",
  "Deactivate",
  "Access requests",
  "Audit events",
  // #5160 adds the "Identity profile" section (attribute set +
  // retention config, platform-admin only).
  "Identity profile",
];

let root: Root | null = null;
let container: HTMLDivElement;
let fetchUrls: string[] = [];

function stubFetch() {
  fetchUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      fetchUrls.push(url);
      if (url.includes("/api/iaaa/access-requests")) {
        return new Response(JSON.stringify({ requests: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(OVERVIEW), { status: 200 });
    }),
  );
}

function sectionTabButtons(): HTMLButtonElement[] {
  const bar = container.querySelector('[aria-label="IAAA admin overview sections"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

function sectionTabLabels(): string[] {
  return sectionTabButtons().map((b) => b.textContent ?? "");
}

function sectionPanel(sectionId: string): Element | null {
  return container.querySelector(`#iaaa-admin-overview-panel-${sectionId}`);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<IaaaAdminPanel />);
  });
  // Flush the post-load effects (access-requests load, if any).
  await act(async () => {});
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
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

describe("IAAA admin overview sub-tabs (#4821)", () => {
  it("Overview renders the ten section sub-tabs and starts on Summary", async () => {
    await renderPanel();
    expect(sectionTabLabels()).toEqual(SECTION_LABELS);
    // Summary: tenant summary + genesis, no other section mounted.
    expect(container.textContent).toContain("primary");
    expect(container.textContent).toContain("Completed");
    expect(sectionPanel("summary")).not.toBeNull();
    expect(sectionPanel("service-tokens")).toBeNull();
    expect(sectionPanel("audit-events")).toBeNull();
    expect(container.textContent).not.toContain("Recent audit events");
    expect(container.textContent).not.toContain("auth.login");
  });

  it("a deep link to a section lands on that section and mounts only it", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=security-hub&view=iaaa-admin&iaaaTab=overview&iaaaSection=service-tokens",
    );
    await renderPanel();
    expect(sectionPanel("service-tokens")).not.toBeNull();
    expect(sectionPanel("summary")).toBeNull();
    expect(sectionPanel("audit-events")).toBeNull();
    const selected = sectionTabButtons().find(
      (b) => b.getAttribute("aria-selected") === "true",
    );
    expect(selected?.textContent).toBe("Service tokens");
  });

  it("clicking a section sub-tab writes iaaaSection into the URL and swaps the mount", async () => {
    await renderPanel();
    await act(async () => {
      sectionTabButtons()[8].click();
    });
    expect(window.location.search).toContain("iaaaSection=audit-events");
    expect(sectionPanel("audit-events")).not.toBeNull();
    expect(sectionPanel("summary")).toBeNull();
    expect(container.textContent).toContain("Recent audit events");
    expect(container.textContent).toContain("auth.login");
  });

  it("an unknown iaaaSection falls back to Summary", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=security-hub&view=iaaa-admin&iaaaTab=overview&iaaaSection=bogus",
    );
    await renderPanel();
    expect(sectionPanel("summary")).not.toBeNull();
    expect(sectionPanel("service-tokens")).toBeNull();
  });

  it("legacy ?iaaaTab= links keep working; the section bar lives only on Overview", async () => {
    window.history.replaceState(
      null,
      "",
      "/?tab=security-hub&view=iaaa-admin&iaaaTab=members",
    );
    await renderPanel();
    expect(container.textContent).toContain("Grant membership");
    expect(sectionTabButtons()).toEqual([]);
    // ?iaaaTab=overview with no section is the legacy Overview address.
    window.history.replaceState(
      null,
      "",
      "/?tab=security-hub&view=iaaa-admin&iaaaTab=overview",
    );
    await act(async () => {
      root!.unmount();
    });
    await renderPanel();
    expect(sectionPanel("summary")).not.toBeNull();
  });

  it("access requests load only when their sub-tab is visited", async () => {
    await renderPanel();
    expect(fetchUrls.filter((u) => u.includes("/api/iaaa/access-requests"))).toEqual([]);
    expect(fetchUrls.filter((u) => u.includes("/api/iaaa/overview")).length).toBeGreaterThan(0);
    await act(async () => {
      sectionTabButtons()[7].click();
    });
    expect(fetchUrls.filter((u) => u.includes("/api/iaaa/access-requests")).length).toBe(1);
    expect(container.textContent).toContain("No access requests");
  });

  it("each section panel has exactly one live mount in the Overview; no policy proposals", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/client/IaaaAdminPanel.tsx"),
      "utf8",
    );
    // Scope the count to the Overview TabPanel: RoleGrantsPanel and
    // LoggedInUsersPanel legitimately mount a second time in the
    // tenant-admin limited view above (server-scoped), which is not
    // part of this restructure — the pin is one mount per Overview
    // section, not one mount in the file.
    const overviewStart = src.indexOf('tabId="overview"');
    const membersStart = src.indexOf('tabId="members"');
    expect(overviewStart).toBeGreaterThan(-1);
    expect(membersStart).toBeGreaterThan(overviewStart);
    const overview = src.slice(overviewStart, membersStart);
    for (const panel of [
      "ServiceUserSection",
      "ServiceTokensPanel",
      "RoleGrantsPanel",
      "BootstrapProposalsPanel",
      "LoggedInUsersPanel",
    ]) {
      expect(overview.split(`<${panel}`).length - 1).toBe(1);
    }
    // #4658: policy proposals live on the PAP tab now, never here.
    expect(src).not.toContain("<PolicyProposalsPanel");
  });
});
