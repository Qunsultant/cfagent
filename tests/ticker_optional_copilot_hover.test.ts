/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadTickerEnabled,
  saveTickerEnabled,
  subscribeTickerEnabled,
} from "../src/client/quotes/tickerVisibility";
import { getRegisteredCopilots } from "../src/client/chat/copilotRegistry";

describe("Ticker Optionality & Hover-Only Copilot Info", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("loadTickerEnabled defaults to false (ticker off by default)", () => {
    expect(loadTickerEnabled()).toBe(false);
  });

  it("saveTickerEnabled updates localStorage and notifies subscribers", () => {
    let notifiedValue: boolean | null = null;
    const unsubscribe = subscribeTickerEnabled((val) => {
      notifiedValue = val;
    });

    saveTickerEnabled(true);
    expect(loadTickerEnabled()).toBe(true);
    expect(notifiedValue).toBe(true);

    saveTickerEnabled(false);
    expect(loadTickerEnabled()).toBe(false);
    expect(notifiedValue).toBe(false);

    unsubscribe();
  });

  it("Chat.tsx conditionally renders MarketTickerTape based on tickerEnabled", () => {
    const chatSource = fs.readFileSync(
      path.resolve(__dirname, "../src/client/Chat.tsx"),
      "utf8"
    );
    expect(chatSource).toContain("useTickerEnabled");
    expect(chatSource).toContain("{tickerEnabled && (");
    expect(chatSource).toContain("<MarketTickerTape");
  });

  it("BrokerDynamicMenu.tsx provides ticker toggle setting (Off by default)", () => {
    const menuSource = fs.readFileSync(
      path.resolve(__dirname, "../src/client/BrokerDynamicMenu.tsx"),
      "utf8"
    );
    expect(menuSource).toContain("saveTickerEnabled");
    expect(menuSource).toContain("Market Data &amp; Ticker Tape");
    expect(menuSource).toContain("handleToggleTicker");
  });

  it("copilotRegistry does not contain fixed top-right corner badges (Structured Outputs, Alpaca Paper Loop)", () => {
    const copilots = getRegisteredCopilots();
    for (const copilot of copilots) {
      if (copilot.banner) {
        expect(copilot.banner.badgeText).toBeUndefined();
      }
    }
  });

  it("AgentChatTabContent.tsx removes fixed options-copilot-banner and fixed ledger session subtitle", () => {
    const agentChatSource = fs.readFileSync(
      path.resolve(__dirname, "../src/client/chat/AgentChatTabContent.tsx"),
      "utf8"
    );
    expect(agentChatSource).not.toContain("options-copilot-banner");
    expect(agentChatSource).not.toContain("Stateful Distributed Ledger Session");
    expect(agentChatSource).toContain("copilot-hover-info-badge");
    expect(agentChatSource).toContain("TabHoverItem");
  });
});

