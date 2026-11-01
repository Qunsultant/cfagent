/**
 * CI/CD CodeQL Tree Deduplication & Dual Workflow_Run Velocity Guard (#2632).
 *
 * Verifies:
 * 1. codeql.yml implements 24-hour non-transitive tree-hash deduplication on merge_group,
 *    skipping re-analysis when HEAD^{tree} was already analyzed in a successful CodeQL run.
 * 2. codeql.yml writes the deduplication audit trail to $GITHUB_STEP_SUMMARY.
 * 3. auto-update-prs-app.yml triggers on completion of BOTH "Continuous Integration & Test Verification"
 *    and "CodeQL" so PRs are evaluated and enqueued without waiting for cron intervals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const codeqlYml = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf-8"
);
const autoUpdateYml = readFileSync(
  new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url),
  "utf-8"
);

describe("CodeQL Tree Deduplication & Dual Workflow_Run Auto-Enqueue (#2632)", () => {
  it("implements 24h tree-hash deduplication on merge_group in codeql.yml (#2632)", () => {
    expect(codeqlYml).toContain("git rev-parse 'HEAD^{tree}'");
    expect(codeqlYml).toContain("tree_already_analyzed");
    expect(codeqlYml).toContain("24 hours ago");
    expect(codeqlYml).toContain("GITHUB_STEP_SUMMARY");
    expect(codeqlYml).toContain("steps.dedup.outputs.tree_already_analyzed != 'true'");
  });

  it("skips CodeQL initialization, autobuild, and analysis when tree is already analyzed (#2632)", () => {
    expect(codeqlYml).toMatch(/Initialize CodeQL[\s\S]*?tree_already_analyzed != 'true'/);
    expect(codeqlYml).toMatch(/Autobuild[\s\S]*?tree_already_analyzed != 'true'/);
    expect(codeqlYml).toMatch(/Perform CodeQL Analysis[\s\S]*?tree_already_analyzed != 'true'/);
  });

  it("monitors both CI and CodeQL workflow completions in auto-update-prs-app.yml (#2632)", () => {
    expect(autoUpdateYml).toContain("Continuous Integration & Test Verification");
    expect(autoUpdateYml).toContain("CodeQL");
    expect(autoUpdateYml).toMatch(/workflow_run:\s*[\r\n]+\s*workflows:\s*[\r\n]+\s*-\s*["']Continuous Integration & Test Verification["']\s*[\r\n]+\s*-\s*["']CodeQL["']/);
  });
});
