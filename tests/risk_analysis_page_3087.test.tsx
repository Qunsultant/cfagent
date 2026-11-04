/** @vitest-environment jsdom */
/**
 * Issue #3087: standalone Risk Analysis page + sub-menu under the Fast
 * Order Ticket nav item.
 * - Nav config: a `risk-analysis` route (no nav entry, like the other
 *   sub-menu pages), a `risk-analysis` sub-menu entry under `order`,
 *   and the deep-link override order:risk-analysis -> ?tab=risk-analysis.
 * - Chat: a TAB_CONTENT entry renders RiskAnalysisPanel.
 * - Gate: the panel is shell-conforming (PageShell, primitives only,
 *   no inline styles, no bespoke classes) and does not touch the hub's
 *   RiskAnalysisModal.
 * - Render: a symbol input builds a RiskSubject through the existing
 *   engine; anatomy, scenarios, and AI tabs render from it.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RiskAnalysisPanel } from "../src/client/RiskAnalysisPanel";
import {
  DEEP_LINK_OVERRIDES,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = join(__dirname);
const NAV_CONFIG = JSON.parse(
  readFileSync(join(HERE, "..", "src", "client", "nav-config.json"), "utf8"),
);
const PANEL_SRC = readFileSync(
  join(HERE, "..", "src", "client", "RiskAnalysisPanel.tsx"),
  "utf8",
);
const CHAT_SRC = readFileSync(
  join(HERE, "..", "src", "client", "Chat.tsx"),
  "utf8",
);

function tabContentKeys(src: string): string[] {
  const start = src.indexOf("const TAB_CONTENT");
  const end = src.indexOf("const SHELL_CONTENT");
  const region = src.slice(start, end);
  const marker = /^    "?([a-z0-9-]+)"?: \($/gm;
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(region)) !== null) keys.push(m[1]);
  return keys;
}

describe("risk analysis page (#3087)", () => {
  it("carries a risk-analysis route with no nav entry", () => {
    const route = (NAV_CONFIG.routes as { id: string }[]).find(
      (r: any) => r.id === "risk-analysis",
    ) as any;
    expect(route).toBeDefined();
    expect(route.navGroup).toBe("order");
    expect(route.crumb).toBe("Risk Analysis");
    expect(route.category).toBe("Execution");
    expect(route.navEntry).toBeUndefined();
  });

  it("carries a Risk Analysis sub-menu entry on the Fast Order Ticket item", () => {
    const order = (NAV_CONFIG.subMenus.order as { id: string }[]).find(
      (s: any) => s.id === "risk-analysis",
    ) as any;
    expect(order).toBeDefined();
    expect(order.label).toBe("Risk Analysis");
  });

  it("resolves order:risk-analysis to ?tab=risk-analysis", () => {
    expect(DEEP_LINK_OVERRIDES["order:risk-analysis"]).toEqual({
      tab: "risk-analysis",
    });
    expect(deepLinkForNavNode("order", "risk-analysis")).toEqual({
      tab: "risk-analysis",
    });
    expect(deepLinkHrefForNavNode("order", "risk-analysis")).toBe(
      "?tab=risk-analysis",
    );
  });

  it("renders RiskAnalysisPanel from Chat TAB_CONTENT", () => {
    expect(tabContentKeys(CHAT_SRC)).toContain("risk-analysis");
    expect(CHAT_SRC).toContain("RiskAnalysisPanel");
  });

  it("is shell-conforming with primitives only", () => {
    expect(PANEL_SRC).toContain("<PageShell");
    expect(PANEL_SRC).not.toContain("style={");
    expect(PANEL_SRC).not.toContain("className=");
    expect(PANEL_SRC).not.toContain("<RiskAnalysisModal");
    expect(PANEL_SRC).not.toContain('from "./options/RiskAnalysisModal"');
    expect(PANEL_SRC).toContain("computeRiskProfile");
  });
});

describe("risk analysis panel render (#3087)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function buttonByText(text: string): HTMLButtonElement {
    const btn = [...document.body.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(text),
    );
    expect(btn).toBeDefined();
    return btn as HTMLButtonElement;
  }

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) root.unmount();
    if (container) container.remove();
    vi.unstubAllGlobals();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(<RiskAnalysisPanel />);
    });
  }

  async function analyze(symbol: string) {
    await renderPanel();
    const inputs = container.querySelectorAll("input");
    const symbolInput = [...inputs].find(
      (i) => i.placeholder === "e.g. AAPL",
    ) as HTMLInputElement;
    expect(symbolInput).toBeDefined();
    await act(async () => {
      setInputValue(symbolInput, symbol);
    });
    await act(async () => {
      buttonByText("Analyze").click();
    });
  }

  it("builds a risk profile from a symbol", async () => {
    await analyze("AAPL");
    expect(document.body.textContent).toContain("Capital at risk");
    expect(document.body.textContent).toContain("Risk score");
  });

  it("switches to scenarios and AI tabs from the same profile", async () => {
    await analyze("AAPL");
    await act(async () => {
      buttonByText("Stress Tests & Tail Shocks").click();
    });
    expect(document.body.textContent).toContain("Current Spot");
    await act(async () => {
      buttonByText("AI Risk Manager (Chat)").click();
    });
    expect(document.body.textContent).toContain("Copy prompt");
  });

  it("copies the AI prompt to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await analyze("AAPL");
    await act(async () => {
      buttonByText("AI Risk Manager (Chat)").click();
    });
    await act(async () => {
      buttonByText("Copy prompt").click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(typeof writeText.mock.calls[0][0]).toBe("string");
  });
});
