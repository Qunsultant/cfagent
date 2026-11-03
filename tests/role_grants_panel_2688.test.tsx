/** @vitest-environment jsdom */
/**
 * Issue #2688 — RoleGrantsPanel (IAAA Admin → Overview, beside
 * Service tokens / Service user): grant form for platform-admin /
 * tenant-admin only, grant list showing who granted each role and
 * when, and revoke-with-confirm per grant. Server decides every
 * refusal; the panel surfaces it, never hides enforcement.
 *
 * Harness mirrors tests/service_tokens_panel_2681.test.tsx: the
 * real api client module is mocked, the panel renders with
 * react-dom/client in jsdom.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoleGrantsPanel } from "../src/client/RoleGrantsPanel";
import {
  fetchRoleGrants,
  grantRoleGrant,
  revokeRoleGrant,
} from "../src/client/roleGrantsApi";

vi.mock("../src/client/roleGrantsApi", () => ({
  fetchRoleGrants: vi.fn(),
  grantRoleGrant: vi.fn(),
  revokeRoleGrant: vi.fn(),
  fmtRoleGrantTime: (ms: number) => `t${ms}`,
  ROLE_GRANT_ROLE_OPTIONS: ["platform-admin", "tenant-admin"],
}));

const mockedFetch = vi.mocked(fetchRoleGrants);
const mockedGrant = vi.mocked(grantRoleGrant);
const mockedRevoke = vi.mocked(revokeRoleGrant);

let container: HTMLDivElement;
let root: Root;

const GRANTS = [
  {
    grantId: "m-1:0",
    membershipId: "m-1",
    bindingIndex: 0,
    internalUserId: "v1:target00000000000000000000000000000000000000000001",
    identity: "https://github.com:12345",
    email: null,
    tenantId: "primary",
    role: "tenant-admin",
    scope: "tenant",
    grantedBy: "v1:admin000000000000000000000000000000000000000000001",
    grantedAtMs: 1_800_000_000_000,
    revoked: false,
  },
];

function bodyText(): string {
  return document.body.textContent ?? "";
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RoleGrantsPanel />);
  });
}

async function click(label: string) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) throw new Error(`button not found: ${label}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInput(id: string, value: string) {
  const el = document.body.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  if (!el) throw new Error(`No input #${id}`);
  // React controlled inputs ignore plain .value assignment in jsdom;
  // drive the native setter so React's onChange fires (same pattern
  // as tests/service_tokens_panel_2681.test.tsx).
  const proto =
    el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  mockedFetch.mockResolvedValue([...GRANTS] as never);
  mockedGrant.mockResolvedValue({ grant: GRANTS[0] } as never);
  mockedRevoke.mockResolvedValue({ ok: true } as never);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  vi.clearAllMocks();
});

describe("issue #2688: RoleGrantsPanel", () => {
  it("lists grants with identity, grantor, and grant time", async () => {
    await renderPanel();
    expect(bodyText()).toContain("https://github.com:12345");
    expect(bodyText()).toContain("tenant-admin");
    expect(bodyText()).toContain("v1:admin000000000000000000000000000000000000000000001");
    expect(bodyText()).toContain("t1800000000000");
  });

  it("grants through the API and reloads the list", async () => {
    await renderPanel();
    setInput("rgp-target", "v1:new0000000000000000000000000000000000000000000001");
    await click("Grant role");
    expect(mockedGrant).toHaveBeenCalledWith(
      expect.objectContaining({ internalUserId: "v1:new0000000000000000000000000000000000000000000001", role: "tenant-admin" }),
    );
    expect(mockedFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("revokes only after confirm, and surfaces a server refusal", async () => {
    await renderPanel();
    await click("Revoke");
    expect(mockedRevoke).not.toHaveBeenCalled();
    await click("Confirm revoke");
    expect(mockedRevoke).toHaveBeenCalledWith("m-1", 0);
    mockedFetch.mockResolvedValueOnce([...GRANTS] as never);
    mockedRevoke.mockRejectedValueOnce(new Error("Forbidden: revoke denied."));
    await renderPanel();
    await click("Revoke");
    await click("Confirm revoke");
    expect(bodyText()).toContain("Forbidden: revoke denied.");
  });

  it("shows a denied state instead of a silently empty list", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("Forbidden: listing role grants requires admin access."));
    await renderPanel();
    expect(bodyText()).toContain("Forbidden: listing role grants requires admin access.");
  });
});
