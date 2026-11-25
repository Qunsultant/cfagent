// @vitest-environment node
/**
 * Issue #6526 — one normal CDF.
 *
 * The research economics module used to carry a local copy of the
 * Abramowitz–Stegun CDF. It now exports the shared implementation.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { normCdf as researchCdf } from "../src/services/researchEconomics";
import { normalCdf } from "../src/shared/riskMath";

describe("one normal CDF (issue 6526)", () => {
  it("P01: research exports the shared function itself", () => {
    expect(researchCdf).toBe(normalCdf);
  });

  it("P02: both tails and the centre agree across a value grid", () => {
    for (const x of [-10, -8, -4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 8, 10]) {
      expect(researchCdf(x), String(x)).toBe(normalCdf(x));
    }
  });

  it("P03: the research module carries no local CDF constants", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/services/researchEconomics.ts"),
      "utf8",
    );
    expect(source).not.toContain("0.254829592");
    expect(source).not.toContain("0.3275911");
  });
});
