/**
 * Gitleaks allowlist rule-scoping (#1762, #1717 slice F-35).
 *
 * Before #1762, `.gitleaks.toml` carried a single global `[allowlist]` that
 * suppressed EVERY rule for every file under `tests/` and `docs/` and for
 * nine listed commits. That is blanket suppression: a new rule's finding in
 * a test fixture (e.g. a Stripe key, a GitHub PAT) was silently ignored.
 *
 * After #1762 the allowlist is rule-scoped: the only rule with an allowlist
 * is `generic-api-key`, and each of its allowlist entries names exactly one
 * suppression dimension (paths, commits, or line regexes). A different
 * rule's finding in the same file or commit is still reported.
 *
 * These tests pin the config TEXT (no TOML parser dependency in the suite):
 * they fail if a global allowlist returns, if the scope widens to another
 * rule, or if a dead (non-commit) entry is re-added to the commits list.
 * The behavioral proof (a planted Stripe/PAT finding in tests/ fires while
 * a generic-api-key finding in tests/ does not) was run with gitleaks
 * v8.24.2 — the version `.github/workflows/gitleaks.yml` pins — and is
 * recorded in the #1762 completion report, not in this file, because the
 * suite has no gitleaks binary.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const gitleaksToml = readFileSync(
  new URL("../.gitleaks.toml", import.meta.url),
  "utf-8"
);

// Commits verified live (2026-11-01) to resolve in this repo's full history
// AND to carry only generic-api-key findings (per .gitleaksignore).
const RULE_SCOPED_COMMITS = [
  "c49ea9c659b03abda1fae3f61f9cb5aef5b2a0ae",
  "1d9e719c0f5eeb0ad07d3dcd40e107783c1f218f",
  "7676f0babe957b8fcd2b001e54e93b6c7bd81ff0",
  "b398dd1b4d51f11f09cb92e9dd51b9fde773bae2",
];

// Entries the pre-#1762 global allowlist carried as "commits" that do NOT
// resolve to any object in the repo's full history (git cat-file fails):
// they are .gitleaksignore fingerprints, not commits, and suppressed nothing.
const DEAD_NON_COMMIT_ENTRIES = [
  "420f56ad333cb4b62962b7a5e467ed29033e73bb",
  "13594c2bb398c2cb6c88d4b2d7c9193b97ee7eb3",
  "fcb6f08983dd8c76b55a4f731035b809edaa0cc9",
  "b3af1ffd3e27f0b233d8b089eebb261eed167c29",
  "0c8312c0b9e3d98dfd6b9d98d6482eebddd0a152",
];

describe("gitleaks allowlist is rule-scoped, not global (#1762)", () => {
  it("has no global [allowlist] section (blanket suppression is gone)", () => {
    expect(gitleaksToml).not.toMatch(/^\[allowlist\]\s*$/m);
    expect(gitleaksToml).toContain("[extend]");
    expect(gitleaksToml).toContain("useDefault = true");
  });

  it("scopes the allowlist to the generic-api-key rule only", () => {
    expect(gitleaksToml).toContain('id = "generic-api-key"');
    expect(gitleaksToml).toContain("[[rules.allowlists]]");
    // No other rule id may carry an allowlist: the only [[rules]] block
    // in the file is generic-api-key.
    const ruleIds = [...gitleaksToml.matchAll(/^\[\[rules\]\]\s*$/gm)];
    expect(ruleIds).toHaveLength(1);
  });

  it("keeps the fixture/doc path scope inside the generic-api-key rule", () => {
    expect(gitleaksToml).toContain("'''tests/.*'''");
    expect(gitleaksToml).toContain("'''docs/.*'''");
  });

  it("keeps the historical line regexes inside the generic-api-key rule", () => {
    expect(gitleaksToml).toContain("'''sandbox\\.paypal\\.com'''");
    expect(gitleaksToml).toContain(
      "'''0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B'''"
    );
    expect(gitleaksToml).toContain('regexTarget = "line"');
  });

  it("carries only real, generic-api-key-only commits — dead entries removed", () => {
    for (const sha of RULE_SCOPED_COMMITS) {
      expect(gitleaksToml).toContain(`"${sha}"`);
    }
    for (const sha of DEAD_NON_COMMIT_ENTRIES) {
      expect(gitleaksToml).not.toContain(sha);
    }
  });
});
