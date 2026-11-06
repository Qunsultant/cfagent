/**
 * Issue #3186 step 4 - checkpoint/resume proof.
 *
 * The pipeline's checkpointing discipline is runId+stageId claims in
 * `mas_stage_claims` (src/data/stageClaimsStore.ts): a stage that
 * completed is never re-executed, a stage that failed has its claim
 * released so a retry re-runs it, and the claims live in SQL so they
 * survive an instance eviction. The composer-level skip was proven
 * with in-memory claims in step 2; this file proves it against the
 * DURABLE store (MockSqlStorage), including the eviction case (a
 * second store instance over the same SQL still sees the claims).
 *
 * The ports here are counting stubs, not production ports: the proof
 * is about the claim discipline, and the production entries that wire
 * the durable store (goal leg, manual entry, unified handler) are
 * pinned in their own files.
 */
import { describe, expect, it } from "vitest";
import { createSqlStageClaimStore } from "../src/data/stageClaimsStore";
import { MockSqlStorage } from "./mock-sql";
import {
  runOptionsScreenWorkflow,
  type OptionsStagePort,
} from "../src/workflows/optionsScreenWorkflow";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { stageIdempotencyKey } from "../src/workflows/stageMessage";

function countingPorts(
  counts: Map<string, number>,
  failAt?: string,
): Record<string, OptionsStagePort> {
  const ports: Record<string, OptionsStagePort> = {};
  for (const stageId of OPTIONS_PIPELINE_STAGES) {
    ports[stageId] = {
      execute: async () => {
        counts.set(stageId, (counts.get(stageId) ?? 0) + 1);
        if (failAt === stageId) {
          throw new Error(`boom at ${stageId}`);
        }
        return { stage: stageId, terminal: "completed" };
      },
      persist: async (_input, output) => [
        `options:${(output as { stage: string }).stage}`,
      ],
    };
  }
  return ports;
}

const runId = "checkpoint-proof:run-1";

async function run(
  claims: ReturnType<typeof createSqlStageClaimStore>,
  counts: Map<string, number>,
  failAt?: string,
) {
  return runOptionsScreenWorkflow(
    {
      runId,
      userLogin: "tester",
      request: { assetClass: "options", classInput: {} },
    },
    {
      stages: countingPorts(counts, failAt),
      claims,
      queue: null,
      warn: () => undefined,
    },
  );
}

describe("checkpoint/resume over the durable claim store (#3186 step 4)", () => {
  it("a second run over the same runId re-executes nothing", async () => {
    const sql = new MockSqlStorage();
    const claims = createSqlStageClaimStore(() => sql as never);
    const counts = new Map<string, number>();

    const first = await run(claims, counts);
    expect(first.outcome).toBe("completed");
    expect(first.stages.map((s) => s.status)).toEqual(
      OPTIONS_PIPELINE_STAGES.map(() => "completed"),
    );
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      expect(counts.get(stageId)).toBe(1);
    }

    const second = await run(claims, counts);
    expect(second.outcome).toBe("completed");
    expect(second.stages.map((s) => s.status)).toEqual(
      OPTIONS_PIPELINE_STAGES.map(() => "skipped-claimed"),
    );
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      expect(counts.get(stageId)).toBe(1);
    }
  });

  it("claims survive an instance eviction (a fresh store over the same SQL still skips)", async () => {
    const sql = new MockSqlStorage();
    const counts = new Map<string, number>();

    const first = await run(createSqlStageClaimStore(() => sql as never), counts);
    expect(first.outcome).toBe("completed");

    // A new store instance = a new DO instance after eviction: no
    // in-memory state carries over, only the SQL rows do.
    const evicted = createSqlStageClaimStore(() => sql as never);
    const second = await run(evicted, counts);
    expect(second.outcome).toBe("completed");
    expect(second.stages.map((s) => s.status)).toEqual(
      OPTIONS_PIPELINE_STAGES.map(() => "skipped-claimed"),
    );
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      expect(counts.get(stageId)).toBe(1);
    }
  });

  it("a failure releases only the failed stage's claim, and the retry resumes after the last completed stage", async () => {
    const sql = new MockSqlStorage();
    const claims = createSqlStageClaimStore(() => sql as never);
    const counts = new Map<string, number>();

    const failed = await run(claims, counts, "screen");
    expect(failed.outcome).toBe("failed");
    expect(failed.failedStage).toBe("screen");
    // plan/chainFetch/enrich ran once; screen attempted once and
    // failed; later stages never ran.
    expect(counts.get("plan")).toBe(1);
    expect(counts.get("chainFetch")).toBe(1);
    expect(counts.get("enrich")).toBe(1);
    expect(counts.get("screen")).toBe(1);
    expect(counts.get("risk")).toBeUndefined();
    expect(counts.get("deliver")).toBeUndefined();
    // The failed stage's claim is released; the completed stages'
    // claims stand.
    expect(claims.has(stageIdempotencyKey(runId, "screen", "options"))).toBe(false);
    expect(claims.has(stageIdempotencyKey(runId, "plan", "options"))).toBe(true);
    expect(claims.has(stageIdempotencyKey(runId, "enrich", "options"))).toBe(true);

    const resumed = await run(claims, counts);
    expect(resumed.outcome).toBe("completed");
    expect(resumed.stages.map((s) => `${s.stageId}:${s.status}`)).toEqual([
      "plan:skipped-claimed",
      "chainFetch:skipped-claimed",
      "enrich:skipped-claimed",
      "screen:completed",
      "risk:completed",
      "persistCanonicalResults:completed",
      "shapeReport:completed",
      "deliver:completed",
    ]);
    expect(counts.get("plan")).toBe(1);
    expect(counts.get("screen")).toBe(2);
    expect(counts.get("deliver")).toBe(1);
  });
});
