/**
 * Tests for scripts/measure-startup.mjs (Issue #6281, code-splitting Slice 0).
 *
 * The harness rebuilds the #3185 diagnosis measurement as an in-repo script:
 * worker bundle bytes (wrangler dry-run = authoritative), esbuild metafile
 * module ranking, parse-only time (node --check) and full import CPU, plus
 * the CI budget check (fail when bundle bytes exceed baseline + maxGrowthPct).
 * Startup time is reported, never a failing gate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  median,
  topModules,
  budgetLimitBytes,
  exceedsBudget,
  validateBudgetConfig,
  assessBudget,
  parseArgs,
} from "../scripts/measure-startup.mjs";

describe("median (#6281)", () => {
  it("returns the middle value for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("returns the mean of the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns the single value for one sample", () => {
    expect(median([42])).toBe(42);
  });

  it("throws on an empty sample", () => {
    expect(() => median([])).toThrow();
  });
});

describe("topModules (#6281)", () => {
  const metafile = {
    inputs: {
      "node_modules/a/index.js": { bytes: 100 },
      "node_modules/b/index.js": { bytes: 500 },
      "src/c.ts": { bytes: 300 },
    },
  };

  it("sorts inputs by bytes descending", () => {
    expect(topModules(metafile, 10)).toEqual([
      { path: "node_modules/b/index.js", bytes: 500 },
      { path: "src/c.ts", bytes: 300 },
      { path: "node_modules/a/index.js", bytes: 100 },
    ]);
  });

  it("respects the limit", () => {
    expect(topModules(metafile, 2)).toHaveLength(2);
    expect(topModules(metafile, 2)[0].path).toBe("node_modules/b/index.js");
  });

  it("returns an empty list for an empty metafile", () => {
    expect(topModules({ inputs: {} }, 10)).toEqual([]);
    expect(topModules({}, 10)).toEqual([]);
  });
});

describe("budget check (#6281)", () => {
  it("budgetLimitBytes adds maxGrowthPct to the baseline, floored", () => {
    expect(budgetLimitBytes(100, 5)).toBe(105);
    expect(budgetLimitBytes(13_000_000, 5)).toBe(13_650_000);
    expect(budgetLimitBytes(101, 5)).toBe(106);
  });

  it("exceedsBudget is false at or below the limit, true above it", () => {
    expect(exceedsBudget(105, 100, 5)).toBe(false);
    expect(exceedsBudget(100, 100, 5)).toBe(false);
    expect(exceedsBudget(106, 100, 5)).toBe(true);
  });

  it("assessBudget reports the verdict and the overage", () => {
    expect(assessBudget(100, { baselineBytes: 100, maxGrowthPct: 5 })).toEqual({
      bytes: 100,
      baselineBytes: 100,
      limitBytes: 105,
      maxGrowthPct: 5,
      over: false,
      overByBytes: 0,
    });
    expect(assessBudget(110, { baselineBytes: 100, maxGrowthPct: 5 })).toEqual({
      bytes: 110,
      baselineBytes: 100,
      limitBytes: 105,
      maxGrowthPct: 5,
      over: true,
      overByBytes: 5,
    });
  });
});

describe("validateBudgetConfig (#6281)", () => {
  it("accepts a valid config and normalizes it", () => {
    expect(
      validateBudgetConfig({
        baselineBytes: 14_187_604,
        baselineCommit: "680f98323",
        maxGrowthPct: 5,
      })
    ).toEqual({
      baselineBytes: 14_187_604,
      baselineCommit: "680f98323",
      maxGrowthPct: 5,
    });
  });

  it("rejects a missing or invalid baselineBytes", () => {
    expect(() => validateBudgetConfig({ maxGrowthPct: 5 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: 0, maxGrowthPct: 5 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: -1, maxGrowthPct: 5 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: 1.5, maxGrowthPct: 5 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: "100", maxGrowthPct: 5 })).toThrow();
  });

  it("rejects a missing or invalid maxGrowthPct", () => {
    expect(() => validateBudgetConfig({ baselineBytes: 100 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: 100, maxGrowthPct: 0 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: 100, maxGrowthPct: -5 })).toThrow();
    expect(() => validateBudgetConfig({ baselineBytes: 100, maxGrowthPct: "5" })).toThrow();
  });

  it("rejects a non-object config", () => {
    expect(() => validateBudgetConfig(null)).toThrow();
    expect(() => validateBudgetConfig("x")).toThrow();
    expect(() => validateBudgetConfig([])).toThrow();
  });
});

describe("parseArgs (#6281)", () => {
  it("returns defaults with no arguments", () => {
    expect(parseArgs([])).toEqual({
      out: "startup-measurement.json",
      esbuildOnly: false,
      runs: 5,
      config: "scripts/measure-startup.config.json",
    });
  });

  it("accepts --out, --config, --runs and --esbuild-only", () => {
    expect(parseArgs(["--out", "out.json", "--config", "c.json", "--runs", "3", "--esbuild-only"])).toEqual({
      out: "out.json",
      esbuildOnly: true,
      runs: 3,
      config: "c.json",
    });
  });

  it("rejects unknown flags and invalid runs", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["--runs", "0"])).toThrow();
    expect(() => parseArgs(["--runs", "abc"])).toThrow();
    expect(() => parseArgs(["--out"])).toThrow();
  });
});

describe("import setup (#6281)", () => {
  it("scripts/measure-startup.import-setup.mjs defines globalThis.require", async () => {
    await import("../scripts/measure-startup.import-setup.mjs");
    expect(typeof globalThis.require).toBe("function");
    expect(globalThis.require("node:process")).toBe(process);
  });
});

describe("committed baseline config (#6281)", () => {
  it("scripts/measure-startup.config.json exists and carries a positive baseline", () => {
    const raw = readFileSync("scripts/measure-startup.config.json", "utf8");
    const config = validateBudgetConfig(JSON.parse(raw));
    expect(config.baselineBytes).toBeGreaterThan(0);
    expect(config.maxGrowthPct).toBe(5);
    expect(typeof config.baselineCommit).toBe("string");
  });
});
