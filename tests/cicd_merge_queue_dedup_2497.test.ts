/**
 * CI/CD Optimization, Integrity, and Velocity Guards (#2497, #2499, merge_group shard tiering).
 *
 * Merge_group-only shard tiering: test-shard is split into test-shard-pr
 * (parallel with fast-gates on pull_request) and test-shard-mq (needs
 * fast-gates on merge_group); test-and-verify accepts exactly the dedup/docs,
 * PR, and merge_group paths.
 *
 * Verifies:
 * 1. policy-gate.yml runs on both pull_request and merge_group and passes GH_TOKEN
 *    so scripts/ci/policy_gate.py evaluates each queued PR individually + aggregate.
 * 2. ci.yml enforces a 24h non-transitive tree-dedup anchor (verifying Fast gates +
 *    all 4 Tests shards concluded success), supports a docs-only fast path inside
 *    load-environment, writes to $GITHUB_STEP_SUMMARY, and keeps test-and-verify on if: always().
 * 3. gitleaks.yml verifies the SHA-256 checksum of the OSS gitleaks binary, scans
 *    merge-base..HEAD on PR/merge_group, and includes a nightly full-history schedule backstop.
 * 4. auto-update-prs-app.yml is scoped to unqueued auto-merge PRs so Merge Queue is the sole updater for queued PRs (#2546).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const policyGateYml = readFileSync(
  new URL("../.github/workflows/policy-gate.yml", import.meta.url),
  "utf-8"
);
const ciYml = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8"
);
const gitleaksYml = readFileSync(
  new URL("../.github/workflows/gitleaks.yml", import.meta.url),
  "utf-8"
);
const autoUpdateYml = readFileSync(
  new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url),
  "utf-8"
);
const autoMergeTrustedYml = readFileSync(
  new URL("../.github/workflows/auto-merge-trusted.yml", import.meta.url),
  "utf-8"
);

describe("CI/CD Merge Queue + Policy Gate + Tree-Hash Deduplication (#2497, #2499)", () => {
  it("triggers Policy Gate on merge_group with GH_TOKEN for per-PR evaluation", () => {
    expect(policyGateYml).toMatch(/^\s*merge_group:\s*$/m);
    expect(policyGateYml).toContain(
      "if: github.event_name == 'merge_group' || github.event.pull_request.state == 'open'"
    );
    expect(policyGateYml).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("enforces non-transitive 24h tree-dedup anchor, docs-only fast path, and step summary audit trail", () => {
    expect(ciYml).toContain("git rev-parse 'HEAD^{tree}'");
    expect(ciYml).toContain("verify_anchor_jobs()");
    expect(ciYml).toContain("24 hours ago");
    expect(ciYml).toContain("docs_only");
    expect(ciYml).toContain("GITHUB_STEP_SUMMARY");
    expect(ciYml).toContain("if: needs.load-environment.outputs.tree_already_verified != 'true'");
    expect(ciYml).toContain("if: always()");
    expect(ciYml).toContain("Test & Build (Node 22) [${{ needs.load-environment.outputs.target_env }}]");
  });

  it("pins OSS gitleaks SHA-256 checksum, scans merge-base..HEAD, and runs a nightly full-history backstop", () => {
    expect(gitleaksYml).toContain("fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e");
    expect(gitleaksYml).toContain("sha256sum --check --strict");
    expect(gitleaksYml).toContain('gitleaks git --log-opts="${BASE_MERGE}..HEAD"');
    expect(gitleaksYml).toMatch(/^\s*schedule:\s*$/m);
    expect(gitleaksYml).not.toContain("uses: gitleaks/gitleaks-action@v2");
  });

  it("splits test-shard into PR and merge_group jobs with merge_group-only tiering", () => {
    expect(ciYml).toContain("test-shard-pr:");
    expect(ciYml).toContain("test-shard-mq:");
    expect(ciYml).toContain("Tests PR (shard");
    expect(ciYml).toContain("Tests MQ (shard");
    // PR job stays parallel with fast-gates (needs load-environment only)
    expect(ciYml).toMatch(/test-shard-pr:[\s\S]*?needs: \[load-environment\]/);
    expect(ciYml).toContain("github.event_name != 'merge_group'");
    // MQ job waits for fast-gates before burning 4 shard runners
    expect(ciYml).toMatch(/test-shard-mq:[\s\S]*?needs: \[load-environment, fast-gates\]/);
    expect(ciYml).toContain("github.event_name == 'merge_group'");
    // Both jobs keep the tree-dedup skip and the shard matrix
    expect(ciYml).toContain("needs.load-environment.outputs.tree_already_verified != 'true'");
    // test-and-verify still reports the required name and accepts all three paths
    expect(ciYml).toContain("needs: [load-environment, fast-gates, test-shard-pr, test-shard-mq]");
    expect(ciYml).toContain("needs.test-shard-pr.result");
    expect(ciYml).toContain("needs.test-shard-mq.result");
    expect(ciYml).toContain("PR event: fast-gates and test-shard-pr passed");
    expect(ciYml).toContain("merge_group event: fast-gates and test-shard-mq passed");
    // Dedup anchor must still recognise the renamed shard jobs (otherwise
    // every merge_group run would re-run the full suite instead of deduping)
    expect(ciYml).toContain('Tests (PR|MQ)');
  });

  it("keeps auto-update-prs-app.yml scoped to unqueued auto-merge PRs so Merge Queue is the sole updater for queued PRs (#2546)", () => {
    expect(autoUpdateYml).toContain("isInMergeQueue");
    expect(autoUpdateYml).toContain("hasAutoMerge");
  });

  it("does not configure environment deployments on PR/MQ test shards to avoid manual approval gates (#2580)", () => {
    const testShardPrBlock = ciYml.match(/test-shard-pr:[\s\S]*?(?=\n\s\s#|\ntest-shard-mq:)/)?.[0] || "";
    expect(testShardPrBlock).not.toContain("environment:");
    const testShardMqBlock = ciYml.match(/test-shard-mq:[\s\S]*?(?=\n\s\s#|\ntest-and-verify:)/)?.[0] || "";
    expect(testShardMqBlock).not.toContain("environment:");
  });

  it("protects in-flight CI runs and skips clean/conflicting PRs in auto-update-prs-app.yml (#2580)", () => {
    expect(autoUpdateYml).toContain("statusCheckRollup");
    expect(autoUpdateYml).toContain("checkState === 'PENDING'");
    expect(autoUpdateYml).toContain("mergeStateStatus === 'CLEAN'");
  });

  it("enforces REBASE auto-merge and resets non-REBASE configurations (#2580)", () => {
    expect(autoMergeTrustedYml).toContain('"$CURRENT_METHOD" != "REBASE"');
    expect(autoMergeTrustedYml).toContain("disablePullRequestAutoMerge");
    expect(autoMergeTrustedYml).toContain("mergeMethod: REBASE");
  });
});
