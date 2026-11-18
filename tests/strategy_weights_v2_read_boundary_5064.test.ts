/**
 * Issue #5064 (AG-10) — the v2-weights read boundary is pinned.
 *
 * The module header used to claim "no production ranking path reads v2
 * weights", while the reselection tick and the challenger evaluation did read
 * them. Prose alone cannot hold that line: adding one import inverts the
 * claim silently. This census test enumerates the real import graph under
 * `src/` and compares it with the boundary declared in the module, so a new
 * reader fails CI until someone states, in `STRATEGY_WEIGHTS_V2_READERS`, that
 * it is allowed and why.
 *
 * It also pins the negative half: the live screen ranking and the agentic
 * cycle never read v2 weights at decision time.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  STRATEGY_WEIGHTS_V2_NEVER_READERS,
  STRATEGY_WEIGHTS_V2_READERS,
} from "../src/services/strategyWeightsV2";

const ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Normalise to `src/...` with forward slashes, matching the declarations. */
function modulePath(file: string): string {
  return relative(process.cwd(), file).split(sep).join("/");
}

/** True when the file imports `strategyWeightsV2` (static or dynamic). */
function importsV2Weights(source: string): boolean {
  const staticImport = /from\s+["'][^"']*strategyWeightsV2["']/;
  const dynamicImport = /import\(\s*["'][^"']*strategyWeightsV2["']\s*\)/;
  return staticImport.test(source) || dynamicImport.test(source);
}

describe("Issue #5064 — v2 weights read boundary", () => {
  const declared = STRATEGY_WEIGHTS_V2_READERS.map((r) => r.path).sort();
  const actual = sourceFiles(ROOT)
    .filter((file) => modulePath(file) !== "src/services/strategyWeightsV2.ts")
    .filter((file) => importsV2Weights(readFileSync(file, "utf8")))
    .map(modulePath)
    .sort();

  it("declares every module that imports the weights module", () => {
    expect(actual).toEqual(declared);
  });

  it("keeps the live decision paths out of the weights module", () => {
    for (const never of STRATEGY_WEIGHTS_V2_NEVER_READERS) {
      expect(actual).not.toContain(never);
    }
  });

  it("states the boundary in the module header, matching the declaration", () => {
    const header = readFileSync(
      join(ROOT, "services", "strategyWeightsV2.ts"),
      "utf8",
    ).slice(0, 4000);

    expect(header).toContain("READ BOUNDARY (#5064");
    expect(header).toContain("STRATEGY_WEIGHTS_V2_READERS");
    expect(header).toContain("does NOT read v2 weights at decision time");
    // The old, invertible absolute claim is gone.
    expect(header).not.toContain(
      "no production ranking path reads v2 weights",
    );
  });

  it("declares a purpose for every reader", () => {
    for (const reader of STRATEGY_WEIGHTS_V2_READERS) {
      expect(reader.purpose.length).toBeGreaterThan(10);
    }
  });
});
