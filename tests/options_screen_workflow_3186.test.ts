/**
 * Issue #3186 step 2 - composition: the eight options pipeline stages
 * as Blocks behind ports, composed into one workflow by a THIN composer.
 *
 * The composer runs the stages in pipeline order. Each stage, in order:
 * claim runId+stageId (already claimed -> skip, never re-run), execute
 * (reads ONLY persisted input, by artifact key), persist (canonical
 * store), publish the stage message. A stage failure stops the run
 * LOUDLY (failed outcome with stage + reason, no message for the failed
 * stage, later stages never run) and releases the failed stage's claim.
 * Nothing is silently dropped.
 *
 * The plan stage reuses the Phase A options plan Block (plannerPort):
 * its port wraps planner.plan as execute, plus persist for the plan
 * artifact. Every stage port is { execute, persist } so the composer
 * stays uniform; production port implementations land in step 3 (entry
 * migration), one entry at a time.
 */
import { describe, expect, it } from "vitest";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import {
  defineBlock,
  validateComposition,
} from "../src/workflows/blocks/blockContract";
import {
  OPTIONS_BLOCKS,
  OPTIONS_SCREEN_COMPOSITION,
} from "../src/workflows/blocks/optionsBlocks";
import {
  runOptionsScreenWorkflow,
  type OptionsScreenWorkflowDeps,
  type OptionsStagePort,
} from "../src/workflows/optionsScreenWorkflow";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import type { StageClaimStore } from "../src/workflows/stageReportConsumer";
import { SAGA_BLOCKS } from "../src/workflows/blocks/sagaBlocks";

const resolves = (code: string) => resolveOutcome(code).resolved;

function memoryClaims(preclaimed: string[] = []): StageClaimStore {
  const claimed = new Set(preclaimed);
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

function stubPorts(order: string[] = []): {
  ports: Record<string, OptionsStagePort>;
  calls: string[];
} {
  const calls: string[] = [];
  const ports: Record<string, OptionsStagePort> = {};
  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    ports[stageId] = {
      execute: async (input) => {
        calls.push(`execute:${stageId}`);
        order.push(stageId);
        return { stage: stageId, inputArtifactKeys: input.artifactKeys };
      },
      persist: async (_input, output) => {
        calls.push(`persist:${stageId}`);
        return [`options:${stageId}:${(output as { stage: string }).stage}`];
      },
    };
  }
  return { ports, calls };
}

function deps(overrides: Partial<OptionsScreenWorkflowDeps> = {}): {
  deps: OptionsScreenWorkflowDeps;
  sent: Array<{ stageId: string; family?: string; idempotencyKey: string }>;
  calls: string[];
  order: string[];
} {
  const sent: Array<{ stageId: string; family?: string; idempotencyKey: string }> = [];
  const order: string[] = [];
  const { ports, calls } = stubPorts(order);
  return {
    deps: {
      stages: ports,
      claims: memoryClaims(),
      queue: {
        send: async (body: unknown) => {
          const message = body as { stageId: string; family?: string; idempotencyKey: string };
          sent.push(message);
          calls.push(`publish:${message.stageId}`);
        },
      },
      warn: () => undefined,
      ...overrides,
    },
    sent,
    calls,
    order,
  };
}

describe("options workflow composition (#3186 step 2)", () => {
  it("registers one Block per pipeline stage, in pipeline order", () => {
    expect(OPTIONS_BLOCKS.map((block) => block.id)).toEqual(
      [...OPTIONS_PIPELINE_STAGES].map((stageId) => `options-${stageId}`),
    );
    for (const block of OPTIONS_BLOCKS) {
      expect(block.kind).toBe("leg");
      expect(block.stageContract.stageIds).toHaveLength(1);
      for (const code of block.catalogEntries) {
        expect(resolves(code)).toBe(true);
      }
      expect(() => defineBlock(block)).not.toThrow();
    }
  });

  it("the composition resolves against its registered blocks", () => {
    expect(OPTIONS_SCREEN_COMPOSITION.refs.map((ref) => ref.blockId)).toEqual(
      [...OPTIONS_PIPELINE_STAGES].map((stageId) => `options-${stageId}`),
    );
    expect(() =>
      validateComposition(OPTIONS_SCREEN_COMPOSITION, OPTIONS_BLOCKS, {
        outcomeCodeResolves: resolves,
      }),
    ).not.toThrow();
  });

  it("every stage Block declares the execute+ persist port", () => {
    for (const block of OPTIONS_BLOCKS) {
      expect(block.port.methods).toEqual(["execute", "persist"]);
    }
  });

  // Issue #3186 step 5 (AOP catalog decision, RULED by reuse): the
  // pipeline reuses the generic SCREEN_* outcome codes and adds NO
  // stage-specific entries. The catalog's naming rule encodes the
  // OUTCOME, not the location: a screen completes / partially covers
  // / evaluates nothing / fails the same way whichever stage it
  // happened in, and the stage dimension already rides the stage
  // record + message (stageId, runId, reason). A stage-specific code
  // would duplicate the stageId. The saga precedent (FAILURE_SAGA_*)
  // is different in kind: those are journey outcomes (payment /
  // gate / trade), not stage locations. This pin guards the decision
  // against drift: the complete code set across all eight Blocks is
  // exactly these four generic codes.
  it("the pipeline uses only the generic SCREEN_* outcome codes (no stage-specific entries)", () => {
    const codes = new Set(OPTIONS_BLOCKS.flatMap((block) => block.catalogEntries));
    expect([...codes].sort()).toEqual([
      "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
      "FAILURE_SCREEN_RUN_FAILED",
      "SUCCESS_SCREEN_COMPLETED",
      "SUCCESS_SCREEN_PARTIAL_RESULTS",
    ]);
  });

  it("the Phase A options-leg proposal now carries the real pipeline stages", () => {
    const optionsLeg = SAGA_BLOCKS.find((block) => block.id === "options-leg");
    expect(optionsLeg).toBeDefined();
    expect([...(optionsLeg?.stageContract.stageIds ?? [])]).toEqual([
      ...OPTIONS_PIPELINE_STAGES,
    ]);
  });

  it("runs all eight stages in order, persist-then-publish each", async () => {
    const { deps: d, sent, calls, order } = deps();
    const result = await runOptionsScreenWorkflow(
      { runId: "run-1", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(result.outcome).toBe("completed");
    expect(order).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect(sent.map((message) => message.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const message of sent) {
      expect(message.family).toBe("options");
      expect(message.idempotencyKey).toBe(
        `run-1::options::${message.stageId}`,
      );
    }
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      const executeAt = calls.indexOf(`execute:${stageId}`);
      const persistAt = calls.indexOf(`persist:${stageId}`);
      const publishAt = calls.indexOf(`publish:${stageId}`);
      expect(executeAt).toBeGreaterThanOrEqual(0);
      expect(persistAt).toBeGreaterThan(executeAt);
      expect(publishAt).toBeGreaterThan(persistAt);
    }
  });

  it("skips an already-claimed stage and keeps going", async () => {
    const { deps: d, sent, order } = deps({
      claims: memoryClaims(["run-2::options::chainFetch"]),
    });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-2", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(result.outcome).toBe("completed");
    expect(order).not.toContain("chainFetch");
    expect(sent.map((message) => message.stageId)).not.toContain("chainFetch");
    expect(result.stages.find((entry) => entry.stageId === "chainFetch")?.status).toBe(
      "skipped-claimed",
    );
  });

  it("a stage failure stops the run loudly with no message for the failed stage", async () => {
    const { ports, calls } = stubPorts();
    ports["screen"] = {
      execute: async () => {
        calls.push("execute:screen");
        throw new Error("chains unavailable");
      },
      persist: async () => {
        calls.push("persist:screen");
        return [];
      },
    };
    const { deps: d, sent } = deps({ stages: ports });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-3", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(result.outcome).toBe("failed");
    expect(result.failedStage).toBe("screen");
    expect(result.reason).toContain("chains unavailable");
    expect(sent.map((message) => message.stageId)).not.toContain("screen");
    expect(sent.map((message) => message.stageId)).not.toContain("risk");
    expect(calls).not.toContain("execute:risk");
  });

  it("refuses a stage port missing a method, loudly", async () => {
    const { ports } = stubPorts();
    const broken = { ...ports, screen: { execute: ports["screen"]!.execute } };
    const { deps: d } = deps({ stages: broken as never });
    await expect(
      runOptionsScreenWorkflow(
        { runId: "run-4", userLogin: "owner@example.com", request: { filter: {} } },
        d,
      ),
    ).rejects.toThrow(/missing port method persist/);
  });

  it("a partial stage keeps the run going; the outcome stays completed", async () => {
    const { ports } = stubPorts();
    ports["chainFetch"] = {
      execute: async () => ({ stage: "chainFetch", terminal: "partial" }),
      persist: async () => ["options:chainFetch:chainFetch"],
    };
    const { deps: d, sent } = deps({ stages: ports });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-6", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(result.outcome).toBe("completed");
    expect(result.stages.find((entry) => entry.stageId === "chainFetch")?.status).toBe(
      "partial",
    );
    expect(sent).toHaveLength(8);
  });

  it("zero contracts is a legitimate complete, not a failure (#2038)", async () => {
    const { ports } = stubPorts();
    ports["screen"] = {
      execute: async () => ({ terminal: "no_contracts", contracts: [] }),
      persist: async () => ["options:screen:screen"],
    };
    const { deps: d } = deps({ stages: ports });
    const result = await runOptionsScreenWorkflow(
      { runId: "run-7", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(result.outcome).toBe("completed");
    expect(result.stages.find((entry) => entry.stageId === "screen")?.status).toBe(
      "no_contracts",
    );
  });

  it("each stage reads only persisted input: execute receives the previous artifact keys", async () => {
    const seen: Array<{ stageId: string; artifactKeys: string[] }> = [];
    const { deps: d } = deps();
    const ports = d.stages;
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      const original = ports[stageId]!.execute;
      ports[stageId]!.execute = async (input) => {
        seen.push({ stageId, artifactKeys: [...input.artifactKeys] });
        return original(input);
      };
    }
    await runOptionsScreenWorkflow(
      { runId: "run-5", userLogin: "owner@example.com", request: { filter: {} } },
      d,
    );
    expect(seen[0]?.artifactKeys).toEqual([]);
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index]?.artifactKeys).toEqual([`options:${OPTIONS_PIPELINE_STAGES[index - 1]}:${OPTIONS_PIPELINE_STAGES[index - 1]}`]);
    }
  });
});
