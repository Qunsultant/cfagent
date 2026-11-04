/**
 * Issue #3075 - the WIDE sweep.
 *
 * The earlier #3075 PR swept one surface (`stageReportConsumer`) and said so.
 * This one sweeps every module in `src/workflows/` that speaks the stage
 * vocabulary, and it fails closed: a raw dead-letter literal, an uncatalogued
 * code, or a magic retry budget anywhere in those files breaks the build until
 * someone either codes it or lists it here with a reason.
 *
 * The allow-list is deliberately tiny and explicit. It is not a place to park
 * work: an entry should disappear when the literal becomes a code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGE_MESSAGE_CATALOG, STAGE_MESSAGE_CODES } from "../src/workflows/stageConfig";

const WORKFLOW_DIR = "src/workflows";

/** Every file that speaks the stage contract, discovered rather than listed. */
function sweptSurfaces(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /^stage.*\.ts$/.test(name))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => `${WORKFLOW_DIR}/${name}`)
    .sort();
}

/**
 * Dead-letter helpers that take a reason. A raw string at one of these call
 * sites is exactly the drift this sweep exists to catch.
 */
const DEAD_LETTER_CALL = /deadLetter\(\s*(["`])/g;

/**
 * Known, justified exceptions. Each MUST carry a reason; the test fails if an
 * entry no longer matches (so stale allow-list entries cannot accumulate).
 */
const ALLOWED_RAW_REASONS: Array<{ file: string; contains: string; why: string }> = [
  {
    file: "src/workflows/stageConfig.ts",
    contains: "DEFAULT_STAGE_CONFIG",
    why: "stageConfig DECLARES the code default; that is the one place a literal belongs",
  },
];

describe("wide surface sweep (#3075)", () => {
  it("discovers the stage surfaces (a new stage module is swept automatically)", () => {
    const surfaces = sweptSurfaces();
    expect(surfaces.length).toBeGreaterThanOrEqual(4);
    expect(surfaces).toContain("src/workflows/stageReportConsumer.ts");
    expect(surfaces).toContain("src/workflows/stageTabularConsumer.ts");
  });

  it("no raw dead-letter literal survives on any swept surface", () => {
    const offenders: string[] = [];
    for (const file of sweptSurfaces()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(DEAD_LETTER_CALL)) {
        const allowed = ALLOWED_RAW_REASONS.some(
          (entry) => entry.file === file && source.slice(Math.max(0, match.index - 200), match.index + 200).includes(entry.contains),
        );
        if (!allowed) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still explains something real", () => {
    for (const entry of ALLOWED_RAW_REASONS) {
      expect(entry.why.length).toBeGreaterThan(10);
      expect(readFileSync(entry.file, "utf8")).toContain(entry.contains);
    }
  });

  it("every code literal on a swept surface is catalogued", () => {
    const unknown: string[] = [];
    for (const file of sweptSurfaces()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/formatStageMessage\(\s*"([A-Z_]+)"/g)) {
        if (!(STAGE_MESSAGE_CODES as readonly string[]).includes(match[1]!)) {
          unknown.push(`${file}: ${match[1]}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("no magic retry budget sits on a swept surface", () => {
    const offenders: string[] = [];
    for (const file of sweptSurfaces()) {
      // stageConfig.ts is where the code default is declared; everywhere else
      // a numeric budget is drift.
      if (file.endsWith("stageConfig.ts")) continue;
      const source = readFileSync(file, "utf8");
      // The shapes this replaced: `maxAttempts ?? 3`, `maxAttempts: 3`.
      for (const match of source.matchAll(/maxAttempts\s*(\?\?|:)\s*\d/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the catalog covers every code with text, severity and remediation", () => {
    for (const code of STAGE_MESSAGE_CODES) {
      const meta = STAGE_MESSAGE_CATALOG[code];
      expect(meta.text.length).toBeGreaterThan(10);
      expect(meta.remediation.length).toBeGreaterThan(10);
      expect(["poison", "budget", "data"]).toContain(meta.severity);
    }
  });
});
