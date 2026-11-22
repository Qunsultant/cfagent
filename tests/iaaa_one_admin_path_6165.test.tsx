/** @vitest-environment jsdom */
/**
 * Issue #6165 — one admin-creation path: the Members tab is the ONE
 * grant surface. The Role grants section (Overview) is a read-only
 * admin-role list that points at the Members tab; its grant form and
 * revoke action are retired, and the role-grants grant/revoke routes
 * are deprecated aliases of the membership-grant route (same minting
 * seam, no behavior change). The bootstrap path is unchanged by this
 * slice: IAAA_BOOTSTRAP_ADMINS env list + login-path provisioning +
 * genesis claim, with the Bootstrap proposals panel (#3077) as the
 * one proposal flow.
 *
 * Harness mirrors tests/role_grants_panel_2688.test.tsx: the real api
 * client module is mocked, the panel renders with react-dom/client
 * in jsdom.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("issue #6165: one admin-creation path", () => {
  it("Role grants has no grant form — the Members tab is the one grant surface", async () => {
    await renderPanel();
    expect(document.body.querySelector("#rgp-target")).toBeNull();
    const buttons = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(buttons).not.toContain("Grant role");
    expect(bodyText()).toContain(
      "Grant or revoke admin roles from Grant membership on the Members tab.",
    );
  });

  it("Role grants list stays read-only — no revoke action", async () => {
    await renderPanel();
    expect(bodyText()).toContain("https://github.com:12345");
    expect(bodyText()).toContain("tenant-admin");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(buttons).not.toContain("Revoke");
    expect(buttons).not.toContain("Confirm revoke");
  });

  it("the role-grants grant/revoke routes are marked deprecated, naming the Members-tab replacement", () => {
    const auth = readFileSync(path.join(repoRoot, "src/server/routes/auth.ts"), "utf8");
    for (const route of ["/api/iaaa/role-grants/grant", "/api/iaaa/role-grants/revoke"]) {
      const at = auth.indexOf(`if (path === "${route}")`);
      expect(at, `${route} handler present`).toBeGreaterThan(-1);
      const window = auth.slice(Math.max(0, at - 1200), at);
      expect(window).toMatch(/Deprecated:.*\/api\/iaaa\/membership\/grant/);
    }
  });

  it("the role-grants client grant/revoke fns are marked @deprecated", () => {
    const api = readFileSync(
      path.join(repoRoot, "src/client/roleGrantsApi.ts"),
      "utf8",
    );
    for (const fn of ["grantRoleGrant", "revokeRoleGrant"]) {
      const at = api.indexOf(`export async function ${fn}`);
      expect(at, `${fn} still exported`).toBeGreaterThan(-1);
      const window = api.slice(Math.max(0, at - 600), at);
      expect(window).toContain("@deprecated");
    }
  });
});
