/**
 * Policy Gate Guards Tests (#1684)
 *
 * Verifies that scripts/ci/policy_gate.py reliably enforces:
 * - (a) linked issue presence, either owner form (issue #2511):
 *   OpenAIMP/cfagent#N and Qunsultant/cfagent#N both pass, non-closing
 *   form keeps passing, neither form still fails
 * - (b) lane label (lane:*)
 * - (c) agent hashtag (#<agent>-<id>)
 * - (d) CHANGELOG entry under ## [Unreleased]
 * - (e) docs scope guard (docs PR cannot touch code/tests)
 * - (f) stale base reversion guard (cannot delete recently merged main additions)
 * - (i) no-deletion rule (issue #1894, supersedes (g)): no file may be
 *   deleted at all, with no label bypass; retire by deprecating in place.
 *   Exception (issue #1917): a deleted TEST file passes when an added
 *   test file covers every one of its test names (no title lost) and
 *   git pairs the two as a rename at a 20% threshold (or coverage is
 *   exact); non-test deletions still fail unconditionally
 * - (j) deprecation completeness (issue #1894): a new deprecation marker
 *   in code must name what superseded it
 * - head evaluation (issue #1894): a merge-commit HEAD resolves to the
 *   PR branch head, so (f)/(i)/(j) see the branch tree
 * - body-only attribution (issue #1894): (a)/(b)/(c) read the PR body
 *   and labels only; commit messages are not fallback context
 * - (h) process documentation line (gitops §23: PR body must carry the
 *   §9 "Process documentation impact:" checklist line, presence only)
 *
 * Uses an isolated, temporary git repository to ensure deterministic test
 * execution across all environments and shallow CI clones.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const SCRIPT_PATH = path.resolve(__dirname, "../scripts/ci/policy_gate.py");

let tempRepoDir = "";

function runGit(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runPolicyGate(
  env: Record<string, string>,
  args: string[] = ["--base", "main", "--head", "HEAD"],
  cwd: string = tempRepoDir
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(PYTHON_BIN, [SCRIPT_PATH, ...args], {
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", ...env },
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    const stdout = (err.stdout || "") + "\n" + (err.stderr || "");
    return { stdout, status: err.status ?? 1 };
  }
}

describe("Policy Gate Guards (#1684)", () => {
  beforeAll(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfagent-policy-test-"));
    runGit(tempRepoDir, ["init", "-b", "main"]);
    runGit(tempRepoDir, ["config", "user.email", "test@example.com"]);
    runGit(tempRepoDir, ["config", "user.name", "Test Runner"]);

    // Initial structure: CHANGELOG, src file, test file
    fs.mkdirSync(path.join(tempRepoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempRepoDir, "tests"), { recursive: true });

    fs.writeFileSync(
      path.join(tempRepoDir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- Base initial unreleased change\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, "src", "index.ts"), "export const a = 1;\n");
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "unit.test.ts"),
      "test('truthy', () => {});\n"
    );
    // Tiny base file for the exact-title move fixture (issue #1917).
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "tiny.test.ts"),
      `import { it, expect } from "vitest";
it("tiny alpha", () => { expect(1).toBe(1); });
it("tiny beta", () => { expect(2).toBe(2); });
`
    );
    // Base file for the rename-allowance fixtures (issue #1917): a test
    // file whose titles embed a vocabulary token, renamed throughout
    // on the fixture branches below.
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "old_modes.test.ts"),
      `import { describe, it, expect } from "vitest";
import { resolveFossSwitch, levelsForFossSwitch } from "../src/fossModes";

// Shared neutral helpers: identical in both files by design.
const NEUTRAL_TABLE = [1, 2, 3, 4, 5, 6, 7, 8];
function neutralSum(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}
function neutralCheck(value: number): boolean {
  return value > 0 && value < 1000;
}
const NEUTRAL_EXPECTED = neutralSum(NEUTRAL_TABLE);

describe("MCP foss commands", () => {
  it("F01 /foss/quote default: NVDA, no audit; mcp mode audits foss.quote.fetched", () => {
    expect(resolveFossSwitch("mcp")).toBe("mcp");
  });
  it("F01 /foss/quote invalid mode fails closed to rest + audits foss.config_error", () => {
    expect(resolveFossSwitch("bogus")).toBe("rest");
  });
  it("F02 /foss/bars default: fuller envelope + provider yfinance, no audit", () => {
    expect(levelsForFossSwitch("session")).toEqual(["session"]);
  });
});

describe("REST foss routes", () => {
  it("F01 /foss/fundamentals default: NVDA, no audit", () => {
    expect(resolveFossSwitch("rest")).toBe("rest");
  });
  it("fossModes resolver", () => {
    expect(levelsForFossSwitch("user")).toEqual(["user"]);
  });
});
`
    );

    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "chore: initial commit"]);

    // Branch 1: docs PR that improperly touches a src file
    runGit(tempRepoDir, ["checkout", "-b", "branch-docs-scope-violation"]);
    fs.appendFileSync(path.join(tempRepoDir, "src", "index.ts"), "export const b = 2;\n");
    runGit(tempRepoDir, ["commit", "-am", "docs: update docs but touch src"]);

    // Branch 2: branch deleting a test file
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-deletion"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "unit.test.ts"));
    runGit(tempRepoDir, ["commit", "-am", "refactor: delete test file"]);

    // Branch 3: stale base branch that reverts a file added to main
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-stale-reversion"]);
    // Advance main with a newly added file
    runGit(tempRepoDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "new_feature.ts"), "export const newF = true;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: new feature on main"]);

    // Branch 4: fully valid compliant feature branch
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-compliant"]);
    fs.writeFileSync(
      path.join(tempRepoDir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n- **Awesome feature (#1684):** compliant change #CTO-mbshr\n- Base initial unreleased change\n"
    );
    fs.writeFileSync(path.join(tempRepoDir, "src", "feature.ts"), "export const feat = 1;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: valid feature"]);

    // Branch 5: fragment-only PR (issue #1801) — no CHANGELOG change.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-fragment"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1684-feature.md"),
      "### Added\n\n- **Fragment feature (#1684):** changelog.d entry\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: fragment-only change"]);

    // Branch 6: header-only fragment — passes no gate: no entry line.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-fragment-empty"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, "changelog.d", "1684-empty.md"), "### Added\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: header-only fragment"]);

    // Branch 7: neither a CHANGELOG entry nor a fragment.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-no-changelog"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "nochange.ts"), "export const n = 1;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: no changelog at all"]);

    // Branch 8: deletes a src file (no-deletion rule covers every file).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-src-deletion"]);
    fs.unlinkSync(path.join(tempRepoDir, "src", "index.ts"));
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1894-src-del.md"),
      "### Added\n\n- **Src deletion fixture (#1894):** no-deletion test\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: delete src file"]);

    // Branch 9: deprecation that names its superseding module.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-deprecation-good"]);
    fs.appendFileSync(
      path.join(tempRepoDir, "src", "index.ts"),
      "/**\n * @deprecated Do not use. Superseded by src/feature.ts - use feature instead.\n */\nexport const oldApi = 1;\n"
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1894-dep-good.md"),
      "### Added\n\n- **Deprecation fixture (#1894):** complete deprecation\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: deprecate old API"]);

    // Branch 10: deprecation that names nothing superseding it.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-deprecation-bad"]);
    fs.appendFileSync(
      path.join(tempRepoDir, "src", "index.ts"),
      "// @deprecated Do not use this anymore.\nexport const oldApi2 = 1;\n"
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1894-dep-bad.md"),
      "### Added\n\n- **Deprecation fixture (#1894):** incomplete deprecation\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: deprecate without successor"]);

    // Branch 11: attribution lives ONLY in the commit message (must fail
    // under body-only attribution: body carries no ref, no hashtag).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-commit-attribution"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "commitattr.ts"), "export const c = 1;\n");
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1894-attr.md"),
      "### Added\n\n- **Attribution fixture (#1894):** commit-only attribution\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: commit attribution", "-m", "Fixes #1684 #CISO-bhdm"]);

    // Branch 12: heavily-edited test rename (issue #1917) — titles and
    // identifiers renamed throughout, two tests added. Similarity must
    // sit below git's default 50% rename threshold (so the pair reports
    // D+A and only the allowance can pass it) and above the 20% pairing
    // floor. Verified by the test run, not by construction.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-rename-allowed"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "old_modes.test.ts"));
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "new_modes.test.ts"),
      `import { describe, it, expect } from "vitest";
import {
  resolveMarketDataSwitch,
  levelsForMarketDataSwitch,
} from "../src/marketDataModes";

// Shared neutral helpers: identical in both files by design.
const NEUTRAL_TABLE = [1, 2, 3, 4, 5, 6, 7, 8];
function neutralSum(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}
function neutralCheck(value: number): boolean {
  return value > 0 && value < 1000;
}
const NEUTRAL_EXPECTED = neutralSum(NEUTRAL_TABLE);

// Renamed from the foss vocabulary; every old test is preserved.
describe("MCP market-data commands", () => {
  it("F01 /market-data/quote default: NVDA, no audit; mcp mode audits market_data.quote.fetched", () => {
    expect(resolveMarketDataSwitch("mcp")).toBe("mcp");
  });
  it("F01 /market-data/quote invalid mode fails closed to rest + audits market_data.config_error", () => {
    expect(resolveMarketDataSwitch("bogus")).toBe("rest");
  });
  it("F02 /market-data/bars default: fuller envelope + provider yfinance, no audit", () => {
    expect(levelsForMarketDataSwitch("session")).toEqual(["session"]);
  });
  it("F02 /market-data/bars rest mode honors an explicit provider", () => {
    expect(levelsForMarketDataSwitch("session", "yfinance")).toEqual(["session"]);
  });
});

describe("REST market-data routes", () => {
  it("F01 /market-data/fundamentals default: NVDA, no audit", () => {
    expect(resolveMarketDataSwitch("rest")).toBe("rest");
  });
  it("marketDataModes resolver", () => {
    expect(levelsForMarketDataSwitch("user")).toEqual(["user"]);
  });
  it("marketDataModes resolver rejects values outside each switch", () => {
    expect(resolveMarketDataSwitch("nope")).toBe("rest");
  });
});
`
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1917-rename-ok.md"),
      "### Added\n\n- **Rename fixture (#1917):** allowed test rename\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: rename test file with edits"]);

    // Branch 13: same rename but one old test dropped — must still fail (i).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-rename-drops-test"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "old_modes.test.ts"));
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "new_modes.test.ts"),
      `import { describe, it, expect } from "vitest";
import {
  resolveMarketDataSwitch,
  levelsForMarketDataSwitch,
} from "../src/marketDataModes";

// Shared neutral helpers: identical in both files by design.
const NEUTRAL_TABLE = [1, 2, 3, 4, 5, 6, 7, 8];
function neutralSum(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}
function neutralCheck(value: number): boolean {
  return value > 0 && value < 1000;
}
const NEUTRAL_EXPECTED = neutralSum(NEUTRAL_TABLE);

describe("MCP market-data commands", () => {
  it("F01 /market-data/quote default: NVDA, no audit; mcp mode audits market_data.quote.fetched", () => {
    expect(resolveMarketDataSwitch("mcp")).toBe("mcp");
  });
  it("F01 /market-data/quote invalid mode fails closed to rest + audits market_data.config_error", () => {
    expect(resolveMarketDataSwitch("bogus")).toBe("rest");
  });
});

describe("REST market-data routes", () => {
  it("F01 /market-data/fundamentals default: NVDA, no audit", () => {
    expect(resolveMarketDataSwitch("rest")).toBe("rest");
  });
  it("marketDataModes resolver", () => {
    expect(levelsForMarketDataSwitch("user")).toEqual(["user"]);
  });
});
`
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1917-rename-drop.md"),
      "### Added\n\n- **Rename fixture (#1917):** rename that drops a test\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: rename test file dropping one test"]);

    // Branch 14: test file deleted, unrelated new test file added — must fail (i).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-deletion-unrelated-add"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "old_modes.test.ts"));
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "unrelated.test.ts"),
      `import { describe, it, expect } from "vitest";

describe("arithmetic", () => {
  it("adds two numbers", () => {
    expect(1 + 2).toBe(3);
  });
  it("multiplies two numbers", () => {
    expect(2 * 3).toBe(6);
  });
});
`
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1917-unrelated-add.md"),
      "### Added\n\n- **Rename fixture (#1917):** deletion plus unrelated file\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: delete test file, add unrelated file"]);

    // Branch 15: heavily-edited NON-test rename — allowance is test-only, must fail (i).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-src-rename-heavy-edit"]);
    fs.unlinkSync(path.join(tempRepoDir, "src", "index.ts"));
    fs.writeFileSync(
      path.join(tempRepoDir, "src", "renamed.ts"),
      `export const renamed = "unrelated content";
export function renamedHelper(): number {
  return 42;
}
`
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1917-src-rename.md"),
      "### Added\n\n- **Rename fixture (#1917):** heavily-edited src rename\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: rename src file with heavy edits"]);

    // Branch 16: verbatim-title move (issue #1917) — titles identical,
    // bodies rewritten, unpaired even at 20%: only the exact-title
    // fallback can pass it.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-test-move-exact-titles"]);
    fs.unlinkSync(path.join(tempRepoDir, "tests", "tiny.test.ts"));
    fs.writeFileSync(
      path.join(tempRepoDir, "tests", "tiny2.test.ts"),
      `import { describe, it, expect } from "vitest";
import { somethingElse } from "../src/elsewhere";
describe("rewritten wrapper", () => {
  it("tiny alpha", () => {
    const value = computeSomethingCompletelyDifferent();
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1000000);
  });
  it("tiny beta", () => {
    const other = anotherUnrelatedComputation("x", "y", "z");
    expect(other).toBeDefined();
  });
});
`
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1917-exact-move.md"),
      "### Added\n\n- **Rename fixture (#1917):** verbatim-title move\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "refactor: move test file keeping titles"]);
  });

  afterAll(() => {
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      try {
        fs.rmSync(tempRepoDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error on Windows
      }
    }
  });

  it("rejects PR missing linked issue", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature",
      PR_BODY: "## Agent\n#CTO-mbshr",
      PR_LABELS: "lane:cto-mbshr",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(a) linked issue");
  });

  it("accepts a Qunsultant-form linked issue reference, non-closing (issue #2511)", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: admin provisioning UI",
      PR_BODY:
        "Related: Qunsultant/cfagent#2511 (not closing: the issue closes only after live proof).\n\n## Agent\n#ceo-aimp\n\nProcess documentation impact: none",
      PR_LABELS: "lane:ceo-aimp",
    });
    expect(res.stdout).not.toContain("(a) linked issue");
  });

  it("accepts an OpenAIMP-form linked issue reference, non-closing (issue #2511)", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: admin provisioning UI",
      PR_BODY:
        "Related: OpenAIMP/cfagent#2511 (not closing: the issue closes only after live proof).\n\n## Agent\n#ceo-aimp\n\nProcess documentation impact: none",
      PR_LABELS: "lane:ceo-aimp",
    });
    expect(res.stdout).not.toContain("(a) linked issue");
  });

  it("still rejects a body with neither owner reference (issue #2511)", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: admin provisioning UI",
      PR_BODY:
        "No linked issue here.\n\n## Agent\n#ceo-aimp\n\nProcess documentation impact: none",
      PR_LABELS: "lane:ceo-aimp",
    });
    expect(res.stdout).toContain("(a) linked issue");
  });

  it("rejects PR missing lane label or agent hashtag in body", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature (#100)",
      PR_BODY: "Fixes #100\nNo agent hashtag here",
      PR_LABELS: "unrelated-label",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(b) lane label");
  });

  it("rejects PR missing agent hashtag", () => {
    const res = runPolicyGate({
      PR_TITLE: "feat: add awesome feature (#100)",
      PR_BODY: "Fixes #100",
      PR_LABELS: "lane:cto-mbshr",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(c) agent hashtag");
  });

  it("catches docs-scoped PRs touching code files", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "docs(architecture): update architecture docs (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-docs-scope-violation"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(e) docs scope");
  });

  it("rejects any file deletion under the no-deletion rule (supersedes (g))", () => {
    const resWithoutLabel = runPolicyGate(
      {
        PR_TITLE: "refactor: cleanup tests (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-test-deletion"]
    );
    expect(resWithoutLabel.status).toBe(1);
    expect(resWithoutLabel.stdout).toContain("(i) no deletion");
  });

  it("rejects test deletion even with allow-test-deletion label (label no longer permits deletions)", () => {
    const resWithLabel = runPolicyGate(
      {
        PR_TITLE: "refactor: retirement cleanup (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr allow-test-deletion",
      },
      ["--base", "main", "--head", "branch-test-deletion"]
    );
    expect(resWithLabel.status).toBe(1);
    expect(resWithLabel.stdout).toContain("(i) no deletion");
  });

  it("rejects PR cut from stale base that reverts newly added main files", () => {
    const resStale = runPolicyGate(
      {
        PR_TITLE: "feat: stale branch work (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-stale-reversion"]
    );
    expect(resStale.status).toBe(1);
    expect(resStale.stdout).toContain("(f) stale base reversion");
  });

  it("validates that a compliant PR format passes all policy gate checks", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("passes Policy Gate (d) with only a changelog.d fragment (issue #1801)", () => {
    runGit(tempRepoDir, ["checkout", "branch-fragment"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: fragment-only change (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-fragment"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("rejects a header-only changelog.d fragment with no entry line", () => {
    runGit(tempRepoDir, ["checkout", "branch-fragment-empty"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: header-only fragment (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-fragment-empty"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(d) CHANGELOG");
  });

  it("rejects a PR missing the process documentation checklist line (gitops §23)", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(h) process documentation");
  });

  it("passes Policy Gate (h) when the process documentation line is present", () => {
    runGit(tempRepoDir, ["checkout", "branch-compliant"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: add awesome feature (#1684) #CTO-mbshr",
        PR_BODY:
          "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-compliant"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("rejects a PR with neither a CHANGELOG entry nor a fragment", () => {
    runGit(tempRepoDir, ["checkout", "branch-no-changelog"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: no changelog at all (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-no-changelog"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(d) CHANGELOG");
  });

  it("rejects a src file deletion under the no-deletion rule", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: delete src file (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-src-deletion"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(i) no deletion");
    expect(res.stdout).toContain("src/index.ts");
  });

  it("passes a deprecation that names its superseding module", () => {
    runGit(tempRepoDir, ["checkout", "branch-deprecation-good"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: deprecate old API (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-deprecation-good"]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("rejects a deprecation that names no superseding module", () => {
    runGit(tempRepoDir, ["checkout", "branch-deprecation-bad"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: deprecate without successor (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", "main", "--head", "branch-deprecation-bad"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(j) deprecation");
  });

  it("rejects attribution that lives only in commit messages (body-only rule)", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: commit attribution",
        PR_BODY: "No refs here",
        PR_LABELS: "unrelated-label",
      },
      ["--base", "main", "--head", "branch-commit-attribution"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(a) linked issue");
    expect(res.stdout).toContain("(c) agent hashtag");
  });

  it("allows a heavily-edited test rename when every old test name has a counterpart (issue #1917)", () => {
    runGit(tempRepoDir, ["checkout", "branch-test-rename-allowed"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: rename test file with edits (#1917) #CAIO-quns",
        PR_BODY: "Fixes #1917\n\n## Agent\n#CAIO-quns\n\n- [ ] Process documentation impact: gitops §22 + AGENTS.md updated",
        PR_LABELS: "lane:caio-quns",
      },
      ["--base", "main", "--head", "branch-test-rename-allowed"]
    );
    expect(res.stdout).not.toContain("(i) no deletion");
    expect(res.stdout).toContain("(i) allowed rename: tests/old_modes.test.ts -> tests/new_modes.test.ts");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("still rejects a test rename that drops one old test (issue #1917)", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: rename test file dropping one test (#1917) #CAIO-quns",
        PR_BODY: "Fixes #1917\n\n## Agent\n#CAIO-quns\n\n- [ ] Process documentation impact: gitops §22 + AGENTS.md updated",
        PR_LABELS: "lane:caio-quns",
      },
      ["--base", "main", "--head", "branch-test-rename-drops-test"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(i) no deletion");
    expect(res.stdout).toContain("tests/old_modes.test.ts");
  });

  it("still rejects a test deletion paired with an unrelated new test file (issue #1917)", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: delete test file, add unrelated file (#1917) #CAIO-quns",
        PR_BODY: "Fixes #1917\n\n## Agent\n#CAIO-quns\n\n- [ ] Process documentation impact: gitops §22 + AGENTS.md updated",
        PR_LABELS: "lane:caio-quns",
      },
      ["--base", "main", "--head", "branch-test-deletion-unrelated-add"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(i) no deletion");
    expect(res.stdout).toContain("tests/old_modes.test.ts");
  });

  it("still rejects a heavily-edited non-test rename: the allowance is test-only (issue #1917)", () => {
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: rename src file with heavy edits (#1917) #CAIO-quns",
        PR_BODY: "Fixes #1917\n\n## Agent\n#CAIO-quns\n\n- [ ] Process documentation impact: gitops §22 + AGENTS.md updated",
        PR_LABELS: "lane:caio-quns",
      },
      ["--base", "main", "--head", "branch-src-rename-heavy-edit"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(i) no deletion");
    expect(res.stdout).toContain("src/index.ts");
  });

  it("allows a verbatim-title move even when unpaired at 20% (issue #1917)", () => {
    runGit(tempRepoDir, ["checkout", "branch-test-move-exact-titles"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "refactor: move test file keeping titles (#1917) #CAIO-quns",
        PR_BODY: "Fixes #1917\n\n## Agent\n#CAIO-quns\n\n- [ ] Process documentation impact: gitops §22 + AGENTS.md updated",
        PR_LABELS: "lane:caio-quns",
      },
      ["--base", "main", "--head", "branch-test-move-exact-titles"]
    );
    expect(res.stdout).not.toContain("(i) no deletion");
    expect(res.stdout).toContain("(i) allowed rename: tests/tiny.test.ts -> tests/tiny2.test.ts");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
  });

  it("evaluates each queued PR individually on merge_group so PR #2 cannot mask a missing changelog or body edit in PR #1 (#2499)", () => {
    runGit(tempRepoDir, ["checkout", "branch-fragment"]);
    // Stacked merge_group where PR #1 (branch-no-changelog) has no changelog, while PR #2 (branch-fragment) does
    const stackedBad = JSON.stringify([
      {
        number: 101,
        title: "feat: first PR missing changelog (#1684)",
        body: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [x] Process documentation impact: none",
        labels: ["lane:cto-mbshr"],
        head: "branch-no-changelog",
      },
      {
        number: 102,
        title: "feat: second PR with fragment (#1684)",
        body: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [x] Process documentation impact: none",
        labels: ["lane:cto-mbshr"],
        head: "branch-fragment",
      },
    ]);
    const resMasked = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: stackedBad,
      },
      ["--base", "main", "--head", "branch-fragment"]
    );
    expect(resMasked.status).toBe(1);
    expect(resMasked.stdout).toContain("[PR #101] (d) CHANGELOG");

    // Compliant queued PR passes both per-PR metadata/tree checks and aggregate tree check
    const stackedGood = JSON.stringify([
      {
        number: 102,
        title: "feat: second PR with fragment (#1684)",
        body: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [x] Process documentation impact: none",
        labels: ["lane:cto-mbshr"],
        head: "branch-fragment",
      },
    ]);
    const resGood = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: stackedGood,
      },
      ["--base", "main", "--head", "branch-fragment"]
    );
    expect(resGood.status).toBe(0);
    expect(resGood.stdout).toContain("Policy gate passed");
  });

  it("still rejects file deletions (i) on merge_group event (#2497, #2499)", () => {
    const res = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: JSON.stringify([
          {
            number: 103,
            title: "refactor: delete src file (#1684)",
            body: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [x] Process documentation impact: none",
            labels: ["lane:cto-mbshr"],
            head: "branch-src-deletion",
          },
        ]),
      },
      ["--base", "main", "--head", "branch-src-deletion"]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("[PR #103] (i) no deletion");
    expect(res.stdout).toContain("src/index.ts");
  });

  it("detects a stale branch through a merge commit via head resolution (f)", () => {
    // Branch from current main; main then adds a fresh file the branch
    // never sees. The CI-style merge commit must NOT hide the staleness:
    // resolving HEAD to its second parent (the branch head) makes (f)
    // see the branch tree. This test advances main and merges, so it
    // runs last.
    runGit(tempRepoDir, ["checkout", "-b", "branch-merge-sim"]);
    runGit(tempRepoDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "fresh.ts"), "export const fresh = 1;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: fresh file on main"]);
    const mainWithFresh = runGit(tempRepoDir, ["rev-parse", "main"]);
    runGit(tempRepoDir, ["checkout", "branch-merge-sim"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "1894-sim.md"),
      "### Added\n\n- **Sim fragment (#1894):** merge-head test\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: sim fragment"]);
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["merge", "branch-merge-sim", "--no-ff", "-m", "ci merge simulation"]);
    const mergeHead = runGit(tempRepoDir, ["rev-parse", "main"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: sim fragment (#1684) #CTO-mbshr",
        PR_BODY: "Fixes #1684\n\n## Agent\n#CTO-mbshr\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:cto-mbshr",
      },
      ["--base", mainWithFresh, "--head", mergeHead]
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("(f) stale base reversion");
    expect(res.stdout).toContain("src/fresh.ts");
  });

  it("merge_group per-PR check: does not false-fail (f)/(i) when main advanced after PR was cut (#2519)", () => {
    // Regression test for issue #2519 root cause 2:
    // Before the fix, policy_gate.py passed base=origin/main to evaluate_policy
    // for each queued PR. If main advanced (another PR merged) between when the
    // PR was opened and when the merge-group gate ran, git-diff(main, pr.head)
    // treated every file added to main since branching as "deleted by this PR",
    // producing spurious (f)/(i) failures.
    //
    // After the fix, the script computes pr_base = git merge-base main pr.head
    // so each PR is only diffed against its own authored commits.
    //
    // Setup:
    //   1. current main already has src/fresh.ts (from the test above).
    //   2. We create a branch from main~1 (before fresh.ts), add mq_fix.ts +
    //      changelog.
    //   3. We create a merge commit on main that combines main + the PR branch
    //      (this is the merge_group "merged head" — it has both fresh.ts AND
    //      mq_fix.ts). The aggregate tree check uses this merge commit as --head
    //      so it sees no deletions.
    //   4. The per-PR check uses prHead (lacks fresh.ts) but with the merge-base
    //      fix it diffs only against main~1, so fresh.ts is not seen as deleted.
    const mainBeforeFresh = runGit(tempRepoDir, [
      "rev-parse",
      "main~1", // the commit just before fresh.ts was added to main
    ]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-mq-no-false-positive", mainBeforeFresh]);

    // Add a compliant src file and changelog fragment on this branch
    fs.writeFileSync(
      path.join(tempRepoDir, "src", "mq_fix.ts"),
      "export const mqFix = true;\n"
    );
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "2519-mq-fix.md"),
      "### Fixed\n\n- **MQ deadlock fix (#2519):** per-PR merge-base diff\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "fix: mq false positive regression (#2519) #CFO-qunso"]);
    const prHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    // Build the merge_group merge commit: merge the PR branch into main.
    // This commit has BOTH fresh.ts (from main) AND mq_fix.ts (from PR branch),
    // so the aggregate tree check (base=currentMain, head=mergeCommit) sees
    // only additions, never deletions.
    const currentMain = runGit(tempRepoDir, ["rev-parse", "main"]);
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["merge", "branch-mq-no-false-positive", "--no-ff", "-m",
      "ci(merge_group): merge branch-mq-no-false-positive into main"]);
    const mergeCommit = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    const prJson = JSON.stringify([
      {
        number: 200,
        title: "fix: mq false positive regression (#2519) #CFO-qunso",
        body: "Fixes #2519\n\n## Agent\n#CFO-qunso\n\n- [x] Process documentation impact: none",
        labels: ["lane:cfo-qunso"],
        // prHead is cut from main~1, so it lacks fresh.ts.
        // The per-PR merge-base fix should diff it against main~1 only.
        head: prHead,
      },
    ]);

    // --base=currentMain (has fresh.ts), --head=mergeCommit (has both files).
    // Aggregate: diff(currentMain..mergeCommit) = only mq_fix.ts + changelog added, no deletions.
    // Per-PR:   merge-base(currentMain, prHead) = mainBeforeFresh;
    //           diff(mainBeforeFresh..prHead) = only mq_fix.ts + changelog added, no deletions.
    const res = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: prJson,
      },
      ["--base", currentMain, "--head", mergeCommit]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
    // Confirm fresh.ts is NOT reported as a false (f) or (i) failure
    expect(res.stdout).not.toContain("(f) stale base reversion");
    expect(res.stdout).not.toContain("(i) no deletion");
  });

  it("resolves branch parent when main was merged into the PR branch (#2546)", () => {
    // When main is merged into the PR branch, parent 0 is the branch and parent 1 is main.
    // policy_gate must inspect the branch parent, not main, ensuring CHANGELOG fragment is detected.
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-merge-main"]);
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "2546-sim.md"),
      "### Added\n\n- **Sim fragment (#2546):** merge main into branch test\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: branch commit with changelog"]);
    runGit(tempRepoDir, ["merge", "main", "--no-ff", "-m", "Merge branch 'main' into branch-merge-main"]);
    const branchHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);
    const res = runPolicyGate(
      {
        PR_TITLE: "feat: branch with merged main (#2546) #COO-spr9",
        PR_BODY: "Fixes #2546\n\n## Agent\n#COO-spr9\n\n- [ ] Process documentation impact: none",
        PR_LABELS: "lane:coo-spr9",
      },
      ["--base", "main", "--head", branchHead]
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
    expect(res.stdout).not.toContain("(d) CHANGELOG");
  });

  it("allows zero-touch merge for pure documentation PRs (#2555)", () => {
    // A pure documentation PR modifying only docs/ passes without
    // issue reference (a), lane label (b), hashtag (c), changelog (d), or process doc line (h).
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-pure-docs"]);
    fs.mkdirSync(path.join(tempRepoDir, "docs", "agentic-org"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "docs", "agentic-org", "platforms.md"),
      "# Platforms\n\nDocs content update without code or ceremony.\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "docs: update platforms documentation"]);
    const docsHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    const res = runPolicyGate(
      {
        PR_TITLE: "Create docs/agentic-org/platforms.md",
        PR_BODY: "Adding platforms documentation.",
        PR_LABELS: "",
      },
      ["--base", "main", "--head", docsHead]
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
    expect(res.stdout).not.toContain("(a) linked issue");
    expect(res.stdout).not.toContain("(b) lane label");
    expect(res.stdout).not.toContain("(c) agent hashtag");
    expect(res.stdout).not.toContain("(d) CHANGELOG");
    expect(res.stdout).not.toContain("(h) process documentation");
  });

  it("allows zero-touch docs PR in merge_group after merging main (#2555)", () => {
    // When main has new commits and was merged into a pure docs PR,
    // merge_group evaluates the per-PR check without (f) stale base reversion.
    runGit(tempRepoDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "new_feature.ts"), "export const b = 2;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: new feature on main"]);
    const currentMain = runGit(tempRepoDir, ["rev-parse", "main"]);

    runGit(tempRepoDir, ["checkout", "branch-pure-docs"]);
    runGit(tempRepoDir, ["merge", "main", "--no-ff", "-m", "Merge branch 'main' into branch-pure-docs"]);
    const docsHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    const prJson = JSON.stringify([
      {
        number: 2554,
        title: "Create docs/agentic-org/platforms.md",
        body: "Adding platforms documentation.",
        labels: [],
        head: docsHead,
      },
    ]);

    const res = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: prJson,
      },
      ["--base", currentMain, "--head", docsHead]
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
    expect(res.stdout).not.toContain("(f) stale base reversion");
  });

  it("merge_group per-PR check does not false-fail check (f) when main advanced since PR was cut (#2571)", () => {
    // When multiple PRs are processed in merge_group, downstream PR branches cut
    // from older main lack commits added to main. The aggregate check validates
    // the queue-rebased tree, so per-PR check must not false-fail (f).
    runGit(tempRepoDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "main_new_file_2571.ts"), "export const newFile = true;\n");
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "feat: new file on main (#2571)"]);
    const currentMain = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    // Create PR branch from commit before the new file
    const oldBase = runGit(tempRepoDir, ["rev-parse", "HEAD~1"]);
    runGit(tempRepoDir, ["checkout", "-b", "branch-old-base-2571", oldBase]);
    fs.writeFileSync(path.join(tempRepoDir, "src", "pr_file_2571.ts"), "export const prFile = true;\n");
    fs.mkdirSync(path.join(tempRepoDir, "changelog.d"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "changelog.d", "2571-test.md"),
      "### Fixed\n\n- **CI/CD merge queue fix (#2571):** skip stale base on per-PR check\n"
    );
    runGit(tempRepoDir, ["add", "-A"]);
    runGit(tempRepoDir, ["commit", "-m", "fix: pr commit (#2571) #COO-spr9"]);
    const prHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    // Merge PR into main to form the merge_group tree (has both files)
    runGit(tempRepoDir, ["checkout", "main"]);
    runGit(tempRepoDir, ["merge", "branch-old-base-2571", "--no-ff", "-m", "ci(merge_group): rebased queue tree"]);
    const queueTreeHead = runGit(tempRepoDir, ["rev-parse", "HEAD"]);

    const prJson = JSON.stringify([
      {
        number: 2571,
        title: "fix: pr test (#2571) #COO-spr9",
        body: "Fixes #2571\n\n## Agent\n#COO-spr9\n\n- [ ] Process documentation impact: none",
        labels: ["lane:coo-spr9"],
        head: prHead,
      },
    ]);

    const res = runPolicyGate(
      {
        GITHUB_EVENT_NAME: "merge_group",
        MERGE_GROUP_PRS_JSON: prJson,
      },
      ["--base", currentMain, "--head", queueTreeHead]
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Policy gate passed");
    expect(res.stdout).not.toContain("(f) stale base reversion");
  });
});
