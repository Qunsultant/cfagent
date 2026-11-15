/**
 * Research tab migration pin (#1804 S2, issue #2027): MarketDataResearchHub
 * runs its inner tabs on the shared `useUrlSyncedTabs` hook with
 * `?researchTab=` as the canonical param and "screener" as the default —
 * no bespoke tab state. Issue #4576 moved it off `view`: that param belongs
 * to the Stock hub, which nests this panel under `view=research`. (The hub is too fetch-heavy for a cheap render test, so this
 * pins the wiring; the hook's own behavior is covered by
 * tests/use_url_synced_tabs.test.tsx.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("MarketDataResearchHub tab wiring (S2 phase 3)", () => {
  const hubSrc = readFileSync("src/client/MarketDataResearchHub.tsx", "utf8");

  it("uses the shared hook with ?researchTab= and the screener default", () => {
    expect(hubSrc).toContain("useUrlSyncedTabs<ResearchSubTab>");
    expect(hubSrc).toContain('param: "researchTab"');
    expect(hubSrc).toContain('defaultTab: "screener"');
  });

  it("has no bespoke tab state left", () => {
    expect(hubSrc).not.toContain("setSubTab");
  });
});
