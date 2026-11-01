/**
 * Issue #2041 Q4 — saga network scope (ruled 2026-11-01: no
 * exclusion, include mainnet).
 *
 * Venus ruled the saga imposes NO network restriction: the
 * payment leg's network policy governs, and the gate admits
 * Base mainnet, so mainnet is in scope for saga runs. The
 * pre-ruling record said "mainnet excluded" in a comment
 * (sagaWorkflow.ts:40) with zero enforcement code and zero
 * pins behind it — the audit found the exclusion unenforced.
 *
 * This pin asserts the ruled property, not the old comment:
 * (a) the saga header records mainnet in scope with no
 * network restriction and the payment leg governing, and
 * no longer says "mainnet excluded"; (b) no CODE on the
 * saga surface reads MONETIZATION_NETWORK or throws on
 * network grounds, so the saga cannot refuse a run by
 * network — a future enforcement would trip this pin by
 * design and need its own ruling. Comments are stripped
 * before (b): the header itself may name the variable it
 * declines to read, and only a code read counts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

const SAGA_SURFACE = [
  "src/workflows/sagaWorkflow.ts",
  "src/workflows/sagaWorkflowFlow.ts",
  "src/workflows/sagaTradeLeg.ts",
  "src/workflows/sagaCompensation.ts",
  "src/workflows/sagaJourneyGate.ts",
  "src/workflows/sagaLegPort.ts",
  "src/agents/routes/sagaEntry.ts",
  "src/agents/routes/sagaStatus.ts",
];

describe("saga network scope (Q4 ruled: no exclusion, mainnet in scope)", () => {
  it("records mainnet in scope with no saga network restriction", () => {
    const header = read("src/workflows/sagaWorkflow.ts");
    expect(header).toContain("mainnet is in scope");
    expect(header).toContain("no network restriction");
    expect(header).toContain("payment leg");
    expect(header).not.toContain("mainnet excluded");
  });

  it("no saga-surface code reads MONETIZATION_NETWORK", () => {
    for (const file of SAGA_SURFACE) {
      expect(stripComments(read(file))).not.toContain("MONETIZATION_NETWORK");
    }
  });

  it("no saga-surface code throws on network grounds", () => {
    for (const file of SAGA_SURFACE) {
      const lines = stripComments(read(file)).split("\n");
      const offending = lines.filter((line) => /throw[^;]*network/i.test(line));
      expect(offending).toEqual([]);
    }
  });
});
