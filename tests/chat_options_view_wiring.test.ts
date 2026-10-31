import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("AgentChatTabContent options view wiring (#2563)", () => {
  const chatSrc = readFileSync("src/client/chat/AgentChatTabContent.tsx", "utf8");

  it("uses useUrlSyncedTabs with canonical ?view= param and 'general' default", () => {
    expect(chatSrc).toContain("useUrlSyncedTabs");
    expect(chatSrc).toContain('param: "view"');
    expect(chatSrc).toContain('defaultTab: "general"');
  });

  it("validates 'general' and 'options' sub-views", () => {
    expect(chatSrc).toContain("isValidChatSubView");
    expect(chatSrc).toMatch(/options.*general|general.*options/);
  });

  it("renders CapabilityNavBar for copilot modes", () => {
    expect(chatSrc).toContain("CapabilityNavBar");
    expect(chatSrc).toContain("Options Copilot");
  });

  it("binds sourceTab to E*TRADE · Auto Options Research in options view for backend execution", () => {
    expect(chatSrc).toContain("E*TRADE · Auto Options Research");
  });

  it("provides tailored options quick-action chips in options view", () => {
    expect(chatSrc).toContain("Bull Put Spread");
    expect(chatSrc).toContain("Iron Condor");
  });
});
