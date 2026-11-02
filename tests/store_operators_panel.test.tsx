/** @vitest-environment jsdom */
/**
 * Issue #2680 — StoreOperatorsPanel component pins.
 *
 * Harness follows tests/approvals_panel.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed
 * fetch. The component is standalone: it is NOT wired into
 * PaymentWorkflowAssurance here (the parent wires it after
 * #2677 Slice A merges), so this suite renders it directly.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StoreOperatorsPanel } from "../src/client/StoreOperatorsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type RouteHandler = (url: string, init?: any) => any;

function mockFetch(handler: RouteHandler) {
  const fetchMock = vi.fn(async (input: any, init?: any) => handler(String(input), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

function err(status: number, message: string) {
  return { ok: false, status, json: async () => ({ error: message }) } as any;
}

const OPERATORS = [
  { login: "op1", source: "env", addedBy: null, addedAtMs: null },
  { login: "op2", source: "store", addedBy: "op1", addedAtMs: 1700000000000 },
];

describe("StoreOperatorsPanel (#2680)", () => {
  it("lists operators with source badges; env rows have no remove button, store rows do", async () => {
    mockFetch((url) => {
      if (url === "/api/payments/agentic/commercial/operators") return ok({ operators: OPERATORS });
      return ok({});
    });
    await render(<StoreOperatorsPanel />);
    expect(container.textContent).toContain("op1");
    expect(container.textContent).toContain("op2");
    expect(container.textContent).toContain("env");
    expect(container.textContent).toContain("store");
    const removeButtons = [...container.querySelectorAll("button")].filter((b) =>
      (b.textContent || "").toLowerCase().includes("remove"),
    );
    expect(removeButtons).toHaveLength(1);
  });

  it("add form posts the login and refreshes the list", async () => {
    const calls: string[] = [];
    let listed: any[] = [...OPERATORS];
    mockFetch((url, init) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url === "/api/payments/agentic/commercial/operators" && !init?.method) return ok({ operators: listed });
      if (url === "/api/payments/agentic/commercial/operators/add") {
        const body = JSON.parse(init.body);
        listed = [...listed, { login: body.login, source: "store", addedBy: "op1", addedAtMs: 1700000001000 }];
        return ok({ operator: listed[listed.length - 1] });
      }
      return ok({});
    });
    await render(<StoreOperatorsPanel />);
    const input = container.querySelector('input[name="operator-login"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      input.value = "op3";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent || "").toLowerCase().includes("add operator"),
    );
    expect(addButton).toBeDefined();
    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(calls).toContain("POST /api/payments/agentic/commercial/operators/add");
    expect(container.textContent).toContain("op3");
  });

  it("remove posts and refreshes; a guard error surfaces as a clear message", async () => {
    mockFetch((url, init) => {
      if (url === "/api/payments/agentic/commercial/operators" && !init?.method) return ok({ operators: OPERATORS });
      if (url === "/api/payments/agentic/commercial/operators/remove") {
        return err(409, "Refusing to remove the last effective operator.");
      }
      return ok({});
    });
    await render(<StoreOperatorsPanel />);
    const removeButton = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent || "").toLowerCase().includes("remove"),
    );
    await act(async () => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("Refusing to remove the last effective operator.");
    // The operator is still listed: a refused removal changes nothing.
    expect(container.textContent).toContain("op2");
  });

  it("non-operator state: a 403 list renders the not-an-operator message, not the form", async () => {
    mockFetch((url) => {
      if (url === "/api/payments/agentic/commercial/operators") return err(403, "Forbidden: store operator required.");
      return ok({});
    });
    await render(<StoreOperatorsPanel />);
    expect(container.textContent).toMatch(/not a store operator/i);
    expect(container.querySelector('input[name="operator-login"]')).toBeNull();
  });
});
