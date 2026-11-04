/**
 * Issue #3075 - the surface sweep, plus the seam that reads the config.
 *
 * The point of this file: coded messages and externalized config are only
 * worth anything if they are actually USED at the seam and if a new raw
 * literal cannot quietly appear beside them. So it scans the swept surfaces
 * and fails closed on an unlisted entry - adding a dead-letter string or a
 * magic retry budget now costs one line in this file, which is the review
 * moment the sweep exists to create.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeAnalysisDone } from "../src/workflows/stageReportConsumer";
import { STAGE_MESSAGE_CODES } from "../src/workflows/stageConfig";

const read = (path: string) => readFileSync(path, "utf8");

/** Swept surfaces: stage modules that may fail loudly. */
const SWEPT = ["src/workflows/stageReportConsumer.ts"] as const;

describe("surface sweep (#3075)", () => {
  it("no raw dead-letter literal survives on a swept surface", () => {
    const offenders: string[] = [];
    for (const path of SWEPT) {
      const source = read(path);
      for (const match of source.matchAll(/deadLetter\(\s*(["`])/g)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every code literal used on a swept surface is catalogued", () => {
    for (const path of SWEPT) {
      const source = read(path);
      for (const match of source.matchAll(/formatStageMessage\(\s*"([A-Z_]+)"/g)) {
        expect(STAGE_MESSAGE_CODES).toContain(match[1]);
      }
    }
  });

  it("no magic retry budget is left in the stage consumer", () => {
    const source = read("src/workflows/stageReportConsumer.ts");
    // `maxAttempts ?? 3` was the shape this replaced.
    expect(source).not.toMatch(/maxAttempts\s*\?\?\s*\d/);
    expect(source).toMatch(/maxAttemptsForStage\(/);
  });
});

describe("the seam reads the externalized config (#3075)", () => {
  const message = {
    stageId: "analysis-done",
    runId: "run-1",
    userLogin: "user",
    idempotencyKey: "run-1:analysis-done",
    artifactKeys: ["k1"],
  } as never;

  const base = {
    message,
    readPersisted: async () => ({ allStocks: [] }),
    generate: async () => ({ ok: true }),
  };

  it("dead-letters at the code default when nothing overrides it", async () => {
    const result = await consumeAnalysisDone({ ...base, attempt: 4 });
    expect(result.status).toBe("dead-lettered");
    expect((result as { reason: string }).reason).toContain("STAGE_RETRY_EXHAUSTED");
  });

  it("a per-stage environment budget changes the threshold", async () => {
    const result = await consumeAnalysisDone({
      ...base,
      attempt: 4,
      env: { WORKFLOW_STAGE_MAX_ATTEMPTS__ANALYSIS_DONE: "9" },
    });
    expect(result.status).toBe("generated");
  });

  it("a bad environment budget fails loudly instead of running on defaults", async () => {
    await expect(
      consumeAnalysisDone({ ...base, attempt: 1, env: { WORKFLOW_STAGE_MAX_ATTEMPTS: "lots" } }),
    ).rejects.toThrow(/STAGE_CONFIG_INVALID/);
  });
});
