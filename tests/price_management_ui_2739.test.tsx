/** @vitest-environment jsdom */
/**
 * Price management UI (issue 2739): the price approval section
 * extended with real entries, per-family editing, Save, and
 * Save & approve. Component tests use the repo idiom (createRoot +
 * act + stubbed global fetch, no testing library).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PriceApprovalSection } from "../src/client/PaymentWorkflowAssurance";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const PRICING_BODY = {
  monetizationEnabled: true,
  prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
};

const ENTRIES_BODY = {
  entries: [
    {
      family: "stock",
      priceUSD: 0.02,
      updatedAtMs: 1761984000000,
      approvalStatus: "approved",
      approvedBy: "op1",
      approvedAtMs: 1761984000000,
    },
    {
      family: "goal",
      priceUSD: 0.1,
      updatedAtMs: 1761984000000,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
    },
    {
      family: "options",
      priceUSD: 0.05,
      updatedAtMs: 1761984000000,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
    },
    {
      family: "strategy",
      priceUSD: 0.1,
      updatedAtMs: 1761984000000,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
    },
  ],
};

describe("PriceApprovalSection price management (issue 2739)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let probeStatus: number;
  let entriesStatus: number;
  let postCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    probeStatus = 400;
    entriesStatus = 200;
    postCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/payments/agentic/commercial/pricing") && method === "GET") {
          return { ok: true, status: 200, json: async () => PRICING_BODY };
        }
        if (url.endsWith("/payments/agentic/commercial/prices") && method === "GET") {
          return {
            ok: entriesStatus < 300,
            status: entriesStatus,
            json: async () => (entriesStatus < 300 ? ENTRIES_BODY : {}),
          };
        }
        if (url.endsWith("/payments/agentic/commercial/prices") && method === "POST") {
          const body = JSON.parse((init?.body as string) || "{}") as Record<string, unknown>;
          postCalls.push(body);
          if (body["approvalStatus"] === undefined && body["priceUSD"] === undefined) {
            return { ok: probeStatus < 300, status: probeStatus, json: async () => ({}) };
          }
          if (body["priceUSD"] !== undefined && body["approvalStatus"] === "approved") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                entry: {
                  family: body["family"],
                  priceUSD: body["priceUSD"],
                  updatedAtMs: 1761984100000,
                  approvalStatus: "approved",
                  approvedBy: "op1",
                  approvedAtMs: 1761984100000,
                },
              }),
            };
          }
          if (body["priceUSD"] !== undefined) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                entry: {
                  family: body["family"],
                  priceUSD: body["priceUSD"],
                  updatedAtMs: 1761984100000,
                  approvalStatus: "proposed",
                  approvedBy: null,
                  approvedAtMs: null,
                },
              }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              entry: {
                family: body["family"],
                priceUSD: PRICING_BODY.prices[body["family"] as string] ?? 0,
                updatedAtMs: 1761984100000,
                approvalStatus: "approved",
                approvedBy: "op1",
                approvedAtMs: 1761984100000,
              },
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderSection = async () => {
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="op1" />);
    });
    await flush();
  };

  const buttonByLabel = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label)!;

  const inputByLabel = (label: string) =>
    container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;

  it("shows real entry state: Approved with approver for stock, Proposed for goal", async () => {
    await renderSection();
    expect(container.textContent).toContain("$0.10");
    expect(container.textContent).toContain("Proposed");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("op1");
  });

  it("Save flips an approved row to Proposed with a needs-re-approval note and the new price", async () => {
    await renderSection();
    const input = inputByLabel("Edit Stock price")!;
    expect(input).toBeTruthy();
    await act(async () => {
      setInput(input, "0.03");
    });
    await act(async () => {
      buttonByLabel("Save Stock price").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(container.textContent).toContain("$0.03");
    expect(container.textContent).toContain("Proposed");
    expect(container.textContent).toContain("Needs re-approval");
    expect(container.textContent).not.toContain("Approved");
  });

  it("Save & approve sends exactly ONE POST carrying both priceUSD and approvalStatus", async () => {
    await renderSection();
    const input = inputByLabel("Edit Goal price")!;
    await act(async () => {
      setInput(input, "0.15");
    });
    await act(async () => {
      buttonByLabel("Save and approve Goal price").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    const combined = postCalls.filter(
      (b) => b["priceUSD"] !== undefined && b["approvalStatus"] === "approved",
    );
    expect(combined).toHaveLength(1);
    expect(combined[0]["family"]).toBe("goal");
    expect(combined[0]["priceUSD"]).toBe(0.15);
    expect(container.textContent).toContain("$0.15");
    expect(container.textContent).toContain("Approved");
  });

  it("invalid prices send no request and show an inline error", async () => {
    await renderSection();
    const input = inputByLabel("Edit Goal price")!;
    for (const bad of ["0", "-1", ""]) {
      await act(async () => {
        setInput(input, bad);
      });
      await act(async () => {
        buttonByLabel("Save Goal price").dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await flush();
    }
    expect(postCalls.filter((b) => b["priceUSD"] !== undefined)).toHaveLength(0);
    expect(container.textContent).toMatch(/positive price/);
  });

  it("hides all editing controls and status badges for non-operators", async () => {
    probeStatus = 403;
    await act(async () => {
      root.render(<PriceApprovalSection userLogin="mallory" />);
    });
    await flush();
    expect(container.textContent).toMatch(/not a store operator/);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(
      [...container.querySelectorAll("button")].filter((b) =>
        /^(Approve|Save)/.test(b.getAttribute("aria-label") ?? ""),
      ),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain("Proposed");
    expect(container.textContent).not.toContain("Approved");
  });

  it("shows Unknown when the entries read fails, keeping prices from the pricing read", async () => {
    entriesStatus = 500;
    await renderSection();
    expect(container.textContent).toContain("$0.10");
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Proposed");
  });

  it("Approve behavior is unchanged: approving goal records approver and time", async () => {
    await renderSection();
    await act(async () => {
      buttonByLabel("Approve Goal price").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("op1");
  });
});
