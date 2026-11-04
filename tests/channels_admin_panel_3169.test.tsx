/** @vitest-environment jsdom */
/**
 * Issue #3169 (program #2218) — Channels administration panel.
 *
 * The panel lists tenants (from the tenant admin read path),
 * loads the selected tenant's channel flags, and toggles one
 * flag per click. API modules are mocked: the panel is under
 * test, not the routes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchTenantsMock = vi.fn(async () => [
  {
    tenantId: "tenant-a",
    adsEnabled: true,
    autoRefreshEnabled: false,
    autoRefreshIntervalS: 15,
    dataProviderId: "etrade",
    brokerId: "etrade",
    memberCount: 1,
  },
]);
const fetchTenantChannelsMock = vi.fn(async () => ({
  email: true,
  slack: true,
  webhook: true,
  copilot: true,
  docs: true,
}));
const updateTenantChannelsMock = vi.fn(async (_tenantId: string, patch: Record<string, boolean>) => ({
  email: true,
  slack: true,
  webhook: true,
  copilot: true,
  docs: true,
  ...patch,
}));

vi.mock("../src/client/tenantAdminApi", () => ({
  fetchTenants: (...args: unknown[]) => fetchTenantsMock(...args),
}));
vi.mock("../src/client/channelAdminApi", () => ({
  fetchTenantChannels: (...args: unknown[]) => fetchTenantChannelsMock(...args),
  updateTenantChannels: (...args: unknown[]) => updateTenantChannelsMock(...args),
  TENANT_CHANNEL_META: [
    { id: "email", label: "Email", description: "Outbound email delivery for this tenant." },
    { id: "slack", label: "Slack", description: "Slack delivery for this tenant." },
    { id: "webhook", label: "Webhook", description: "Outbound webhook delivery for this tenant." },
    { id: "copilot", label: "Copilot card", description: "Copilot card rendering for this tenant." },
    { id: "docs", label: "Docs", description: "Docs delivery for this tenant." },
  ],
}));

import { ChannelsAdminPanel } from "../src/client/ChannelsAdminPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function checkboxes(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="checkbox"]'));
}

describe("channels admin panel (#3169)", () => {
  it("lists tenants and loads the selected tenant's five channel flags", async () => {
    await render(<ChannelsAdminPanel />);
    expect(container.textContent).toContain("tenant-a");
    const tenantButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("tenant-a"),
    ) as HTMLElement;
    await act(async () => {
      tenantButton.click();
    });
    expect(fetchTenantChannelsMock).toHaveBeenCalledWith("tenant-a");
    const boxes = checkboxes();
    expect(boxes).toHaveLength(5);
    expect(boxes.every((b) => b.checked)).toBe(true);
    for (const label of ["Email", "Slack", "Webhook", "Copilot card", "Docs"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("toggling a flag patches exactly that flag", async () => {
    await render(<ChannelsAdminPanel />);
    const tenantButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("tenant-a"),
    ) as HTMLElement;
    await act(async () => {
      tenantButton.click();
    });
    const slackBox = checkboxes()[1];
    await act(async () => {
      slackBox.click();
    });
    expect(updateTenantChannelsMock).toHaveBeenCalledWith("tenant-a", { slack: false });
  });

  it("shows an error notice when the tenant list fails", async () => {
    fetchTenantsMock.mockRejectedValueOnce(new Error("Forbidden: not an operator."));
    await render(<ChannelsAdminPanel />);
    expect(container.textContent).toContain("Forbidden: not an operator.");
  });
});
