/** @vitest-environment jsdom */
/**
 * Issue #3245 (slice 1 of #3241) — the unlimited-free grant
 * section in the Accounts admin panel.
 *
 * Harness follows tests/checkout_ui_native_panel.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed
 * fetch. The section reads the account through the existing
 * commercial account GET route and writes grants through the
 * existing POST route; no network, no key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UnlimitedFreeGrantSection } from "../src/client/UnlimitedFreeGrantSection";

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

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function mockFetch(opts: {
  record?: Record<string, unknown>;
  posts?: Array<Record<string, unknown>>;
}) {
  const record = opts.record ?? {
    id: "u1",
    tenantId: "t1",
    tier: "Free",
    creditsUSD: 0,
    includedRuns: 0,
    unlimitedFreeGrant: null,
  };
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/payments/agentic/commercial/account") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ record, effectiveTier: "Free" }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/account" && method === "POST") {
      opts.posts?.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ record }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("unlimited-free grant section (#3245)", () => {
  it("shows no-grant status and grants with a reason (grantedBy left to the server)", async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch({ posts });
    await render(<UnlimitedFreeGrantSection userId="u1" />);
    const text = container.textContent || "";
    expect(text).toContain("No unlimited-free grant on this account.");
    expect(text).toContain("Grant unlimited free");
    await act(async () => {
      setInputValue(inputForLabel("Reason for the grant"), "Owner-approved pilot");
    });
    await act(async () => {
      clickButton("Grant unlimited free");
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      userId: "u1",
      tenantId: "t1",
      tier: "Free",
      creditsUSD: 0,
      includedRuns: 0,
    });
    expect(
      (posts[0].unlimitedFreeGrant as Record<string, unknown>).reason,
    ).toBe("Owner-approved pilot");
    expect(
      (posts[0].unlimitedFreeGrant as Record<string, unknown>).expiresAtMs,
    ).toBeNull();
  });

  it("shows an active grant with its reason and revokes it by explicit null", async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch({
      posts,
      record: {
        id: "u1",
        tenantId: "t1",
        tier: "Free",
        creditsUSD: 0,
        includedRuns: 0,
        unlimitedFreeGrant: { grantedBy: "op1", reason: "Owner-approved pilot", expiresAtMs: null },
      },
    });
    await render(<UnlimitedFreeGrantSection userId="u1" />);
    const text = container.textContent || "";
    expect(text).toContain("Grant ACTIVE");
    expect(text).toContain("Owner-approved pilot");
    expect(text).toContain("Revoke grant");
    await act(async () => {
      clickButton("Revoke grant");
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].unlimitedFreeGrant).toBeNull();
  });

  it("refuses a grant with no reason without posting", async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch({ posts });
    await render(<UnlimitedFreeGrantSection userId="u1" />);
    await act(async () => {
      clickButton("Grant unlimited free");
    });
    await flush();
    expect(posts).toHaveLength(0);
    expect(container.textContent || "").toContain("Enter a reason for the grant.");
  });
});
