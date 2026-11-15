/**
 * Flows tab migration pin (#1804 S2, issue #2027): OptionsFlowsHub runs
 * its inner tabs on the shared `useUrlSyncedTabs` hook with `?flowsTab=`
 * as the canonical param and "live" as the default — no bespoke tab state.
 * Issue #4576 moved it off `view`: that param belongs to the Options hub,
 * which nests this panel under `view=options-flows`.
 * (The hub is too fetch-heavy for a cheap render test, so this pins the
 * wiring; the hook's own behavior is covered by
 * tests/use_url_synced_tabs.test.tsx.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("OptionsFlowsHub tab wiring (S2 phase 3)", () => {
  const hubSrc = readFileSync("src/client/options/flows/OptionsFlowsHub.tsx", "utf8");

  it("uses the shared hook with ?flowsTab= and the live default", () => {
    expect(hubSrc).toContain('useUrlSyncedTabs<FlowSubTab>');
    expect(hubSrc).toContain('param: "flowsTab"');
    expect(hubSrc).toContain('defaultTab: "live"');
  });

  it("has no bespoke tab state left", () => {
    expect(hubSrc).not.toContain("handleSwitchSubTab");
    expect(hubSrc).not.toContain("setSubTab");
  });
});
