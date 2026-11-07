import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const REAUDIT = join(ROOT, "docs/architecture/standards/stock-15-factor-reaudit.md");
const PACK = join(ROOT, "docs/architecture/standards/stock-programme-evidence.md");

const FACTORS = [
  "One Codebase",
  "Explicit Dependencies",
  "Config in Environment",
  "Backing Services",
  "Build / Release / Run",
  "Stateless Processes",
  "Port Binding",
  "Concurrency",
  "Disposability",
  "Dev / Prod Parity",
  "Logs as event streams",
  "Admin Tasks",
  "API-First",
  "Telemetry",
  "AuthN / AuthZ",
];

describe("15-factor re-audit #2860", () => {
  it("publishes a per-factor re-audit for new stock code", () => {
    expect(existsSync(REAUDIT)).toBe(true);
    const doc = readFileSync(REAUDIT, "utf8");
    for (const factor of FACTORS) expect(doc).toContain(factor);
    expect(doc).toContain("Overall: COMPLIANT");
    expect(doc).toContain("15 PASS / 0 PARTIAL / 0 FAIL / 0 NOT VERIFIED");
    // The re-audit must never cite the self-asserting test as evidence.
    expect(doc).toContain("must not be cited");
  });

  it("makes no blanket 15-factor compliance claim for new stock code", () => {
    const doc = readFileSync(REAUDIT, "utf8");
    expect(doc).not.toContain("is 15-factor compliant");
    expect(doc).not.toContain("fully 15-factor compliant");
    expect(doc).toContain("No 15-factor compliance claim is made beyond what this document records");
  });

  it("the standards evidence pack points at the published re-audit", () => {
    const pack = readFileSync(PACK, "utf8");
    expect(pack).toContain("stock-15-factor-reaudit.md");
    expect(pack).toContain("10 PASS / 5 PARTIAL");
  });
});
