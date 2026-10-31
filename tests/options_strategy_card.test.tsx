/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";
import { OptionsStrategyCard } from "../src/client/chat/OptionsStrategyCard";
import { ToolResultView } from "../src/client/chat/ToolResultView";
import { MarkdownContent } from "../src/client/chat/MarkdownContent";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("OptionsStrategyCard structured output (#2563)", () => {
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

  const sampleStrategy = {
    strategy: "Bull Put Spread",
    symbol: "NVDA",
    underlyingPrice: 138.25,
    expirationDate: "2026-11-20",
    sentiment: "bullish",
    legs: [
      { action: "SELL", quantity: 1, strike: 135, optionType: "PUT", limitPrice: 2.10, delta: -0.25 },
      { action: "BUY", quantity: 1, strike: 130, optionType: "PUT", limitPrice: 0.85, delta: -0.12 },
    ],
    maxProfit: 125,
    maxLoss: 375,
    breakevens: [133.75],
    probabilityOfProfit: 0.745,
    targetRewardRisk: 0.33,
    netDebitCredit: "$1.25 Credit",
    netGreeks: { delta: 0.13, gamma: -0.01, theta: 4.80, vega: -6.20 },
    score: 88,
    dataFreshness: "FRESH",
  };

  it("renders strategy header, metrics, greeks, and legs", async () => {
    await renderComponent(<OptionsStrategyCard data={sampleStrategy} />);

    expect(container.textContent).toContain("Bull Put Spread");
    expect(container.textContent).toContain("NVDA");
    expect(container.textContent).toContain("$138.25");
    expect(container.textContent).toContain("BULLISH");
    expect(container.textContent).toContain("$125.00");
    expect(container.textContent).toContain("$375.00");
    expect(container.textContent).toContain("$133.75");
    expect(container.textContent).toContain("74.5%");
    expect(container.textContent).toContain("Δ Delta: 0.13");
    expect(container.textContent).toContain("Θ Theta: 4.80");
    expect(container.textContent).toContain("$135.00");
    expect(container.textContent).toContain("$130.00");
  });

  it("dispatches preview action on button click", async () => {
    const onAction = vi.fn();
    await renderComponent(<OptionsStrategyCard data={sampleStrategy} onAction={onAction} />);

    const buttons = Array.from(container.querySelectorAll("button"));
    const previewBtn = buttons.find((b) => b.textContent?.includes("Preview in E*TRADE"));
    expect(previewBtn).toBeDefined();

    act(() => {
      previewBtn?.click();
    });

    expect(onAction).toHaveBeenCalledWith(expect.stringContaining("Preview trade Bull Put Spread on NVDA in E*TRADE"));
  });

  it("ToolResultView renders OptionsStrategyCard for screen_options tool", async () => {
    await renderComponent(
      <ToolResultView
        toolType="screen_options"
        data={{
          symbol: "SPY",
          label: "Iron Condor",
          legs: [
            { action: "BUY", strike: 550, optionType: "PUT" },
            { action: "SELL", strike: 560, optionType: "PUT" },
            { action: "SELL", strike: 600, optionType: "CALL" },
            { action: "BUY", strike: 610, optionType: "CALL" },
          ],
          maxProfit: 250,
          maxLoss: 750,
        }}
      />
    );

    expect(container.textContent).toContain("Iron Condor");
    expect(container.textContent).toContain("SPY");
    expect(container.textContent).toContain("$250.00");
    expect(container.textContent).toContain("$750.00");
  });

  it("MarkdownContent parses structured options JSON block into OptionsStrategyCard", async () => {
    const markdown = [
      "Here is the recommended options strategy setup for your query:",
      "```json",
      JSON.stringify(sampleStrategy, null, 2),
      "```",
      "Let me know if you would like to execute this spread.",
    ].join("\n");

    await renderComponent(<MarkdownContent text={markdown} />);

    expect(container.textContent).toContain("Bull Put Spread");
    expect(container.textContent).toContain("NVDA");
    expect(container.textContent).toContain("$125.00");
    expect(container.textContent).toContain("View Raw JSON ▼");
  });
});
