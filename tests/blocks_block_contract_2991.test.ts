/**
 * Issue #2991 (#2770 Phase A) — Block contract: the onboarding gate
 * in code. A capability onboards only when its definition carries
 * every piece the platform needs: port interface, input/output
 * schemas, stage contract, terminal semantics, tests (outside this
 * module), outcome-catalog entries, and governed promotion (§5).
 *
 * The contract is asset-class agnostic: no stock-only assumptions
 * anywhere in the definition shape.
 */
import { describe, expect, it } from "vitest";
import {
  assertBlockConforms,
  defineBlock,
  validateComposition,
  type BlockDefinition,
} from "../src/workflows/blocks/blockContract";

function validDef(over: Partial<BlockDefinition> = {}): BlockDefinition {
  return {
    id: "journey-gate",
    kind: "gate",
    version: "1",
    port: { methods: ["run", "withdraw"] },
    inputSchema: [{ name: "sagaId", type: "string", required: true }],
    outputSchema: [{ name: "kind", type: "string", required: true }],
    stageContract: {
      stageIds: ["prompt", "decide", "withdraw"],
      terminalSemantics: { approved: "SUCCESS_SAGA_JOURNEY_APPROVED" },
    },
    catalogEntries: ["SUCCESS_SAGA_JOURNEY_APPROVED"],
    promotion: {
      candidate: "journey gate capability",
      evaluation: "saga flow tests",
      promotion: "Phase A decomposition",
    },
    ...over,
  };
}

describe("Block contract #2991", () => {
  it("accepts a complete definition verbatim", () => {
    const def = defineBlock(validDef());
    expect(def.id).toBe("journey-gate");
    expect(def.kind).toBe("gate");
    expect(def.stageContract.stageIds).toEqual(["prompt", "decide", "withdraw"]);
  });

  it("rejects a definition missing its port methods", () => {
    expect(() => defineBlock(validDef({ port: { methods: [] } }))).toThrow(
      /port methods/,
    );
  });

  it("rejects a definition missing stage ids", () => {
    expect(() =>
      defineBlock(
        validDef({ stageContract: { stageIds: [], terminalSemantics: {} } }),
      ),
    ).toThrow(/stage/);
  });

  it("rejects a definition missing terminal semantics", () => {
    expect(() =>
      defineBlock(
        validDef({
          stageContract: { stageIds: ["prompt"], terminalSemantics: {} },
        }),
      ),
    ).toThrow(/terminal/);
  });

  it("rejects a definition missing catalog entries", () => {
    expect(() => defineBlock(validDef({ catalogEntries: [] }))).toThrow(
      /catalog/,
    );
  });

  it("rejects a definition missing governed promotion", () => {
    expect(() =>
      defineBlock(
        validDef({
          promotion: { candidate: "", evaluation: "tests", promotion: "ship" },
        }),
      ),
    ).toThrow(/promotion/);
  });

  it("assertBlockConforms passes an implementation carrying every port method", () => {
    const def = defineBlock(validDef());
    expect(() =>
      assertBlockConforms({ run: () => {}, withdraw: () => {} }, def),
    ).not.toThrow();
  });

  it("assertBlockConforms rejects an implementation missing a port method", () => {
    const def = defineBlock(validDef());
    expect(() => assertBlockConforms({ run: () => {} }, def)).toThrow(
      /withdraw/,
    );
  });

  it("validateComposition rejects a ref to an unregistered block", () => {
    const def = defineBlock(validDef());
    expect(() =>
      validateComposition(
        {
          id: "saga",
          refs: [{ blockId: "no-such-block", action: "run" }],
          terminals: {},
        },
        [def],
        { outcomeCodeResolves: () => true },
      ),
    ).toThrow(/no-such-block/);
  });

  it("validateComposition rejects a gate ref pointing at a non-gate block", () => {
    const def = defineBlock(validDef());
    expect(() =>
      validateComposition(
        {
          id: "saga",
          refs: [
            { blockId: "journey-gate", action: "run", gateBlockId: "journey-gate" },
          ],
          terminals: {},
        },
        [defineBlock(validDef({ id: "journey-gate", kind: "leg" }))],
        { outcomeCodeResolves: () => true },
      ),
    ).toThrow(/gate/);
    expect(def.kind).toBe("gate");
  });

  it("validateComposition rejects a terminal whose outcome code does not resolve", () => {
    const def = defineBlock(validDef());
    expect(() =>
      validateComposition(
        {
          id: "saga",
          refs: [{ blockId: "journey-gate", action: "run" }],
          terminals: { approved: "NO_SUCH_OUTCOME_CODE" },
        },
        [def],
        { outcomeCodeResolves: (code) => code !== "NO_SUCH_OUTCOME_CODE" },
      ),
    ).toThrow(/NO_SUCH_OUTCOME_CODE/);
  });

  it("validateComposition accepts a resolving composition", () => {
    const def = defineBlock(validDef());
    expect(() =>
      validateComposition(
        {
          id: "saga",
          refs: [{ blockId: "journey-gate", action: "run" }],
          terminals: { approved: "SUCCESS_SAGA_JOURNEY_APPROVED" },
        },
        [def],
        {
          outcomeCodeResolves: (code) =>
            code === "SUCCESS_SAGA_JOURNEY_APPROVED",
        },
      ),
    ).not.toThrow();
  });
});
