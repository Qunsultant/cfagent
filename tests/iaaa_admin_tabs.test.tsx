/** @vitest-environment jsdom */
/**
 * #945 IAAA-UI v2 — tabbed endpoint/event explorer.
 *
 * Harness follows the established panel tests (scanner_panel.test.ts):
 * the REAL apiFetch is driven against a stubbed global fetch, and
 * components render with react-dom/client in jsdom. The tab strip uses
 * the shared Tabs primitive — tab switching is the primitive's
 * mount/unmount behavior, asserted here end to end.
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

let root: Root | null = null;
let container: HTMLDivElement;

function tabButtons(): HTMLButtonElement[] {
  // #4821 pin update (§7): the Overview tab now carries a second tab
  // bar (its section sub-tabs), so the top-level tabs are scoped to
  // their own bar instead of every [role="tab"] on the page.
  const bar = container.querySelector('[aria-label="IAAA admin sections"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

function tabLabels(): string[] {
  return tabButtons().map((b) => b.textContent ?? "");
}

// #4821: the Overview tab's section sub-tab bar.
function sectionTabButtons(): HTMLButtonElement[] {
  const bar = container.querySelector('[aria-label="IAAA admin overview sections"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<IaaaAdminPanel />);
  });
  await flush();
}

beforeEach(() => {
  // Issue #2776: panel tabs are URL-synced, so a tab click in one test
  // writes ?iaaaTab= into the shared jsdom URL and would leak into the
  // next test's initial tab. Every test starts from a clean URL.
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // #6438: the panel fetches the served catalogue once the
      // overview gate passes — the stub serves a valid payload for
      // it, so the MCP tab lists served tools.
      if (String(url).includes("/api/mcp/catalog")) {
        return new Response(
          JSON.stringify({
            tools: [
              { name: "knowledge_search", description: "Search the knowledge base", scope: "mcp:read", inputSchema: { type: "object", properties: {}, required: [] } },
            ],
            resources: [],
            prompts: [],
            server: { name: "openaimp", title: "Multi-Agent Studio Enterprise MCP Server", version: "1.0.0", protocolVersion: "2024-11-05" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(OVERVIEW), { status: 200 });
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("IAAA admin tabs", () => {
  it("renders six tabs and starts on Overview with the v1 content intact", async () => {
    await renderPanel();
    // #1758 pin update (§7): the Members tab joins the five v1/v2 tabs.
    // #3121 S2: the Queue tab moved out — the admin queue is now a
    // view of the schedules home (`?tab=schedules&view=queue`).
    expect(tabLabels()).toEqual(["Overview", "Members", "API", "MCP", "IAAA", "Correlations"]);
    expect(container.textContent).toContain("primary");
    expect(container.textContent).toContain("platform-admin (platform)");
    expect(container.textContent).toContain("Completed");
    // #4821 pin update (§7): the Overview is sub-tabbed now — the
    // default Summary shows the tenant summary, and the audit events
    // live on the Audit events sub-tab, not on the landing screen.
    expect(container.textContent).not.toContain("auth.login");
    await act(async () => {
      sectionTabButtons()[8].click();
    });
    expect(container.textContent).toContain("auth.login");
  });

  it("switching to API shows the endpoint table, and back to Overview restores v1", async () => {
    await renderPanel();
    // #1758 pin update (§7): Members is now index 1, so API moves to 2.
    const api = tabButtons()[2];
    await act(async () => {
      api.click();
    });
    expect(container.textContent).toContain("/api/iaaa/overview");
    expect(container.textContent).toContain("platform-admin");
    expect(container.textContent).not.toContain("Recent audit events");
    const overview = tabButtons()[0];
    await act(async () => {
      overview.click();
    });
    // #4821 pin update (§7): returning to Overview lands on the
    // Summary sub-tab; the audit events are one click further in.
    expect(container.textContent).not.toContain("Recent audit events");
    await act(async () => {
      sectionTabButtons()[8].click();
    });
    expect(container.textContent).toContain("Recent audit events");
  });

  it("MCP tab lists served catalog tools, IAAA tab lists events and gaps, Correlations shows UNMAPPED rows", async () => {
    await renderPanel();
    // #6438: the MCP tab reads the served catalogue, which arrives on
    // a second fetch after the overview gate passes — wait for both
    // round-trips before opening the tab.
    await flush();
    // #1758 pin update (§7): tab indices shift by one after Members.
    await act(async () => {
      tabButtons()[3].click();
    });
    expect(container.textContent).toContain("knowledge_search");
    await act(async () => {
      tabButtons()[4].click();
    });
    expect(container.textContent).toContain("auth.logout");
    expect(container.textContent).toContain("PDP denial");
    await act(async () => {
      tabButtons()[5].click();
    });
    expect(container.textContent).toContain("UNMAPPED");
  });

  it("#3121 S2: no Queue tab — the admin queue is a schedules-home view now", async () => {
    await renderPanel();
    expect(tabLabels()).not.toContain("Queue");
    expect(container.textContent).not.toContain("Queue dump");
    expect(container.textContent).not.toContain("Cancel all schedules");
  });

  it("#2173: overview with adminCounts renders the counts section and per-tenant breakdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...OVERVIEW,
            adminCounts: {
              platformAdmins: 2,
              tenantAdminsTotal: 3,
              tenantAdminsByTenant: [
                { tenantId: "acme", count: 2 },
                { tenantId: "primary", count: 1 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    await renderPanel();
    expect(container.textContent).toContain("Admin counts");
    expect(container.textContent).toContain("Platform admins");
    expect(container.textContent).toContain("Tenant admins (all tenants)");
    expect(container.textContent).toContain("acme");
    expect(container.textContent).toContain("primary");
  });

  it("a 403 still shows the not-admin state and no tabs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })),
    );
    await renderPanel();
    expect(container.textContent).toContain("Not an IAAA admin");
    expect(tabButtons()).toEqual([]);
  });
});
