/**
 * Issue #3073 - the saga and trading halves of the family seam.
 *
 * Saga's flow has one dynamic step id (`poll-<leg>-<round>`) that is a wait,
 * not a stage. These pins keep that distinction honest: declared stages
 * publish a boundary, the polling wait publishes nothing, and no boundary is
 * ever able to change a saga's or a trade's outcome.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAGA_STEP_IDS } from "../src/workflows/stageRuntimeIds";
import { STAGE_IDS_BY_FAMILY, stageMessage } from "../src/workflows/stageMessage";
import { createStageBoundaryEmitter } from "../src/workflows/stageBoundaryEmitter";

const read = (path: string) => readFileSync(path, "utf8");

describe("saga seam (#3073)", () => {
  const source = read("src/workflows/sagaWorkflowFlow.ts");

  it("routes every declared stage through the boundary wrapper", () => {
    for (const stageId of SAGA_STEP_IDS) {
      expect(source).toContain(`doStage("${stageId}"`);
      expect(source).not.toContain(`step.do("${stageId}"`);
    }
  });

  it("leaves the dynamic polling wait as a bare step with no boundary", () => {
    expect(source).toMatch(/step\.do\(`poll-/);
  });

  it("publishes only ids the saga family declares", async () => {
    const sent: string[] = [];
    const emit = createStageBoundaryEmitter({
      family: "saga",
      runId: "saga-1",
      userLogin: "owner@example.com",
      queue: { send: async (body: unknown) => sent.push((body as { stageId: string }).stageId) },
      warn: () => undefined,
    });
    for (const stageId of SAGA_STEP_IDS) await emit({ stageId });
    expect(sent).toEqual([...SAGA_STEP_IDS]);
    await expect(emit({ stageId: "poll-payment-1" })).resolves.toBe("malformed");
  });
});

describe("trading seam (#3073)", () => {
  const source = read("src/agents/trading-trade-workflow.ts");

  it("publishes at the approval wait and the settle, nothing else", () => {
    expect(source).toContain('emitBoundary(env, params, "await-approval")');
    expect(source).toContain('emitBoundary(env, params, "settle-trade")');
    const emitted = [...source.matchAll(/emitBoundary\(env, params, "([a-z-]+)"\)/g)].map((m) => m[1]!);
    expect(emitted).toEqual([...STAGE_IDS_BY_FAMILY.trading]);
  });

  it("keeps the boundary out of the settle path's failure surface", () => {
    // emitBoundary wraps everything in try/catch: the trade must not depend on it.
    const body = source.slice(source.indexOf("async function emitBoundary"));
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/catch \{/);
  });
});

describe("families stay in step with the catalog (#3073)", () => {
  it("every family's declared ids validate through the message builder", () => {
    for (const [family, ids] of Object.entries(STAGE_IDS_BY_FAMILY)) {
      for (const stageId of ids) {
        const message = stageMessage({
          runId: "run-1",
          family: family as never,
          stageId,
          artifactKeys: [`k:${stageId}`],
          userLogin: "owner",
        });
        expect(message.family).toBe(family);
        expect(message.stageId).toBe(stageId);
      }
    }
  });
});
