// @vitest-environment jsdom
/**
 * #6151 S4 — the Nav & Menu Access admin panel.
 *
 * Rendered with the admin-config API + tenant list + platform
 * context stubbed: a platform admin sees the allowance editor
 * pre-checked from the stored row and the user picker for the
 * tenant's members, saving the allowance calls the API with the
 * checked ids and refreshes the platform context, a tenant admin
 * gets a read-only allowance and a writable per-user editor, and
 * a regular user gets only the info notice. A server refusal
 * (allow-list wider than the allowance) surfaces as a danger
 * toast, never a silent revert.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ToastProvider } from "../src/client/components/ui/Toast";
import NavAdminConfigPanel from "../src/client/NavAdminConfigPanel";
import type { NavAdminConfigResponse } from "../src/client/navAdminApi";
import type { StoreTier } from "../src/data/commercialPorts";

const state = vi.hoisted(() => ({
  persona: "platform-admin" as "platform-admin" | "tenant-admin" | "paid",
  config: null as NavAdminConfigResponse | null,
  saveAllowlistError: null as string | null,
}));

const mocks = vi.hoisted(() => ({
  fetchNavAdminConfig: vi.fn(),
  saveTenantAllowance: vi.fn(),
  saveUserAllowlist: vi.fn(),
  savePersonaDefault: vi.fn(),
  resetPersonaDefault: vi.fn(),
  fetchTenants: vi.fn(),
  invalidatePlatformContext: vi.fn(),
  fetchPlatformContext: vi.fn(),
}));

vi.mock("../src/client/navAdminApi", () => ({
  fetchNavAdminConfig: mocks.fetchNavAdminConfig,
  saveTenantAllowance: mocks.saveTenantAllowance,
  saveUserAllowlist: mocks.saveUserAllowlist,
  savePersonaDefault: mocks.savePersonaDefault,
  resetPersonaDefault: mocks.resetPersonaDefault,
}));

vi.mock("../src/client/tenantAdminApi", () => ({
  fetchTenants: mocks.fetchTenants,
}));

vi.mock("../src/client/platformContextStore", () => ({
  usePlatformContext: () => ({
    ok: true,
    visibleTabs: {},
    availablePresets: [],
    personaDefault: "alltabs",
    persona: state.persona,
    tier: "Subscribed" as StoreTier,
  }),
  invalidatePlatformContext: mocks.invalidatePlatformContext,
  fetchPlatformContext: mocks.fetchPlatformContext,
}));

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <NavAdminConfigPanel />
      </ToastProvider>,
    );
  });
  await flush();
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.restoreAllMocks();
  state.saveAllowlistError = null;
});

function baseConfig(): NavAdminConfigResponse {
  return {
    ok: true,
    scope: "platform",
    tenantId: "tenant-a",
    allowances: [
      {
        tenantId: "tenant-a",
        allowedIds: ["order", "chat"],
        updatedAtMs: 1,
        updatedBy: "admin-1",
      },
    ],
    allowlists: [
      {
        userId: "user-1",
        tenantId: "tenant-a",
        allowedIds: ["order"],
        savedPresetsAllowed: true,
        updatedAtMs: 1,
        updatedBy: "admin-1",
      },
    ],
    personaDefaults: [
      { persona: "platform-admin", presetKey: "alltabs", overridden: false },
      { persona: "tenant-admin", presetKey: "alltabs", overridden: false },
      { persona: "paid", presetKey: "research", overridden: true },
      { persona: "non-paid", presetKey: "alltabs", overridden: false },
    ],
    tenantMembers: [
      { tenantId: "tenant-a", userIds: ["user-1", "user-2"] },
      { tenantId: "tenant-b", userIds: ["user-3"] },
    ],
  };
}

function tenantRow(tenantId: string) {
  return {
    tenantId,
    adsEnabled: true,
    autoRefreshEnabled: false,
    autoRefreshIntervalS: 0,
    dataProviderId: "",
    brokerId: "",
    turnStepTimeoutMs: null,
    sloUptimeTargetRatio: null,
    sloP95LatencyMaxMs: null,
    memberCount: 1,
  };
}

function setup(config: NavAdminConfigResponse = baseConfig()) {
  state.config = config;
  mocks.fetchNavAdminConfig.mockResolvedValue(config);
  mocks.fetchTenants.mockResolvedValue([
    tenantRow("tenant-a"),
    tenantRow("tenant-b"),
  ]);
  mocks.saveTenantAllowance.mockResolvedValue({
    tenantId: "tenant-a",
    allowedIds: ["order"],
    updatedAtMs: 2,
    updatedBy: "admin-1",
  });
  mocks.saveUserAllowlist.mockImplementation(async () => {
    if (state.saveAllowlistError) throw new Error(state.saveAllowlistError);
    return {
      userId: "user-1",
      tenantId: "tenant-a",
      allowedIds: ["order"],
      savedPresetsAllowed: true,
      updatedAtMs: 2,
      updatedBy: "admin-1",
    };
  });
  mocks.savePersonaDefault.mockResolvedValue({
    persona: "paid",
    presetKey: "research",
    updatedAtMs: 2,
    updatedBy: "admin-1",
  });
  mocks.resetPersonaDefault.mockResolvedValue({ deleted: true });
  mocks.fetchPlatformContext.mockResolvedValue(undefined);
}

function checkboxByLabel(label: string): HTMLInputElement {
  const el = [...container.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no label ${label}`);
  // Checkbox wraps its input (implicit association); Select/TextInput
  // use htmlFor. Try both.
  const input =
    el.querySelector("input") ??
    (el.htmlFor
      ? (container.querySelector(`#${el.htmlFor}`) as HTMLInputElement | null)
      : null);
  if (!input) throw new Error(`no input for label ${label}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!el) throw new Error(`no button ${text}`);
  return el as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function selectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function selectByLabel(label: string): HTMLSelectElement {
  const el = [...container.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no label ${label}`);
  const input =
    el.querySelector("select") ??
    (el.htmlFor
      ? (container.querySelector(
          `#${el.htmlFor}`,
        ) as HTMLSelectElement | null)
      : null);
  if (!input) throw new Error(`no select for label ${label}`);
  return input;
}

describe("NavAdminConfigPanel (#6151 S4)", () => {
  it("platform admin: allowance pre-checks the stored row and the user picker lists members", async () => {
    state.persona = "platform-admin";
    setup();
    await renderPanel();
    expect(container.textContent).toContain("Nav & Menu Access");
    expect(checkboxByLabel("Fast Order Ticket").checked).toBe(true);
    expect(checkboxByLabel("Copilot Ideas").checked).toBe(true);
    const userSelect = selectByLabel("User");
    const options = [...userSelect.querySelectorAll("option")].map((o) => o.value);
    expect(options).toContain("user-1");
    expect(options).toContain("user-2");
    expect(options).not.toContain("user-3");
    expect(container.textContent).toContain("Overridden by an admin.");
  });

  it("platform admin: saving the allowance calls the API with the checked ids and refreshes context", async () => {
    state.persona = "platform-admin";
    setup();
    await renderPanel();
    await click(checkboxByLabel("Copilot Ideas"));
    expect(checkboxByLabel("Copilot Ideas").checked).toBe(false);
    await click(buttonByText("Save allowance"));
    expect(mocks.saveTenantAllowance).toHaveBeenCalledWith("tenant-a", ["order"]);
    expect(mocks.invalidatePlatformContext).toHaveBeenCalled();
    expect(mocks.fetchPlatformContext).toHaveBeenCalledWith(true);
  });

  it("tenant admin: allowance is read-only, per-user editing stays writable", async () => {
    state.persona = "tenant-admin";
    const config = baseConfig();
    config.scope = "tenant";
    setup(config);
    await renderPanel();
    expect(container.textContent).toContain("Tenant: tenant-a");
    expect(checkboxByLabel("Fast Order Ticket").disabled).toBe(true);
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Save allowance",
      ),
    ).toBe(false);
    const userSelect = selectByLabel("User");
    await selectValue(userSelect, "user-1");
    expect(checkboxByLabel("Fast Order Ticket").checked).toBe(true);
    await click(buttonByText("Save allow-list"));
    expect(mocks.saveUserAllowlist).toHaveBeenCalledWith("user-1", {
      tenantId: undefined,
      allowedIds: ["order"],
      savedPresetsAllowed: true,
    });
  });

  it("regular user: only the info notice, no editors", async () => {
    state.persona = "paid";
    setup();
    await renderPanel();
    expect(container.textContent).toContain("managed by your platform and tenant admins");
    expect(container.querySelectorAll("input[type='checkbox']").length).toBe(0);
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Save allowance",
      ),
    ).toBe(false);
  });

  it("a server refusal on the allow-list surfaces as a danger toast", async () => {
    state.persona = "platform-admin";
    state.saveAllowlistError = "FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE";
    setup();
    await renderPanel();
    const userSelect = selectByLabel("User");
    await selectValue(userSelect, "user-1");
    await click(buttonByText("Save allow-list"));
    expect(mocks.saveUserAllowlist).toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE",
    );
  });
});
