/** @vitest-environment jsdom */
/**
 * Issue #3247 (slice 2 of #3241) — the free-access grant section
 * in the Accounts admin panel.
 *
 * Harness follows tests/unlimited_free_grant_3245_ui.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed
 * fetch. The section reads the grant through the free-access GET
 * route and writes grants through the grant/revoke POST routes;
 * no network, no key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FreeAccessGrantSection } from "../src/client/FreeAccessGrantSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function selectForLabel(labelText: string): HTMLSelectElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const select = (id ? document.getElementById(id) : null) as HTMLSelectElement | null;
  if (!select) throw new Error(`No select found for label: ${labelText}`);
  return select;
}

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function grantRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fa1",
    login: "u1",
    kind: "lifetime",
    grantedBy: "op1",
    grantedAtMs: Date.UTC(2026, 10, 12),
    expiresAtMs: null,
    revokedAtMs: null,
    reason: "Owner-approved pilot",
    ...overrides,
  };
}

function mockFetch(opts: {
  active?: Record<string, unknown> | null;
  history?: Array<Record<string, unknown>>;
  grantPosts?: Array<Record<string, unknown>>;
  revokePosts?: Array<Record<string, unknown>>;
  revoke404?: boolean;
  getCalls?: Array<string>;
}) {
  const active = opts.active === undefined ? null : opts.active;
  const history = opts.history ?? [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/payments/agentic/commercial/free-access") && method === "GET") {
      opts.getCalls?.push(url);
      return { ok: true, status: 200, json: async () => ({ userId: "u1", active, history }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/free-access/grant" && method === "POST") {
      opts.grantPosts?.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ granted: grantRecord(), replaced: null }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/free-access/revoke" && method === "POST") {
      opts.revokePosts?.push(JSON.parse(String(init.body)));
      if (opts.revoke404) {
        return { ok: false, status: 404, json: async () => ({ error: "No active free-access grant for user u1." }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ revoked: grantRecord() }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("free-access grant section (#3247)", () => {
  it("shows no-grant status and grants lifetime with a reason (grantedBy left to the server)", async () => {
    const grantPosts: Array<Record<string, unknown>> = [];
    mockFetch({ grantPosts });
    await render(<FreeAccessGrantSection userId="u1" />);
    const text = container.textContent || "";
    expect(text).toContain("No free-access grant on this account.");
    expect(text).toContain("Grant free access");
    await act(async () => {
      setInputValue(inputForLabel("Reason for the grant"), "Owner-approved pilot");
    });
    await act(async () => {
      clickButton("Grant free access");
    });
    await flush();
    expect(grantPosts).toHaveLength(1);
    expect(grantPosts[0]).toEqual({
      userId: "u1",
      kind: "lifetime",
      expiresAtMs: null,
      reason: "Owner-approved pilot",
    });
  });

  it("grants a limited grant with a future expiry", async () => {
    const grantPosts: Array<Record<string, unknown>> = [];
    mockFetch({ grantPosts });
    await render(<FreeAccessGrantSection userId="u1" />);
    await act(async () => {
      setSelectValue(selectForLabel("Grant kind"), "limited");
    });
    await flush();
    await act(async () => {
      setInputValue(inputForLabel("Expiry"), "2027-01-01");
    });
    await act(async () => {
      setInputValue(inputForLabel("Reason for the grant"), "Pilot window");
    });
    await act(async () => {
      clickButton("Grant free access");
    });
    await flush();
    expect(grantPosts).toHaveLength(1);
    expect(grantPosts[0]).toEqual({
      userId: "u1",
      kind: "limited",
      expiresAtMs: Date.parse("2027-01-01"),
      reason: "Pilot window",
    });
  });

  it("shows an active grant with its reason, the replace disclosure, history, and revokes it", async () => {
    const revokePosts: Array<Record<string, unknown>> = [];
    mockFetch({
      revokePosts,
      active: grantRecord(),
      history: [
        grantRecord(),
        grantRecord({ id: "fa0", kind: "limited", expiresAtMs: Date.UTC(2026, 9, 1), revokedAtMs: Date.UTC(2026, 10, 1), reason: "Earlier window" }),
      ],
    });
    await render(<FreeAccessGrantSection userId="u1" />);
    const text = container.textContent || "";
    expect(text).toContain("Grant ACTIVE");
    expect(text).toContain("Owner-approved pilot");
    expect(text).toContain("Granting replaces the current grant");
    expect(text).toContain("revoked");
    expect(text).toContain("Revoke grant");
    await act(async () => {
      clickButton("Revoke grant");
    });
    await flush();
    expect(revokePosts).toHaveLength(1);
    expect(revokePosts[0]).toEqual({ userId: "u1" });
  });

  it("a stale revoke (404) reloads with the already-gone note", async () => {
    const getCalls: Array<string> = [];
    mockFetch({ getCalls, active: grantRecord(), revoke404: true });
    await render(<FreeAccessGrantSection userId="u1" />);
    await act(async () => {
      clickButton("Revoke grant");
    });
    await flush();
    expect(container.textContent || "").toContain("The grant is already gone — reloaded.");
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a grant with no reason without posting", async () => {
    const grantPosts: Array<Record<string, unknown>> = [];
    mockFetch({ grantPosts });
    await render(<FreeAccessGrantSection userId="u1" />);
    await act(async () => {
      clickButton("Grant free access");
    });
    await flush();
    expect(grantPosts).toHaveLength(0);
    expect(container.textContent || "").toContain("Enter a reason for the grant.");
  });

  it("refuses a limited grant with no expiry or a past expiry without posting", async () => {
    const grantPosts: Array<Record<string, unknown>> = [];
    mockFetch({ grantPosts });
    await render(<FreeAccessGrantSection userId="u1" />);
    await act(async () => {
      setSelectValue(selectForLabel("Grant kind"), "limited");
    });
    await flush();
    await act(async () => {
      setInputValue(inputForLabel("Reason for the grant"), "Pilot window");
    });
    await act(async () => {
      clickButton("Grant free access");
    });
    await flush();
    expect(grantPosts).toHaveLength(0);
    expect(container.textContent || "").toContain("Enter an expiry date for a limited grant.");
    await act(async () => {
      setInputValue(inputForLabel("Expiry"), "2020-01-01");
    });
    await act(async () => {
      clickButton("Grant free access");
    });
    await flush();
    expect(grantPosts).toHaveLength(0);
    expect(container.textContent || "").toContain("Expiry must be a future date");
  });
});
