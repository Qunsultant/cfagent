/**
 * Issue #2866 (Phase 2 Slice 6 under #2764) — pins for the
 * adopted shard-failure rule on the sharded scheduled path:
 * partial/marked, never silent, never whole-run failure while
 * any shard completed. The rule itself lives in
 * collateShards (src/workflows/screenerCollation.ts),
 * reused as-is — these pins tie the decision to this slice
 * so a future collation change cannot silently drop it.
 */
import { describe, expect, it } from "vitest";
import { collateShards } from "../src/workflows/screenerCollation";
import type { ShardOutcome } from "../src/workflows/workflowPorts";

function outcome(
  overrides: Partial<ShardOutcome> & { shardId: string },
): ShardOutcome {
  return {
    status: "completed",
    expectedCount: 10,
    totalScanned: 10,
    matchedCount: 1,
    stored: true,
    ...overrides,
  };
}

describe("collateShards shard-failure rule (Slice 6 adopted decision)", () => {
  it("marks a run with one failed shard qualified-partial, not failed", () => {
    const collation = collateShards(
      "job-1",
      "wf-1",
      [
        outcome({ shardId: "NASDAQ100" }),
        outcome({ shardId: "NYSE", status: "failed", error: "quotes down", stored: false }),
      ],
      [],
      [],
    );
    expect(collation.qualified).toBe(true);
    expect(collation.lifecycle).not.toBe("Failed");
    expect(collation.shards.find((s) => s.shardId === "NYSE")?.status).toBe("failed");
  });

  it("marks a timed-out shard qualified-partial too", () => {
    const collation = collateShards(
      "job-1",
      "wf-1",
      [
        outcome({ shardId: "NASDAQ100" }),
        outcome({ shardId: "NYSE", status: "timed_out", timedOut: true, stored: false }),
      ],
      [],
      [],
    );
    expect(collation.qualified).toBe(true);
    expect(collation.lifecycle).not.toBe("Failed");
  });

  it("fails honestly when every shard failed", () => {
    const collation = collateShards(
      "job-1",
      "wf-1",
      [
        outcome({ shardId: "NASDAQ100", status: "failed", error: "boom", stored: false }),
        outcome({ shardId: "NYSE", status: "failed", error: "boom", stored: false }),
      ],
      [],
      [],
    );
    expect(collation.lifecycle).toBe("Failed");
    expect(collation.error).toBe("boom");
  });

  it("leaves an all-completed, all-stored run unqualified", () => {
    const collation = collateShards(
      "job-1",
      "wf-1",
      [outcome({ shardId: "NASDAQ100" }), outcome({ shardId: "NYSE" })],
      [],
      [],
    );
    expect(collation.qualified).toBe(false);
    expect(collation.lifecycle).toBe("ReportGenerated");
  });
});
