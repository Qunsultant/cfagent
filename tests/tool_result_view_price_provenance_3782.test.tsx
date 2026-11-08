/** @vitest-environment jsdom */
/**
 * Issue #3782 (b) — the order preview card must never render an
 * estimated price as the order price, must show price provenance,
 * and must keep Approve disabled until a real price is attached.
 *
 * TDD Red: on the pre-fix tree the card renders `estimatedPrice` as
 * the order price and Approve is enabled on a priceless draft.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, afterEach } from "vitest";
import { ToolResultView } from "../src/client/chat/ToolResultView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("order preview card price provenance (#3782b)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderComponent(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(node);
    });
  }

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  function approveButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Approve"),
    ) as HTMLButtonElement | undefined;
  }

  const baseDraft = {
    orderId: "ord_3782test",
    status: "previewed",
    symbol: "AAPL",
    action: "BUY",
    quantity: 10,
    orderType: "LIMIT",
  };

  it("never renders an estimated price as the order price, and Approve stays disabled", async () => {
    await renderComponent(
      <ToolResultView
        toolType="etrade_preview_order"
        data={{
          ...baseDraft,
          estimatedPrice: 178.0,
          estimatedTotal: 1780.0,
          priceSource: { kind: "estimated", provider: "static fallback", timestamp: "2026-11-08T15:30:00Z" },
        }}
      />,
    );
    expect(container.textContent).not.toContain("$178.00");
    expect(container.textContent).toContain("AAPL");
    const approve = approveButton();
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(true);
  });

  it("renders a user-supplied limit price and enables Approve", async () => {
    await renderComponent(
      <ToolResultView
        toolType="alpaca_preview_order"
        data={{
          ...baseDraft,
          orderId: "alp_ord_3782test",
          limitPrice: 340.0,
          estimatedPrice: 340.0,
          estimatedTotal: 3400.0,
          priceSource: { kind: "user" },
        }}
      />,
    );
    expect(container.textContent).toContain("$340.00");
    expect(container.textContent).toMatch(/user-supplied/i);
    const approve = approveButton();
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(false);
  });

  it("shows live-quote provenance with provider and timestamp", async () => {
    await renderComponent(
      <ToolResultView
        toolType="alpaca_preview_order"
        data={{
          ...baseDraft,
          orderId: "alp_ord_3782live",
          limitPrice: 342.37,
          estimatedPrice: 342.37,
          estimatedTotal: 3423.7,
          priceSource: { kind: "live-quote", provider: "Alpaca Real-Time NBBO Feed", timestamp: "2026-11-08T15:30:00Z" },
        }}
      />,
    );
    expect(container.textContent).toContain("$342.37");
    expect(container.textContent).toContain("Alpaca Real-Time NBBO Feed");
    expect(container.textContent).toContain("2026-11-08T15:30:00Z");
    expect(approveButton()!.disabled).toBe(false);
  });

  it("a MARKET draft without a limit price does not invent one from the estimate", async () => {
    await renderComponent(
      <ToolResultView
        toolType="etrade_preview_order"
        data={{
          ...baseDraft,
          orderType: "MARKET",
          limitPrice: undefined,
          estimatedPrice: 342.37,
          estimatedTotal: 3423.7,
          priceSource: { kind: "live-quote", provider: "E*TRADE Market Data Feed", timestamp: "2026-11-08T15:30:00Z" },
        }}
      />,
    );
    expect(container.textContent).not.toContain("@ $342.37");
  });
});
