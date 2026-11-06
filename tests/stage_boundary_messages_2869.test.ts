/**
 * Issue #2869 slice 2 (under #2764) — one stage message per
 * stage boundary inside runScreenInner, over slice 1's
 * transport. Pins the transport and the wiring, not a
 * re-execution of any stage: the fused path still executes
 * in-process, and each boundary message is the persisted
 * summary + queue record for that boundary.
 * analysis-done is deliberately NOT in the slice 2 set:
 * slice 1 already publishes it after the canonical row lands.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  buildStageBoundaryMessage,
  executeStageBoundaryQueueMessage,
  isStageBoundaryMessage,
  isStageMessage,
  publishStageBoundaryMessage,
  stageBoundaryKey,
} from "../src/workflows/stageQueueTransport";
import { STOCK_STAGE_IDS, stageMessage } from "../src/workflows/stageMessage";

const SLICE_2_STAGES = STOCK_STAGE_IDS.filter((s) => s !== "analysis-done");

function boundaryMessage(stageId: (typeof STOCK_STAGE_IDS)[number]) {
  return buildStageBoundaryMessage({
    timestamp: "2026-11-04T00:00:00.000Z",
    userLogin: "alice",
    stageId,
    artifactKeys: [stageBoundaryKey("2026-11-04T00:00:00.000Z", stageId)],
  });
}

describe("stage boundary keys and messages", () => {
  it("keys one artifact per run + stage, and messages key idempotency by runId + stage", () => {
    const msg = boundaryMessage("fetchQuotes");
    expect(msg.runId).toBe("screener:2026-11-04T00:00:00.000Z");
    expect(msg.stageId).toBe("fetchQuotes");
    expect(msg.artifactKeys).toEqual(["screener:stage:2026-11-04T00:00:00.000Z:fetchQuotes"]);
    expect(msg.idempotencyKey).toBe("screener:2026-11-04T00:00:00.000Z::fetchQuotes");
    expect(msg.producedBy).toBe("fetchQuotes");
    expect(isStageMessage(msg)).toBe(true);
    expect(isStageBoundaryMessage(msg)).toBe(true);
  });

  it("covers every stage id exactly once, and analysis-done is not a slice 2 boundary", () => {
    expect(SLICE_2_STAGES).toHaveLength(12);
    for (const stageId of SLICE_2_STAGES) {
      expect(isStageBoundaryMessage(boundaryMessage(stageId))).toBe(true);
    }
    const analysisDone = stageMessage({
      runId: "screener:t",
      stageId: "analysis-done",
      artifactKeys: ["screener:analysis:t"],
      userLogin: "alice",
    });
    expect(isStageMessage(analysisDone)).toBe(true);
    expect(isStageBoundaryMessage(analysisDone)).toBe(false);
  });

  it("rejects malformed bodies, unknown stages, and the default identity", () => {
    expect(isStageMessage(null)).toBe(false);
    expect(isStageMessage({ ...boundaryMessage("plan"), artifactKeys: [] })).toBe(false);
    expect(isStageMessage({ ...boundaryMessage("plan"), userLogin: "default" })).toBe(false);
    expect(isStageMessage({ ...boundaryMessage("plan"), stageId: "nope" })).toBe(false);
    expect(() =>
      buildStageBoundaryMessage({
        timestamp: "t",
        userLogin: "default",
        stageId: "plan",
        artifactKeys: ["k"],
      }),
    ).toThrow(/userLogin/);
  });
});

describe("publishStageBoundaryMessage", () => {
  it("never throws: no queue binding reports published false", async () => {
    const out = await publishStageBoundaryMessage({ queue: null, message: boundaryMessage("plan") });
    expect(out.published).toBe(false);
    const out2 = await publishStageBoundaryMessage({ queue: undefined, message: boundaryMessage("plan") });
    expect(out2.published).toBe(false);
  });

  it("publishes the message through the queue send, and reports a send throw instead of throwing", async () => {
    const sent: unknown[] = [];
    const ok = await publishStageBoundaryMessage({
      queue: { send: async (body: unknown) => void sent.push(body) },
      message: boundaryMessage("deliver"),
    });
    expect(ok.published).toBe(true);
    expect(sent).toHaveLength(1);
    const failing = await publishStageBoundaryMessage({
      queue: {
        send: async () => {
          throw new Error("queue down");
        },
      },
      message: boundaryMessage("deliver"),
    });
    expect(failing.published).toBe(false);
  });

  it("refuses a malformed message without touching the queue", async () => {
    const sent: unknown[] = [];
    const out = await publishStageBoundaryMessage({
      queue: { send: async (body: unknown) => void sent.push(body) },
      message: { ...boundaryMessage("plan"), artifactKeys: [] },
    });
    expect(out.published).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("executeStageBoundaryQueueMessage", () => {
  it("acks recorded and duplicate-suppressed outcomes, and dead-letters poison without retry", async () => {
    const recorded = await executeStageBoundaryQueueMessage({
      message: boundaryMessage("enrich"),
      record: async () => "recorded",
    });
    expect(recorded).toEqual({ action: "ack", status: "recorded" });
    const dup = await executeStageBoundaryQueueMessage({
      message: boundaryMessage("enrich"),
      record: async () => "duplicate-suppressed",
    });
    expect(dup).toEqual({ action: "ack", status: "duplicate-suppressed" });
    const deadLetters: unknown[] = [];
    const poison = await executeStageBoundaryQueueMessage({
      message: { ...boundaryMessage("plan"), stageId: "analysis-done" } as never,
      record: async () => "recorded",
      deadLetter: async (info) => void deadLetters.push(info),
    });
    expect(poison.action).toBe("ack");
    expect(poison.status).toBe("dead-lettered");
    expect(deadLetters).toHaveLength(1);
  });

  it("propagates a recorder throw so the caller retries into the DLQ, never acks a missing artifact", async () => {
    await expect(
      executeStageBoundaryQueueMessage({
        message: boundaryMessage("plan"),
        record: async () => {
          throw new Error("artifact missing");
        },
      }),
    ).rejects.toThrow(/artifact missing/);
  });
});

describe("runScreenInner wiring", () => {
  it("emits one boundary per slice 2 stage, in the fused path, and never emits analysis-done", () => {
    const src = readFileSync("src/agents/screener-agent.ts", "utf8");
    for (const stageId of SLICE_2_STAGES) {
      expect(src).toContain(`emitStageBoundary(timestamp, userLogin, "${stageId}"`);
    }
    expect(src).not.toContain('emitStageBoundary(timestamp, userLogin, "analysis-done"');
    // The queue executor exists and never calls the report consumer
    // (the Factor 6 pin: only the stageReportProduction helper does).
    expect(src).toContain("async recordQueuedStageBoundary(");
    // The recorder never calls the report consumer itself
    // (the Factor 6 pin: only the stageReportProduction
    // helper does) — the other queue endpoint in this file
    // does, via the shared helper, and is out of scope here.
    expect(src).not.toContain("consumeAnalysisDone(");
  });
});

describe("server queue routing", () => {
  it("routes boundary messages to the owning agent recorder, not the undecodable drop", () => {
    // Slice 8 of #2902 moves the queue handler from server.ts to
    // src/server/routes/queue.ts; the entry surface is both files.
    const src = readFileSync("src/server.ts", "utf8") + readFileSync("src/server/routes/queue.ts", "utf8");
    expect(src).toContain("isStageBoundaryMessage(msg.body)");
    expect(src).toContain("recordQueuedStageBoundary(");
  });
});
