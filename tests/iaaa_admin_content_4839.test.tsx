/** @vitest-environment jsdom */
/**
 * #4839 — IAAA Admin content pass: make the page useful.
 *
 * Harness mirrors iaaa_admin_subtabs_4821.test.tsx: the REAL apiFetch is
 * driven against a stubbed global fetch, components render with
 * react-dom/client in jsdom.
 *
 * Red first (§7): these tests assert the new copy (page intro, Summary
 * heading, closed dead ends, section intros, grant explainers, visible
 * form labels, corrected Access-requests wording, success-toned
 * deactivation, deduped Logged-in-users intro, Audit-events scope,
 * API endpoint count). They fail on the pre-#4839 copy.
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

const QUOTA_WINDOW = {
  window: "daily",
  limit: 10,
  usage: 2,
  remaining: 8,
  resetAtMs: 1792700000000,
  resetAtIso: "2026-11-16T00:00:00.000Z",
  overrides: [],
};

let root: Root | null = null;
let container: HTMLDivElement;
let overviewOverride: Record<string, unknown> | null = null;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/iaaa/deactivate") && method === "POST") {
        return new Response(JSON.stringify({ verified: true, residuals: [] }), { status: 200 });
      }
      if (url.includes("/api/iaaa/access-requests")) {
        return new Response(JSON.stringify({ requests: [] }), { status: 200 });
      }
      if (url.includes("/api/admin/service-user/status")) {
        return new Response(
          JSON.stringify({
            serviceUser: "svc-background",
            serviceInternalUserId: "v1:abc",
            platform: null,
            tenants: [],
          }),
          { status: 200 },
        );
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
      if (url.includes("/api/iaaa/quota-usage")) {
        return new Response(
          JSON.stringify({
            scope: "tenant",
            userLogin: "someone",
            tenantPartition: "primary",
            usage: { daily: QUOTA_WINDOW, weekly: QUOTA_WINDOW, monthly: QUOTA_WINDOW },
            overrides: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/iaaa/bootstrap-proposals/current")) {
        return new Response(
          JSON.stringify({
            entries: [],
            resolvedInternalUserIds: [],
            unresolvedEntries: [],
            divergence: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/iaaa/bootstrap-proposals")) {
        return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
      }
      if (url.includes("/api/iaaa/memberships")) {
        return new Response(JSON.stringify({ memberships: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(overviewOverride ?? OVERVIEW), { status: 200 });
    }),
  );
}

function topTabButtons(): HTMLButtonElement[] {
  const bar = container.querySelector('[aria-label="IAAA admin sections"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

function sectionTabButtons(): HTMLButtonElement[] {
  const bar = container.querySelector('[aria-label="IAAA admin overview sections"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
}

function sectionPanel(sectionId: string): Element | null {
  return container.querySelector(`#iaaa-admin-overview-panel-${sectionId}`);
}

function visibleLabels(): string[] {
  return Array.from(container.querySelectorAll("label")).map((l) => l.textContent ?? "");
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

async function openSection(index: number) {
  await act(async () => {
    sectionTabButtons()[index].click();
  });
  await act(async () => {});
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  overviewOverride = null;
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

describe("IAAA Admin content pass (#4839)", () => {
  it("G1 — the page states its purpose above the tab bar", async () => {
    await renderPanel();
    const heading = container.querySelector("h4");
    expect(heading?.textContent).toBe("IAAA Admin");
    expect(container.textContent).toContain("Identity and access administration");
    expect(container.textContent).toContain("tenant admins see only their own tenant");
  });

  it("G2 — the Summary section has a heading like every other section", async () => {
    await renderPanel();
    const summary = sectionPanel("summary");
    expect(summary).not.toBeNull();
    const heading = summary!.querySelector("h4");
    expect(heading?.textContent).toBe("Summary");
  });

  it("G3 — genesis not yet occurred explains itself and points to Bootstrap proposals", async () => {
    overviewOverride = { ...OVERVIEW, genesis: { platformGenesisOccurred: false } };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Not yet occurred");
    expect(text).toContain("first platform admin comes from the bootstrap list");
    expect(text).toContain("Bootstrap proposals");
  });

  it("G3 — no roles points at how to get a role", async () => {
    overviewOverride = { ...OVERVIEW, memberships: [] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("None");
    expect(text).toContain("ask a platform admin to grant you a role from the Members tab");
  });

  it("G4 — the Service user section explains itself before the button", async () => {
    await renderPanel();
    await openSection(1);
    const text = container.textContent ?? "";
    expect(text).toContain("platform's own identity for background work");
    expect(text).toContain("Provision creates that tier");
  });

  it("G5 — the one grant surface explains itself; Role grants points at it (#6165)", async () => {
    await renderPanel();
    // Members tab: Grant membership is the one place admin roles are granted.
    await act(async () => {
      topTabButtons()[1].click();
    });
    await act(async () => {});
    const membersText = container.textContent ?? "";
    expect(membersText).toContain("Grant membership here is the one place admin roles are granted");
    // Role grants section: read-only list that points at the Members tab.
    await act(async () => {
      topTabButtons()[0].click();
    });
    await act(async () => {});
    await openSection(3);
    const grantsText = container.textContent ?? "";
    expect(grantsText).toContain("Grant or revoke admin roles from Grant membership on the Members tab.");
  });

  it("G6 — the one grant form says where an internal user id comes from (#6165)", async () => {
    await renderPanel();
    await act(async () => {
      topTabButtons()[1].click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("Memberships table below");
    expect(container.textContent).toContain("/api/me");
    // Role grants has no grant form anymore — no target input to explain.
    await act(async () => {
      topTabButtons()[0].click();
    });
    await act(async () => {});
    await openSection(3);
    expect(container.querySelector("#rgp-target")).toBeNull();
  });

  it("G7 — the Members role and scope dropdowns say what each option can do", async () => {
    await renderPanel();
    await act(async () => {
      topTabButtons()[1].click();
    });
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("approver — approves actions only");
    expect(text).toContain("auditor — reads tasks, artifacts, and the audit trail");
    expect(text).toContain("workspace-admin — all permissions within one workspace");
    expect(text).toContain("tenant-admin — all permissions within one tenant");
    expect(text).toContain("platform-admin — assigns admin roles");
    expect(text).toContain("platform — the whole platform");
  });

  it("G8 — the Bootstrap propose form fields have visible labels", async () => {
    await renderPanel();
    await openSection(4);
    const labels = visibleLabels();
    expect(labels).toContain("Change action");
    expect(labels).toContain("Bootstrap identifier");
    expect(labels).toContain("Proposal reason");
  });

  it("G8 — the Logged-in users quota block fields have visible labels", async () => {
    await renderPanel();
    await openSection(5);
    // The lookup field is always rendered; the override fields render
    // once a quota lookup returns data.
    expect(visibleLabels()).toContain("User login");
    const userLoginLabel = [...container.querySelectorAll("label")].find(
      (l) => (l.textContent ?? "") === "User login",
    );
    const loginInput = userLoginLabel?.htmlFor
      ? (container.querySelector(`#${userLoginLabel.htmlFor}`) as HTMLInputElement | null)
      : null;
    expect(loginInput).not.toBeNull();
    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(loginInput!, "someone");
    });
    const lookupButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Look up quota"),
    );
    await act(async () => {
      lookupButton!.click();
    });
    await act(async () => {});
    const labels = visibleLabels();
    expect(labels).toContain("Override window");
    expect(labels).toContain("Extra runs");
    expect(labels).toContain("Override reason");
  });

  it("G9 — the Access requests intro states the two-admin rule and no audit sentence lives there", async () => {
    await renderPanel();
    await openSection(7);
    const panel = sectionPanel("access-requests");
    const text = panel?.textContent ?? "";
    expect(text).toContain("second, distinct admin");
    expect(text).not.toContain("Audit events are read-only");
    const headers = [...(panel?.querySelectorAll("th") ?? [])].map((h) => h.textContent);
    // The table renders only with requests; the header set is asserted
    // on the empty state copy instead — the intro must not misstate.
    expect(text).toContain("Membership grant, revoke, and edit live on the Members tab");
    expect(headers).not.toContain("Requested");
  });

  it("G9 — the Requested column header labels a timestamp", async () => {
    // A pending request renders the table; the header must read
    // "Requested at", not the bare "Requested".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init?: any) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        if (url.includes("/api/iaaa/access-requests")) {
          return new Response(
            JSON.stringify({
              requests: [
                {
                  requestId: "r-1",
                  requesterInternalUserId: "v1:abc",
                  requestedRole: "tenant-admin",
                  status: "pending",
                  createdAtMs: 1792660000000,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(OVERVIEW), { status: 200 });
      }),
    );
    await renderPanel();
    await openSection(7);
    const panel = sectionPanel("access-requests");
    const headers = [...(panel?.querySelectorAll("th") ?? [])].map((h) => h.textContent);
    expect(headers).toContain("Requested at");
    expect(headers).not.toContain("Requested");
  });

  it("G10 — a verified deactivation renders as success and states the way back", async () => {
    await renderPanel();
    await openSection(6);
    expect(container.textContent).toContain("sign in again");
    expect(container.textContent).toContain("re-grant your roles from the Members tab");
    const buttons = [...container.querySelectorAll("button")];
    const arm = buttons.find((b) => (b.textContent ?? "").includes("Deactivate my account"));
    await act(async () => {
      arm!.click();
    });
    const confirm = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Confirm deactivation"),
    );
    await act(async () => {
      confirm!.click();
    });
    await act(async () => {});
    const success = container.querySelector(".tone-success");
    expect(success).not.toBeNull();
    expect(success?.textContent).toContain("Deactivated:");
  });

  it("G11 — the Logged-in users intro no longer repeats itself", async () => {
    await renderPanel();
    await openSection(5);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Each row below is one active login session");
    expect(text).toContain("Each row is one active login session");
  });

  it("G12 — the Audit events sub-tab states its scope, legend, and taxonomy link", async () => {
    await renderPanel();
    await openSection(8);
    const text = container.textContent ?? "";
    expect(text).toContain("100 most recent audit events for this tenant");
    expect(text).toContain("Audit events are read-only");
    expect(text).toContain("Decision is allow or deny");
    expect(text).toContain("Outcome is whether the action succeeded, failed, or is unknown");
    const taxonomyButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("IAAA tab taxonomy"),
    );
    expect(taxonomyButton).toBeDefined();
    await act(async () => {
      taxonomyButton!.click();
    });
    await act(async () => {});
    const selected = topTabButtons().find((b) => b.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toBe("IAAA");
  });

  it("G13 — the API tab shows an endpoint count like the MCP tab shows counts", async () => {
    await renderPanel();
    await act(async () => {
      topTabButtons()[2].click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("Endpoints (");
  });
});
