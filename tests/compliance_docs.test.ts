import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Compliance documentation layout (#1447)", () => {
  const root = process.cwd();
  const newComplianceDir = path.join(root, "docs", "compliance");
  const oldComplianceDir = path.join(root, "docs", "architecture", "compliance");

  it("houses anti-drift framework and anti-drift controls under docs/compliance", () => {
    // #3802: the controls document was retired under the gitops §22 rename form
    // (anti-drift-controls.md -> anti-drift-controls.deprecated.md, superseded by
    // anti-drift.md); the pin asserts the retired path + its original title.
    expect(fs.existsSync(newComplianceDir)).toBe(true);

    const antiDriftPath = path.join(newComplianceDir, "anti-drift.md");
    expect(fs.existsSync(antiDriftPath)).toBe(true);
    const antiDriftContent = fs.readFileSync(antiDriftPath, "utf8");
    expect(antiDriftContent).toContain("Comprehensive UX & Multi-Tier Architectural Anti-Drift Framework");

    const controlsPath = path.join(newComplianceDir, "anti-drift-controls.deprecated.md");
    expect(fs.existsSync(controlsPath)).toBe(true);
    const controlsContent = fs.readFileSync(controlsPath, "utf8");
    expect(controlsContent).toContain("Architectural & UX Drift Analysis and Governance Framework");
  });

  it("removes the deprecated docs/architecture/compliance directory", () => {
    expect(fs.existsSync(oldComplianceDir)).toBe(false);
  });

  it("ensures assessment documentation references the new compliance path", () => {
    const assessmentPath = path.join(
      root,
      "docs",
      "architecture",
      "enterprise",
      "assessment",
      "comprehensive-enterprise-strategy-and-capabilities-assessment.md",
    );
    const content = fs.readFileSync(assessmentPath, "utf8");
    expect(content).toContain("docs/compliance/anti-drift.md");
    expect(content).not.toContain("docs/architecture/compliance/anti-drift.md");
  });
});
