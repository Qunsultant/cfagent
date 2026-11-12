/**
 * Tests for .github/workflows/auto-update-prs-app.yml and workflow runner standardization.
 *
 * Ensures the App-authenticated updater triggers on push to main, handles pagination,
 * avoids duplicate dispatches, and all repo workflows use pinned ubuntu-24.04 runners.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url);
const workflowContent = readFileSync(workflowPath, "utf-8");

describe("auto-update-prs-app.yml workflow configuration", () => {
  it("replaces the previous updater instead of leaving both active", () => {
    expect(existsSync(new URL("../.github/workflows/auto-update-prs.yml", import.meta.url))).toBe(false);
  });

  it("no longer triggers on push to main — manual dispatch only (#4264)", () => {
    expect(workflowContent).toContain("workflow_dispatch:");
    expect(workflowContent).not.toMatch(/^\s*push:\s*$/m);
    expect(workflowContent).not.toMatch(/^\s*branches:\s*$/m);
  });

  it("pins runner to ubuntu-24.04", () => {
    expect(workflowContent).toMatch(/runs-on:\s*ubuntu-24\.04/);
  });

  it("creates a narrowly scoped GitHub App token from repository configuration", () => {
    expect(workflowContent).toContain("actions/create-github-app-token@");
    expect(workflowContent).toContain("vars.AUTO_UPDATE_APP_CLIENT_ID");
    expect(workflowContent).toContain("secrets.AUTO_UPDATE_APP_PRIVATE_KEY");
    expect(workflowContent).toContain("permission-contents: write");
    expect(workflowContent).toContain("permission-pull-requests: write");
    expect(workflowContent).not.toContain("permission-actions:");
  });

  it("uses the App token with pagination and updateBranch API without manual dispatches", () => {
    expect(workflowContent).toContain("actions/github-script@");
    expect(workflowContent).toContain("github-token: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}");
    expect(workflowContent).toContain("github.paginate(github.rest.pulls.list");
    expect(workflowContent).toContain("github.rest.pulls.updateBranch");
    expect(workflowContent).not.toContain("github.rest.actions.createWorkflowDispatch");
    expect(workflowContent).not.toContain("if (pr.draft) continue;");
  });

  it("skips Dependabot PRs to prevent exponential CI workflow thrash on reference-only PRs", () => {
    expect(workflowContent).toContain("pr.user?.login === 'dependabot[bot]'");
    expect(workflowContent).toContain("isDependabot");
    expect(workflowContent).toContain("Skipping Dependabot PR");
  });

  it("skips fork PRs because the App is installed only on the base repository", () => {
    expect(workflowContent).toContain("pr.head?.repo?.full_name !== baseRepo");
    expect(workflowContent).toContain("Skipping fork PR");
  });
});

describe("workflow runner standardization", () => {
  it("ensures no workflow in .github/workflows uses unpinned ubuntu-latest", () => {
    const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(workflowsDir, file), "utf-8");
      expect(content, `${file} should not use ubuntu-latest`).not.toMatch(/runs-on:\s*ubuntu-latest/);
    }
  });
});
