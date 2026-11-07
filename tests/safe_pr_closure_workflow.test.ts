import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

describe("Anti-Work-Loss Guardrail (scripts/ci/verify_pr_closure.py)", () => {
  const scriptPath = path.resolve(__dirname, "../scripts/ci/verify_pr_closure.py");
  let tempRepoDir: string;

  function runGit(args: string[]) {
    return execFileSync("git", args, { cwd: tempRepoDir, encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfagent-closure-test-"));
    runGit(["init", "-b", "main"]);
    runGit(["config", "user.email", "test@example.com"]);
    runGit(["config", "user.name", "Test Runner"]);

    // Initial commit on main
    fs.mkdirSync(path.join(tempRepoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, "src", "index.ts"), "export const base = 1;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "initial commit"]);

    // 1. Branch whose changes are fully absorbed into main
    runGit(["checkout", "-b", "absorbed-feature"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "absorbed.ts"), "export const absorbed = true;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "add absorbed feature"]);
    runGit(["checkout", "main"]);
    runGit(["merge", "--no-ff", "absorbed-feature", "-m", "merge absorbed-feature"]);

    // 2. Branch with unmerged changes
    runGit(["checkout", "-b", "unmerged-feature"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "unmerged.ts"), "export const unmerged = true;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "add unmerged feature"]);

    // 3. Branch with changelog-only changes
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "changelog-only-feature"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1234-feature.md"),
      "### Added\n- Feature\n"
    );
    runGit(["add", "."]);
    runGit(["commit", "-m", "add changelog fragment"]);

    // 4. Superseded branch whose issue landed via a re-cut commit on main
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "feat/9999-superseded-r1"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "superseded_feature.ts"), "export const code = 9999;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "feat(9999): work on superseded r1"]);

    // Advance main with an unrelated commit
    runGit(["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "unrelated.ts"), "export const unrelated = true;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "chore: unrelated commit on main"]);

    // Land issue 9999 on main via re-cut (simulating squash / MQ landing) with evolved content
    fs.writeFileSync(
      path.join(tempRepoDir, "src", "superseded_feature.ts"),
      "export const code = 9999;\nexport const evolved = true;\n"
    );
    runGit(["add", "."]);
    runGit(["commit", "-m", "feat(9999): superseded feature landed via r2 with additions"]);

    // 5. Superseded branch with a lost file that was not in the landed commit
    runGit(["checkout", "-b", "feat/8888-with-lost-file"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "lost.ts"), "export const lost = true;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "feat(8888): work with lost file"]);
    runGit(["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "other8888.ts"), "export const other = 8888;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "feat(8888): issue 8888 landed without lost.ts"]);

    runGit(["checkout", "main"]);
  });

  afterAll(() => {
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failure on Windows locks
    }
  });

  it("passes when comparing main against main (zero unmerged changes)", () => {
    const stdout = execFileSync(
      "python3",
      [scriptPath, "main", "--base", "main", "--json"],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
    expect(parsed.changed_files).toEqual([]);
    expect(parsed.message).toContain("Zero unmerged functional differences");
  });

  it("passes when comparing a branch that was fully merged into main", () => {
    const stdout = execFileSync(
      "python3",
      [scriptPath, "absorbed-feature", "--base", "main", "--json"],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
  });

  it("fails when evaluating a branch with unmerged functional changes", () => {
    let error: any = null;
    try {
      execFileSync(
        "python3",
        [scriptPath, "unmerged-feature", "--base", "main", "--json"],
        { cwd: tempRepoDir, encoding: "utf-8" }
      );
    } catch (e) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error.status).toBe(1);
    const parsed = JSON.parse(error.stdout);
    expect(parsed.safe_to_close).toBe(false);
    expect(parsed.changed_files_count).toBe(1);
    expect(parsed.changed_files[0].path).toBe("src/unmerged.ts");
    expect(parsed.message).toContain("Work-loss prevention rule");
    expect(parsed.message).toContain("Refusing closure");
  });

  it("permits emergency override when --allow-override flag is passed", () => {
    const stdout = execFileSync(
      "python3",
      [
        scriptPath,
        "unmerged-feature",
        "--base",
        "main",
        "--allow-override",
        "--json",
      ],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(false);
    expect(parsed.changed_files_count).toBe(1);
    expect(parsed.message).toContain("Work-loss prevention rule");
  });

  it("filters changelog fragments when --ignore-changelog is specified", () => {
    const stdout = execFileSync(
      "python3",
      [
        scriptPath,
        "changelog-only-feature",
        "--base",
        "main",
        "--ignore-changelog",
        "--json",
      ],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
  });

  it("passes when evaluating a superseded branch whose issue landed on main and additive files are present", () => {
    const stdout = execFileSync(
      "python3",
      [
        scriptPath,
        "feat/9999-superseded-r1",
        "--base",
        "main",
        "--json",
      ],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
    expect(parsed.message).toContain("verified superseded without work loss");
  });

  it("fails when evaluating a superseded branch that has unique added files not absorbed into main", () => {
    let error: any = null;
    try {
      execFileSync(
        "python3",
        [
          scriptPath,
          "feat/8888-with-lost-file",
          "--base",
          "main",
          "--json",
        ],
        { cwd: tempRepoDir, encoding: "utf-8" }
      );
    } catch (e) {
      error = e;
    }

    expect(error).not.toBeNull();
    expect(error.status).toBe(1);
    const parsed = JSON.parse(error.stdout);
    expect(parsed.safe_to_close).toBe(false);
    expect(parsed.changed_files_count).toBe(1);
    expect(parsed.changed_files[0].path).toBe("src/lost.ts");
  });
});
