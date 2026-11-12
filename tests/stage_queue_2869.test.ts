/**
 * Issue #2869 (under #2764) — pins for the stage-message
 * contract, the report-from-persisted consumer, and batch
 * checkpointing. These pin the CONTRACT properties; they do
 * not claim every stage's execution has migrated to queue
 * pub/sub (that migration is follow-through under #2869).
 */
import { describe, expect, it, vi } from "vitest";
import {
  publishStageOutput,
  stageIdempotencyKey,
  stageMessage,
} from "../src/workflows/stageMessage";
import { consumeAnalysisDone } from "../src/workflows/stageReportConsumer";
import {
  createBatchCheckpoint,
  missingBatchManifest,
  planBatches,
} from "../src/workflows/stageBatching";
import { collateShards } from "../src/workflows/screenerCollation";

function analysisDoneMessage(overrides: Record<string, unknown> = {}) {
  return stageMessage({
    runId: "run-1",
    stageId: "analysis-done",
    artifactKeys: ["artifact-1"],
    userLogin: "alice",
    ...overrides,
  } as never);
}

function claimsStore() {
  const seen = new Set<string>();
  return {
    has: (key: string) => seen.has(key),
    add: (key: string) => {
      seen.add(key);
    },
  };
}

describe("stageMessage", () => {
  it("keys idempotency by runId + stageId", () => {
    expect(stageIdempotencyKey("run-1", "enrich")).toBe("run-1::enrich");
    const message = stageMessage({
      runId: "run-1",
      stageId: "enrich",
      artifactKeys: ["a-1"],
      userLogin: "alice",
    });
    expect(message.idempotencyKey).toBe("run-1::enrich");
  });

  it("refuses messages with no persisted reference, no run, or a default identity", () => {
    expect(() =>
      stageMessage({ runId: "run-1", stageId: "enrich", artifactKeys: [], userLogin: "alice" }),
    ).toThrow(/artifactKey/);
    expect(() =>
      stageMessage({ runId: " ", stageId: "enrich", artifactKeys: ["a"], userLogin: "alice" }),
    ).toThrow(/runId/);
    expect(() =>
      stageMessage({ runId: "run-1", stageId: "enrich", artifactKeys: ["a"], userLogin: "default" }),
    ).toThrow(/userLogin/);
  });
});

describe("publishStageOutput (persist-then-publish)", () => {
  it("persists before publishing, in order", async () => {
    const order: string[] = [];
    const message = await publishStageOutput({
      persist: async () => {
        order.push("persist");
        return ["artifact-1"];
      },
      publish: async () => {
        order.push("publish");
      },
      runId: "run-1",
      stageId: "enrich",
      output: { rows: 3 },
      userLogin: "alice",
    });
    expect(order).toEqual(["persist", "publish"]);
    expect(message.artifactKeys).toEqual(["artifact-1"]);
  });

  it("leaves the output durable when publish throws, so it can be republished", async () => {
    let persisted = false;
    await expect(
      publishStageOutput({
        persist: async () => {
          persisted = true;
          return ["artifact-1"];
        },
        publish: async () => {
          throw new Error("queue down");
        },
        runId: "run-1",
        stageId: "enrich",
        output: {},
        userLogin: "alice",
      }),
    ).rejects.toThrow("queue down");
    expect(persisted).toBe(true);
  });
});

describe("consumeAnalysisDone (report from persisted only)", () => {
  it("generates from the persisted result, never from a live input", async () => {
    const persisted = { allStocks: [{ symbol: "NVDA" }], opportunities: [] };
    const generate = vi.fn(async (input: { result: unknown }) => ({ pdfKey: "pdf-1", input }));
    const result = await consumeAnalysisDone({
      message: analysisDoneMessage(),
      readPersisted: async () => persisted,
      generate,
    });
    expect(result.status).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(1);
    // The generate input IS the persisted analysis — no other
    // data source exists on the consumer's signature.
    expect(generate.mock.calls[0][0].result).toBe(persisted);
    expect(generate.mock.calls[0][0].partial).toBe(false);
  });

  it("carries partial marking through instead of failing or hiding it", async () => {
    const generate = vi.fn(async () => ({ pdfKey: "pdf-1" }));
    const result = await consumeAnalysisDone({
      message: analysisDoneMessage(),
      readPersisted: async () => ({ allStocks: [], partial: { reason: "quotes partial" } }),
      generate,
    });
    expect(result.status).toBe("generated");
    expect(generate.mock.calls[0][0].partial).toBe(true);
  });

  it("suppresses a redelivered message without regenerating", async () => {
    const claims = claimsStore();
    const generate = vi.fn(async () => ({ pdfKey: "pdf-1" }));
    const first = await consumeAnalysisDone({
      message: analysisDoneMessage(),
      claims,
      readPersisted: async () => ({ allStocks: [] }),
      generate,
    });
    const second = await consumeAnalysisDone({
      message: analysisDoneMessage(),
      claims,
      readPersisted: async () => ({ allStocks: [] }),
      generate,
    });
    expect(first.status).toBe("generated");
    expect(second.status).toBe("duplicate-suppressed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("dead-letters poison immediately, regardless of attempt, and over-budget messages", async () => {
    const deadLetter = vi.fn();
    const wrongStage = await consumeAnalysisDone({
      message: stageMessage({ runId: "run-1", stageId: "enrich", artifactKeys: ["a"], userLogin: "alice" }),
      attempt: 1,
      readPersisted: async () => null,
      generate: async () => ({}),
      deadLetter,
    });
    expect(wrongStage.status).toBe("dead-lettered");
    expect(wrongStage.reason).toMatch(/poison/);
    const overBudget = await consumeAnalysisDone({
      message: analysisDoneMessage(),
      attempt: 4,
      maxAttempts: 3,
      readPersisted: async () => ({ allStocks: [] }),
      generate: async () => ({}),
      deadLetter,
    });
    expect(overBudget.status).toBe("dead-lettered");
    expect(overBudget.reason).toMatch(/budget/);
    expect(deadLetter).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when the persisted analysis is missing — never regenerating it", async () => {
    await expect(
      consumeAnalysisDone({
        message: analysisDoneMessage(),
        readPersisted: async () => null,
        generate: async () => ({}),
      }),
    ).rejects.toThrow(/missing/);
  });
});

describe("batching and checkpoints", () => {
  it("plans batches with the throttle cap and refuses nonsense inputs", () => {
    const plan = planBatches(250, 100, 2);
    expect(plan.batches).toEqual([
      { index: 0, start: 0, end: 100, size: 100 },
      { index: 1, start: 100, end: 200, size: 100 },
      { index: 2, start: 200, end: 250, size: 50 },
    ]);
    expect(plan.maxInFlight).toBe(2);
    expect(() => planBatches(10, 0, 1)).toThrow(/batchSize/);
    expect(() => planBatches(10, 10, 0)).toThrow(/maxInFlight/);
  });

  it("reports a missing-batch manifest instead of partial-complete", () => {
    const checkpoint = createBatchCheckpoint(["b0", "b1", "b2"]);
    checkpoint.markComplete("b0");
    checkpoint.markFailed("b1", "quotes down");
    const manifest = checkpoint.manifest();
    expect(manifest.complete).toBe(false);
    expect(manifest.missing).toEqual(["b2"]);
    expect(manifest.failed).toEqual([{ batchId: "b1", reason: "quotes down" }]);
    checkpoint.markComplete("b1");
    checkpoint.markComplete("b2");
    expect(checkpoint.manifest().complete).toBe(true);
  });

  it("derives the missing manifest from collation: non-completed shards are missing batches", () => {
    const collation = collateShards(
      "job-1",
      "wf-1",
      [
        { shardId: "NASDAQ100", status: "completed", expectedCount: 10, totalScanned: 10, matchedCount: 1, stored: true },
        { shardId: "NYSE", status: "failed", expectedCount: 10, totalScanned: 0, matchedCount: 0, error: "down" },
      ],
      [],
      [],
    );
    expect(missingBatchManifest(collation)).toEqual({ complete: false, missing: ["NYSE"] });
  });
});
