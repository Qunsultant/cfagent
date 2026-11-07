/** @vitest-environment jsdom */

/**
 * Issue #3449 — Multi-Copilot Sub-Tabs & Architecture Extensibility.
 * Issue #3454 — Uniform copilot shell: EVERY registered copilot renders
 * the same shell — its banner (when configured), its custom surface
 * (when it declares one) composed ABOVE the conversation, and ALWAYS
 * the shared conversation (messages stream + composer). No copilot
 * mode may replace or suppress the chat surface.
 *
 * Verifies:
 * 1. Copilot Registry contains the 3 default copilots: General, Options, Stock.
 * 2. URL syncing and sub-view validation for all 3 copilots.
 * 3. Extensibility: external copilots can register/unregister dynamically.
 * 4. Uniform composition (#3454): the messages stream and composer
 *    render in EVERY sub-view; the StockCopilotPanel renders only in
 *    the 'stock' view, above the conversation. This deliberately
 *    supersedes the #3449 pin that hid the composer on the stock
 *    view — that pin encoded the defect #3454 fixes.
 * 5. A message sent from the stock sub-view flows through the same
 *    useAgentChat sendMessage as every other sub-view, and a
 *    registered copilot carrying renderCustom inherits the
 *    conversation by construction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { mockSendMessage, mockChatMessages } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockChatMessages: [] as any[],
}));

// Mock agent chat hooks
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    messages: mockChatMessages,
    sendMessage: mockSendMessage,
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
  hasCustomSurface,
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
    expect(hasCustomSurface(findCopilot("crypto")!)).toBe(false);

    // Clean up
    unregister();
    expect(isRegisteredCopilotId("crypto")).toBe(false);
    expect(isValidChatSubView("crypto")).toBe(false);
  });

  it("declares uniform chat mode across all copilots (#3454, #3557)", () => {
    // Issue #3557: all 3 core copilots share the uniform 'chat' mode
    expect(findCopilot("stock")?.mode).toBe("chat");
    expect(findCopilot("general")?.mode).toBe("chat");
    expect(findCopilot("options")?.mode).toBe("chat");
    expect(hasCustomSurface(findCopilot("stock")!)).toBe(false);
    expect(hasCustomSurface(findCopilot("general")!)).toBe(false);
    expect(hasCustomSurface(findCopilot("options")!)).toBe(false);
  });
});

describe("AgentChatTabContent Multi-Copilot Sub-Tabs & View Isolation (#3449)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const renderChat = async () => {
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
  };

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockSendMessage.mockClear();
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
    await renderChat();

    const tabs = container!.querySelectorAll(".chat-capability-subnav [role='tab']");
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    const tabTexts = Array.from(tabs).map((t) => t.textContent || "");
    expect(tabTexts.some((txt) => txt.includes("General Copilot"))).toBe(true);
    expect(tabTexts.some((txt) => txt.includes("Options Copilot"))).toBe(true);
    expect(tabTexts.some((txt) => txt.includes("Stock Copilot"))).toBe(true);
  });

  it("in default/general view: StockCopilotPanel is NOT rendered, chat composer is active", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=general");

    await renderChat();

    // Zero overlap: StockCopilotPanel MUST NOT be rendered
    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    // Chat composer and stream MUST be rendered
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
    expect(container!.querySelector(".messages-stream")).not.toBeNull();
  });

  it("in options view: Options banner is shown, StockCopilotPanel is NOT rendered", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=options");

    await renderChat();

    // Zero overlap: StockCopilotPanel MUST NOT be rendered
    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    // Options banner is present
    expect(container!.textContent).toContain("Options Copilot Active:");
    // Chat composer and stream are present (uniform shell, #3454)
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
    expect(container!.querySelector(".messages-stream")).not.toBeNull();
  });

  it("in stock view: renders uniform copilot chat surface with banner, welcome hero, and bottom chatbox (#3541, #3557)", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=stock");

    await renderChat();

    // Uniform shell: fullChatArea rendered, no side-by-side dashboard pane
    const panel = container!.querySelector("[data-testid='stock-copilot-panel']");
    expect(panel).toBeNull();
    // Stock Copilot banner is present
    expect(container!.textContent).toContain("Stock Copilot Active:");
    // Stock Copilot welcome hero and quick chips are present
    expect(container!.textContent).toContain("Stock Copilot & Autonomous Loop");
    expect(container!.textContent).toContain("Open Positions & Exits");
    // Chat composer and stream ARE rendered uniformly with sticky bottom composer
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
    expect(container!.querySelector(".messages-stream")).not.toBeNull();
  });

  it("in conversational view: a message typed in the composer flows through the shared sendMessage", async () => {
    window.history.replaceState({}, "", "/?tab=chat&view=options");

    await renderChat();

    const input = container!.querySelector<HTMLInputElement>(".chat-input-bar input");
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    await act(async () => {
      setValue.call(input, "What is the best SPY Iron Condor?");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container!.querySelector<HTMLFormElement>("form.chat-input-bar");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sent = mockSendMessage.mock.calls[0][0] as any;
    expect(sent.text).toBe("What is the best SPY Iron Condor?");
    expect(sent.metadata?.userLogin).toBe("test-user");
  });

  it("supports URL alias ?copilot=stock with uniform copilot workspace (#3541, #3557)", async () => {
    window.history.replaceState({}, "", "/?tab=chat&copilot=stock");

    await renderChat();

    expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    expect(container!.textContent).toContain("Stock Copilot Active:");
    expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
    expect(container!.querySelector(".messages-stream")).not.toBeNull();
  });

  it("a registered copilot with renderCustom renders its surface alongside the chatbox (#3541)", async () => {
    const unregister = registerCopilot({
      id: "lab",
      label: "Lab Copilot",
      icon: "🧪",
      mode: "custom",
      tooltip: {
        eyebrow: "Test",
        title: "Lab Copilot",
        description: "Synthetic copilot for custom surface side-by-side contract",
      },
      renderCustom: () => <div data-testid="lab-surface">Lab Surface</div>,
    });

    try {
      window.history.replaceState({}, "", "/?tab=chat&view=lab");

      await renderChat();

      // Its own custom surface renders…
      const surface = container!.querySelector("[data-testid='lab-surface']");
      expect(surface).not.toBeNull();
      // …and the conversational chatbox is rendered alongside it
      expect(container!.querySelector(".chat-input-bar")).not.toBeNull();
      expect(container!.querySelector(".messages-stream")).not.toBeNull();
      // A copilot with its own renderCustom does NOT pull in the stock panel
      expect(container!.querySelector("[data-testid='stock-copilot-panel']")).toBeNull();
    } finally {
      unregister();
    }
  });

  it("in stock view with active conversation: renders persistent collapsible prompt chips bar above composer (#3656)", async () => {
    mockChatMessages.push(
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello Stock Copilot" }] },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "Ready to assist." }] },
    );

    try {
      window.history.replaceState({}, "", "/?tab=chat&view=stock");
      await renderChat();

      // Zero-state hero is hidden when messages exist
      expect(container!.querySelector(".hero-welcome")).toBeNull();

      // Persistent prompt chips bar IS rendered above composer
      const chipsBar = container!.querySelector("[data-testid='copilot-quick-chips-bar']");
      expect(chipsBar).not.toBeNull();
      expect(chipsBar!.textContent).toContain("▼ Prompts");
      expect(chipsBar!.textContent).toContain("Buy AAPL Bracket");

      // Clicking a chip invokes sendMessage
      const aaplChip = Array.from(chipsBar!.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Buy AAPL Bracket")
      );
      expect(aaplChip).toBeDefined();

      await act(async () => {
        aaplChip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Draft a limit buy order for 10 AAPL"),
        })
      );

      // Collapsing the bar hides chips and shows expand toggle
      const toggleBtn = container!.querySelector<HTMLButtonElement>("[data-testid='toggle-copilot-chips']");
      expect(toggleBtn).not.toBeNull();

      await act(async () => {
        toggleBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container!.querySelector("[data-testid='toggle-copilot-chips']")?.textContent).toContain("▶ Prompts");
      expect(chipsBar!.textContent).not.toContain("Buy AAPL Bracket");
    } finally {
      mockChatMessages.length = 0;
    }
  });
});
