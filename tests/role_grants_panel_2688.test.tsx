/** @vitest-environment jsdom */
/**
 * Issue #2688 — RoleGrantsPanel (IAAA Admin → Overview, beside
 * Service tokens / Service user): grant list showing who granted
 * each role and when. Server decides every refusal; the panel
 * surfaces it, never hides enforcement.
 *
 * Issue #6165 — one admin-creation path: the panel no longer
 * grants or revokes. Granting and revoking happen in exactly one
 * place — Grant membership on the Members tab. This section keeps
 * only the read-only admin-role list and points at the Members
 * tab; the grant form and revoke action are retired (the
 * role-grants routes stay as deprecated aliases).
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
import { fetchRoleGrants } from "../src/client/roleGrantsApi";

vi.mock("../src/client/roleGrantsApi", () => ({
  fetchRoleGrants: vi.fn(),
  grantRoleGrant: vi.fn(),
  revokeRoleGrant: vi.fn(),
  fmtRoleGrantTime: (ms: number) => `t${ms}`,
  ROLE_GRANT_ROLE_OPTIONS: ["platform-admin", "tenant-admin"],
}));

const mockedFetch = vi.mocked(fetchRoleGrants);

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

beforeEach(() => {
  mockedFetch.mockResolvedValue([...GRANTS] as never);
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

  it("offers no grant form and no revoke — #6165 retired them to the Members tab", async () => {
    await renderPanel();
    expect(document.body.querySelector("#rgp-target")).toBeNull();
    const buttons = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(buttons).not.toContain("Grant role");
    expect(buttons).not.toContain("Revoke");
    expect(bodyText()).toContain(
      "Grant or revoke admin roles from Grant membership on the Members tab.",
    );
  });

  it("shows a denied state instead of a silently empty list", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("Forbidden: listing role grants requires admin access."));
    await renderPanel();
    expect(bodyText()).toContain("Forbidden: listing role grants requires admin access.");
  });
});
