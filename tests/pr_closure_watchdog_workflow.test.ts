import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = new URL("../.github/workflows/pr-closure-watchdog.yml", import.meta.url);

describe("pr-closure-watchdog.yml workflow configuration (#3444)", () => {
  it("exists in .github/workflows", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  const content = readFileSync(workflowPath, "utf-8");

  it("triggers on pull_request_target closed events", () => {
    expect(content).toMatch(/pull_request_target:\s*\n\s*types:\s*\[closed\]/);
  });

  it("pins runner to ubuntu-24.04", () => {
    expect(content).toMatch(/runs-on:\s*ubuntu-24\.04/);
    expect(content).not.toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it("requires pull-requests: write and issues: write permissions", () => {
    expect(content).toMatch(/pull-requests:\s*write/);
    expect(content).toMatch(/issues:\s*write/);
  });

  it("executes verify_pr_closure.py with ignore-changelog and json flags", () => {
    expect(content).toContain("python3 scripts/ci/verify_pr_closure.py");
    expect(content).toContain("--ignore-changelog");
    expect(content).toContain("--json");
  });

  it("attempts to reopen the PR and falls back to filing an incident issue", () => {
    expect(content).toContain("gh pr reopen");
    expect(content).toContain("unmerged-work-detected");
    expect(content).toContain("repos/$GITHUB_REPOSITORY/issues");
  });
});
