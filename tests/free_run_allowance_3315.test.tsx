/** @vitest-environment jsdom */
/**
 * Issue #3315 (sub-issue of #3241) — the free-run allowance
 * section on the Platform Admin page.
 *
 * Harness follows tests/unlimited_free_grant_3245_ui.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed
 * fetch. The section reads the allowances through the
 * operator-gated GET route and writes one family at a time
 * through the POST route; no network, no key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FreeRunAllowanceSection } from "../src/client/FreeRunAllowanceSection";

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

type AllowanceRow = { family: string; runs: number | null };

function mockFetch(opts: {
  allowances?: AllowanceRow[];
  status?: number;
  posts?: Array<Record<string, unknown>>;
}) {
  const store: AllowanceRow[] = (opts.allowances ?? [
    { family: "stock", runs: 10 },
    { family: "goal", runs: 10 },
    { family: "options", runs: 10 },
    { family: "strategy", runs: 10 },
  ]).map((row) => ({ ...row }));
  const status = opts.status ?? 200;
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/payments/agentic/commercial/free-run-allowance" && method === "GET") {
      if (status !== 200) {
        return { ok: false, status, json: async () => ({ error: "Forbidden: store operator required." }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ allowances: store.map((row) => ({ ...row })) }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/free-run-allowance" && method === "POST") {
      const body = JSON.parse(String(init.body));
      opts.posts?.push(body);
      const row = store.find((entry) => entry.family === body.family);
      if (row) row.runs = body.runs;
      return { ok: true, status: 200, json: async () => ({ family: body.family, runs: body.runs }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("free-run allowance section (#3315)", () => {
  it("shows every family's allowance and saves a changed value", async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch({ posts });
    await render(<FreeRunAllowanceSection />);
    const text = container.textContent || "";
    for (const label of ["Stock", "Goal", "Options", "Strategy"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("10 runs per month.");
    expect(inputForLabel("Goal allowance (runs per month)").value).toBe("10");
    await act(async () => {
      setInputValue(inputForLabel("Goal allowance (runs per month)"), "25");
    });
    await act(async () => {
      clickButton("Save Goal allowance");
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ family: "goal", runs: 25 });
    expect(container.textContent || "").toContain(
      "Free-run allowance for Goal set to 25 runs per month.",
    );
    expect(inputForLabel("Goal allowance (runs per month)").value).toBe("25");
  });

  it("shows Not set for a family with no stored row, and 0 disables free runs", async () => {
    mockFetch({
      allowances: [
        { family: "stock", runs: null },
        { family: "goal", runs: 0 },
        { family: "options", runs: 10 },
        { family: "strategy", runs: 10 },
      ],
    });
    await render(<FreeRunAllowanceSection />);
    const text = container.textContent || "";
    expect(text).toContain("Not set — no free runs for this product.");
    expect(text).toContain("0 runs per month — free runs disabled for this product.");
    expect(inputForLabel("Stock allowance (runs per month)").value).toBe("");
  });

  it("refuses a non-numeric allowance without posting", async () => {
    const posts: Array<Record<string, unknown>> = [];
    mockFetch({ posts });
    await render(<FreeRunAllowanceSection />);
    await act(async () => {
      setInputValue(inputForLabel("Options allowance (runs per month)"), "abc");
    });
    await act(async () => {
      clickButton("Save Options allowance");
    });
    await flush();
    expect(posts).toHaveLength(0);
    expect(container.textContent || "").toContain(
      "Enter a non-negative whole number of runs for Options.",
    );
  });

  it("shows the operator-access message when the server refuses (403)", async () => {
    mockFetch({ status: 403 });
    await render(<FreeRunAllowanceSection />);
    expect(container.textContent || "").toContain(
      "Operator access required: only store operators may manage the free-run allowance.",
    );
  });
});
