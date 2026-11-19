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

    // 4a. Superseded branch with a BARE leading issue number in the subject
    // (push-files convention, e.g. "3515 S3 batch 6: ...") and no number in
    // the branch name — a SHA invocation must extract it from the subject.
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "bare-subject-superseded-r1"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "superseded_feature.ts"), "export const code = 9999;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "9999 S3 batch 6: work on superseded r1"]);

    // 4b. Superseded branch whose number lives ONLY in the branch name
    // (subject carries no number) — a SHA invocation must be given the head
    // ref via --head-ref to see it.
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "issue-9999-name-only-r1"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "superseded_feature.ts"), "export const code = 9999;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "work on superseded r1 without a number in the subject"]);

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

    // 6. SHA-invoked supersede whose issue did NOT land on main
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "unlanded-bare-subject"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "unlanded7777.ts"), "export const unlanded = 7777;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "7777 S3 batch 6: unlanded work"]);

    // 7. Date-like subject must not yield a phantom issue number
    runGit(["checkout", "main"]);
    runGit(["checkout", "-b", "dated-subject-feature"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "dated.ts"), "export const dated = true;\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "2026-11-18 migrate dated feature"]);

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

  it("passes when evaluating a superseded branch BY ITS HEAD SHA with a bare leading issue number in the subject", () => {
    const sha = runGit(["rev-parse", "bare-subject-superseded-r1"]);
    const stdout = execFileSync(
      "python3",
      [scriptPath, sha, "--base", "main", "--json"],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
    expect(parsed.message).toContain("verified superseded without work loss");
    expect(parsed.message).toContain("issue #9999 landed");
  });

  it("passes when evaluating a superseded branch BY ITS HEAD SHA with --head-ref where the number lives only in the head ref", () => {
    const sha = runGit(["rev-parse", "issue-9999-name-only-r1"]);

    // Without --head-ref the number is invisible: still unsafe (the known
    // limitation of a bare SHA invocation).
    let error: any = null;
    try {
      execFileSync(
        "python3",
        [scriptPath, sha, "--base", "main", "--json"],
        { cwd: tempRepoDir, encoding: "utf-8" }
      );
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(error.status).toBe(1);
    expect(JSON.parse(error.stdout).safe_to_close).toBe(false);

    // With --head-ref the branch name is in the extraction text: safe.
    const stdout = execFileSync(
      "python3",
      [scriptPath, sha, "--base", "main", "--head-ref", "issue-9999-name-only-r1", "--json"],
      { cwd: tempRepoDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.safe_to_close).toBe(true);
    expect(parsed.changed_files_count).toBe(0);
    expect(parsed.message).toContain("verified superseded without work loss");
    expect(parsed.message).toContain("issue #9999 landed");
  });

  it("fails when evaluating a SHA-invoked supersede whose issue did not land on main", () => {
    const sha = runGit(["rev-parse", "unlanded-bare-subject"]);
    let error: any = null;
    try {
      execFileSync(
        "python3",
        [scriptPath, sha, "--base", "main", "--json"],
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
    expect(parsed.changed_files[0].path).toBe("src/unlanded7777.ts");
  });

  it("fails when evaluating a branch with a date-like subject and otherwise-unmerged content (no phantom issue)", () => {
    const sha = runGit(["rev-parse", "dated-subject-feature"]);
    let error: any = null;
    try {
      execFileSync(
        "python3",
        [scriptPath, sha, "--base", "main", "--json"],
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
    expect(parsed.changed_files[0].path).toBe("src/dated.ts");
  });
});
