import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, type BrandConfig } from "../src/client/branding";
import { BRAND as REEXPORTED_BRAND } from "../src/client/designTokens";
import { renderLandingPage } from "../src/client/landing";

const ROOT = join(__dirname, "..");

describe("Thematic Branding Token Architecture (Issue #1297)", () => {
  it("exports a single canonical BRAND token configuration", () => {
    expect(BRAND).toBeDefined();
    expect(REEXPORTED_BRAND).toBe(BRAND);
    expect(BRAND.name).toBe("NextGenTP");
    expect(typeof BRAND.tagline).toBe("string");
    expect(BRAND.tagline.length).toBeGreaterThan(5);
    expect(BRAND.badge).toBe("PRO");
    expect(BRAND.copilotName).toBe("NextGenTP Agent Copilot");
    expect(BRAND.searchName).toBe("NextGenTP Global Search");
    expect(BRAND.storagePrefix).toBe("nextgentp");
  });

  it("positions AI Search Agent as one agent in the multi-agent ecosystem, not the system brand", () => {
    expect(BRAND.ecosystem).toBeDefined();
    expect(BRAND.ecosystem.systemName).toBe("NextGenTP");
    expect(Array.isArray(BRAND.ecosystem.agents)).toBe(true);
    expect(BRAND.ecosystem.agents.length).toBeGreaterThanOrEqual(4);

    const searchAgent = BRAND.ecosystem.agents.find((a) => a.id === "ai_search");
    expect(searchAgent).toBeDefined();
    expect(searchAgent?.name).toContain("AI Search Agent");
    // Ensure the system name is NOT AI Search Agent
    expect(BRAND.name).not.toBe("AI Search Agent");
    expect(BRAND.name).toBe("NextGenTP");

    const orchestratorAgent = BRAND.ecosystem.agents.find((a) => a.id === "orchestrator");
    expect(orchestratorAgent).toBeDefined();

    const screenerAgent = BRAND.ecosystem.agents.find((a) => a.id === "screener");
    expect(screenerAgent).toBeDefined();
  });

  it("renderLandingPage dynamically adheres to BRAND tokens", () => {
    const defaultHtml = renderLandingPage();
    expect(defaultHtml).toContain(BRAND.name);
    expect(defaultHtml).toContain(`Why ${BRAND.name} Outperforms`);

    const customHtml = renderLandingPage("CustomEnterprise");
    expect(customHtml).toContain("CustomEnterprise");
    expect(customHtml).toContain("Why CustomEnterprise Outperforms");
  });

  it("CSS foundation in tokens.css carries brand custom properties", () => {
    const css = readFileSync(join(ROOT, "src", "client", "tokens.css"), "utf8");
    expect(css).toContain("--brand-name:");
    expect(css).toContain("--brand-tagline:");
    expect(css).toContain("--brand-badge:");
  });

  it("all primary UI components import and consume BRAND from the UX token architecture", () => {
    const navMenuSrc = readFileSync(join(ROOT, "src", "client", "components", "NavigationMenu.tsx"), "utf8");
    expect(navMenuSrc).toContain('from "../branding"');
    expect(navMenuSrc).toContain("BRAND.name");
    expect(navMenuSrc).toContain("BRAND.badge");

    const askWidgetSrc = readFileSync(join(ROOT, "src", "client", "components", "AskAgentWidget.tsx"), "utf8");
    expect(askWidgetSrc).toContain('from "../branding"');
    expect(askWidgetSrc).toContain("BRAND.copilotName");

    const searchBarSrc = readFileSync(join(ROOT, "src", "client", "components", "StockSearchBar.tsx"), "utf8");
    expect(searchBarSrc).toContain('from "../branding"');
    expect(searchBarSrc).toContain("BRAND.searchName");

    const capabilityNavSrc = readFileSync(join(ROOT, "src", "client", "components", "CapabilityNavBar.tsx"), "utf8");
    expect(capabilityNavSrc).toContain('from "../branding"');
    expect(capabilityNavSrc).toContain("BRAND.copilotName");

    const autopilotSrc = readFileSync(join(ROOT, "src", "client", "components", "AutopilotControlCenter.tsx"), "utf8");
    expect(autopilotSrc).toContain('from "../branding"');
    expect(autopilotSrc).toContain("BRAND.name");

    const chatSrc = readFileSync(join(ROOT, "src", "client", "Chat.tsx"), "utf8");
    expect(chatSrc).toContain('from "./branding"');
    expect(chatSrc).toContain("BRAND.name");
  });

  it("slice 7 (#2727): no hardcoded brand literal remains outside the seam", () => {
    // The seam (branding.ts) is the only canonical definition; the four
    // files below previously carried 9 hardcoded "NextGenTP" literals.
    // ReferralsTab renders its share copy via BRAND.name; the other five
    // occurrences were comments, reworded to drop the brand token since
    // a comment cannot consume the seam and would go stale on a rename.
    const files = [
      join(ROOT, "src", "client", "chat", "tabs", "ReferralsTab.tsx"),
      join(ROOT, "src", "client", "components", "AutopilotControlCenter.tsx"),
      join(ROOT, "src", "client", "landing.ts"),
      join(ROOT, "src", "client", "Chat.tsx"),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("NextGenTP");
    }
    const referralsSrc = readFileSync(
      join(ROOT, "src", "client", "chat", "tabs", "ReferralsTab.tsx"),
      "utf8"
    );
    expect(referralsSrc).toContain('from "../../branding"');
    expect(referralsSrc).toContain("BRAND.name");
  });
});
