/** @vitest-environment jsdom */
/**
 * Issue #4513 — Tenant administration panel: every create settles
 * with a plain outcome. A created tenant is confirmed by message
 * and visible in the list; a request that never returns surfaces
 * a timeout message instead of spinning forever. API modules are
 * mocked: the panel is under test, not the routes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiFetchTimeoutError } from "../src/client/apiFetch";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type TenantRow = {
  tenantId: string;
  adsEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalS: number;
  dataProviderId: string;
  brokerId: string;
  memberCount: number;
};

function settingsRow(tenantId: string): TenantRow {
  return {
    tenantId,
    adsEnabled: true,
    autoRefreshEnabled: false,
    autoRefreshIntervalS: 15,
    dataProviderId: "etrade",
    brokerId: "etrade",
    memberCount: 0,
  };
}

let rows: TenantRow[] = [settingsRow("tenant-a")];

const fetchTenantsMock = vi.fn(async () => [...rows]);
const createTenantMock = vi.fn(async (tenantId: string) => {
  const created = settingsRow(tenantId);
  rows = [...rows, created];
  return created;
});
const fetchTenantDetailMock = vi.fn(async (tenantId: string) => ({
  ...settingsRow(tenantId),
  members: [],
}));
const updateTenantSettingsMock = vi.fn(async (tenantId: string) => settingsRow(tenantId));
const fetchMembershipsMock = vi.fn(async () => []);

vi.mock("../src/client/tenantAdminApi", () => ({
  fetchTenants: (...args: unknown[]) => fetchTenantsMock(...args),
  createTenant: (...args: unknown[]) => createTenantMock(...args),
  fetchTenantDetail: (...args: unknown[]) => fetchTenantDetailMock(...args),
  updateTenantSettings: (...args: unknown[]) => updateTenantSettingsMock(...args),
}));
vi.mock("../src/client/iaaaAdminApi", () => ({
  fetchMemberships: (...args: unknown[]) => fetchMembershipsMock(...args),
}));

import { TenantAdminPanel } from "../src/client/TenantAdminPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rows = [settingsRow("tenant-a")];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function setNewTenantId(value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function createButton(): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Create tenant"),
  ) as HTMLButtonElement;
}

async function clickCreate() {
  await act(async () => {
    createButton().click();
  });
}

describe("tenant admin panel create outcome (#4513)", () => {
  it("confirms a created tenant by message and shows the new row", async () => {
    await render(<TenantAdminPanel />);
    setNewTenantId("acme");
    await clickCreate();

    expect(createTenantMock).toHaveBeenCalledWith("acme");
    expect(container.textContent).toContain("Tenant acme created.");
    expect(container.textContent).toContain("acme");
    expect(fetchTenantsMock.mock.calls.length).toBeGreaterThan(1);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(createButton().disabled).toBe(false);
  });

  it("shows a timeout message and re-enables the button when the request never returns", async () => {
    createTenantMock.mockRejectedValueOnce(new ApiFetchTimeoutError(30_000));
    await render(<TenantAdminPanel />);
    setNewTenantId("acme");
    await clickCreate();

    expect(container.textContent).toContain(
      "The create request timed out. Check the tenant list — if the tenant is not there, try again.",
    );
    expect(container.textContent).not.toContain("Tenant acme created.");
    expect(createButton().disabled).toBe(false);
  });

  it("shows the server failure message when the create is refused", async () => {
    createTenantMock.mockRejectedValueOnce(
      new Error("Forbidden: tenant administration requires a store operator."),
    );
    await render(<TenantAdminPanel />);
    setNewTenantId("acme");
    await clickCreate();

    expect(container.textContent).toContain(
      "Forbidden: tenant administration requires a store operator.",
    );
    expect(container.textContent).not.toContain("Tenant acme created.");
  });

  it("asks for a tenant id when the input is empty", async () => {
    await render(<TenantAdminPanel />);
    await clickCreate();

    expect(container.textContent).toContain("Enter a tenant id to create.");
    expect(createTenantMock).not.toHaveBeenCalled();
  });
});
