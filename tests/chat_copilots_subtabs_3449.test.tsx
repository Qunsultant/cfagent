/** @vitest-environment jsdom */

/**
 * Issue #3449 — Multi-Copilot Sub-Tabs & Architecture Extensibility.
 *
 * Verifies:
 * 1. Copilot Registry contains the 3 default copilots: General, Options, Stock.
 * 2. URL syncing and sub-view validation for all 3 copilots.
 * 3. Extensibility: external copilots can register/unregister dynamically.
 * 4. Zero overlap: StockCopilotPanel is isolated to the 'stock' view and
 *    does NOT render in 'general' or 'options' views.
 * 5. General and Options views render the conversational stream and composer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock agent chat hooks
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    error: null,
    connectionError: null,
  }),
}));

vi.mock("agents/react", () => ({
  useAgent: () => ({
    reconnect: vi.fn(),
    readyState: 1,
  }),
}));

// Mock StockCopilotPanel so it doesn't do real fetches
vi.mock("../src/client/StockCopilotPanel", () => ({
  StockCopilotPanel: () => <div data-testid="stock-copilot-panel">Stock Copilot Panel Surface</div>,
}));

import {
  DEFAULT_COPILOTS,
  getRegisteredCopilots,
  registerCopilot,
  findCopilot,
  isRegisteredCopilotId,
} from "../src/client/chat/copilotRegistry";
import {
  AgentChatTabContent,
  isValidChatSubView,
} from "../src/client/chat/AgentChatTabContent";

const mockUser = {
  login: "test-user",
  name: "Test User",
  avatar: "https://example.com/avatar.png",
} as any;

describe("Copilot Registry & Extensibility (#3449)", () => {
  it("includes the 3 core copilots by default", () => {
    const copilots = getRegisteredCopilots();
    const ids = copilots.map((c) => c.id);
    expect(ids).toContain("general");
    expect(ids).toContain("options");
    expect(ids).toContain("stock");
  });

  it("identifies valid sub-views accurately", () => {
    expect(isValidChatSubView("general")).toBe(true);
    expect(isValidChatSubView("options")).toBe(true);
    expect(isValidChatSubView("stock")).toBe(true);
    expect(isValidChatSubView("non_existent_view")).toBe(false);
    expect(isValidChatSubView(null)).toBe(false);
    expect(isValidChatSubView(123)).toBe(false);
  });

  it("supports dynamic copilot registration and cleanup", () => {
    const unregister = registerCopilot({
      id: "crypto",
      label: "Crypto Copilot",
      icon: "🪙",
      mode: "chat",
      tooltip: {
        eyebrow: "Digital Assets",
        title: "Crypto Strategy & Arbitrage",
        description: "Autonomous DeFi & CeFi execution",
      },
    });

    expect(isRegisteredCopilotId("crypto")).toBe(true);
    expect(isValidChatSubView("crypto")).toBe(true);
    expect(findCopilot("crypto")?.label).toBe("Crypto Copilot");

    // Clean up
    unregister();
    expect(isRegisteredCopilotId("crypto")).toBe(false);
    expect(isValidChatSubView("crypto")).toBe(false);
  });
});

describe("AgentChatTabContent Multi-Copilot Sub-Tabs & View Isolation (#3449)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState({}, "", "/?tab=chat");
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
  });

  it("renders all 3 copilot tabs in CapabilityNavBar", async () => {
    await act(async () => {
      root!.render(
        <AgentChatTabContent
          user={mockUser}
          ads={[]}
          onAdClick={vi.fn()}
          onOpenAdsTab={vi.fn()}
          onStatusChange={vi.fn()}
          onResetSession={vi.fn()}
          isResetting={false}
          resetNotice={null}
          authExpired={false}
        />
      );
    });

    const tabs = container!.querySelectorAll(".chat-capability-subnav [role='tab']");
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    const tabTexts = Array.from(tabs).map((t) => t.textContent || "");
    expect(tabTexts.some((txt) => txt.includes("General Copilot"))).toBe(true);
    expect(tabTexts.some((txt) => txt.includes("Options Copilot"))).toBe(true);
    expect(tabTexts.some((txt) => txt.includes("Stock Copilot"))).toBe(true);
  });

  it("in default/general view: StockCopilotPanel is NOT rendered, chat composer is active", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=general");

    await act(async () => {
      root!.render(
        <AgentChatTabContent
          user={mockUser}
          ads={[]}
          onAdClick={vi.fn()}
          onOpenAdsTab={vi.fn()}
          onStatusChange={vi.fn()}
          onResetSession={vi.fn()}
          isResetting={false}
          resetNotice={null}
          authExpired={false}
        />
      );
    });

    // Zero overlap: StockCopilotPanel MUST NOT be rendered
    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    // Chat composer and stream MUST be rendered
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
    expect(container!.querySelector(".messages-stream")).not.toBeNull();
  });

  it("in options view: Options banner is shown, StockCopilotPanel is NOT rendered", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=options");

    await act(async () => {
      root!.render(
        <AgentChatTabContent
          user={mockUser}
          ads={[]}
          onAdClick={vi.fn()}
          onOpenAdsTab={vi.fn()}
          onStatusChange={vi.fn()}
          onResetSession={vi.fn()}
          isResetting={false}
          resetNotice={null}
          authExpired={false}
        />
      );
    });

    // Zero overlap: StockCopilotPanel MUST NOT be rendered
    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    // Options banner is present
    expect(container!.textContent).toContain("Options Copilot Active:");
    // Chat composer is present
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
  });

  it("in stock view: StockCopilotPanel IS rendered in dedicated surface, chat composer is hidden", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=stock");

    await act(async () => {
      root!.render(
        <AgentChatTabContent
          user={mockUser}
          ads={[]}
          onAdClick={vi.fn()}
          onOpenAdsTab={vi.fn()}
          onStatusChange={vi.fn()}
          onResetSession={vi.fn()}
          isResetting={false}
          resetNotice={null}
          authExpired={false}
        />
      );
    });

    // StockCopilotPanel MUST be rendered
    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).not.toBeNull();
    // Stock Copilot banner is present
    expect(container!.textContent).toContain("Stock Copilot Active:");
    // Chat composer is hidden on stock surface to prevent overlapping/crushing
    expect(container!.querySelector(".chat-input-bar")).toBeNull();
  });

  it("supports URL alias ?copilot=stock", async () => {
    window.history.replaceState({}, "", "/?tab=chat&copilot=stock");

    await act(async () => {
      root!.render(
        <AgentChatTabContent
          user={mockUser}
          ads={[]}
          onAdClick={vi.fn()}
          onOpenAdsTab={vi.fn()}
          onStatusChange={vi.fn()}
          onResetSession={vi.fn()}
          isResetting={false}
          resetNotice={null}
          authExpired={false}
        />
      );
    });

    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).not.toBeNull();
  });
});
