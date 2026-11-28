/**
 * Workflows tab migration pin (#1804 S2, issue #2027): WorkflowsHub runs
 * its subnav on real Tabs + the shared `useUrlSyncedTabs` hook with
 * `?view=` as the canonical param and "faq" as the default — no
 * PillGroup subnav, no bespoke tab state. (The hub is content-heavy, so
 * this pins the wiring; the hook's own behavior is covered by
 * tests/use_url_synced_tabs.test.tsx.)
 *
 * Issue #6709: the views live in one named registry (`WORKFLOWS_VIEWS`
 * in WorkflowsHub.tsx) — the Tabs strip and the validator read it, never
 * an inline literal duplicated between the page and a test. This file
 * parses the registry out of the source and pins the panels, labels,
 * and validator against it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function parseRegistryIds(hubSrc: string): string[] {
  const match = hubSrc.match(
    /export const WORKFLOWS_VIEWS: readonly WorkflowsSubTab\[\] = \[([\s\S]*?)\];/,
  );
  if (!match) throw new Error("WORKFLOWS_VIEWS registry not found in WorkflowsHub.tsx");
  return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("WorkflowsHub tab wiring (S2 phase 3)", () => {
  const hubSrc = readFileSync("src/client/WorkflowsHub.tsx", "utf8");

  it("uses Tabs + the shared hook with ?view= and the faq default", () => {
    expect(hubSrc).toContain("useUrlSyncedTabs<WorkflowsSubTab>");
    expect(hubSrc).toContain('param: "view"');
    expect(hubSrc).toContain('defaultTab: "faq"');
    expect(hubSrc).toContain("<Tabs");
    expect(hubSrc).toContain('idBase="workflows"');
  });

  it("has no bespoke tab state left", () => {
    expect(hubSrc).not.toContain("setActiveTab");
  });

  it("declares the six views in one registry (issue #6709)", () => {
    expect(parseRegistryIds(hubSrc)).toEqual([
      "faq",
      "workflows",
      "decisioning",
      "matrix",
      "improvements",
      "capabilities",
    ]);
  });

  it("renders the Tabs strip from the registry, with a label per view", () => {
    expect(hubSrc).toContain("WORKFLOWS_VIEWS.map(");
    const labelsMatch = hubSrc.match(
      /export const WORKFLOWS_VIEW_LABELS: Record<WorkflowsSubTab, string> = \{([\s\S]*?)\};/,
    );
    if (!labelsMatch) throw new Error("WORKFLOWS_VIEW_LABELS not found in WorkflowsHub.tsx");
    for (const id of parseRegistryIds(hubSrc)) {
      expect(labelsMatch[1]).toContain(`${id}: "`);
    }
  });

  it("validates tabs against the registry", () => {
    expect(hubSrc).toContain("(WORKFLOWS_VIEWS as readonly string[]).includes(tab)");
  });

  it("wires every panel to its tab for ARIA", () => {
    for (const tab of parseRegistryIds(hubSrc)) {
      expect(hubSrc).toContain(`id="workflows-panel-${tab}"`);
      expect(hubSrc).toContain(`aria-labelledby="workflows-tab-${tab}"`);
    }
  });
});
