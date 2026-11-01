import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

describe("GitOps Control Integrity & Redundancy Reduction (#2556)", () => {
  const codeownersPath = path.resolve(__dirname, "../.github/CODEOWNERS");
  const policyGatePath = path.resolve(__dirname, "../.github/workflows/policy-gate.yml");
  const ciPath = path.resolve(__dirname, "../.github/workflows/ci.yml");
  const deployPath = path.resolve(__dirname, "../.github/workflows/deploy.yml");
  const fixerPath = path.resolve(__dirname, "../.github/workflows/self-heal-fixer-nocopilot.yml");

  it("expands .github/CODEOWNERS to protect critical governance and control files", () => {
    expect(existsSync(codeownersPath)).toBe(true);
    const content = readFileSync(codeownersPath, "utf-8");

    expect(content).toContain("/.github/ @OpenAIMP");
    expect(content).toContain("/scripts/ci/ @OpenAIMP");
    expect(content).toContain("/AGENTS.md @OpenAIMP");
    expect(content).toContain("/docs/agents/ @OpenAIMP");
    expect(content).toContain("/environment.config.json @OpenAIMP");
    expect(content).toContain("/wrangler.jsonc @OpenAIMP");
  });

  it("executes policy evaluation from trusted origin/main in policy-gate.yml", () => {
    expect(existsSync(policyGatePath)).toBe(true);
    const content = readFileSync(policyGatePath, "utf-8");

    // Must evaluate from origin/main to prevent candidate PRs from tampering with evaluator
    expect(content).toMatch(/origin\/main:scripts\/ci\/policy_gate\.py/);
    expect(content).not.toMatch(/run:\s*python3 scripts\/ci\/policy_gate\.py/);
  });

  it("removes broker secrets from PR CI test shards in ci.yml", () => {
    expect(existsSync(ciPath)).toBe(true);
    const content = readFileSync(ciPath, "utf-8");

    // test-shard-pr and test-shard-mq must run without real broker secrets
    const testShardPr = content.split("test-shard-pr:")[1]?.split("test-shard-mq:")[0] ?? "";
    expect(testShardPr).not.toContain("ET_API_KEY");
    expect(testShardPr).not.toContain("ET_API_SECRET");
    expect(testShardPr).not.toContain("ET_BASE_URL");

    const testShardMq = content.split("test-shard-mq:")[1]?.split("test-and-verify:")[0] ?? "";
    expect(testShardMq).not.toContain("ET_API_KEY");
    expect(testShardMq).not.toContain("ET_API_SECRET");
    expect(testShardMq).not.toContain("ET_BASE_URL");
  });

  it("binds deployment to successful CI validation in deploy.yml", () => {
    expect(existsSync(deployPath)).toBe(true);
    const content = readFileSync(deployPath, "utf-8");

    expect(content).toContain("workflow_run:");
    expect(content).toContain("Continuous Integration & Test Verification");
  });

  it("disables automated runner burn on self-heal-fixer-nocopilot.yml", () => {
    expect(existsSync(fixerPath)).toBe(true);
    const content = readFileSync(fixerPath, "utf-8");

    // Automated triggers (schedule, issues opened) must be disabled/commented out
    expect(content).not.toMatch(/^\s*-\s*cron:/m);
    expect(content).not.toMatch(/^\s*issues:\s*\n\s*types:\s*\[opened\]/m);
  });
});

