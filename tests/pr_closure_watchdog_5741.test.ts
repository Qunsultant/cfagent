import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WATCHDOG_YML = fs.readFileSync(
  path.resolve(process.cwd(), ".github/workflows/pr-closure-watchdog.yml"),
  "utf8",
);
const VERIFY_PY = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/ci/verify_pr_closure.py"),
  "utf8",
);

describe("Issue #5741 — PR Closure Watchdog automation", () => {
  it("mints the trusted App token instead of reopening as github-actions[bot]", () => {
    expect(WATCHDOG_YML).toContain("actions/create-github-app-token@");
    expect(WATCHDOG_YML).toContain("AUTO_UPDATE_APP_CLIENT_ID");
    expect(WATCHDOG_YML).toContain("AUTO_UPDATE_APP_PRIVATE_KEY");
    expect(WATCHDOG_YML).toContain("steps.app-token.outputs.token || secrets.GITHUB_TOKEN");
  });

  it("skips reopen on 'superseded' label, cleans up stale same-repo branches, and checks git cherry in verify_pr_closure.py", () => {
    expect(WATCHDOG_YML).toContain("contains(github.event.pull_request.labels.*.name, 'superseded')");
    expect(WATCHDOG_YML).toContain("delete_stale_branch");
    expect(VERIFY_PY).toContain('run_git(["cherry", base_sha, sha])');
  });
});
